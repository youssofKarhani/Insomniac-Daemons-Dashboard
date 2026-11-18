"""Writes realistic telemetry JSON for local front-end testing, without AWS.

Drives the real handlers against the in-memory fakes from tests/fakes.py:
one finished run two hours ago, and one run in progress right now (GPU up).

    uv run python scripts/make_fixture.py ../web/public/dev-data
"""

from __future__ import annotations

import json
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from fakes import CP_ID, GPU_ID, FakeCe, FakeEc2, FakePricing, ec2_event  # noqa: E402
from test_telemetry import Q, World  # noqa: E402

from twin import costs  # noqa: E402
from twin.handlers import handle  # noqa: E402


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(out: Path) -> None:
    now = int(time.time() * 1000)
    w = World()

    def ec2(inst: str, state: str, at: int, tag: str) -> None:
        if inst == CP_ID:
            w.ec2.cp_state = state
        handle(ec2_event(inst, state, iso(at), f"{tag}-{inst}-{state}"), w.env, w.clients, w.store, now_ms=at)

    # Finished run, two hours ago.
    a = now - 2 * 3600_000
    w.poll(a - 60_000)
    w.sqs.depth[Q["workflow"]] = (1, 0)
    w.poll(a)
    ec2(CP_ID, "pending", a + 2_000, "r1")
    ec2(CP_ID, "running", a + 58_000, "r1")
    w.asg.suspended = False
    w.sqs.depth[Q["workflow"]] = (0, 0)
    w.sqs.depth[Q["gpu"]] = (0, 1)
    w.asg.desired = 1
    w.poll(a + 120_000)
    ec2(GPU_ID, "pending", a + 130_000, "r1")
    ec2(GPU_ID, "running", a + 160_000, "r1")
    w.sqs.depth[Q["gpu"]] = (0, 0)
    w.poll(a + 420_000)
    w.asg.desired = 0
    w.poll(a + 540_000)
    ec2(GPU_ID, "shutting-down", a + 545_000, "r1")
    ec2(GPU_ID, "terminated", a + 580_000, "r1")
    ec2(CP_ID, "stopping", a + 2_400_000, "r1")
    w.asg.suspended = True
    w.poll(a + 2_410_000)
    ec2(CP_ID, "stopped", a + 2_430_000, "r1")

    # Run in progress: two jobs waiting, GPU just came up.
    b = now - 5 * 60_000
    w.sqs.depth[Q["workflow"]] = (2, 0)
    w.poll(b)
    ec2(CP_ID, "pending", b + 3_000, "r2")
    ec2(CP_ID, "running", b + 60_000, "r2")
    w.asg.suspended = False
    w.sqs.depth[Q["workflow"]] = (0, 0)
    w.sqs.depth[Q["gpu"]] = (1, 1)
    w.asg.desired = 1
    w.poll(b + 120_000)
    ec2(GPU_ID, "pending", b + 135_000, "r2")
    ec2(GPU_ID, "running", b + 170_000, "r2")
    w.poll(now)

    w.s3.objects["costs.json"] = costs.build(
        now,
        date.today(),
        FakeCe(),
        FakePricing(),
        FakeEc2(),
        {"gpu_type": "g5.xlarge", "cp_type": "t3.medium", "region": "eu-north-1", "gpu_az": "eu-north-1c"},
    )
    w.assert_safe()

    for key, doc in w.s3.objects.items():
        p = out / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(doc), encoding="utf-8")
        print("wrote", p.relative_to(out.parent))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
