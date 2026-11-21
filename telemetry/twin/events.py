"""Dashboard event vocabulary, mirrored from web/src/model/events.ts.

Only these kinds and these data keys may leave the telemetry stack. Anything
else is dropped before storage (see redact.py).
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, Optional

# kind -> allowed data keys and their allowed value types / values
SCHEMA: Dict[str, Dict[str, Any]] = {
    "ingress.request": {"route": {"/jobs", "/wake", "/status", "/health"}, "jobType": str},
    "ingress.prewarm": {},
    "lambda.invoked": {"action": {"enqueue", "wake", "status"}},
    "job.enqueued": {"queue": {"workflow", "gpu"}, "jobType": str},
    "cp.state": {"state": {"pending", "running", "stopping", "stopped"}},
    "pods.ready": {"ready": bool},
    "job.dequeued": {"queue": {"workflow", "gpu"}},
    "laya.gate": {"result": {"pass", "reject", "decision"}, "probability": float},
    "keda.scale": {"replicas": int},
    "vllm.state": {"state": {"absent", "pending", "loading", "ready"}},
    "asg.desired": {"desired": int, "by": {"cluster-autoscaler", "guard", "watchdog", "observed", "unknown"}},
    "gpu.instance": {
        "state": {"launching", "running", "terminating", "terminated", "launch_failed"},
        "market": {"on-demand", "spot"},
    },
    "ebs.attached": {"attached": bool},
    "node.joined": {"joined": bool},
    "job.generate": {"attempt": int},
    "laya.verify": {"attempt": int, "passed": bool, "probability": float},
    "job.failed": {"queue": {"workflow", "gpu"}, "receiveCount": int},
    "job.dlq": {"queue": {"workflow", "gpu"}},
    "job.finished": {"outcome": {"completed", "rejected", "needs_review", "decided"}},
    "s3.result": {},
    "spot.warning": {},
    "watchdog.idle": {"idle": bool},
    "guard.latch": {"locked": bool},
    "ssm.session": {"open": bool},
    "queue.depth": {"queue": {"workflow", "gpu", "workflowDlq", "gpuDlq"}, "visible": int, "inFlight": int},
}

JOB_TYPES = {
    "tailor_cv",
    "tailor_cover_letter",
    "job_analysis",
    "application_reasoning",
    "news_summarization",
    "decision_classification",
    "general_inference",
    "hybrid_verified_task",
}


_LETTERS = str.maketrans("0123456789abcdef", "abcdefghijklmnop")


def event_id(source: str) -> str:
    """Stable, opaque id derived from the source event id (never the raw id).

    Letters only, so an id can never resemble an account number to the redaction scanner.
    """
    return "e" + hashlib.sha256(source.encode("utf-8")).hexdigest()[:16].translate(_LETTERS)


def make(
    kind: str,
    ts_ms: int,
    source_id: str,
    data: Optional[Dict[str, Any]] = None,
    confidence: str = "observed",
    job_id: Optional[str] = None,
) -> Dict[str, Any]:
    ev: Dict[str, Any] = {
        "id": event_id(f"{kind}|{source_id}"),
        "ts": int(ts_ms),
        "kind": kind,
        "confidence": confidence,
        "data": dict(data or {}),
    }
    if job_id:
        ev["jobId"] = job_id
    return ev
