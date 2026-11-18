"""Lambda entry points.

telemetry_handler  EventBridge (EC2, Auto Scaling), the 1-minute schedule, and
                   batches forwarded by the ingest Lambda ({"twin": "ingest"}).
                   Runs with reserved concurrency 1 so meta updates never race.
costs_handler      Daily schedule.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from . import costs as costs_mod
from . import poll as poll_mod
from .normalize import normalize
from .publish import live_doc, publish_costs, publish_index, publish_live, publish_run, summarize
from .redact import clean_events
from .runs import assign
from .store import Store

log = logging.getLogger()
log.setLevel(logging.INFO)

MAX_CACHED_INSTANCES = 50


class Env:
    def __init__(self, env: Optional[Dict[str, str]] = None):
        e = env if env is not None else dict(os.environ)
        self.table = e["TABLE_NAME"]
        self.bucket = e["DATA_BUCKET"]
        self.cp_instance = e["CP_INSTANCE_ID"]
        self.gpu_asg_prefix = e.get("GPU_ASG_PREFIX", "personal-ai-gpu-asg-")
        self.queue_urls: Dict[str, str] = json.loads(e.get("QUEUE_URLS", "{}"))
        self.region = e.get("AWS_REGION", "eu-north-1")
        self.gpu_type = e.get("GPU_INSTANCE_TYPE", "g5.xlarge")
        self.gpu_az = e.get("GPU_AZ", "eu-north-1c")
        self.model_volume_name = e.get("MODEL_VOLUME_NAME", "personal-ai-model-cache-ebs-1c")


class Clients:
    """Lazily created boto3 clients; tests pass fakes instead."""

    def __init__(self, region: str, **fakes: Any):
        self._region = region
        self._c: Dict[str, Any] = dict(fakes)

    def _get(self, name: str, region: Optional[str] = None) -> Any:
        if name not in self._c:
            import boto3  # available in the Lambda runtime

            if name == "table":
                raise RuntimeError("table must be provided")
            self._c[name] = boto3.client(name.split(":")[0], region_name=region or self._region)
        return self._c[name]

    @property
    def ec2(self) -> Any: return self._get("ec2")
    @property
    def sqs(self) -> Any: return self._get("sqs")
    @property
    def autoscaling(self) -> Any: return self._get("autoscaling")
    @property
    def s3(self) -> Any: return self._get("s3")
    @property
    def ce(self) -> Any: return self._get("ce", "us-east-1")
    @property
    def pricing(self) -> Any: return self._get("pricing", "us-east-1")


# ---- AWS readings -----------------------------------------------------------


def lookup_instance(clients: Clients, env: Env, meta: Dict[str, Any], instance_id: str) -> Optional[Dict[str, Any]]:
    cache: Dict[str, Any] = meta.setdefault("instances", {})
    if instance_id in cache:
        return cache[instance_id]
    try:
        r = clients.ec2.describe_instances(InstanceIds=[instance_id])
        inst = r["Reservations"][0]["Instances"][0]
    except Exception as exc:  # noqa: BLE001
        log.warning("describe_instances failed: %s", type(exc).__name__)
        return None
    tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
    info = {
        "gpu": tags.get("aws:autoscaling:groupName", "").startswith(env.gpu_asg_prefix),
        "market": "spot" if inst.get("InstanceLifecycle") == "spot" else "on-demand",
    }
    cache[instance_id] = info
    if len(cache) > MAX_CACHED_INSTANCES:
        for k in list(cache)[: len(cache) - MAX_CACHED_INSTANCES]:
            del cache[k]
    return info


def read_queues(clients: Clients, env: Env) -> Dict[str, Dict[str, int]]:
    out: Dict[str, Dict[str, int]] = {}
    for name, url in env.queue_urls.items():
        try:
            a = clients.sqs.get_queue_attributes(
                QueueUrl=url, AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"]
            )["Attributes"]
            out[name] = {"visible": int(a.get("ApproximateNumberOfMessages", 0)), "inFlight": int(a.get("ApproximateNumberOfMessagesNotVisible", 0))}
        except Exception as exc:  # noqa: BLE001
            log.warning("queue read failed for %s: %s", name, type(exc).__name__)
    return out


def read_asg(clients: Clients, env: Env) -> Optional[Dict[str, Any]]:
    try:
        r = clients.autoscaling.describe_auto_scaling_groups(
            Filters=[{"Name": "tag-key", "Values": ["k8s.io/cluster-autoscaler/enabled"]}]
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("asg read failed: %s", type(exc).__name__)
        return None
    for g in r.get("AutoScalingGroups", []):
        if g["AutoScalingGroupName"].startswith(env.gpu_asg_prefix):
            suspended = {p["ProcessName"] for p in g.get("SuspendedProcesses", [])}
            return {"desired": int(g.get("DesiredCapacity", 0)), "launchSuspended": "Launch" in suspended}
    return None


def read_model_attached(clients: Clients, env: Env) -> Optional[bool]:
    """Whether the model-cache volume is attached to an instance. None if unknown.

    Exactly one volume must carry the Name tag; anything else is treated as unknown
    rather than guessed. Only the attachment state is used; no ids leave this function.
    """
    try:
        r = clients.ec2.describe_volumes(Filters=[{"Name": "tag:Name", "Values": [env.model_volume_name]}])
    except Exception as exc:  # noqa: BLE001
        log.warning("volume read failed: %s", type(exc).__name__)
        return None
    vols = r.get("Volumes", [])
    if len(vols) != 1:
        log.warning("expected one model volume, found %d", len(vols))
        return None
    return any(a.get("State") == "attached" for a in vols[0].get("Attachments", []))


def read_cp_state(clients: Clients, env: Env) -> Optional[str]:
    try:
        r = clients.ec2.describe_instances(InstanceIds=[env.cp_instance])
        state = r["Reservations"][0]["Instances"][0]["State"]["Name"]
    except Exception as exc:  # noqa: BLE001
        log.warning("cp read failed: %s", type(exc).__name__)
        return None
    return {"shutting-down": "stopping", "terminated": "stopped"}.get(state, state)


# ---- core ---------------------------------------------------------------------


def apply_events(store: Store, meta: Dict[str, Any], events: List[Dict[str, Any]]) -> List[str]:
    """Stores events in their runs and updates meta. Returns ids of runs closed."""
    closed: List[str] = []
    for ev in sorted(clean_events(events), key=lambda e: (e["ts"], e["id"])):
        if ev["kind"] == "cp.state":
            state = ev["data"].get("state")
            if (meta.get("cp") or {}).get("state") != state:
                meta["cp"] = {"state": state, "since": ev["ts"], "podsEmitted": False}
        elif ev["kind"] == "pods.ready":
            meta["cp"] = {**(meta.get("cp") or {}), "podsEmitted": True}
        rid, new_meta, closed_id = assign(meta, ev)
        meta.clear()
        meta.update(new_meta)
        if rid:
            store.put_event(rid, ev)
        if closed_id:
            closed.append(closed_id)
    return closed


def publish_all(store: Store, s3: Any, bucket: str, meta: Dict[str, Any], closed: List[str], now_ms: int) -> None:
    for rid in closed:
        last = meta.get("lastRun") or {}
        if last.get("id") != rid:
            continue
        evs = store.run_events(rid)
        summary = summarize(rid, last["start"], last["end"], evs)
        store.put_run_summary(summary)
        publish_run(s3, bucket, summary, evs)
    if closed:
        publish_index(s3, bucket, now_ms, store.run_summaries())

    open_run = meta.get("openRun")
    run = open_run or meta.get("lastRun")
    events = store.run_events(run["id"]) if run else []
    publish_live(s3, bucket, live_doc(now_ms, run, open_run is not None, events, meta.get("exporterAt")))


def handle(event: Dict[str, Any], env: Env, clients: Clients, store: Store, now_ms: Optional[int] = None) -> Dict[str, Any]:
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    meta = store.get_meta()
    events: List[Dict[str, Any]]

    if event.get("source") in ("aws.ec2", "aws.autoscaling"):
        events = normalize(event, env.cp_instance, env.gpu_asg_prefix, lambda iid: lookup_instance(clients, env, meta, iid))
    elif event.get("twin") == "poll":
        queues = read_queues(clients, env)
        asg = read_asg(clients, env)
        cp_state = read_cp_state(clients, env)
        attached = read_model_attached(clients, env)
        events = poll_mod.diff(now, meta, queues, asg, cp_state, attached)
        meta["poll"] = poll_mod.snapshot(queues, asg, meta.get("poll") or {}, attached)
    elif event.get("twin") == "ingest":
        # From the ingest Lambda: already reduced to twin events with pseudonymous job ids.
        # apply_events still runs every event through the allowlist.
        events = [e for e in event.get("events") or [] if isinstance(e, dict)]
        hb = event.get("exporterAt")
        if isinstance(hb, int) and hb > int(meta.get("exporterAt") or 0):
            meta["exporterAt"] = hb
    else:
        log.info("ignored event with source=%s", event.get("source"))
        return {"stored": 0}

    closed = apply_events(store, meta, events)
    publish_all(store, clients.s3, env.bucket, meta, closed, now)
    store.put_meta(meta)
    return {"stored": len(events), "closed": closed}


def _store_from_env(env: Env) -> Store:
    import boto3

    return Store(boto3.resource("dynamodb", region_name=env.region).Table(env.table))


def telemetry_handler(event: Dict[str, Any], _ctx: Any) -> Dict[str, Any]:
    env = Env()
    return handle(event, env, Clients(env.region), _store_from_env(env))


def costs_handler(_event: Dict[str, Any], _ctx: Any) -> Dict[str, Any]:
    env = Env()
    clients = Clients(env.region)
    cp_type = "t3.medium"  # Live type checked 2026-11-18; only used if the lookup fails
    try:
        r = clients.ec2.describe_instances(InstanceIds=[env.cp_instance])
        cp_type = r["Reservations"][0]["Instances"][0]["InstanceType"]
    except Exception as exc:  # noqa: BLE001
        log.warning("cp type read failed: %s", type(exc).__name__)
    now = int(time.time() * 1000)
    doc = costs_mod.build(
        now,
        datetime.now(timezone.utc).date(),
        clients.ce,
        clients.pricing,
        clients.ec2,
        {"gpu_type": env.gpu_type, "cp_type": cp_type, "region": env.region, "gpu_az": env.gpu_az},
    )
    publish_costs(clients.s3, env.bucket, doc)
    return {"ok": True}
