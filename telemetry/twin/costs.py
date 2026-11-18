"""Daily cost document: billed costs from Cost Explorer plus list prices for estimates.

Cost Explorer charges $0.01 per request; this makes three per day (about $0.90/month). Errors are
recorded by error code only, because AWS error messages can contain ARNs.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from .publish import SCHEMA_VERSION

TOP_SERVICES = 6
REGION_LOCATION = {"eu-north-1": "EU (Stockholm)"}


def _code(exc: Exception) -> str:
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):
        return str(resp.get("Error", {}).get("Code", type(exc).__name__))
    return type(exc).__name__


def month_start(d: date, back: int = 0) -> date:
    y, m = d.year, d.month - back
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


CREDIT_TYPES = ["Credit", "Refund"]
# Usage only: credits and refunds are reported separately so a credit never hides real spend.
USAGE_ONLY = {"Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": CREDIT_TYPES}}}

# Cost by platform component, from usage types such as "EUN1-BoxUsage:g5.xlarge".
COMPONENTS = ["GPU compute", "Control-plane compute", "Disks", "Disk snapshots", "Data transfer", "Other"]


def component_of(usage_type: str, gpu_type: str, cp_type: str) -> str:
    u = usage_type
    if "BoxUsage" in u or "SpotUsage" in u:
        if gpu_type and u.endswith(gpu_type):
            return "GPU compute"
        if cp_type and u.endswith(cp_type):
            return "Control-plane compute"
        return "Other"
    if "CPUCredits" in u:
        return "Control-plane compute"
    if "EBS:Snapshot" in u:
        return "Disk snapshots"
    if "EBS:" in u:
        return "Disks"
    if "DataTransfer" in u or "-Bytes" in u:
        return "Data transfer"
    return "Other"


def billed(ce: Any, today: date, months: int = 6, gpu_type: str = "", cp_type: str = "") -> Dict[str, Any]:
    start = month_start(today, months - 1)
    end = today + timedelta(days=1)  # End is exclusive
    period = {"Start": start.isoformat(), "End": end.isoformat()}
    monthly = ce.get_cost_and_usage(
        TimePeriod=period,
        Granularity="MONTHLY",
        Metrics=["UnblendedCost"],
        GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}, {"Type": "DIMENSION", "Key": "RECORD_TYPE"}],
    )
    by_usage = ce.get_cost_and_usage(
        TimePeriod=period,
        Granularity="MONTHLY",
        Metrics=["UnblendedCost"],
        Filter=USAGE_ONLY,
        GroupBy=[{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
    )
    components: Dict[str, Dict[str, float]] = {}
    for r in by_usage.get("ResultsByTime", []):
        acc = components.setdefault(r["TimePeriod"]["Start"][:7], {})
        for g in r.get("Groups", []):
            name = component_of(g["Keys"][0], gpu_type, cp_type)
            acc[name] = acc.get(name, 0.0) + float(g["Metrics"]["UnblendedCost"]["Amount"])

    out_months: List[Dict[str, Any]] = []
    currency = "USD"
    for r in monthly.get("ResultsByTime", []):
        month = r["TimePeriod"]["Start"][:7]
        per_service: Dict[str, float] = {}
        credits = 0.0
        for g in r.get("Groups", []):
            amt = g["Metrics"]["UnblendedCost"]
            currency = amt.get("Unit", currency)
            keys = g["Keys"]
            value = float(amt["Amount"])
            if len(keys) > 1 and keys[1] in CREDIT_TYPES:
                credits += value
            else:
                per_service[keys[0]] = per_service.get(keys[0], 0.0) + value
        services = sorted(({"name": k, "amount": round(v, 4)} for k, v in per_service.items()), key=lambda s: -s["amount"])
        top = services[:TOP_SERVICES]
        rest = sum(s["amount"] for s in services[TOP_SERVICES:])
        if rest > 0:
            top.append({"name": "Other", "amount": round(rest, 4)})
        usage = sum(per_service.values())
        comp = components.get(month, {})
        out_months.append(
            {
                "month": month,
                "total": round(usage, 4),
                "credits": round(credits, 4),
                "net": round(usage + credits, 4),
                "partial": month == today.isoformat()[:7],
                "services": top,
                "components": [{"name": n, "amount": round(comp[n], 4)} for n in COMPONENTS if round(comp.get(n, 0.0), 4) != 0],
            }
        )

    # Daily by usage type: the month's daily totals, plus enough earlier days to
    # measure the storage floor even early in a month.
    daily_start = min(month_start(today), today - timedelta(days=FLOOR_WINDOW_DAYS + FLOOR_LAG_DAYS))
    daily = ce.get_cost_and_usage(
        TimePeriod={"Start": daily_start.isoformat(), "End": end.isoformat()},
        Granularity="DAILY",
        Metrics=["UnblendedCost"],
        Filter=USAGE_ONLY,
        GroupBy=[{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
    )
    per_day: Dict[str, Dict[str, float]] = {}
    for r in daily.get("ResultsByTime", []):
        acc = per_day.setdefault(r["TimePeriod"]["Start"], {})
        for g in r.get("Groups", []):
            name = component_of(g["Keys"][0], gpu_type, cp_type)
            acc[name] = acc.get(name, 0.0) + float(g["Metrics"]["UnblendedCost"]["Amount"])
    this_month = month_start(today).isoformat()
    days = [{"date": d, "total": round(sum(v.values()), 4)} for d, v in sorted(per_day.items()) if d >= this_month]
    return {"currency": currency, "months": out_months, "days": days, "floor": storage_floor(per_day, today)}


# The floor is measured over complete days that Cost Explorer has finished billing.
FLOOR_WINDOW_DAYS = 7
FLOOR_LAG_DAYS = 2
FLOOR_PARTS = ["Disks", "Disk snapshots"]
DAYS_PER_MONTH = 30.4


def storage_floor(per_day: Dict[str, Dict[str, float]], today: date) -> Optional[Dict[str, Any]]:
    """What the platform costs per month while fully asleep: storage billed whether awake or not.

    Measured from the last FLOOR_WINDOW_DAYS complete billed days, so it follows real
    volume and snapshot changes without needing EC2 describe permissions.
    """
    last = today - timedelta(days=FLOOR_LAG_DAYS)
    window = [(last - timedelta(days=i)).isoformat() for i in range(FLOOR_WINDOW_DAYS)]
    seen = [d for d in window if d in per_day]
    if not seen:
        return None
    parts = []
    for name in FLOOR_PARTS:
        avg = sum(per_day[d].get(name, 0.0) for d in seen) / len(seen)
        if avg > 0:
            parts.append({"name": name, "monthly": round(avg * DAYS_PER_MONTH, 2)})
    return {
        "monthly": round(sum(p["monthly"] for p in parts), 2),
        "parts": parts,
        "days": len(seen),
        "through": seen[0],
    }


def on_demand_price(pricing: Any, instance_type: str, region: str) -> Optional[float]:
    loc = REGION_LOCATION.get(region)
    if not loc:
        return None
    r = pricing.get_products(
        ServiceCode="AmazonEC2",
        Filters=[
            {"Type": "TERM_MATCH", "Field": k, "Value": v}
            for k, v in {
                "instanceType": instance_type,
                "location": loc,
                "operatingSystem": "Linux",
                "tenancy": "Shared",
                "preInstalledSw": "NA",
                "capacitystatus": "Used",
            }.items()
        ],
        MaxResults=1,
    )
    for raw in r.get("PriceList", []):
        product = json.loads(raw) if isinstance(raw, str) else raw
        for term in product.get("terms", {}).get("OnDemand", {}).values():
            for dim in term.get("priceDimensions", {}).values():
                usd = dim.get("pricePerUnit", {}).get("USD")
                if usd is not None:
                    return round(float(usd), 4)
    return None


def spot_price(ec2: Any, instance_type: str, az: str) -> Optional[float]:
    r = ec2.describe_spot_price_history(
        InstanceTypes=[instance_type], ProductDescriptions=["Linux/UNIX"], AvailabilityZone=az, MaxResults=1
    )
    h = r.get("SpotPriceHistory", [])
    return round(float(h[0]["SpotPrice"]), 4) if h else None


def build(now_ms: int, today: date, ce: Any, pricing: Any, ec2: Any, cfg: Dict[str, str]) -> Dict[str, Any]:
    doc: Dict[str, Any] = {
        "schema": SCHEMA_VERSION,
        "generatedAt": now_ms,
        "notes": "Billed figures lag up to 24 h. total is usage before credits; net is after credits and refunds.",
    }
    try:
        doc["billed"] = billed(ce, today, gpu_type=cfg["gpu_type"], cp_type=cfg["cp_type"])
    except Exception as exc:  # noqa: BLE001 - record and continue
        doc["billed"] = {"error": _code(exc)}

    rates: Dict[str, Any] = {"gpu": {"instanceType": cfg["gpu_type"]}, "controlPlane": {"instanceType": cfg["cp_type"]}}
    for key, itype in (("gpu", cfg["gpu_type"]), ("controlPlane", cfg["cp_type"])):
        try:
            rates[key]["onDemand"] = on_demand_price(pricing, itype, cfg["region"])
        except Exception as exc:  # noqa: BLE001
            rates[key]["onDemandError"] = _code(exc)
    try:
        rates["gpu"]["spot"] = spot_price(ec2, cfg["gpu_type"], cfg["gpu_az"])
    except Exception as exc:  # noqa: BLE001
        rates["gpu"]["spotError"] = _code(exc)
    doc["rates"] = rates
    return doc
