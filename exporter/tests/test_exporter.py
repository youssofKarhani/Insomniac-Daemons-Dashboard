"""Exporter tests: job-store mapping, data minimisation, K8s diffing, sending, and the full
path exporter -> ingest -> telemetry using the dashboard's real code."""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import exporter as ex
from twin import ingest
from twin.handlers import handle as telemetry_handle

from test_telemetry import T0, World

KEY, SALT = "k" * 40, "s" * 40
SECRET = "TOPSECRET"

# Copied from the platform's services/common/job_store.py (_init_db), so the test database
# has every column the exporter must never read.
SCHEMA = """
CREATE TABLE jobs (job_id TEXT PRIMARY KEY, job_type TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  current_step TEXT NOT NULL DEFAULT 'VALIDATING', payload TEXT, payload_ref TEXT, result TEXT, result_ref TEXT,
  error TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
  inference_duration_seconds REAL, verification_passed INTEGER, regeneration_count INTEGER DEFAULT 0,
  lease_owner TEXT, lease_expires_at REAL);
CREATE TABLE job_steps (job_id TEXT NOT NULL, step_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, output TEXT, error TEXT,
  PRIMARY KEY (job_id, step_id, attempt));
CREATE TABLE outbox_events (event_id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', created_at REAL NOT NULL, dispatched_at REAL);
"""


def iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


class Platform:
    """Writes rows the way the platform's record_step does (INSERT OR REPLACE)."""

    def __init__(self, path: Path) -> None:
        self.conn = sqlite3.connect(path, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.executescript(SCHEMA)

    def job(self, jid: str, job_type: str = "tailor_cv", result_ref: bool = True) -> None:
        self.conn.execute(
            "INSERT INTO jobs (job_id, job_type, model, status, payload, payload_ref, result, result_ref, error, idempotency_key, created_at)"
            " VALUES (?, ?, 'reasoning', 'running', ?, ?, ?, ?, ?, ?, ?)",
            (jid, job_type, SECRET, SECRET, SECRET, f"outputs/{SECRET}" if result_ref else None, SECRET, f"{SECRET}-{jid}", iso(T0)),
        )
        self.conn.execute("INSERT INTO outbox_events VALUES (?, 'gpu', ?, 'PENDING', 0, NULL)", (f"o-{jid}", SECRET))

    def step(self, jid: str, step: str, attempt: int, state: str, ms: int) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO job_steps VALUES (?, ?, ?, ?,"
            " COALESCE((SELECT started_at FROM job_steps WHERE job_id=? AND step_id=? AND attempt=?), ?), ?, ?, ?)",
            (jid, step, attempt, state, jid, step, attempt, iso(ms), iso(ms), json.dumps({"text": SECRET, "probability": 0.9}), SECRET),
        )


JOBS = {
    # name: (job_type, steps [(step, attempt, state, offset_ms)], expected outcome)
    "completed": ("tailor_cv", [("step_validation", 1, "VALIDATING", 1000), ("step_triage", 1, "DECIDING", 2000),
                   ("step_gpu_dispatch", 1, "WAITING_GPU", 3000), ("step_generation", 1, "GENERATING", 200_000),
                   ("step_verification", 1, "VERIFYING", 210_000), ("step_generation", 2, "GENERATING", 215_000),
                   ("step_verification", 2, "VERIFYING", 225_000), ("step_final", 1, "COMPLETED", 230_000)], "completed"),
    "rejected": ("job_analysis", [("step_validation", 1, "VALIDATING", 1000), ("step_triage", 1, "DECIDING", 2000),
                  ("step_triage", 1, "REJECTED", 2500)], "rejected"),
    "decided": ("decision_classification", [("step_validation", 1, "VALIDATING", 1000), ("step_decision", 1, "DECIDING", 2000),
                 ("step_decision", 1, "COMPLETED", 2600)], "decided"),
    "review": ("tailor_cover_letter", [("step_validation", 1, "VALIDATING", 1000), ("step_gpu_dispatch", 1, "WAITING_GPU", 3000),
                ("step_generation", 1, "GENERATING", 200_000), ("step_verification", 1, "VERIFYING", 210_000),
                ("step_final", 1, "NEEDS_REVIEW", 220_000)], "needs_review"),
    "failed": ("general_inference", [("step_validation", 1, "VALIDATING", 1000), ("step_gpu_dispatch", 1, "WAITING_GPU", 3000),
                ("step_final", 1, "FAILED", 9000)], None),
}
RAW = {name: f"{i:08x}-1111-4222-8333-{i:012x}" for i, name in enumerate(JOBS, start=1)}  # UUID-shaped like the platform's


@pytest.fixture()
def db(tmp_path: Path) -> Tuple[Path, Platform]:
    path = tmp_path / "jobs.db"
    p = Platform(path)
    for name, (jtype, steps, _) in JOBS.items():
        p.job(RAW[name], jtype, result_ref=name in ("completed", "review"))
        for step, attempt, state, off in steps:
            p.step(RAW[name], step, attempt, state, T0 + off)
    return path, p  # the platform connection stays open, as in production (keeps -wal/-shm present)


class Capture:
    def __init__(self, code: int = 202) -> None:
        self.code = code
        self.bodies: List[Tuple[bytes, Dict[str, str]]] = []

    def __call__(self, url: str, body: bytes, headers: Dict[str, str]) -> int:
        self.bodies.append((body, headers))
        return self.code


def run_exporter(path: Path) -> Capture:
    cap = Capture()
    e = ex.Exporter(ex.JobStore(str(path)), None, ex.Sender("https://ingest.invalid", KEY.encode(), post=cap), now=lambda: T0 / 1000 + 300)
    e.cursor = iso(T0 - 1)
    e.poll_steps()
    while e.sender.queue:
        assert e.sender.flush(T0 / 1000 + 300)
    return cap


def events_of(cap: Capture) -> List[Dict[str, Any]]:
    return [e for body, _ in cap.bodies for e in json.loads(body)["events"]]


# ---- data minimisation -------------------------------------------------------------


def test_sql_never_selects_private_columns() -> None:
    forbidden = {"payload", "payload_ref", "result", "error", "idempotency_key", "output", "lease_owner"}
    for sql in ex.SQLS:
        assert "*" not in sql
        select = re.search(r"SELECT (.*?) FROM", sql, re.S).group(1)
        cols = {c.strip().split()[0].replace("DISTINCT", "").strip() for c in select.split(",")}
        cols = {c for c in (x.replace("DISTINCT ", "") for x in cols) if c}
        assert not cols & forbidden, (sql, cols & forbidden)
        assert "outbox_events" not in sql
    # result_ref is read only as "is it null".
    assert "result_ref IS NOT NULL AS has_result" in ex.SQL_JOBS


def test_nothing_private_leaves_the_exporter(db: Tuple[Path, Platform]) -> None:
    cap = run_exporter(db[0])
    sent = b"".join(body for body, _ in cap.bodies).decode()
    assert SECRET not in sent and "outputs/" not in sent and "probability" not in sent


def test_opens_read_only(db: Tuple[Path, Platform]) -> None:
    conn = ex.JobStore(str(db[0]))._connect()
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("UPDATE jobs SET status = 'x'")


# ---- mapping -------------------------------------------------------------------------


def test_each_outcome_maps_to_the_expected_events(db: Tuple[Path, Platform]) -> None:
    evs = events_of(run_exporter(db[0]))
    by_job: Dict[str, List[str]] = {}
    for e in sorted(evs, key=lambda x: x["ts"]):
        by_job.setdefault(e["job"], []).append(e["kind"] + ("" if not e["data"] else "|" + ",".join(f"{k}={v}" for k, v in sorted(e["data"].items()))))
    assert by_job[RAW["rejected"]] == ["job.dequeued|queue=workflow", "laya.gate|result=reject", "job.finished|outcome=rejected"]
    assert by_job[RAW["decided"]] == ["job.dequeued|queue=workflow", "laya.gate|result=decision", "job.finished|outcome=decided"]
    assert by_job[RAW["completed"]] == [
        "job.dequeued|queue=workflow", "laya.gate|result=pass", "job.enqueued|jobType=tailor_cv,queue=gpu",
        "job.dequeued|queue=gpu", "job.generate|attempt=1", "laya.verify|attempt=1,passed=False",
        "job.generate|attempt=2", "laya.verify|attempt=2,passed=True", "s3.result", "job.finished|outcome=completed",
    ]
    assert by_job[RAW["review"]][-3:] == ["laya.verify|attempt=1,passed=False", "s3.result", "job.finished|outcome=needs_review"]
    assert by_job[RAW["failed"]][-1] == "job.failed|queue=gpu"


def test_rederiving_gives_the_same_keys_and_nothing_is_sent_twice(db: Tuple[Path, Platform]) -> None:
    path, platform = db
    cap = Capture()
    e = ex.Exporter(ex.JobStore(str(path)), None, ex.Sender("u", KEY.encode(), post=cap), now=lambda: T0 / 1000 + 300)
    e.cursor = iso(T0 - 1)
    e.poll_steps()
    first = len(e.sender.queue)
    e.cursor = iso(T0 - 1)  # as after a restart's re-send window
    e.poll_steps()
    assert len(e.sender.queue) == first
    platform.step(RAW["rejected"], "step_final", 1, "REJECTED", T0 + 400_000)  # unmapped final state: no new event
    platform.step(RAW["failed"], "step_validation", 1, "VALIDATING", T0 + 400_000)  # rewrite keeps started_at
    e.poll_steps()
    assert len(e.sender.queue) == first


def test_job_store_unavailable_is_reported_once_and_retried(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    e = ex.Exporter(ex.JobStore(str(tmp_path / "missing.db")), None, ex.Sender("u", KEY.encode(), post=Capture()), now=lambda: 1000.0)
    e.poll_steps()
    e.poll_steps()
    assert e.store_ok is False and e.next_steps == 1010.0
    assert sum("job store unavailable" in r.message for r in caplog.records) == 1


# ---- Kubernetes ------------------------------------------------------------------------


def fake_k8s(state: Dict[str, Any]):
    def get(path: str, **params: str) -> Dict[str, Any]:
        if state.get("fail") == path:
            raise OSError("api down")
        if path.endswith("/personal-ai-infra/deployments"):
            return {"items": [{"metadata": {"name": n}, "spec": {"replicas": 1}, "status": {"readyReplicas": 1 if state["pods"] else 0}}
                              for n in ex.PLATFORM_DEPLOYMENTS]}
        if path.endswith("/deployments/vllm-inference"):
            return {"spec": {"replicas": state["replicas"]}}
        if path.endswith("/personal-ai-inference/pods"):
            phase = state["vllm"]
            if phase == "absent":
                return {"items": []}
            ready = "True" if phase == "ready" else "False"
            return {"items": [{"metadata": {"name": "vllm-inference-1", "creationTimestamp": "2026-11-17T10:00:00Z"},
                               "status": {"phase": "Pending" if phase == "pending" else "Running", "conditions": [{"type": "Ready", "status": ready}]}}]}
        if path == "/api/v1/nodes":
            return {"items": [{"status": {"conditions": [{"type": "Ready", "status": "True"}]}}] if state["node"] else []}
        if path.endswith("/personal-ai-inference/events"):
            return {"items": [{"metadata": {"uid": "u1"}, "count": 1, "source": {"component": "cluster-autoscaler"},
                               "lastTimestamp": "2026-11-17T10:00:05Z", "involvedObject": {"kind": "Pod"}}] if state["scaleup"] else []}
        if path == "/api/v1/events":
            return {"items": [{"metadata": {"uid": "u2"}, "count": 1, "source": {"component": "cluster-autoscaler"},
                               "lastTimestamp": "2026-11-17T10:09:00Z", "involvedObject": {"kind": "Node"}},
                              {"metadata": {"uid": "u3"}, "count": 1, "source": {"component": "kubelet"},
                               "lastTimestamp": "2026-11-17T10:09:00Z", "involvedObject": {"kind": "Node"}}] if state["scaledown"] else []}
        raise AssertionError(path)

    return get


def test_kubernetes_changes_become_events_once() -> None:
    st = {"pods": False, "replicas": 0, "vllm": "absent", "node": False, "scaleup": False, "scaledown": False}
    cap = Capture()
    e = ex.Exporter(ex.JobStore("unused"), fake_k8s(st), ex.Sender("u", KEY.encode(), post=cap), now=lambda: T0 / 1000)
    kinds = lambda: [(x["kind"], x["data"]) for x in e.sender.queue]  # noqa: E731
    e.poll_k8s()
    assert kinds() == [("pods.ready", {"ready": False}), ("keda.scale", {"replicas": 0}), ("vllm.state", {"state": "absent"}), ("node.joined", {"joined": False})]
    e.sender.queue.clear()
    e.poll_k8s()
    assert kinds() == []  # nothing changed
    st.update(pods=True, replicas=1, vllm="pending", scaleup=True)
    e.poll_k8s()
    st.update(vllm="loading", node=True)
    e.poll_k8s()
    st.update(vllm="ready")
    e.poll_k8s()
    st.update(replicas=0, vllm="absent", node=False, scaledown=True)
    e.poll_k8s()
    e.poll_k8s()  # same autoscaler events again: not repeated
    assert kinds() == [
        ("pods.ready", {"ready": True}), ("keda.scale", {"replicas": 1}), ("vllm.state", {"state": "pending"}),
        ("asg.desired", {"desired": 1, "by": "cluster-autoscaler"}),
        ("vllm.state", {"state": "loading"}), ("node.joined", {"joined": True}),
        ("vllm.state", {"state": "ready"}),
        ("keda.scale", {"replicas": 0}), ("vllm.state", {"state": "absent"}), ("node.joined", {"joined": False}),
        ("asg.desired", {"desired": 0, "by": "cluster-autoscaler"}),
    ]


def test_failed_kubernetes_read_is_unknown_not_a_change() -> None:
    st = {"pods": True, "replicas": 1, "vllm": "ready", "node": True, "scaleup": False, "scaledown": False}
    e = ex.Exporter(ex.JobStore("unused"), fake_k8s(st), ex.Sender("u", KEY.encode(), post=Capture()), now=lambda: T0 / 1000)
    e.poll_k8s()
    e.sender.queue.clear()
    st["fail"] = "/api/v1/nodes"
    e.poll_k8s()
    assert e.sender.queue == []
    st.pop("fail")
    e.poll_k8s()
    assert e.sender.queue == []  # still joined: no flip-flop after the outage


# ---- sending ---------------------------------------------------------------------------


def test_signature_is_accepted_by_the_real_ingest_verifier() -> None:
    body = b'{"v":1,"events":[]}'
    assert ingest.verify(KEY.encode(), ex.sign(KEY.encode(), body, T0), body, T0)


def test_failed_send_keeps_events_and_backs_off() -> None:
    cap = Capture(code=500)
    s = ex.Sender("u", KEY.encode(), post=cap)
    s.add([ex.ev("pods.ready", T0, "k", {"ready": True})])
    assert s.due(100.0)
    assert s.flush(100.0) is False and len(s.queue) == 1
    assert not s.due(101.0) and s.due(102.0)
    s.flush(102.0)
    assert s.backoff == 8.0
    cap.code = 202
    assert s.flush(200.0) and s.queue == [] and s.backoff == 2.0


def test_heartbeat_is_sent_when_idle() -> None:
    cap = Capture()
    s = ex.Sender("u", KEY.encode(), post=cap)
    s.last_sent = 100.0
    assert not s.due(150.0) and s.due(160.0)
    s.flush(160.0)
    assert json.loads(cap.bodies[0][0]) == {"v": 1, "events": []}


def test_queue_is_capped() -> None:
    s = ex.Sender("u", KEY.encode(), post=Capture())
    s.add([ex.ev("pods.ready", T0 + i, f"k{i}", {"ready": True}) for i in range(ex.MAX_QUEUE + 10)])
    assert len(s.queue) == ex.MAX_QUEUE and s.queue[0]["key"] == "k10"


# ---- end to end: exporter -> ingest -> telemetry -> public files ---------------------


def test_full_path_into_the_dashboard(db: Tuple[Path, Platform]) -> None:
    cap = run_exporter(db[0])
    sec = ingest.Secrets(lambda n: {"h": KEY, "s": SALT}[n], "h", "s")
    forwarded: List[Dict[str, Any]] = []
    now = T0 + 300_000
    for body, headers in cap.bodies:
        url_event = {"requestContext": {"http": {"method": "POST"}}, "headers": {k.lower(): v for k, v in headers.items()},
                     "body": body.decode(), "isBase64Encoded": False}
        # Re-sign at the ingest's clock so the 5-minute window holds in the test.
        url_event["headers"] = {k.lower(): v for k, v in ex.sign(KEY.encode(), body, now).items()}
        assert ingest.handle(url_event, sec, forwarded.append, now_ms=now)["statusCode"] == 202

    w = World()
    w.ec2.cp_state = "running"
    w.poll(T0)  # tower running opens the run
    for msg in forwarded:
        telemetry_handle(json.loads(json.dumps(msg)), w.env, w.clients, w.store, now_ms=now)
    live = w.s3.objects["live.json"]
    kinds = [e["kind"] for e in live["events"]]
    assert kinds.count("job.finished") == 4 and "job.failed" in kinds and "s3.result" in kinds
    assert {e["data"]["outcome"] for e in live["events"] if e["kind"] == "job.finished"} == {"completed", "rejected", "decided", "needs_review"}
    assert len({e["jobId"] for e in live["events"] if "jobId" in e}) == 5
    assert live["exporterAt"] == now
    w.assert_safe()
    text = json.dumps(w.s3.objects)
    assert SECRET not in text and not any(raw in text for raw in RAW.values())
