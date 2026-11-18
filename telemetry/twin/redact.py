"""Public-safety gate. Everything published passes through here.

Two layers:
1. Allowlist: only known kinds, known data keys, and allowed values survive.
2. Scanner: the serialised output is searched for anything that looks like an
   AWS identifier, ARN, account id, IP address or URL. A hit blocks the publish.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional

from .events import JOB_TYPES, SCHEMA

FORBIDDEN = [
    ("arn", re.compile(r"arn:aws[a-z-]*:")),
    ("account-id", re.compile(r"(?<!\d)\d{12}(?!\d)")),
    ("ec2-id", re.compile(r"\b(i|vol|subnet|vpc|sg|igw|lt|ami|eni|snap)-[0-9a-f]{8,17}\b")),
    ("ipv4", re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")),
    ("url", re.compile(r"https?://", re.I)),
    ("execute-api", re.compile(r"execute-api", re.I)),
    ("queue-url", re.compile(r"sqs\.[a-z0-9-]+\.amazonaws", re.I)),
    ("receipt-or-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    # Raw platform job ids are UUIDs; only pseudonyms (j + 10 letters) may be published.
    ("uuid", re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)),
]

_JOB_ID = re.compile(r"^j[a-z]{10}$")


class RedactionError(ValueError):
    pass


def _clean_value(spec: Any, value: Any) -> Optional[Any]:
    if isinstance(spec, set):
        return value if isinstance(value, str) and value in spec else None
    if spec is bool:
        return value if isinstance(value, bool) else None
    if spec is int:
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    if spec is float:
        return round(float(value), 3) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    if spec is str:
        # Only job types are free strings today, and they come from a fixed list.
        return value if isinstance(value, str) and value in JOB_TYPES else None
    return None


def clean_event(ev: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Returns a copy holding only allowed fields, or None if the kind is unknown."""
    kind = ev.get("kind")
    if kind not in SCHEMA:
        return None
    spec = SCHEMA[kind]
    data = {}
    for key, value in (ev.get("data") or {}).items():
        if key not in spec:
            continue
        v = _clean_value(spec[key], value)
        if v is not None:
            data[key] = v
    out: Dict[str, Any] = {
        "id": str(ev["id"]),
        "ts": int(ev["ts"]),
        "kind": kind,
        "confidence": "inferred" if ev.get("confidence") == "inferred" else "observed",
        "data": data,
    }
    job = ev.get("jobId")
    if isinstance(job, str) and _JOB_ID.match(job):
        out["jobId"] = job
    return out


def clean_events(events: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [c for c in (clean_event(e) for e in events) if c is not None]


def scan(payload: Any) -> List[str]:
    """Names of forbidden patterns found in the JSON form of `payload`."""
    text = json.dumps(payload, separators=(",", ":"))
    return [name for name, rx in FORBIDDEN if rx.search(text)]


def assert_public_safe(payload: Any) -> None:
    hits = scan(payload)
    if hits:
        raise RedactionError(f"refusing to publish: matched {', '.join(sorted(set(hits)))}")
