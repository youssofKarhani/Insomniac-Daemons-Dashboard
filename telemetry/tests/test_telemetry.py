from __future__ import annotations

import json
from datetime import date

import pytest

from twin import costs
from twin.events import make
from twin.handlers import Clients, Env, handle
from twin.publish import publish_costs
from twin.redact import RedactionError, assert_public_safe, clean_event, scan
from twin.runs import ATTACH_WINDOW_MS, assign
from twin.store import Store

from fakes import (
    ACCOUNT,
    CP_ID,
    GPU_ID,
    OTHER_ID,
    FakeAsg,
    FakeBucket,
    FakeCe,
    FakeEc2,
    FakePricing,
    FakeSqs,
    FakeTable,
    ec2_event,
)

Q = {
    "workflow": "https://sqs.eu-north-1.amazonaws.com/111122223333/personal-ai-ai-jobs",
    "gpu": "https://sqs.eu-north-1.amazonaws.com/111122223333/personal-ai-gpu-inference-jobs",
    "workflowDlq": "https://sqs.eu-north-1.amazonaws.com/111122223333/personal-ai-ai-jobs-dlq",
    "gpuDlq": "https://sqs.eu-north-1.amazonaws.com/111122223333/personal-ai-gpu-inference-jobs-dlq",
}

FORBIDDEN_LITERALS = [CP_ID, GPU_ID, OTHER_ID, ACCOUNT, "10.0.1.15", "arn:aws", "https://", "personal-ai-gpu-asg"]


class World:
    """A fake AWS account plus the twin's storage, driven step by step."""

    def __init__(self) -> None:
        self.env = Env(
            {
                "TABLE_NAME": "twin",
                "DATA_BUCKET": "twin-data",
                "CP_INSTANCE_ID": CP_ID,
                "QUEUE_URLS": json.dumps(Q),
            }
        )
        self.ec2, self.sqs, self.asg, self.s3 = FakeEc2(), FakeSqs(), FakeAsg(), FakeBucket()
        self.clients = Clients("eu-north-1", ec2=self.ec2, sqs=self.sqs, autoscaling=self.asg, s3=self.s3)
        self.store = Store(FakeTable())

    def poll(self, ms: int) -> dict:
        return handle({"twin": "poll"}, self.env, self.clients, self.store, now_ms=ms)

    def state_change(self, instance: str, state: str, iso: str, ms: int) -> dict:
        return handle(ec2_event(instance, state, iso, f"evt-{instance}-{state}"), self.env, self.clients, self.store, now_ms=ms)

    def assert_safe(self) -> None:
        for key, doc in self.s3.objects.items():
            text = json.dumps(doc)
            for lit in FORBIDDEN_LITERALS:
                assert lit not in text, f"{lit} leaked into {key}"
            assert scan(doc) == [], f"{key}: {scan(doc)}"


T0 = 1_794_900_000_000  # 2026-11-17 ~ 10:00 UTC


def iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_full_cycle(w: World) -> None:
    w.poll(T0)  # asleep baseline
    w.sqs.depth[Q["workflow"]] = (1, 0)
    w.poll(T0 + 60_000)  # job arrives while asleep -> run opens
    w.ec2.cp_state = "pending"
    w.state_change(CP_ID, "pending", iso(T0 + 61_000), T0 + 61_000)
    w.ec2.cp_state = "running"
    w.state_change(CP_ID, "running", iso(T0 + 120_000), T0 + 120_000)
    w.asg.suspended = False
    w.sqs.depth[Q["workflow"]] = (0, 0)
    w.sqs.depth[Q["gpu"]] = (0, 1)
    w.asg.desired = 1
    w.poll(T0 + 180_000)  # pods inferred, GPU requested
    w.state_change(GPU_ID, "pending", iso(T0 + 190_000), T0 + 190_000)
    w.state_change(OTHER_ID, "running", iso(T0 + 195_000), T0 + 195_000)  # unrelated instance
    w.state_change(GPU_ID, "running", iso(T0 + 220_000), T0 + 220_000)
    w.sqs.depth[Q["gpu"]] = (0, 0)
    w.asg.desired = 0
    w.poll(T0 + 600_000)
    w.state_change(GPU_ID, "shutting-down", iso(T0 + 610_000), T0 + 610_000)
    w.ec2.cp_state = "stopping"
    w.state_change(CP_ID, "stopping", iso(T0 + 2_400_000), T0 + 2_400_000)
    w.asg.suspended = True
    w.ec2.cp_state = "stopped"
    w.state_change(CP_ID, "stopped", iso(T0 + 2_430_000), T0 + 2_430_000)
    w.state_change(GPU_ID, "terminated", iso(T0 + 2_440_000), T0 + 2_440_000)  # late, attaches to closed run


def test_baseline_poll_while_asleep_creates_no_run() -> None:
    w = World()
    w.poll(T0)
    live = w.s3.objects["live.json"]
    assert live["run"] is None and live["events"] == []
    assert live["generatedAt"] == T0


def test_full_cycle_records_one_run_with_expected_story() -> None:
    w = World()
    run_full_cycle(w)
    index = w.s3.objects["runs/index.json"]["runs"]
    assert len(index) == 1
    run = index[0]
    assert run["start"] == T0 + 60_000
    assert run["end"] == T0 + 2_430_000
    assert run["gpuLaunches"] == 1
    assert run["gpuSeconds"] == (2_430_000 - 190_000) // 1000  # GPU still terminating at close
    doc = w.s3.objects[f"runs/{run['id']}.json"]
    kinds = [e["kind"] for e in doc["events"]]
    assert kinds[0] == "queue.depth"
    assert "pods.ready" in kinds and "guard.latch" in kinds and "asg.desired" in kinds
    assert kinds.count("gpu.instance") == 3  # launching, running, terminating (terminated arrived later)
    pods = next(e for e in doc["events"] if e["kind"] == "pods.ready")
    assert pods["confidence"] == "inferred"
    # Late termination attached to the same run in storage and shows in live.json.
    live = w.s3.objects["live.json"]
    assert live["run"]["open"] is False
    assert live["events"][-1]["data"]["state"] == "terminated"


def test_nothing_identifying_is_ever_published() -> None:
    w = World()
    run_full_cycle(w)
    w.assert_safe()


def test_unrelated_instances_are_ignored() -> None:
    w = World()
    w.state_change(OTHER_ID, "running", iso(T0), T0)
    assert w.s3.objects["live.json"]["events"] == []


def test_events_are_idempotent_by_source_id() -> None:
    w = World()
    w.ec2.cp_state = "pending"
    w.state_change(CP_ID, "pending", iso(T0), T0)
    w.state_change(CP_ID, "pending", iso(T0), T0 + 5)
    assert len(w.s3.objects["live.json"]["events"]) == 1


def test_late_event_outside_window_opens_nothing() -> None:
    meta = {"openRun": None, "lastRun": {"id": "r-x", "start": 0, "end": 1000}}
    ev = make("gpu.instance", 1000 + ATTACH_WINDOW_MS + 1, "s", {"state": "terminated"})
    rid, _, _ = assign(meta, ev)
    assert rid is None


def test_clean_event_keeps_only_allowed_fields() -> None:
    ev = {
        "id": "eabc",
        "ts": 1,
        "kind": "gpu.instance",
        "confidence": "observed",
        "data": {"state": "running", "market": "spot", "instanceId": GPU_ID, "ip": "10.0.0.1"},
    }
    assert clean_event(ev)["data"] == {"state": "running", "market": "spot"}
    assert clean_event({**ev, "kind": "made.up"}) is None
    assert clean_event({**ev, "data": {"state": "exploded"}})["data"] == {}


@pytest.mark.parametrize(
    "bad",
    [f"arn:aws:iam::{ACCOUNT}:role/x", ACCOUNT, "i-0123456789abcdef0", "vol-0123456789abcdef0", "13.48.1.2", "https://x.example", "abc.execute-api.eu-north-1"],
)
def test_scanner_blocks_identifiers(bad: str) -> None:
    with pytest.raises(RedactionError):
        assert_public_safe({"note": bad})


def test_costs_document() -> None:
    ce = FakeCe()
    doc = costs.build(T0, date(2026, 11, 17), ce, FakePricing(), FakeEc2(), {"gpu_type": "g5.xlarge", "cp_type": "t3.medium", "region": "eu-north-1", "gpu_az": "eu-north-1c"})
    # Credits are reported on their own so a fully credited month still shows its real usage.
    assert doc["billed"]["months"][0] == {
        "month": "2026-10",
        "total": 13.32,
        "credits": -13.32,
        "net": 0.0,
        "partial": False,
        "services": [
            {"name": "Amazon Elastic Compute Cloud - Compute", "amount": 9.12},
            {"name": "EC2 - Other", "amount": 4.2},
        ],
        "components": [
            {"name": "GPU compute", "amount": 8.5},
            {"name": "Control-plane compute", "amount": 0.62},
            {"name": "Disks", "amount": 3.9},
            {"name": "Disk snapshots", "amount": 0.3},
        ],
    }
    assert len(ce.calls) == 3
    assert all("Filter" in c for c in ce.calls if c.get("GroupBy", [{}])[0].get("Key") != "SERVICE")
    assert doc["billed"]["months"][1]["partial"] is True
    assert doc["rates"]["gpu"] == {"instanceType": "g5.xlarge", "onDemand": 1.092, "spot": 0.3712}
    assert doc["rates"]["controlPlane"]["onDemand"] == 0.0432
    bucket = FakeBucket()
    publish_costs(bucket, "b", doc)
    assert "costs.json" in bucket.objects


def test_costs_error_records_code_only() -> None:
    doc = costs.build(T0, date(2026, 11, 17), FakeCe(deny=True), FakePricing(), FakeEc2(), {"gpu_type": "g5.xlarge", "cp_type": "t3.medium", "region": "eu-north-1", "gpu_az": "eu-north-1c"})
    assert doc["billed"] == {"error": "AccessDeniedException"}
    assert_public_safe(doc)
