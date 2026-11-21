"""Ingest Lambda: authentication, reduction to dashboard events, pseudonyms, hand-off."""

from __future__ import annotations

import base64
import gzip
import json
import re
from typing import Any, Dict, List

from twin import ingest
from twin.handlers import handle as telemetry_handle
from twin.redact import scan

from test_telemetry import T0, World

KEY = "k" * 40
SALT = "s" * 40
RAW_JOB = "3f2b9c1e-8d4a-4f6b-9a2e-1c7d5e8f0a3b"
PSEUDO = re.compile(r"^j[a-z]{10}$")


def secrets(key: str = KEY, salt: str = SALT) -> ingest.Secrets:
    values = {"h": key, "s": salt}
    return ingest.Secrets(lambda n: values[n], "h", "s")


class Sink:
    def __init__(self) -> None:
        self.msgs: List[Dict[str, Any]] = []

    def __call__(self, msg: Dict[str, Any]) -> None:
        self.msgs.append(json.loads(json.dumps(msg)))  # as it would cross the wire

    @property
    def events(self) -> List[Dict[str, Any]]:
        return [e for m in self.msgs for e in m["events"]]


def url_event(body: bytes, headers: Dict[str, str], method: str = "POST") -> Dict[str, Any]:
    return {"requestContext": {"http": {"method": method}}, "headers": {k.lower(): v for k, v in headers.items()}, "body": body.decode(), "isBase64Encoded": False}


def batch(*events: Dict[str, Any]) -> bytes:
    return json.dumps({"v": 1, "events": list(events)}).encode()


STEP_EVENTS = [
    {"kind": "job.dequeued", "ts": T0 + 1000, "key": f"{RAW_JOB}|step_validation|1|VALIDATING", "job": RAW_JOB, "data": {"queue": "workflow"}},
    {"kind": "laya.gate", "ts": T0 + 2000, "key": f"{RAW_JOB}|step_gpu_dispatch|1|WAITING_GPU", "job": RAW_JOB, "data": {"result": "pass"}},
    {"kind": "not.a.kind", "ts": T0 + 2000, "key": "x", "data": {}},
    {"kind": "job.enqueued", "ts": T0 + 2001, "key": f"{RAW_JOB}|gpu", "job": RAW_JOB, "data": {"queue": "gpu", "payload": "secret text"}},
]


def send(body: bytes, now: int = T0 + 5000, sink: Sink | None = None, sec: ingest.Secrets | None = None) -> Dict[str, Any]:
    s = sink if sink is not None else Sink()
    return ingest.handle(url_event(body, ingest.sign(KEY.encode(), body, now)), sec or secrets(), s, now_ms=now)


def logs_event(*messages: str, ts: int = T0 + 1000, kind: str = "DATA_MESSAGE") -> Dict[str, Any]:
    doc = {
        "messageType": kind,
        "logGroup": "/aws/lambda/wake",
        "logEvents": [{"id": f"le{i}", "timestamp": ts + i, "message": m} for i, m in enumerate(messages)],
    }
    return {"awslogs": {"data": base64.b64encode(gzip.compress(json.dumps(doc).encode())).decode()}}


# ---- authentication ---------------------------------------------------------------


def test_rejects_bad_or_stale_signatures_and_wrong_methods() -> None:
    body = batch(*STEP_EVENTS)
    sink = Sink()
    now = T0 + 5000
    good = ingest.sign(KEY.encode(), body, now)
    assert ingest.handle(url_event(body, {**good, "X-Twin-Signature": "0" * 64}), secrets(), sink, now_ms=now)["statusCode"] == 401
    stale = ingest.sign(KEY.encode(), body, now - 6 * 60_000)
    assert ingest.handle(url_event(body, stale), secrets(), sink, now_ms=now)["statusCode"] == 401
    assert ingest.handle(url_event(body + b" ", good), secrets(), sink, now_ms=now)["statusCode"] == 401  # body changed
    assert ingest.handle(url_event(body, good, method="GET"), secrets(), sink, now_ms=now)["statusCode"] == 405
    big = b"x" * (ingest.MAX_BODY_BYTES + 1)
    assert ingest.handle(url_event(big, ingest.sign(KEY.encode(), big, now)), secrets(), sink, now_ms=now)["statusCode"] == 413
    assert sink.msgs == []


def test_refuses_everything_until_secrets_are_set() -> None:
    sink = Sink()
    assert send(batch(*STEP_EVENTS), sink=sink, sec=secrets(key=ingest.UNSET))["statusCode"] == 503
    assert ingest.handle(logs_event("Triggering StartInstances for x..."), secrets(salt="short"), sink)["statusCode"] == 503
    assert sink.msgs == []


def test_secrets_set_after_start_take_effect_on_the_next_call() -> None:
    values = {"h": ingest.UNSET, "s": SALT}
    sec = ingest.Secrets(lambda n: values[n], "h", "s")
    assert sec.get() == (None, None)
    values["h"] = KEY
    assert sec.get() == (KEY.encode(), SALT.encode())


def test_401_body_says_nothing() -> None:
    body = batch(*STEP_EVENTS)
    r = ingest.handle(url_event(body, {"X-Twin-Timestamp": str(T0), "X-Twin-Signature": "nope"}), secrets(), Sink(), now_ms=T0)
    assert r == {"statusCode": 401, "headers": {"content-type": "application/json"}, "body": ""}


# ---- exporter batches -------------------------------------------------------------


def test_exporter_batch_becomes_allowlisted_events_with_pseudonyms() -> None:
    sink = Sink()
    r = send(batch(*STEP_EVENTS), sink=sink)
    assert r["statusCode"] == 202 and json.loads(r["body"]) == {"accepted": 3}
    evs = sink.events
    assert [e["kind"] for e in evs] == ["job.dequeued", "laya.gate", "job.enqueued"]
    assert {e["jobId"] for e in evs} == {ingest.pseudonym(SALT.encode(), RAW_JOB)}
    assert all(PSEUDO.match(e["jobId"]) for e in evs)
    text = json.dumps(sink.msgs)
    assert RAW_JOB not in text and "step_validation" not in text and "WAITING_GPU" not in text
    assert sink.msgs[0]["exporterAt"] == T0 + 5000


def test_resending_a_batch_gives_identical_ids() -> None:
    a, b = Sink(), Sink()
    send(batch(*STEP_EVENTS), sink=a)
    send(batch(*STEP_EVENTS), now=T0 + 65_000, sink=b)
    assert [e["id"] for e in a.events] == [e["id"] for e in b.events]


def test_drops_old_and_malformed_events_and_rejects_bad_batches() -> None:
    sink = Sink()
    old = {**STEP_EVENTS[0], "ts": T0 - 25 * 3600_000}
    nokey = {k: v for k, v in STEP_EVENTS[0].items() if k != "key"}
    assert json.loads(send(batch(old, nokey, "nonsense"), sink=sink)["body"]) == {"accepted": 0}
    assert sink.msgs[0]["events"] == [] and "exporterAt" in sink.msgs[0]  # heartbeat still counts
    assert send(b'{"v": 2, "events": []}')["statusCode"] == 400
    assert send(b"not json")["statusCode"] == 400


def test_heartbeat_only_batch_is_forwarded() -> None:
    sink = Sink()
    send(batch(), sink=sink)
    assert sink.msgs == [{"twin": "ingest", "events": [], "exporterAt": T0 + 5000}]


# ---- wake Lambda log lines ---------------------------------------------------------


def test_log_phrases_map_to_events_and_job_ids_match_the_exporter() -> None:
    sink = Sink()
    ev = logs_event(
        "[INFO]\t2026-11-17T10:00:00Z\treq\tHandling EventBridge scheduled pre-warm: Scheduled Event",
        f"[INFO]\t2026-11-17T10:00:00Z\treq\tJob {RAW_JOB} successfully pushed to SQS https://sqs.eu-north-1.amazonaws.com/111122223333/personal-ai-ai-jobs",
        "[INFO]\t...\tTriggering StartInstances for i-0aaaabbbbccccdddd...",
        "[INFO]\t...\tEventBridge guard: Scaling down GPU ASG personal-ai-gpu-asg-20261013 to desired=0 and suspending launch processes...",
        "[INFO]\t...\t✓ Resumed Launch and ReplaceUnhealthy on GPU ASG personal-ai-gpu-asg-20261013",
    )
    assert ingest.handle(ev, secrets(), sink, now_ms=T0 + 5000) == {"accepted": 8}
    kinds = [e["kind"] for e in sink.events]
    assert kinds == ["ingress.prewarm", "ingress.request", "lambda.invoked", "job.enqueued", "lambda.invoked", "asg.desired", "guard.latch", "guard.latch"]
    enq = next(e for e in sink.events if e["kind"] == "job.enqueued")
    assert enq["jobId"] == ingest.pseudonym(SALT.encode(), RAW_JOB)
    assert "exporterAt" not in sink.msgs[0]
    text = json.dumps(sink.msgs)
    for lit in (RAW_JOB, "111122223333", "i-0aaaabbbbccccdddd", "personal-ai-gpu-asg", "https://"):
        assert lit not in text
    assert scan(sink.msgs) == []


def test_log_lines_that_must_never_be_used() -> None:
    sink = Sink()
    ev = logs_event(
        'Received event: {"body": "Job x successfully pushed to SQS", "headers": {"x-forwarded-for": "203.0.113.9"}}',
        "Control plane i-0aaaabbbbccccdddd current state: running (ip: 203.0.113.9) Triggering StartInstances",
        "[ERROR]\tFailed: EventBridge guard: Scaling down arn:aws:autoscaling:eu-north-1:111122223333:x",
        "Some other line",
    )
    assert ingest.handle(ev, secrets(), sink, now_ms=T0 + 5000) == {"accepted": 0}
    assert sink.msgs == []
    assert ingest.handle(logs_event(kind="CONTROL_MESSAGE"), secrets(), sink, now_ms=T0 + 5000) == {"accepted": 0}


def test_subscription_filter_in_terraform_matches_the_parser() -> None:
    from pathlib import Path

    tf = (Path(__file__).resolve().parents[2] / "infra" / "ingest.tf").read_text(encoding="utf-8")
    m = re.search(r'wake_filter_phrases\s*=\s*\[(.*?)\]', tf, re.S)
    assert m, "wake_filter_phrases not found in infra/ingest.tf"
    in_tf = re.findall(r'"([^"]+)"', m.group(1))
    assert sorted(in_tf) == sorted(ingest.FILTER_PHRASES)
    assert not any(c in p for p in in_tf for c in ":-\"?"), "CloudWatch filter terms must avoid : - \" ?"


# ---- hand-off to the telemetry Lambda -------------------------------------------


def test_forwarded_events_land_in_the_run_and_live_json_stays_safe() -> None:
    w = World()
    w.poll(T0)  # asleep baseline
    sink = Sink()
    ingest.handle(logs_event(f"Job {RAW_JOB} successfully pushed to SQS https://sqs.x/111122223333/q", ts=T0 + 1000), secrets(), sink, now_ms=T0 + 2000)
    send(batch(*STEP_EVENTS), now=T0 + 5000, sink=sink)
    for msg in sink.msgs:
        telemetry_handle(msg, w.env, w.clients, w.store, now_ms=T0 + 6000)
    live = w.s3.objects["live.json"]
    assert live["run"]["open"] is True  # the log line's job.enqueued opened the run
    assert live["exporterAt"] == T0 + 5000
    jobs = {e.get("jobId") for e in live["events"]} - {None}
    assert jobs == {ingest.pseudonym(SALT.encode(), RAW_JOB)}
    w.assert_safe()
    assert RAW_JOB not in json.dumps(w.s3.objects)


def test_pods_inference_is_skipped_while_the_exporter_reports() -> None:
    w = World()
    w.ec2.cp_state = "running"
    w.poll(T0)
    telemetry_handle({"twin": "ingest", "events": [], "exporterAt": T0 + 30_000}, w.env, w.clients, w.store, now_ms=T0 + 30_000)
    w.poll(T0 + 60_000)
    kinds = [e["kind"] for e in w.s3.objects["live.json"]["events"]]
    assert "pods.ready" not in kinds
    # Exporter goes quiet for over 3 minutes: the inference comes back as a fallback.
    w.poll(T0 + 300_000)
    pods = [e for e in w.s3.objects["live.json"]["events"] if e["kind"] == "pods.ready"]
    assert pods and pods[0]["confidence"] == "inferred"
