"""Builds the public JSON documents and writes them to the data bucket.

Documents (all public, all redacted):
  live.json            current or most recent run, plus a heartbeat
  runs/index.json      list of recorded runs, newest first
  runs/<id>.json       full event list of one closed run
  costs.json           written by the costs function
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Protocol

from .redact import assert_public_safe, clean_events

SCHEMA_VERSION = 1
MAX_LIVE_EVENTS = 3000


class Bucket(Protocol):
    def put_object(self, **kw: Any) -> Dict[str, Any]: ...


def summarize(run_id: str, start: int, end: Optional[int], events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Small public summary for the run picker."""
    gpu_ms = 0
    cp_ms = 0
    gpu_since: Optional[int] = None
    cp_since: Optional[int] = None
    launches = 0
    failures = 0
    for e in sorted(events, key=lambda x: x["ts"]):
        k, d = e["kind"], e.get("data", {})
        if k == "gpu.instance":
            s = d.get("state")
            if s == "launching":
                launches += 1
                gpu_since = gpu_since if gpu_since is not None else e["ts"]
            elif s in ("terminated", "launch_failed") and gpu_since is not None:
                gpu_ms += e["ts"] - gpu_since
                gpu_since = None
            if s == "launch_failed":
                failures += 1
        elif k == "cp.state":
            s = d.get("state")
            if s == "pending" and cp_since is None:
                cp_since = e["ts"]
            elif s == "stopped" and cp_since is not None:
                cp_ms += e["ts"] - cp_since
                cp_since = None
    stop = end if end is not None else (events[-1]["ts"] if events else start)
    if gpu_since is not None:
        gpu_ms += max(0, stop - gpu_since)
    if cp_since is not None:
        cp_ms += max(0, stop - cp_since)
    return {
        "id": run_id,
        "start": start,
        "end": end,
        "events": len(events),
        "gpuSeconds": round(gpu_ms / 1000),
        "controlPlaneSeconds": round(cp_ms / 1000),
        "gpuLaunches": launches,
        "launchFailures": failures,
    }


def _put(bucket: Bucket, name: str, key: str, doc: Dict[str, Any], max_age: int) -> None:
    assert_public_safe(doc)
    bucket.put_object(
        Bucket=name,
        Key=key,
        Body=json.dumps(doc, separators=(",", ":")).encode("utf-8"),
        ContentType="application/json",
        CacheControl=f"public, max-age={max_age}",
    )


def live_doc(now_ms: int, run: Optional[Dict[str, Any]], open_: bool, events: List[Dict[str, Any]]) -> Dict[str, Any]:
    evs = sorted(clean_events(events), key=lambda e: (e["ts"], e["id"]))[-MAX_LIVE_EVENTS:]
    return {
        "schema": SCHEMA_VERSION,
        "generatedAt": now_ms,
        "run": {"id": run["id"], "start": run["start"], "end": run.get("end"), "open": open_} if run else None,
        "events": evs,
    }


def publish_live(bucket: Bucket, name: str, doc: Dict[str, Any]) -> None:
    _put(bucket, name, "live.json", doc, max_age=5)


def publish_run(bucket: Bucket, name: str, summary: Dict[str, Any], events: List[Dict[str, Any]]) -> None:
    doc = {"schema": SCHEMA_VERSION, "run": summary, "events": sorted(clean_events(events), key=lambda e: (e["ts"], e["id"]))}
    _put(bucket, name, f"runs/{summary['id']}.json", doc, max_age=3600)


def publish_index(bucket: Bucket, name: str, now_ms: int, summaries: List[Dict[str, Any]]) -> None:
    _put(bucket, name, "runs/index.json", {"schema": SCHEMA_VERSION, "generatedAt": now_ms, "runs": summaries}, max_age=60)


def publish_costs(bucket: Bucket, name: str, doc: Dict[str, Any]) -> None:
    _put(bucket, name, "costs.json", doc, max_age=3600)
