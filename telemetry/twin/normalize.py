"""Turns raw AWS EventBridge events into twin events. Pure functions.

Identifiers from the source event are used only to decide *which* component an
event belongs to; they are never copied into the twin event.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from .events import make

CP_STATES = {
    "pending": "pending",
    "running": "running",
    "stopping": "stopping",
    "stopped": "stopped",
    "shutting-down": "stopping",
    "terminated": "stopped",
}

GPU_STATES = {
    "pending": "launching",
    "running": "running",
    "shutting-down": "terminating",
    "terminated": "terminated",
}

# Looks up an EC2 instance id; returns {"gpu": bool, "market": "spot"|"on-demand"} or None.
InstanceLookup = Callable[[str], Optional[Dict[str, Any]]]


def event_time_ms(raw: Dict[str, Any]) -> int:
    t = raw.get("time")
    if isinstance(t, str):
        return int(datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() * 1000)
    raise ValueError("event has no time")


def normalize(raw: Dict[str, Any], cp_instance_id: str, gpu_asg_prefix: str, lookup: InstanceLookup) -> List[Dict[str, Any]]:
    source = raw.get("source")
    detail_type = raw.get("detail-type")
    detail = raw.get("detail") or {}
    src_id = str(raw.get("id", ""))
    ts = event_time_ms(raw)

    if source == "aws.ec2" and detail_type == "EC2 Instance State-change Notification":
        instance = detail.get("instance-id", "")
        state = detail.get("state", "")
        if instance and instance == cp_instance_id:
            mapped = CP_STATES.get(state)
            return [make("cp.state", ts, src_id, {"state": mapped})] if mapped else []
        info = lookup(instance) if instance else None
        if info and info.get("gpu"):
            mapped = GPU_STATES.get(state)
            if not mapped:
                return []
            return [make("gpu.instance", ts, src_id, {"state": mapped, "market": info.get("market", "on-demand")})]
        return []

    if source == "aws.ec2" and detail_type == "EC2 Spot Instance Interruption Warning":
        info = lookup(detail.get("instance-id", ""))
        return [make("spot.warning", ts, src_id)] if info and info.get("gpu") else []

    if source == "aws.autoscaling" and detail_type == "EC2 Instance Launch Unsuccessful":
        group = detail.get("AutoScalingGroupName", "")
        if group.startswith(gpu_asg_prefix):
            return [make("gpu.instance", ts, src_id, {"state": "launch_failed"})]
        return []

    return []
