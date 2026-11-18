"""Once-a-minute reading of state AWS does not push as events.

Compares fresh readings with the previous snapshot in meta["poll"] and emits a
twin event only when something changed. Pure: readings come in as arguments.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .events import make

PODS_READY_AFTER_MS = 40_000  # placeholder until an in-cluster exporter reports pod readiness


def diff(
    now_ms: int,
    meta: Dict[str, Any],
    queues: Dict[str, Dict[str, int]],
    asg: Optional[Dict[str, Any]],
    cp_state: Optional[str],
) -> List[Dict[str, Any]]:
    prev = meta.get("poll") or {}
    out: List[Dict[str, Any]] = []
    tick = str(now_ms)

    # Control plane: catch up if an EventBridge notification was missed.
    known_cp = (meta.get("cp") or {}).get("state")
    if cp_state and cp_state != known_cp:
        out.append(make("cp.state", now_ms, f"poll-cp|{tick}", {"state": cp_state}))
        known_cp = cp_state

    for name in ("workflow", "gpu", "workflowDlq", "gpuDlq"):
        q = queues.get(name)
        if q is None:
            continue
        before = (prev.get("queues") or {}).get(name)
        if before != q:
            out.append(make("queue.depth", now_ms, f"poll-q|{name}|{tick}", {"queue": name, "visible": q["visible"], "inFlight": q["inFlight"]}))

    if asg is not None:
        if prev.get("desired") != asg["desired"]:
            out.append(make("asg.desired", now_ms, f"poll-asg|{tick}", {"desired": asg["desired"], "by": "observed"}))
        if prev.get("launchSuspended") != asg["launchSuspended"]:
            out.append(make("guard.latch", now_ms, f"poll-latch|{tick}", {"locked": asg["launchSuspended"]}))

    # Inferred: platform services are ready some time after the host is running.
    cp = meta.get("cp") or {}
    if known_cp == "running" and cp.get("state") == "running" and not cp.get("podsEmitted"):
        if now_ms - cp.get("since", now_ms) >= PODS_READY_AFTER_MS:
            out.append(make("pods.ready", now_ms, f"poll-pods|{tick}", {"ready": True}, confidence="inferred"))

    return out


def snapshot(queues: Dict[str, Dict[str, int]], asg: Optional[Dict[str, Any]], prev: Dict[str, Any]) -> Dict[str, Any]:
    snap = dict(prev)
    snap["queues"] = {**(prev.get("queues") or {}), **queues}
    if asg is not None:
        snap["desired"] = asg["desired"]
        snap["launchSuspended"] = asg["launchSuspended"]
    return snap
