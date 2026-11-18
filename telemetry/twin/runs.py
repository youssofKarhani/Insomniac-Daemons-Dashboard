"""Groups events into runs. A run is one wake session of the control plane.

A run opens on the first sign of activity (control plane pending, or work
appearing in a queue while asleep) and closes when the control plane stops.
Events that arrive with no open run attach to the most recent run if it ended
recently (for example a GPU instance finishing termination), otherwise they
open a new run.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

ATTACH_WINDOW_MS = 30 * 60 * 1000


def run_id(start_ms: int) -> str:
    return "r-" + datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).strftime("%Y%m%d-%H%M%S")


def is_opener(ev: Dict[str, Any]) -> bool:
    k = ev["kind"]
    d = ev.get("data", {})
    if k == "cp.state":
        return d.get("state") in ("pending", "running")
    if k == "queue.depth":
        return (d.get("visible", 0) + d.get("inFlight", 0)) > 0 and d.get("queue") in ("workflow", "gpu")
    # GPU events never open a run: the GPU can only start from an awake control plane,
    # and a termination finishing after the control plane stopped belongs to the old run.
    return k in ("ingress.request", "ingress.prewarm", "lambda.invoked", "job.enqueued")


def is_closer(ev: Dict[str, Any]) -> bool:
    return ev["kind"] == "cp.state" and ev.get("data", {}).get("state") == "stopped"


def assign(meta: Dict[str, Any], ev: Dict[str, Any]) -> Tuple[Optional[str], Dict[str, Any], Optional[str]]:
    """Returns (run id for this event or None, updated meta, id of a run closed by this event or None).

    None as run id means the event belongs to no run (for example a baseline
    reading of empty queues while the platform sleeps); it still updates state.
    """
    meta = dict(meta)
    open_run = meta.get("openRun")
    last_run = meta.get("lastRun")
    ts = ev["ts"]

    if open_run is None:
        recent = last_run is not None and ts - last_run["end"] <= ATTACH_WINDOW_MS
        if is_opener(ev):
            open_run = {"id": run_id(ts), "start": ts}
            meta["openRun"] = open_run
        elif recent:
            return last_run["id"], meta, None
        else:
            return None, meta, None

    rid = open_run["id"]
    if is_closer(ev):
        meta["openRun"] = None
        meta["lastRun"] = {"id": rid, "start": open_run["start"], "end": ts}
        return rid, meta, rid
    return rid, meta, None
