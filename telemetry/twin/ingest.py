"""Ingest Lambda: the only way application-level events enter the twin.

Two inputs:
  * Exporter batches over the function URL, signed with HMAC-SHA256.
  * CloudWatch Logs subscription batches from the wake Lambda (Phase D step 3).

Both are checked, reduced to allowlisted twin events with pseudonymous job ids,
and handed to the telemetry Lambda (the single writer) by async invoke. Nothing
here writes to DynamoDB or S3, and raw job ids and log lines never leave this
module.

Exporter batch format (JSON body):
    {"v": 1, "events": [{"kind": str, "ts": ms, "key": str, "data": {...},
                         "job": str?, "confidence": "observed" | "inferred"?}]}
`key` identifies the source fact (for example "job|step|attempt|state") so a
re-sent fact gets the same event id. It may contain raw ids; it is only ever
hashed with a secret salt.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
import json
import logging
import re
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from .events import SCHEMA, make

log = logging.getLogger()

MAX_BODY_BYTES = 256 * 1024
MAX_EVENTS = 500
CLOCK_WINDOW_MS = 5 * 60 * 1000
MAX_AGE_MS = 24 * 60 * 60 * 1000
MAX_KEY_LEN = 300
FORWARD_CHUNK = 200  # events per async invoke, well under the 256 KB payload limit
UNSET = "unset"  # placeholder value of a parameter that has not been set yet

_LETTERS = str.maketrans("0123456789abcdef", "abcdefghijklmnop")


# ---- secrets ------------------------------------------------------------------


class Secrets:
    """Transport key and job salt, read from SSM and cached for a few minutes."""

    TTL_S = 300

    def __init__(self, fetch: Callable[[str], str], hmac_param: str, salt_param: str) -> None:
        self._fetch = fetch
        self._names = (hmac_param, salt_param)
        self._cache: Optional[Tuple[float, str, str]] = None

    @staticmethod
    def _usable(v: str) -> Optional[bytes]:
        return v.encode() if v and v != UNSET and len(v) >= 32 else None

    def get(self) -> Tuple[Optional[bytes], Optional[bytes]]:
        now = time.time()
        if self._cache is None or now - self._cache[0] > self.TTL_S:
            try:
                key, salt = (self._fetch(n) for n in self._names)
            except Exception as exc:  # noqa: BLE001
                log.warning("secret read failed: %s", type(exc).__name__)
                return None, None
            if self._usable(key) is None or self._usable(salt) is None:
                # Not set yet: don't cache, so setting them takes effect on the next call.
                return None, None
            self._cache = (now, key, salt)
        _, key, salt = self._cache
        return self._usable(key), self._usable(salt)


# ---- helpers ------------------------------------------------------------------


def pseudonym(salt: bytes, raw_job_id: str) -> str:
    """'j' + 10 letters. Same raw id, same pseudonym; not reversible without the salt."""
    digest = hmac.new(salt, raw_job_id.encode(), hashlib.sha256).digest()
    letters = base64.b32encode(digest).decode().lower()
    return "j" + "".join(c for c in letters if c.isalpha())[:10]


def source_key(salt: bytes, text: str) -> str:
    return hmac.new(salt, text.encode(), hashlib.sha256).hexdigest()[:32].translate(_LETTERS)


def verify(key: bytes, headers: Dict[str, str], body: bytes, now_ms: int) -> bool:
    h = {k.lower(): v for k, v in (headers or {}).items()}
    sig, ts = h.get("x-twin-signature", ""), h.get("x-twin-timestamp", "")
    if not ts.isdigit() or abs(now_ms - int(ts)) > CLOCK_WINDOW_MS:
        return False
    expected = hmac.new(key, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def sign(key: bytes, body: bytes, now_ms: int) -> Dict[str, str]:
    """Headers for a signed request. Used by the exporter and by tests."""
    ts = str(now_ms)
    return {"X-Twin-Timestamp": ts, "X-Twin-Signature": hmac.new(key, ts.encode() + b"." + body, hashlib.sha256).hexdigest()}


def _ts_ok(ts: Any, now_ms: int) -> bool:
    return isinstance(ts, int) and not isinstance(ts, bool) and now_ms - MAX_AGE_MS <= ts <= now_ms + CLOCK_WINDOW_MS


# ---- exporter batches ---------------------------------------------------------


def from_exporter(batch: Any, salt: bytes, now_ms: int) -> List[Dict[str, Any]]:
    """Twin events from one exporter batch. Anything malformed is dropped, not repaired."""
    if not isinstance(batch, dict) or batch.get("v") != 1 or not isinstance(batch.get("events"), list):
        raise ValueError("bad batch")
    out: List[Dict[str, Any]] = []
    for raw in batch["events"][:MAX_EVENTS]:
        if not isinstance(raw, dict):
            continue
        kind, ts, key = raw.get("kind"), raw.get("ts"), raw.get("key")
        if kind not in SCHEMA or not _ts_ok(ts, now_ms) or not isinstance(key, str) or not 0 < len(key) <= MAX_KEY_LEN:
            continue
        data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
        job = raw.get("job")
        job_id = pseudonym(salt, job) if isinstance(job, str) and 0 < len(job) <= 100 else None
        confidence = "inferred" if raw.get("confidence") == "inferred" else "observed"
        out.append(make(kind, ts, source_key(salt, f"x|{key}"), data, confidence=confidence, job_id=job_id))
    return out


# ---- wake Lambda log lines ----------------------------------------------------

# Fixed phrases written by the platform's wake Lambda. Nothing else in a log line is used.
_PUSHED = re.compile(r"\bJob (\S{1,100}) successfully pushed to SQS\b")
LOG_RULES: List[Tuple[str, List[Tuple[str, Dict[str, Any]]]]] = [
    ("Handling EventBridge scheduled pre-warm", [("ingress.prewarm", {})]),
    ("Triggering StartInstances", [("lambda.invoked", {"action": "wake"})]),
    ("EventBridge guard: Scaling down", [("asg.desired", {"desired": 0, "by": "guard"}), ("guard.latch", {"locked": True})]),
    ("Resumed Launch and ReplaceUnhealthy", [("guard.latch", {"locked": False})]),
]
# Lines that must never be used even if they contain a phrase above.
_NEVER = ("Received event:", "(ip:", "ERROR")


def from_log_line(message: str, ts: int, log_event_id: str, salt: bytes) -> List[Dict[str, Any]]:
    if any(n in message for n in _NEVER):
        return []
    src = lambda kind: source_key(salt, f"l|{log_event_id}|{kind}")  # noqa: E731
    m = _PUSHED.search(message)
    if m:
        job_id = pseudonym(salt, m.group(1))
        return [
            make("ingress.request", ts, src("ingress.request"), {"route": "/jobs"}, job_id=job_id),
            make("lambda.invoked", ts, src("lambda.invoked"), {"action": "enqueue"}, job_id=job_id),
            make("job.enqueued", ts + 1, src("job.enqueued"), {"queue": "workflow"}, job_id=job_id),
        ]
    for phrase, produced in LOG_RULES:
        if phrase in message:
            return [make(kind, ts + i, src(kind), data) for i, (kind, data) in enumerate(produced)]
    return []


def from_logs(awslogs_data: str, salt: bytes, now_ms: int) -> List[Dict[str, Any]]:
    doc = json.loads(gzip.decompress(base64.b64decode(awslogs_data)))
    if doc.get("messageType") != "DATA_MESSAGE":
        return []  # CONTROL_MESSAGE when the subscription is created
    out: List[Dict[str, Any]] = []
    for le in doc.get("logEvents", [])[:MAX_EVENTS]:
        ts = le.get("timestamp")
        if _ts_ok(ts, now_ms):
            out.extend(from_log_line(str(le.get("message", "")), ts, str(le.get("id", "")), salt))
    return out


# ---- entry point --------------------------------------------------------------


def _resp(code: int, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"statusCode": code, "headers": {"content-type": "application/json"}, "body": json.dumps(body) if body else ""}


def handle(event: Dict[str, Any], secrets: Secrets, forward: Callable[[Dict[str, Any]], None], now_ms: Optional[int] = None) -> Dict[str, Any]:
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    key, salt = secrets.get()
    if key is None or salt is None:
        log.warning("ingest secrets not set; rejecting")
        return _resp(503)

    # CloudWatch Logs subscription: authenticated by the Lambda permission, not by HMAC.
    if "awslogs" in event:
        try:
            events = from_logs(event["awslogs"]["data"], salt, now)
        except Exception as exc:  # noqa: BLE001
            log.warning("bad log batch: %s", type(exc).__name__)
            return {"accepted": 0}
        _send(forward, events, heartbeat=None)
        return {"accepted": len(events)}

    # Function URL request from the exporter.
    method = (event.get("requestContext") or {}).get("http", {}).get("method")
    if method != "POST":
        return _resp(405)
    body_s = event.get("body") or ""
    try:
        body = base64.b64decode(body_s) if event.get("isBase64Encoded") else body_s.encode()
    except Exception:  # noqa: BLE001
        return _resp(400)
    if len(body) > MAX_BODY_BYTES:
        return _resp(413)
    if not verify(key, event.get("headers") or {}, body, now):
        return _resp(401)
    try:
        events = from_exporter(json.loads(body), salt, now)
    except Exception:  # noqa: BLE001
        return _resp(400)
    _send(forward, events, heartbeat=now)
    return _resp(202, {"accepted": len(events)})


def _send(forward: Callable[[Dict[str, Any]], None], events: List[Dict[str, Any]], heartbeat: Optional[int]) -> None:
    if not events and heartbeat is None:
        return
    chunks = [events[i : i + FORWARD_CHUNK] for i in range(0, len(events), FORWARD_CHUNK)] or [[]]
    for i, chunk in enumerate(chunks):
        msg: Dict[str, Any] = {"twin": "ingest", "events": chunk}
        if heartbeat is not None and i == 0:
            msg["exporterAt"] = heartbeat
        forward(msg)


# ---- Lambda wiring ------------------------------------------------------------

_secrets: Optional[Secrets] = None


def lambda_handler(event: Dict[str, Any], _ctx: Any) -> Dict[str, Any]:
    import os

    import boto3

    global _secrets
    region = os.environ.get("AWS_REGION", "eu-north-1")
    if _secrets is None:
        ssm = boto3.client("ssm", region_name=region)
        fetch = lambda name: ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]  # noqa: E731
        _secrets = Secrets(fetch, os.environ["INGEST_HMAC_PARAM"], os.environ["JOB_SALT_PARAM"])
    lam = boto3.client("lambda", region_name=region)
    target = os.environ["TELEMETRY_FUNCTION"]

    def forward(msg: Dict[str, Any]) -> None:
        lam.invoke(FunctionName=target, InvocationType="Event", Payload=json.dumps(msg).encode())

    return handle(event, _secrets, forward)
