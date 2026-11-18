# Component and telemetry spec

The contract between each object in the twin and the platform it represents. If the code and this
document disagree, the code is wrong or this document is out of date; fix whichever it is.

Code that implements it:

| Concern | File |
| --- | --- |
| Event kinds and allowed data | `telemetry/twin/events.py` (server), `web/src/model/events.ts` (client) |
| Collection | `telemetry/twin/normalize.py` (EventBridge), `telemetry/twin/poll.py` (1-minute poll) |
| Run grouping | `telemetry/twin/runs.py` |
| What is public | `telemetry/twin/redact.py`, `telemetry/twin/publish.py` |
| State from events | `web/src/model/reduce.ts` |
| Inspector copy and freshness | `web/src/content/components.ts` |

Checked against the live account on 2026-11-18: control plane `t3.medium`, GPU group 0–1 `g5.xlarge`,
one 50 GB gp3 model-cache volume, four queues present.

## Rules that apply to every object

1. **Animation follows events.** An object changes only when `reduce()` applies an event. Live and
   Replay use the same reducer, so a recorded run plays exactly as it was observed.
2. **Observed vs inferred.** Every event carries `confidence`. Inferred state is drawn dashed or pulsing,
   and the inspector says so.
3. **Not observed means not animated in Live.** Objects with no live source stay at rest in Live and say
   so in the inspector. Sample runs (labelled SAMPLE) may animate them.
4. **Idempotent and order-tolerant.** Events are applied by id once, sorted by source time.
5. **Public-safe.** Published files contain only allowlisted event data; a scanner rejects ARNs,
   12-digit numbers, resource ids, IPs and URLs (`assert_public_safe`).
6. **Health.** `live.json` carries `generatedAt`. Older than 3 minutes shows "telemetry stale", never
   "asleep".

## Freshness by source

| Source | How | Lag in Live |
| --- | --- | --- |
| EC2 state change (tower, GPU), Spot warning, GPU launch failure | EventBridge rule to the telemetry Lambda | Seconds |
| Queue counts (4 queues) | `GetQueueAttributes` every minute (approximate counts) | Up to about 75 s |
| GPU group desired capacity, launch lock | `DescribeAutoScalingGroups` every minute | Up to about 75 s |
| Catch-up for missed EC2 events | Same 1-minute poll | Up to about 75 s |
| Pod readiness | Inferred 40 s after the tower is `running` | Not a measurement |
| Publication | `live.json` cached 5 s at CloudFront; the page polls every 10 s | Adds up to 15 s |
| Costs | Cost Explorer and Pricing API, daily at 06:15 UTC | Up to a day; billed data itself lags up to 24 h |

## Objects

States are `WorldState` fields. "Live" says what the deployed telemetry feeds today.

| Object (scene) | AWS / platform | States shown | Driven by | Live | Connections drawn | Fallback |
| --- | --- | --- | --- | --- | --- | --- |
| Desk clock | EventBridge 06:55 pre-warm | pulse | `ingress.prewarm` | Not observed; the wake shows as the tower starting | signal to relay | Rest |
| Arch | API Gateway HTTP API | route light pulse | `ingress.request` | Not observed (Phase D log subscription) | ticket to relay | Rest |
| Relay | Wake Lambda | pulse | `lambda.invoked` | Not observed (Phase D) | ticket to inbox, signal to tower | Rest |
| Inbox tray | SQS workflow queue | tickets (named in samples, unnamed from counts in Live) | `job.*`, `queue.depth` | Observed, polled | ticket to worker | Shows last count; stale banner |
| Inbox bin | Workflow DLQ | tickets | `job.dlq`, `queue.depth` | Observed, polled | — | As above |
| GPU tray | SQS GPU queue | tickets | `job.*`, `queue.depth` | Observed, polled | ticket to core; KEDA watches it | As above |
| GPU bin | GPU DLQ | tickets | `job.dlq`, `queue.depth` | Observed, polled | — | As above |
| Demand lever | KEDA ScaledObject | replicas 0/1, cooldown ring | `keda.scale` | Not observed (exporter) | signal to vLLM outline | Rest |
| Tower | EC2 + K3s control plane | stopped, pending, running, stopping | `cp.state` | Observed, seconds | hosts pods, LAYA, watchdog, autoscaler | Last known state; stale banner |
| Roof modules | Kubernetes pods | ready / not | `pods.ready` | Inferred | — | Drawn as inferred |
| Scanner gate | LAYA decision service | gate pass/reject/decision, verify pass/fail | `laya.gate`, `laya.verify` | Not observed (exporter) | ticket path worker, gate, GPU tray | Rest |
| Dial | Idle watchdog | idle since | `watchdog.idle` | Not observed; its effect is the tower stopping | signal to tower | Rest |
| Capacity arm | Cluster Autoscaler, GPU ASG desired | desired 0/1, who set it | `asg.desired` | Observed, polled (`by: observed`) | arm tower to cradle | Last known |
| Cradle and cassette | GPU ASG instance | none, launching, running, terminating, launch_failed; Spot warning | `gpu.instance`, `spot.warning` | Observed, seconds | cable to tower once joined | Last known |
| Latch | EC2 stop guard | locked / open | `guard.latch` | Observed, polled | latch on cradle | Last known |
| Model drive | EBS gp3 50 GB model cache | attached / detached | `ebs.attached` | Not observed (exporter) | docks to cassette | Rest, undocked |
| Model core | vLLM (qwen-general) | absent, pending, loading, ready | `vllm.state` | Not observed (exporter) | ticket to core | Rest |
| Crate | S3 results | pulse on result | `s3.result` | Not observed | ticket from core or gate | Rest |
| Terminal | SSM Session Manager | open / closed | `ssm.session` | Not observed | — | Rest |
| Platforms | VPC, two subnets, two AZs | static | — | Static | bridge between AZs | — |

The coder model's slot on the drive is shown as reserved, not loaded, until its weights are confirmed.

## Connection kinds

| Kind | Meaning | Drawn as |
| --- | --- | --- |
| Ticket | A request or job moving | Card travelling between anchors (`movers.tsx` Tickets) |
| Signal | A control action (wake, scale, stop) | Light pulse along a rail (`movers.tsx` Signals) |
| Attachment | An infrastructure dependency | Physical dock or cable (drive to cassette, cassette to tower) |
| Failure path | Retry or dead-letter | Ticket to the bin under its tray; red stamp |

## Lifecycle timings

| Phase | Figure | Source |
| --- | --- | --- |
| GPU start (autoscaler reacts to model ready) | 90–150 s | Platform architecture docs |
| Full cold start (everything asleep) | Tower boot and pod start, then KEDA poll, then GPU start; about 3.7 min in the samples | `fullColdStartSampleSeconds()`; replace with medians from recorded runs |
| KEDA poll / cooldown | 15 s / 120 s | `k8s/keda/scaledobject.yaml` |
| Autoscaler scale-down | 2 min unneeded | Cluster Autoscaler flags |
| Watchdog | 30 min idle | `idle_watchdog.py` |

## Costs

- **Usage** is Cost Explorer `UnblendedCost` excluding credits and refunds, so a credited month still
  shows what the platform used. Credits are shown on their own line.
- **By component** groups usage types: GPU compute, control-plane compute, disks, snapshots, data
  transfer, other. Disks and snapshots are charged whether the platform is awake or not.
- **Morning wakes with no GPU work** is an estimate: recorded runs starting within 5 minutes of 06:55 UTC
  with no GPU time, priced at the tower's list rate.
- **Paid vs always on** (Replay) compares the run's GPU and tower time at list price with both running for
  the whole span. Disks are left out because they cost the same either way.

## Not yet covered

- Job identities and overlapping jobs in Live (needs the exporter; Live shows unnamed tickets from counts).
- KEDA, LAYA, vLLM, model drive, pods: exporter, Phase D, with owner approval.
- Gateway and wake Lambda: log subscription that keeps route and status only, Phase D, with owner approval.
- The wake API has no authoriser. That is a platform fix for the owner, independent of the twin.
