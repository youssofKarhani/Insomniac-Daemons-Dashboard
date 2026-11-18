"""In-memory stand-ins for the AWS clients the telemetry code uses."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

CP_ID = "i-0aaaabbbbccccdddd"
GPU_ID = "i-0eeeeffff11112222"
OTHER_ID = "i-0333344445555666"
ACCOUNT = "111122223333"


class FakeTable:
    def __init__(self) -> None:
        self.items: Dict[tuple, Dict[str, Any]] = {}

    def get_item(self, Key: Dict[str, str]) -> Dict[str, Any]:
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": item} if item else {}

    def put_item(self, Item: Dict[str, Any]) -> Dict[str, Any]:
        self.items[(Item["pk"], Item["sk"])] = Item
        return {}

    def query(self, KeyConditionExpression: str, ExpressionAttributeValues: Dict[str, str], ScanIndexForward: bool = True, Limit: Optional[int] = None, ExclusiveStartKey: Any = None) -> Dict[str, Any]:
        pk = ExpressionAttributeValues[":p"]
        prefix = ExpressionAttributeValues.get(":e", "")
        rows = sorted(
            (v for (p, s), v in self.items.items() if p == pk and s.startswith(prefix)),
            key=lambda i: i["sk"],
            reverse=not ScanIndexForward,
        )
        return {"Items": rows[:Limit] if Limit else rows}


class FakeBucket:
    def __init__(self) -> None:
        self.objects: Dict[str, Any] = {}

    def put_object(self, Bucket: str, Key: str, Body: bytes, **_: Any) -> Dict[str, Any]:
        self.objects[Key] = json.loads(Body)
        return {}


class FakeEc2:
    def __init__(self) -> None:
        self.cp_state = "stopped"
        self.instances = {
            CP_ID: {"InstanceType": "t3.medium", "Tags": [{"Key": "Name", "Value": "personal-ai-k3s-control-plane"}]},
            GPU_ID: {
                "InstanceType": "g5.xlarge",
                "Tags": [{"Key": "aws:autoscaling:groupName", "Value": "personal-ai-gpu-asg-20261013"}],
            },
            OTHER_ID: {"InstanceType": "t3.micro", "Tags": [{"Key": "Name", "Value": "unrelated"}]},
        }

    def describe_instances(self, InstanceIds: List[str]) -> Dict[str, Any]:
        iid = InstanceIds[0]
        inst = dict(self.instances[iid])
        inst["InstanceId"] = iid
        inst["State"] = {"Name": self.cp_state if iid == CP_ID else "running"}
        inst["PrivateIpAddress"] = "10.0.1.15"
        return {"Reservations": [{"Instances": [inst]}]}

    def describe_spot_price_history(self, **_: Any) -> Dict[str, Any]:
        return {"SpotPriceHistory": [{"SpotPrice": "0.3712"}]}


class FakeSqs:
    def __init__(self) -> None:
        self.depth: Dict[str, tuple] = {}

    def get_queue_attributes(self, QueueUrl: str, AttributeNames: List[str]) -> Dict[str, Any]:
        v, f = self.depth.get(QueueUrl, (0, 0))
        return {"Attributes": {"ApproximateNumberOfMessages": str(v), "ApproximateNumberOfMessagesNotVisible": str(f)}}


class FakeAsg:
    def __init__(self) -> None:
        self.desired = 0
        self.suspended = True

    def describe_auto_scaling_groups(self, **_: Any) -> Dict[str, Any]:
        return {
            "AutoScalingGroups": [
                {
                    "AutoScalingGroupName": "personal-ai-gpu-asg-20261013",
                    "AutoScalingGroupARN": f"arn:aws:autoscaling:eu-north-1:{ACCOUNT}:autoScalingGroup:x",
                    "DesiredCapacity": self.desired,
                    "SuspendedProcesses": [{"ProcessName": "Launch"}] if self.suspended else [],
                }
            ]
        }


class AccessDenied(Exception):
    def __init__(self) -> None:
        super().__init__(f"User: arn:aws:iam::{ACCOUNT}:user/me is not authorized")
        self.response = {"Error": {"Code": "AccessDeniedException", "Message": str(self)}}


class FakeCe:
    def __init__(self, deny: bool = False) -> None:
        self.deny = deny
        self.calls: List[Dict[str, Any]] = []

    def get_cost_and_usage(self, Granularity: str, **kw: Any) -> Dict[str, Any]:
        self.calls.append({"Granularity": Granularity, **kw})
        if self.deny:
            raise AccessDenied()

        def g(keys: List[str], amount: str) -> Dict[str, Any]:
            return {"Keys": keys, "Metrics": {"UnblendedCost": {"Amount": amount, "Unit": "USD"}}}

        group_keys = [x["Key"] for x in kw.get("GroupBy", [])]
        if Granularity == "MONTHLY" and group_keys == ["USAGE_TYPE"]:
            return {
                "ResultsByTime": [
                    {
                        "TimePeriod": {"Start": "2026-10-01"},
                        "Groups": [
                            g(["EUN1-BoxUsage:g5.xlarge"], "8.50"),
                            g(["EUN1-BoxUsage:t3.medium"], "0.62"),
                            g(["EUN1-EBS:VolumeUsage.gp3"], "3.90"),
                            g(["EUN1-EBS:SnapshotUsage"], "0.30"),
                        ],
                    },
                    {"TimePeriod": {"Start": "2026-11-01"}, "Groups": [g(["EUN1-BoxUsage:g5.xlarge"], "3.5")]},
                ]
            }
        if Granularity == "MONTHLY":
            return {
                "ResultsByTime": [
                    {
                        "TimePeriod": {"Start": "2026-10-01"},
                        "Groups": [
                            g(["Amazon Elastic Compute Cloud - Compute", "Usage"], "9.12"),
                            g(["EC2 - Other", "Usage"], "4.20"),
                            g(["Amazon Elastic Compute Cloud - Compute", "Credit"], "-9.12"),
                            g(["EC2 - Other", "Credit"], "-4.20"),
                        ],
                    },
                    {"TimePeriod": {"Start": "2026-11-01"}, "Groups": [g(["Amazon Elastic Compute Cloud - Compute", "Usage"], "3.5")]},
                ]
            }
        return {"ResultsByTime": [{"TimePeriod": {"Start": "2026-11-01"}, "Total": {"UnblendedCost": {"Amount": "0.21"}}}]}


class FakePricing:
    def get_products(self, Filters: List[Dict[str, str]], **_: Any) -> Dict[str, Any]:
        itype = next(f["Value"] for f in Filters if f["Field"] == "instanceType")
        usd = {"g5.xlarge": "1.0920000000", "t3.medium": "0.0432000000"}.get(itype, "0.01")
        product = {"terms": {"OnDemand": {"x": {"priceDimensions": {"y": {"pricePerUnit": {"USD": usd}}}}}}}
        return {"PriceList": [json.dumps(product)]}


def ec2_event(instance: str, state: str, time: str, eid: str) -> Dict[str, Any]:
    return {
        "id": eid,
        "source": "aws.ec2",
        "detail-type": "EC2 Instance State-change Notification",
        "account": ACCOUNT,
        "region": "eu-north-1",
        "time": time,
        "resources": [f"arn:aws:ec2:eu-north-1:{ACCOUNT}:instance/{instance}"],
        "detail": {"instance-id": instance, "state": state},
    }
