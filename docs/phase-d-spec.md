# Phase D component and telemetry spec

Status: **proposal**. Nothing here is deployed. Each item marked *needs approval* touches the live
platform and is done only after the owner says yes to that item specifically. Everything is built in
this repository; nothing is edited in the platform repository.

Phase C made the twin's infrastructure layer observed (EC2 states, queue counts, GPU group capacity,
launch lock). Phase D makes the **application layer** observed: individual jobs, LAYA's decisions,
KEDA, vLLM, pods and the model drive. It also adds the guided tour and a 2D fallback.

Read with [component-spec.md](component-spec.md), which defines the rules every source here follows
(animation follows events, observed vs inferred, public-safe output, freshness).

## 1. What changes for each object

| Object | Live today (Phase C) | Live after Phase D | New source |
| --- | --- | --- | --- |
| Arch (API Gateway) | Not observed | Pulse per accepted job and per wake | Wake log subscription |
| Relay (wake Lambda) | Not observed | Pulse with action: enqueue, wake, guard | Wake log subscription |
| Desk clock (pre-warm) | Not observed | Pulse at the scheduled pre-warm | Wake log subscription |
| Inbox and GPU trays | Unnamed tickets from counts | Named tickets per job, plus unnamed for any remainder | Exporter + existing poll |
| Roof modules (pods) | Inferred 40 s after boot | Observed readiness | Exporter |
| Scanner gate (LAYA) | Not observed | Gate result (pass, reject, decision) and verify result per attempt | Exporter |
| Demand lever (KEDA) | Not observed | Replicas 0/1 | Exporter |
| Capacity arm | Desired 0/1, `by: observed` | Desired 0/1 with who set it | Exporter, log subscription, timing |
| Model drive | Not observed | Attached / detached | Existing poll (no approval needed) |
| Model core (vLLM) | Not observed | absent, pending, loading, ready | Exporter |
| Crate (S3) | Not observed | Pulse when a result is stored | Exporter |
| Dial (watchdog) | Not observed | Unchanged: its effect shows as the tower stopping | — |
| Terminal (SSM) | Not observed | Unchanged (would need CloudTrail; not proposed) | — |

## 2. Sources

```
Control plane (K3s)                                    Twin stack (this repo, infra/)
┌──────────────────────────────────┐
│ twin-exporter pod (read-only)    │  HTTPS + HMAC    ┌──────────────┐  async   ┌────────────────┐
│  jobs.db job_steps ──┐           ├─────────────────>│ ingest λ     ├─────────>│ telemetry λ    │
│  K8s API (pods, deploy, nodes) ──┤  batch ≤ 5 s     │ (function    │ invoke   │ (concurrency 1)│
└──────────────────────────────────┘                  │  URL)        │          │ DynamoDB, S3   │
                                                      └──────▲───────┘          └───────▲────────┘
Wake Lambda log group ── subscription filter ─────────────────┘                         │
                         (5 fixed phrases only)                                         │
EventBridge + 1-minute poll (Phase C, plus model-volume attachment) ────────────────────┘
```

The telemetry Lambda stays the **single writer** of run state. The ingest Lambda only checks,
reduces and forwards; it never writes DynamoDB or S3 itself.

## 3. Source A: in-cluster exporter (*needs approval*)

### Placement

| Item | Value |
| --- | --- |
| Namespace | `sleepless-twin` (new, owned by the twin) |
| Workload | Deployment `twin-exporter`, 1 replica, `nodeSelector: node-role.kubernetes.io/control-plane: "true"` |
| Image | Stock `python:3.12-slim`, pinned by digest. Code mounted from a ConfigMap. Standard library only (`sqlite3`, `urllib`, `hmac`, `json`), so no image build or registry |
| Resources | requests 25m CPU / 48 Mi, limits 100m / 96 Mi |
| Security context | non-root, read-only root filesystem, no privilege escalation, all capabilities dropped |
| Mount | hostPath `/var/lib/personal-ai/data` at `/data`, **readOnly** |
| Service account | `twin-exporter`, read-only RBAC below; token auto-mounted for the K8s API only |
| Secret | `twin-exporter-hmac` (one key), created by the owner from the twin's SSM parameter |
| Source in this repo | `exporter/exporter.py`, `exporter/tests/`, `exporter/k8s/` (kustomize) |
| Applied by | The owner: `kubectl apply -k exporter/k8s` from this repo |

RBAC (ClusterRole `twin-exporter-read`, verbs `get`, `list` only):

| API group | Resources | Why |
| --- | --- | --- |
| `""` | `pods`, `nodes`, `events` | Pod readiness, GPU node join, autoscaler scale-up events |
| `apps` | `deployments` | vLLM replica count set by KEDA |

No `watch`, no `secrets`, no `configmaps`, no write verbs, no access to `keda.sh` objects (replica
count on the Deployment is enough).

### What it reads from the job store

The exporter opens `file:/data/jobs.db?mode=ro` and runs exactly these queries. Column lists are
explicit; there is no `SELECT *`.

```sql
-- every 2 s, rows changed since the cursor (cursor = max timestamp already sent)
SELECT job_id, step_id, attempt, state, started_at, completed_at
FROM job_steps
WHERE started_at > :cursor OR completed_at > :cursor;

SELECT job_id, job_type, status, result_ref IS NOT NULL AS has_result
FROM jobs
WHERE job_id IN (:ids_from_the_query_above);
```

**Never read:** `payload`, `payload_ref`, `result`, `result_ref` (only whether it is null), `error`,
`idempotency_key`, `job_steps.output`, `job_steps.error`, `outbox_events.payload`. A test asserts the
exporter's SQL contains none of these column names in a select list.

SQLite caveat to test on the dev cluster first: the database runs in WAL mode. A read-only
connection on a read-only mount works only while the `-wal` and `-shm` files exist, which they do
while the orchestrator and worker hold connections. If the open fails, the exporter retries every
10 s and reports `job store unavailable` (section 3, failure behaviour). It must **not** fall back to
`immutable=1`, which ignores the WAL and returns stale or inconsistent rows.

### Job steps to twin events

Step names and states are copied from `services/ai_worker/worker.py` and
`services/common/models.py` (WorkflowStepState).

| Step row | Twin event | Notes |
| --- | --- | --- |
| `step_validation` VALIDATING | `job.dequeued {queue: workflow}` | Worker picked the job from the inbox |
| `step_decision` DECIDING / `step_triage` DECIDING | (none; ticket moves to the scanner on the next event) | |
| `step_decision` COMPLETED | `laya.gate {result: decision}`, then `job.finished {outcome: decided}` | Answered on CPU |
| `step_triage` REJECTED | `laya.gate {result: reject}`, then `job.finished {outcome: rejected}` | GPU never wakes |
| `step_gpu_dispatch` WAITING_GPU | `laya.gate {result: pass}`, then `job.enqueued {queue: gpu}` | Hand-off to the GPU tray |
| `step_generation` GENERATING, attempt *n* | `job.generate {attempt: n}` | On attempt 1, also `job.dequeued {queue: gpu}` |
| `step_verification` VERIFYING, attempt *n*, followed by `step_generation` attempt *n+1* | `laya.verify {attempt: n, passed: false}` | Result read from the step sequence, not from output |
| `step_final` COMPLETED | `laya.verify {passed: true}` for the last attempt, then `job.finished {outcome: completed}` | |
| `step_final` NEEDS_REVIEW | `laya.verify {passed: false}`, then `job.finished {outcome: needs_review}` | |
| `step_final` FAILED | `job.failed {queue}` | Queue from whether a GPU dispatch step exists |
| `jobs.has_result` becomes true | `s3.result` | Never the key |

LAYA's probabilities are **not** exported, because they live only in `job_steps.output`, which is
never read. `laya.gate` and `laya.verify` therefore carry no `probability`, and the caption shows the
result without a number (schema change, section 7).

All events from this source are `confidence: observed`. The verify result is read from the order of
step rows that the worker writes, which is how the worker itself records it.

### Kubernetes to twin events

Polled every 5 s (list, not watch: simpler, and survives API restarts without resume logic).

| Read | Twin event |
| --- | --- |
| Deployments `orchestrator`, `ai-worker`, `laya-service`, `litellm` in `personal-ai-infra`: all Ready | `pods.ready {ready: true}` (observed; replaces the 40 s inference) |
| Any of them not Ready after having been Ready | `pods.ready {ready: false}` |
| Deployment `vllm-inference` (`personal-ai-inference`) `spec.replicas` changes | `keda.scale {replicas}` |
| vLLM pod Pending | `vllm.state {state: pending}` |
| vLLM pod Running, container not Ready | `vllm.state {state: loading}` |
| vLLM pod Ready | `vllm.state {state: ready}` |
| vLLM pod gone | `vllm.state {state: absent}` |
| Node with label `node.kubernetes.io/instance-type: g5.xlarge` becomes Ready | `node.joined {joined: true}` |
| That node removed | `node.joined {joined: false}` |
| Event `TriggeredScaleUp` from `cluster-autoscaler` on the vLLM pod | `asg.desired {desired: 1, by: cluster-autoscaler}` |
| Event `ScaleDown` from `cluster-autoscaler` for the GPU node | `asg.desired {desired: 0, by: cluster-autoscaler}` |

### Transport and authentication

The exporter POSTs batches to the twin's ingest function URL.

| Item | Value |
| --- | --- |
| Endpoint | Lambda function URL, `AuthType NONE`, checked by signature inside the function |
| Signature | `X-Twin-Signature: HMAC-SHA256(secret, timestamp + "." + body)`, `X-Twin-Timestamp` in ms |
| Clock window | Reject if the timestamp is more than 5 minutes from the ingest Lambda's clock |
| Replay | Event ids are deterministic (section 6), so a replayed batch changes nothing |
| Limits | Body ≤ 256 KB, ≤ 500 events per batch, reserved concurrency 2 |
| Rejection | 401 with an empty body; no detail about why |
| Secret | 32 random bytes in an SSM SecureString parameter in the twin stack; copied once into the K8s Secret by the owner; rotated by writing a new value and restarting the pod |
| Where the URL lives | Only in the exporter's ConfigMap. Never in the site, the public data or this repo |

Why not IAM auth: the exporter could sign with the control plane's instance profile (KEDA already
uses it via `podIdentity: aws`), but that needs a new permission on a platform-owned role. A twin-owned
HMAC secret keeps the platform's IAM untouched. If the owner prefers IAM, the alternative is an
`AWS_IAM` function URL plus one `lambda:InvokeFunctionUrl` statement on the control-plane role, added
by the owner.

### Batching, cursor and restarts

- The exporter sends a batch when it has events, at most every 5 s, and an empty heartbeat batch every
  60 s while running, so the twin can show "exporter connected".
- The cursor is held in memory only. On start, the exporter re-sends the last 6 hours of step rows.
  Deterministic event ids make the re-send harmless. The exporter needs no disk of its own.
- On a failed POST it keeps the batch, retries with backoff (2, 4, 8 … 60 s), and keeps at most 2,000
  events in memory, dropping the oldest. Anything dropped is recovered by the next re-send from
  `jobs.db`.
- On SIGTERM (control plane stopping) it makes one last send attempt and exits within 5 s.

### Effect on the platform

- Read-only on the job store and K8s API; writes nothing to the cluster or the database.
- Does not touch SQS, leases, the outbox or the GPU group, so the watchdog's idle check is unaffected
  and the exporter can never keep the platform awake.
- CPU and memory are capped well inside the `t3.medium`'s headroom.
- Turning it off: `kubectl scale deploy/twin-exporter -n sleepless-twin --replicas=0`, or delete the
  namespace. The twin falls back to Phase C behaviour for those objects.

## 4. Source B: wake Lambda log subscription (*needs approval*)

A CloudWatch Logs subscription filter on the wake Lambda's log group, delivering to the twin's ingest
Lambda. Created by this repo's Terraform behind `enable_wake_log_subscription` (default `false`).

The wake Lambda logs every incoming event in full (`Received event: …`), including request bodies,
headers and caller IPs, and logs the control plane's public IP. The filter therefore matches only
these five fixed phrases (OR-ed terms), none of which carry bodies or addresses:

| Phrase in the log line | Twin event |
| --- | --- |
| `Handling EventBridge scheduled pre-warm` | `ingress.prewarm` |
| `successfully pushed to SQS` | `ingress.request {route: /jobs}`, `lambda.invoked {action: enqueue}`, `job.enqueued {queue: workflow, jobId}` |
| `Triggering StartInstances` | `lambda.invoked {action: wake}` |
| `EventBridge guard: Scaling down` | `asg.desired {desired: 0, by: guard}`, `guard.latch {locked: true}` |
| `Resumed Launch and ReplaceUnhealthy` | `guard.latch {locked: false}` |

Must **not** match, and a test feeds them to the parser to prove they are dropped:
`Received event:` (full request), `current state: … (ip: …)` (public IP), any `ERROR` line (exception
text can hold ARNs).

The ingest parser extracts only the job id from the `successfully pushed` line, using a fixed pattern,
and drops the rest of the line, which includes the queue URL with the account id. Raw log lines are
never stored or forwarded.

`/status` and `/health` calls are not logged by phrase and stay unobserved. That is acceptable: they
change nothing on the platform.

## 5. Source C: model-volume attachment (no approval needed)

Added to the existing 1-minute poll, using the twin's own role: `ec2:DescribeVolumes` filtered by the
tag `Name = personal-ai-model-cache-ebs-1c`. Attachment state `attached` / none becomes
`ebs.attached {attached}`. Freshness up to about 75 s. This changes no platform resource; it only adds
a read permission to the twin's telemetry role.

## 6. Ingest Lambda (twin stack)

| Step | Rule |
| --- | --- |
| 1. Authenticate | Exporter batches: HMAC check (section 3). Log batches: arrive from CloudWatch Logs with an invoke permission scoped to that log group |
| 2. Parse | Exporter: JSON array of `{kind, ts, data, jobId?}`. Logs: gunzip, base64-decode, match the five phrases |
| 3. Validate | Kind must be in `events.SCHEMA`; data keys and values from the existing allowlist; `ts` within 24 h; `jobType` in `JOB_TYPES` |
| 4. Pseudonymise | `jobId` → `j` + first 10 letters of base32(HMAC-SHA256(job_salt, raw_id)), letters only. Raw ids are dropped here |
| 5. Assign ids | `id = letters(HMAC(job_salt, kind + pseudonym + step + attempt + state))`, so re-sends collapse |
| 6. Forward | Async invoke of the telemetry Lambda with `{"twin": "ingest", "events": [...]}`. Lambda's async queue holds and retries for up to 6 h |

`job_salt` is a second SSM SecureString, separate from the HMAC transport secret, so rotating the
transport secret does not change job pseudonyms.

The telemetry Lambda gains one handler branch for `twin: ingest`. It applies the events exactly like
EventBridge events (run assignment, store, publish), so `assert_public_safe` still guards every
published file.

## 7. Schema and front-end changes

| Change | File |
| --- | --- |
| `laya.gate.probability` and `laya.verify.probability` become optional | `telemetry/twin/events.py`, `web/src/model/events.ts` |
| Captions omit the number when there is no probability (today they would print `0.00`) | `web/src/content/captions.ts` |
| `jobId` must match `^j[a-z]{10}$` in published files; the redaction scanner rejects anything that looks like a UUID | `telemetry/twin/redact.py` |
| Unnamed tickets = queue count − named tickets at that tray, never below 0, so a job is not drawn twice | `web/src/scene/movers.tsx` |
| `pods.ready` from the exporter replaces the 40 s inference; the inference stays as a fallback when no exporter heartbeat has arrived for 3 minutes | `telemetry/twin/poll.py` |
| `exporter` heartbeat in `live.json` (`exporterAt`); the status line says "job detail unavailable" when it is older than 3 minutes while the tower runs | `telemetry/twin/publish.py`, `web/src/ui/StatusLine.tsx` |
| Inspector "Live data" lines updated per section 8 | `web/src/content/components.ts` |
| `asg.desired.by` can now be `cluster-autoscaler`, `guard` or `watchdog` in Live; `observed` remains for changes nobody claimed | existing enum, no change |

Who set the GPU group size, without CloudTrail:

| Signal | Attributed to |
| --- | --- |
| Autoscaler K8s event `TriggeredScaleUp` / `ScaleDown` | `cluster-autoscaler` |
| Wake log line `EventBridge guard: Scaling down` | `guard` |
| Desired drops to 0 within 60 s before the tower enters `stopping`, with no autoscaler or guard claim | `watchdog` (confidence `inferred`) |
| Anything else | `observed` (who is unknown) |

## 8. Freshness after Phase D

| Source | Lag in Live |
| --- | --- |
| Exporter: job steps | 2 s poll + up to 5 s batch + ingest and publish ≈ 10 s, plus the page's 10–15 s |
| Exporter: pods, KEDA, vLLM, GPU node | 5 s poll + batch ≈ 12 s, plus the page's 10–15 s |
| Wake log subscription | CloudWatch Logs delivery, typically a few seconds |
| Model volume | Up to about 75 s (1-minute poll) |
| Phase C sources | Unchanged |

When the tower is stopped, the exporter is stopped too. That is expected and shows as "asleep", not
"stale": the heartbeat check only applies while the tower is `running`.

## 9. Presentation items in Phase D

These need no platform access.

**Guided tour.** A fixed sequence of steps, each `{objectId, caption, scenario, atSeconds}`, playing a
sample scenario with the camera framing each object. It works offline from sample data, is labelled
SAMPLE, can be left at any step, and respects reduced motion (cuts instead of camera moves). Stops:
front door → inbox → LAYA gate (reject branch) → GPU tray → demand lever → capacity arm → cassette
arriving → model core → verify → crate → cooldown and scale-down → watchdog → asleep floor in the
ledger.

**2D fallback.** An SVG schematic using the same `WorldState` and the same reducer, so Live and Replay
keep working without WebGL. Chosen automatically when WebGL is unavailable, and offered as a toggle.
Each object is a labelled box in the same district layout; tickets are dots; state is colour plus a
text label (never colour alone). The event log and inspector are shared unchanged.

## 10. Rollout order and switches

Each step is asked for separately. Later steps do not depend on earlier ones except where noted.

| # | Item | Approval | Switch |
| --- | --- | --- | --- |
| 1 | Model-volume attachment in the poll (section 5). **Done 2026-11-18.** | No: twin-only read permission | Remove from `poll.py` |
| 2 | Ingest Lambda, SSM parameters, schema changes (sections 6–7) | No: twin-only resources, inert until a source sends | `enable_ingest` |
| 3 | Wake log subscription (section 4) | **Yes**: attaches to a platform log group | `enable_wake_log_subscription` |
| 4 | Exporter in the cluster (section 3), after testing on the dev cluster | **Yes**: runs on the control plane | Scale to 0 or delete the namespace |
| 5 | Guided tour, 2D fallback | No | — |

## 11. Acceptance tests

- Exporter unit tests against a WAL-mode SQLite file built with the platform's schema: every row in the
  section 3 mapping produces the listed events; a select-list test proves forbidden columns are never
  read; a retry test with the file missing.
- Parser tests for each of the five log phrases, plus the three must-not-match lines.
- Ingest tests: bad signature → 401; old timestamp → 401; unknown kind dropped; raw UUIDs never appear
  in the output; the same batch sent twice produces identical event ids.
- End to end on the owner's dev cluster: submit one job of each outcome (completed, rejected, decided,
  needs_review) and confirm `live.json` shows each step within 30 s, with pseudonymous job ids and no
  forbidden pattern (the existing no-leak test, extended to UUIDs).
- Watchdog check: with the exporter running and both queues empty, the tower still stops after 30
  minutes idle.

## 12. Cost

| Item | Estimate |
| --- | --- |
| Ingest Lambda (≈ 1 batch per 5 s while awake; ~20 h awake a month ≈ 15,000 calls) | Free tier |
| Telemetry Lambda async invocations | Free tier |
| CloudWatch Logs subscription delivery | Cents |
| SSM standard parameters | Free |
| Extra cluster load | 25m CPU, 48 Mi memory on the tower |

Well under $1 a month on top of Phase C.

## 13. Platform findings for the owner (not twin work)

Found while reading the platform for this spec. They are the owner's to fix in the platform repository;
the twin works with or without them.

1. **`/wake` returns the control plane's instance id, public IP and orchestrator address
   (`http://<ip>:8000`) to any caller.** With no authoriser on the API, anyone who finds the URL can
   learn where the orchestrator listens, over plain HTTP. More serious than the missing authoriser on
   its own.
2. **The wake Lambda logs every request in full** (`Received event:`), including bodies and caller IPs.
   Logging only route, status and a request id would remove job content from CloudWatch.
3. **The wake Lambda logs the SQS queue URL** (it contains the account id) and the control plane's
   public IP on every call.
4. The API Gateway route has no authoriser (already known).

## 14. Open questions for the owner

- Approve items 3 and 4 in section 10, separately.
- HMAC (recommended, no platform IAM change) or IAM-authenticated ingest for the exporter.
- Is there a dev cluster to test the exporter on before it runs on the live control plane?
- The project runs under AWS-managed SCPs and RCPs. Before step 2, confirm they allow a Lambda function
  URL with `AuthType NONE`; if not, the exporter needs the IAM-authenticated alternative in section 3.
- Should job types be shown on public tickets (for example "CV tailoring"), or only "job"? They are
  allowlisted and contain no content, but they do say what kind of work the platform does.
