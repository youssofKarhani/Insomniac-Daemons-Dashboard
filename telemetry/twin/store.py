"""DynamoDB storage for events, runs and the stack's own bookkeeping.

Table layout (single table, on-demand):
  pk = "META",      sk = "meta"                 bookkeeping (private; may hold resource ids)
  pk = "RUN#<id>",  sk = "EV#<ts:013d>#<id>"    one dashboard event (already cleaned)
  pk = "RUNS",      sk = "<start:013d>#<id>"    run summary
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Dict, List, Optional, Protocol


class Table(Protocol):
    def get_item(self, **kw: Any) -> Dict[str, Any]: ...
    def put_item(self, **kw: Any) -> Dict[str, Any]: ...
    def query(self, **kw: Any) -> Dict[str, Any]: ...


def _to_json(item: Any) -> Any:
    # DynamoDB returns Decimals; events are stored as a JSON string to avoid that entirely.
    if isinstance(item, Decimal):
        return int(item) if item == int(item) else float(item)
    return item


class Store:
    def __init__(self, table: Table):
        self.t = table

    # ---- meta ----
    def get_meta(self) -> Dict[str, Any]:
        r = self.t.get_item(Key={"pk": "META", "sk": "meta"})
        item = r.get("Item")
        return json.loads(item["body"]) if item else {"openRun": None, "lastRun": None, "poll": {}, "instances": {}}

    def put_meta(self, meta: Dict[str, Any]) -> None:
        self.t.put_item(Item={"pk": "META", "sk": "meta", "body": json.dumps(meta)})

    # ---- events ----
    def put_event(self, run: str, ev: Dict[str, Any]) -> None:
        self.t.put_item(
            Item={"pk": f"RUN#{run}", "sk": f"EV#{ev['ts']:013d}#{ev['id']}", "body": json.dumps(ev)},
        )

    def run_events(self, run: str, limit: int = 5000) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        kw: Dict[str, Any] = {
            "KeyConditionExpression": "pk = :p AND begins_with(sk, :e)",
            "ExpressionAttributeValues": {":p": f"RUN#{run}", ":e": "EV#"},
        }
        while True:
            r = self.t.query(**kw)
            out.extend(json.loads(i["body"]) for i in r.get("Items", []))
            lek = r.get("LastEvaluatedKey")
            if not lek or len(out) >= limit:
                break
            kw["ExclusiveStartKey"] = lek
        return out[:limit]

    # ---- runs ----
    def put_run_summary(self, summary: Dict[str, Any]) -> None:
        self.t.put_item(
            Item={"pk": "RUNS", "sk": f"{summary['start']:013d}#{summary['id']}", "body": json.dumps(summary)},
        )

    def run_summaries(self, limit: int = 200) -> List[Dict[str, Any]]:
        r = self.t.query(
            KeyConditionExpression="pk = :p",
            ExpressionAttributeValues={":p": "RUNS"},
            ScanIndexForward=False,
            Limit=limit,
        )
        return [json.loads(i["body"]) for i in r.get("Items", [])]

    def get_run_summary(self, start: int, run: str) -> Optional[Dict[str, Any]]:
        r = self.t.get_item(Key={"pk": "RUNS", "sk": f"{start:013d}#{run}"})
        item = r.get("Item")
        return json.loads(item["body"]) if item else None
