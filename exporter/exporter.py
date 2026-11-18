"""Sleepless Twin in-cluster exporter (Phase D step 4).

Runs on the control plane, read-only. Reports what AWS cannot see:
  * job steps, from the platform's SQLite job store (explicit columns only;
    never payloads, results, outputs or errors), and
  * pod readiness, KEDA's replica count, vLLM state, GPU node join and the
    Cluster Autoscaler's decisions, from the Kubernetes API (get/list only).

Events go to the twin's ingest Lambda as HMAC-signed batches. Standard library
only, so it runs on a stock python image with no build step.

Spec: docs/phase-d-spec.md, section 3. Batch format: telemetry/twin/ingest.py.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import signal
import sqlite3
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

log = logging.getLogger("twin-exporter")

# ---- configuration ----------------------------------------------------------------

DB_PATH = os.environ.get("DB_PATH", "/data/jobs.db")
STEPS_POLL_S = float(os.environ.get("STEPS_POLL_S", "2"))
K8S_POLL_S = float(os.environ.get("K8S_POLL_S", "5"))
BATCH_S = float(os.environ.get("BATCH_S", "5"))
HEARTBEAT_S = float(os.environ.get("HEARTBEAT_S", "60"))
RESEND_HOURS = float(os.environ.get("RESEND_HOURS", "6"))
MAX_QUEUE = 2000
MAX_BATCH = 500

INFRA_NS = "personal-ai-infra"
INFERENCE_NS = "personal-ai-inference"
PLATFORM_DEPLOYMENTS = ("orchestrator", "ai-worker", "laya-service", "litellm")
VLLM_DEPLOYMENT = "vllm-inference"
VLLM_LABEL = "app=vllm-inference"
GPU_NODE_LABEL = "node.kubernetes.io/instance-type=g5.xlarge"

Event = Dict[str, Any]


def iso_ms(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def ev(kind: str, ts: int, key: str, data: Optional[Dict[str, Any]] = None, job: Optional[str] = None) -> Event:
    out: Event = {"kind": kind, "ts": int(ts), "key": key, "data": data or {}}
    if job:
        out["job"] = job
    return out


# ---- job store --------------------------------------------------------------------

# The only SQL this exporter runs. Column lists are explicit: payload, payload_ref, result,
# result_ref (except whether it is null), error, idempotency_key, job_steps.output,
# job_steps.error and outbox_events are never read. tests/test_exporter.py enforces this.
SQL_CHANGED = "SELECT DISTINCT job_id, completed_at FROM job_steps WHERE completed_at > ? ORDER BY completed_at"
SQL_STEPS = "SELECT job_id, step_id, attempt, state, started_at, completed_at FROM job_steps WHERE job_id IN ({})"
SQL_JOBS = "SELECT job_id, job_type, status, result_ref IS NOT NULL AS has_result FROM jobs WHERE job_id IN ({})"
SQLS = (SQL_CHANGED, SQL_STEPS, SQL_JOBS)


class JobStore:
    """Read-only view of the platform's job store.

    Opened with mode=ro on a read-only mount. Never immutable=1: that ignores the WAL
    and can return stale or inconsistent rows.
    """

    def __init__(self, path: str) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def changed_since(self, cursor: str) -> Tuple[List[str], str]:
        with self._connect() as conn:
            rows = conn.execute(SQL_CHANGED, (cursor,)).fetchall()
        if not rows:
            return [], cursor
        ids = sorted({r["job_id"] for r in rows})
        return ids, max(r["completed_at"] for r in rows)

    def load(self, job_ids: List[str]) -> Dict[str, Tuple[Dict[str, Any], List[Dict[str, Any]]]]:
        if not job_ids:
            return {}
        marks = ",".join("?" * len(job_ids))
        with self._connect() as conn:
            jobs = {r["job_id"]: dict(r) for r in conn.execute(SQL_JOBS.format(marks), job_ids)}
            steps: Dict[str, List[Dict[str, Any]]] = {}
            for r in conn.execute(SQL_STEPS.format(marks), job_ids):
                steps.setdefault(r["job_id"], []).append(dict(r))
        return {j: (jobs[j], steps.get(j, [])) for j in job_ids if j in jobs}


def job_events(job: Dict[str, Any], steps: List[Dict[str, Any]]) -> List[Event]:
    """All twin events implied by one job's step rows. Pure; re-deriving gives the same keys.

    The platform rewrites a step row on every state change (INSERT OR REPLACE): started_at
    is the first write, completed_at the latest, state the latest state. Step names and
    states come from the platform's worker (services/ai_worker/worker.py).
    """
    jid = job["job_id"]
    out: List[Event] = []
    by: Dict[Tuple[str, int], Dict[str, Any]] = {(s["step_id"], int(s["attempt"])): s for s in steps}

    def at(s: Dict[str, Any], field: str = "completed_at") -> int:
        return iso_ms(s.get(field)) or iso_ms(s.get("started_at")) or 0

    def add(kind: str, ts: int, name: str, data: Optional[Dict[str, Any]] = None) -> None:
        out.append(ev(kind, ts, f"{jid}|{name}|{kind}", data, job=jid))

    gens = sorted(a for (sid, a) in by if sid == "step_generation")
    verifs = sorted(a for (sid, a) in by if sid == "step_verification")
    dispatched = ("step_gpu_dispatch", 1) in by

    s = by.get(("step_validation", 1))
    if s:
        add("job.dequeued", at(s, "started_at"), "validation", {"queue": "workflow"})

    s = by.get(("step_decision", 1))
    if s and s["state"] == "COMPLETED":
        add("laya.gate", at(s), "decision", {"result": "decision"})
        add("job.finished", at(s) + 1, "decision", {"outcome": "decided"})

    s = by.get(("step_triage", 1))
    if s and s["state"] == "REJECTED":
        add("laya.gate", at(s), "triage", {"result": "reject"})
        add("job.finished", at(s) + 1, "triage", {"outcome": "rejected"})

    s = by.get(("step_gpu_dispatch", 1))
    if s:
        t = at(s, "started_at")
        add("laya.gate", t, "dispatch", {"result": "pass"})
        data = {"queue": "gpu"}
        if job.get("job_type"):
            data["jobType"] = job["job_type"]  # dropped by ingest unless allowlisted
        add("job.enqueued", t + 1, "dispatch", data)

    for n in gens:
        t = at(by[("step_generation", n)], "started_at")
        if n == min(gens):
            add("job.dequeued", t - 1, f"generation{n}", {"queue": "gpu"})
        add("job.generate", t, f"generation{n}", {"attempt": n})
        # A later generation attempt means verification of this one failed.
        if n + 1 in gens and n in verifs:
            add("laya.verify", at(by[("step_generation", n + 1)], "started_at") - 1, f"verify{n}", {"attempt": n, "passed": False})

    s = by.get(("step_final", 1))
    if s:
        t = at(s)
        last = verifs[-1] if verifs else None
        if s["state"] == "COMPLETED":
            if last is not None:
                add("laya.verify", t, f"verify{last}", {"attempt": last, "passed": True})
            add("job.finished", t + 2, "final", {"outcome": "completed"})
        elif s["state"] == "NEEDS_REVIEW":
            if last is not None:
                add("laya.verify", t, f"verify{last}", {"attempt": last, "passed": False})
            add("job.finished", t + 2, "final", {"outcome": "needs_review"})
        elif s["state"] == "FAILED":
            add("job.failed", t, "final", {"queue": "gpu" if dispatched else "workflow"})
        if s["state"] in ("COMPLETED", "NEEDS_REVIEW") and job.get("has_result"):
            add("s3.result", t + 1, "final")
    return out


# ---- Kubernetes -------------------------------------------------------------------


class K8sClient:
    """Minimal in-cluster API client (get/list only)."""

    SA = "/var/run/secrets/kubernetes.io/serviceaccount"

    def __init__(self) -> None:
        host = os.environ["KUBERNETES_SERVICE_HOST"]
        port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
        self.base = f"https://{host}:{port}"
        self.ctx = ssl.create_default_context(cafile=f"{self.SA}/ca.crt")

    def get(self, path: str, **params: str) -> Dict[str, Any]:
        with open(f"{self.SA}/token", encoding="utf-8") as f:  # re-read: projected tokens rotate
            token = f.read().strip()
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        with urllib.request.urlopen(req, context=self.ctx, timeout=10) as r:
            return json.load(r)


def _ready(conds: List[Dict[str, Any]]) -> bool:
    return any(c.get("type") == "Ready" and c.get("status") == "True" for c in conds or [])


def k8s_snapshot(get: Callable[..., Dict[str, Any]]) -> Dict[str, Any]:
    """Current cluster facts the twin shows. Any read that fails leaves its field as None."""
    snap: Dict[str, Any] = {"podsReady": None, "vllmReplicas": None, "vllm": None, "gpuNode": None, "caEvents": []}

    def safe(fn: Callable[[], Any]) -> Any:
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            log.warning("k8s read failed: %s", type(exc).__name__)
            return None

    deps = safe(lambda: get(f"/apis/apps/v1/namespaces/{INFRA_NS}/deployments"))
    if deps is not None:
        state = {d["metadata"]["name"]: d for d in deps.get("items", [])}
        snap["podsReady"] = all(
            n in state and (state[n].get("spec", {}).get("replicas") or 0) > 0
            and (state[n].get("status", {}).get("readyReplicas") or 0) >= (state[n]["spec"]["replicas"] or 0)
            for n in PLATFORM_DEPLOYMENTS
        )

    dep = safe(lambda: get(f"/apis/apps/v1/namespaces/{INFERENCE_NS}/deployments/{VLLM_DEPLOYMENT}"))
    if dep is not None:
        snap["vllmReplicas"] = int(dep.get("spec", {}).get("replicas") or 0)

    pods = safe(lambda: get(f"/api/v1/namespaces/{INFERENCE_NS}/pods", labelSelector=VLLM_LABEL))
    if pods is not None:
        live = [p for p in pods.get("items", []) if not p["metadata"].get("deletionTimestamp")]
        if not live:
            snap["vllm"] = "absent"
        else:
            p = max(live, key=lambda x: x["metadata"].get("creationTimestamp", ""))
            phase = p.get("status", {}).get("phase")
            if phase == "Running":
                snap["vllm"] = "ready" if _ready(p["status"].get("conditions")) else "loading"
            elif phase == "Pending":
                snap["vllm"] = "pending"
            else:
                snap["vllm"] = "absent"

    nodes = safe(lambda: get("/api/v1/nodes", labelSelector=GPU_NODE_LABEL))
    if nodes is not None:
        snap["gpuNode"] = any(_ready(n.get("status", {}).get("conditions")) for n in nodes.get("items", []))

    for path, reason, desired in (
        (f"/api/v1/namespaces/{INFERENCE_NS}/events", "TriggeredScaleUp", 1),
        ("/api/v1/events", "ScaleDown", 0),
    ):
        evs = safe(lambda: get(path, fieldSelector=f"reason={reason}"))
        for e in (evs or {}).get("items", []):
            if "cluster-autoscaler" not in str((e.get("source") or {}).get("component", "")) + str(e.get("reportingComponent", "")):
                continue
            if reason == "ScaleDown" and (e.get("involvedObject") or {}).get("kind") != "Node":
                continue
            ts = iso_ms(e.get("eventTime")) or iso_ms(e.get("lastTimestamp")) or iso_ms(e.get("firstTimestamp"))
            if ts:
                snap["caEvents"].append((f"{e['metadata']['uid']}|{e.get('count', 1)}", desired, ts))
    return snap


def k8s_events(prev: Dict[str, Any], snap: Dict[str, Any], now: int, seen_ca: Set[str]) -> List[Event]:
    """Events for what changed between two snapshots. None in either means unknown: no event."""
    out: List[Event] = []

    def changed(field: str) -> bool:
        return snap[field] is not None and snap[field] != prev.get(field)

    if changed("podsReady"):
        out.append(ev("pods.ready", now, f"k8s|pods|{snap['podsReady']}|{now}", {"ready": snap["podsReady"]}))
    if changed("vllmReplicas"):
        out.append(ev("keda.scale", now, f"k8s|keda|{snap['vllmReplicas']}|{now}", {"replicas": snap["vllmReplicas"]}))
    if changed("vllm"):
        out.append(ev("vllm.state", now, f"k8s|vllm|{snap['vllm']}|{now}", {"state": snap["vllm"]}))
    if changed("gpuNode"):
        out.append(ev("node.joined", now, f"k8s|node|{snap['gpuNode']}|{now}", {"joined": snap["gpuNode"]}))
    for uid, desired, ts in snap["caEvents"]:
        if uid not in seen_ca:
            seen_ca.add(uid)
            out.append(ev("asg.desired", ts, f"k8s|ca|{uid}", {"desired": desired, "by": "cluster-autoscaler"}))
    return out


# ---- sending ----------------------------------------------------------------------


def sign(key: bytes, body: bytes, now_ms: int) -> Dict[str, str]:
    ts = str(now_ms)
    return {"X-Twin-Timestamp": ts, "X-Twin-Signature": hmac.new(key, ts.encode() + b"." + body, hashlib.sha256).hexdigest()}


class Sender:
    """Batches events and POSTs them signed. Keeps unsent events across failures, up to a cap."""

    def __init__(self, url: str, key: bytes, post: Optional[Callable[[str, bytes, Dict[str, str]], int]] = None) -> None:
        self.url, self.key = url, key
        self.queue: List[Event] = []
        self.last_sent = 0.0
        self.backoff_until = 0.0
        self.backoff = 2.0
        self._post = post or self._http_post

    @staticmethod
    def _http_post(url: str, body: bytes, headers: Dict[str, str]) -> int:
        req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def add(self, events: List[Event]) -> None:
        self.queue.extend(events)
        if len(self.queue) > MAX_QUEUE:
            dropped = len(self.queue) - MAX_QUEUE
            self.queue = self.queue[dropped:]  # oldest go; the next re-send from jobs.db recovers job steps
            log.warning("queue full, dropped %d oldest events", dropped)

    def due(self, now: float) -> bool:
        if now < self.backoff_until:
            return False
        return (bool(self.queue) and now - self.last_sent >= BATCH_S) or now - self.last_sent >= HEARTBEAT_S

    def flush(self, now: float) -> bool:
        batch = self.queue[:MAX_BATCH]
        body = json.dumps({"v": 1, "events": batch}, separators=(",", ":")).encode()
        try:
            code = self._post(self.url, body, sign(self.key, body, int(now * 1000)))
        except Exception as exc:  # noqa: BLE001
            log.warning("send failed: %s", type(exc).__name__)
            code = 0
        if code == 202:
            del self.queue[: len(batch)]
            self.last_sent = now
            self.backoff = 2.0
            return True
        log.warning("ingest answered %s; retrying in %.0f s", code or "no response", self.backoff)
        self.backoff_until = now + self.backoff
        self.backoff = min(60.0, self.backoff * 2)
        return False


# ---- main loop --------------------------------------------------------------------


class Exporter:
    def __init__(self, store: JobStore, k8s_get: Optional[Callable[..., Dict[str, Any]]], sender: Sender, now: Callable[[], float] = time.time) -> None:
        self.store, self.k8s_get, self.sender, self.now = store, k8s_get, sender, now
        start = datetime.now(timezone.utc) - timedelta(hours=RESEND_HOURS)
        self.cursor = start.isoformat()  # re-send recent steps on every start; ingest ids make it idempotent
        self.sent_keys: Set[str] = set()
        self.k8s_prev: Dict[str, Any] = {}
        self.seen_ca: Set[str] = set()
        self.next_steps = 0.0
        self.next_k8s = 0.0
        self.store_ok = True

    def poll_steps(self) -> None:
        try:
            ids, cursor = self.store.changed_since(self.cursor)
            loaded = self.store.load(ids)
        except sqlite3.Error as exc:
            if self.store_ok:
                log.warning("job store unavailable (%s); retrying", type(exc).__name__)
            self.store_ok = False
            self.next_steps = self.now() + 10
            return
        if not self.store_ok:
            log.info("job store available again")
        self.store_ok = True
        new: List[Event] = []
        for job, steps in loaded.values():
            for e in job_events(job, steps):
                k = f"{e['kind']}|{e['key']}"
                if k not in self.sent_keys:
                    self.sent_keys.add(k)
                    new.append(e)
        if len(self.sent_keys) > 50_000:
            self.sent_keys.clear()  # bounded memory; a few re-sends are harmless
        self.sender.add(new)
        self.cursor = cursor

    def poll_k8s(self) -> None:
        if self.k8s_get is None:
            return
        snap = k8s_snapshot(self.k8s_get)
        now_ms = int(self.now() * 1000)
        self.sender.add(k8s_events(self.k8s_prev, snap, now_ms, self.seen_ca))
        self.k8s_prev = {k: (snap[k] if snap[k] is not None else self.k8s_prev.get(k)) for k in ("podsReady", "vllmReplicas", "vllm", "gpuNode")}

    def tick(self) -> None:
        t = self.now()
        if t >= self.next_steps:
            self.poll_steps()
            self.next_steps = max(self.next_steps, t + STEPS_POLL_S)
        if t >= self.next_k8s:
            self.poll_k8s()
            self.next_k8s = t + K8S_POLL_S
        if self.sender.due(t):
            self.sender.flush(t)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    url = os.environ["INGEST_URL"]
    key = os.environ["HMAC_KEY"].encode()
    k8s = K8sClient()
    ex = Exporter(JobStore(DB_PATH), k8s.get, Sender(url, key))
    stopping = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stopping.update(now=True))
    log.info("twin exporter started")
    while not stopping["now"]:
        ex.tick()
        time.sleep(0.5)
    # Control plane is stopping: one last attempt, then exit within the grace period.
    if ex.sender.queue:
        ex.sender.backoff_until = 0
        ex.sender.flush(time.time())
    log.info("twin exporter stopped")


if __name__ == "__main__":
    main()
