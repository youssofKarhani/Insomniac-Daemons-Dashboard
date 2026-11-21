# Phase D component and telemetry spec

Status: **proposal**. Nothing here is deployed. Each item marked *needs approval* touches the live
platform and is done only after the owner says yes to that item specifically. Everything is built in
this repository; nothing is edited in the platform repository.

Phase C made the dashboard's infrastructure layer observed (EC2 states, queue counts, GPU group capacity,
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
Control plane (K3s)                                    Dashboard stack (this repo, infra/)
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

### Job steps to dashboard events

Step names and states are copied from `services/ai_worker/worker.py` and
`services/common/models.py` (WorkflowStepState).

| Step row | Dashboard event | Notes |
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

### Kubernetes to dashboard events

Polled every 5 s (list, not watch: simpler, and survives API restarts without resume logic).

| Read | Dashboard event |
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

The exporter POSTs batches to the dashboard's ingest function URL.

| Item | Value |
| --- | --- |
| Endpoint | Lambda function URL, `AuthType NONE`, checked by signature inside the function |
| Signature | `X-Twin-Signature: HMAC-SHA256(secret, timestamp + "." + body)`, `X-Twin-Timestamp` in ms |
| Clock window | Reject if the timestamp is more than 5 minutes from the ingest Lambda's clock |
| Replay | Event ids are deterministic (section 6), so a replayed batch changes nothing |
| Limits | Body ≤ 256 KB, ≤ 500 events per batch, reserved concurrency 2 |
| Rejection | 401 with an empty body; no detail about why |
| Secret | 32 random bytes in an SSM SecureString parameter in the dashboard stack; copied once into the K8s Secret by the owner; rotated by writing a new value and restarting the pod |
| Where the URL lives | Only in the exporter's ConfigMap. Never in the site, the public data or this repo |

Why not IAM auth: the exporter could sign with the control plane's instance profile (KEDA already
uses it via `podIdentity: aws`), but that needs a new permission on a platform-owned role. A dashboard-owned
HMAC secret keeps the platform's IAM untouched. If the owner prefers IAM, the alternative is an
`AWS_IAM` function URL plus one `lambda:InvokeFunctionUrl` statement on the control-plane role, added
by the owner.

### Batching, cursor and restarts

- The exporter sends a batch when it has events, at most every 5 s, and an empty heartbeat batch every
  60 s while running, so the dashboard can show "exporter connected".
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
  namespace. The dashboard falls back to Phase C behaviour for those objects.

## 4. Source B: wake Lambda log subscription (*needs approval*)

A CloudWatch Logs subscription filter on the wake Lambda's log group, delivering to the dashboard's ingest
Lambda. Created by this repo's Terraform behind `enable_wake_log_subscription` (default `false`).

The wake Lambda logs every incoming event in full (`Received event: …`), including request bodies,
headers and caller IPs, and logs the control plane's public IP. The filter therefore matches only
these five fixed phrases (OR-ed terms), none of which carry bodies or addresses:

| Phrase in the log line | Dashboard event |
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

Added to the existing 1-minute poll, using the dashboard's own role: `ec2:DescribeVolumes` filtered by the
tag `Name = personal-ai-model-cache-ebs-1c`. Attachment state `attached` / none becomes
`ebs.attached {attached}`. Freshness up to about 75 s. This changes no platform resource; it only adds
a read permission to the dashboard's telemetry role.

## 6. Ingest Lambda (dashboard stack)

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

The telemetry Lambda gains one handler branch for `dashboard: ingest`. It applies the events exactly like
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
| 1 | Model-volume attachment in the poll (section 5). **Done 2026-11-18.** | No: dashboard-only read permission | Remove from `poll.py` |
| 2 | Ingest Lambda, SSM parameters, schema changes (sections 6–7). **Done 2026-11-18**; see section 14. | No: dashboard-only resources, inert until a source sends | `enable_ingest` |
| 3 | Wake log subscription (section 4). **Approved and done 2026-11-18**; see section 14. | **Yes**: attaches to a platform log group | `enable_wake_log_subscription` |
| 4 | Exporter in the cluster (section 3), after testing on the dev cluster. **Approved 2026-11-18; built and tested, not deployed**: the owner applies it (`exporter/README.md`); see section 14. | **Yes**: runs on the control plane | Scale to 0 or delete the namespace |
| 5 | Guided tour, 2D fallback. **Guided tour done 2026-11-18; 2D fallback done 2026-11-19**; see section 14. | No | — |

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

## 13. Platform findings for the owner (not dashboard work)

Found while reading the platform for this spec. They are the owner's to fix in the platform repository;
the dashboard works with or without them.

1. **`/wake` returns the control plane's instance id, public IP and orchestrator address
   (`http://<ip>:8000`) to any caller.** With no authoriser on the API, anyone who finds the URL can
   learn where the orchestrator listens, over plain HTTP. More serious than the missing authoriser on
   its own.
2. **The wake Lambda logs every request in full** (`Received event:`), including bodies and caller IPs.
   Logging only route, status and a request id would remove job content from CloudWatch.
3. **The wake Lambda logs the SQS queue URL** (it contains the account id) and the control plane's
   public IP on every call.
4. The API Gateway route has no authoriser (already known).
5. **The wake Lambda's log group has no retention period**, so the full request bodies from finding 2
   are kept forever. Setting a retention (for example 14 days) limits that exposure even before the
   logging itself is fixed.

## 14. As built (steps 2–5)

Differences from sections 6–7 found while building, and decisions taken:

- **Function URL permissions.** AWS now requires two statements for a public URL:
  `lambda:InvokeFunctionUrl` for everyone, and `lambda:InvokeFunction` limited by
  `lambda:InvokedViaFunctionUrl = true`. The AWS provider (5.x) cannot set that condition, so
  `infra/ingest.tf` manages that one statement with the AWS CLI from a `terraform_data` resource.
  Plain `lambda:InvokeFunction` is never granted to everyone: it would let any AWS principal invoke the
  function directly with a forged log batch and skip the signature check. The managed SCPs and RCPs
  did not block the URL.
- **Secrets** are created by Terraform with the placeholder `unset` and set once with the AWS CLI, so
  they never sit in Terraform state. Until both are set, the function answers 503 to everything. An
  unset value is not cached, so setting them takes effect on the next call.
- **Exporter batch format** (also in `telemetry/twin/ingest.py`): `{"v": 1, "events": [{kind, ts,
  key, data, job?, confidence?}]}`. `key` names the source fact (for example
  `job|step|attempt|state`); it is only ever hashed with the job salt, so re-sends collapse to the same
  event ids. Every POST that passes the signature counts as an exporter heartbeat, even with no events.
- **Async hand-off** retries for up to 1 hour (`maximum_event_age_in_seconds` on the telemetry
  Lambda), not 6 hours. The exporter's 6-hour re-send from `jobs.db` covers longer outages.
- **"Job detail unavailable"** shows only once an exporter has ever reported (`exporterAt` present)
  and has then been silent for 3 minutes while the tower runs. Before the exporter exists, Live
  behaves exactly as in Phase C.
- **Unnamed tickets** subtract named jobs still held by each queue, including jobs the worker holds
  in flight (at the worker, the scanner or the core), not only those sitting in the tray
  (`namedPerQueue` in `web/src/model/state.ts`).
- **Published job ids** must match `^j[a-z]{10}$`; the scanner also blocks anything shaped like a UUID.

Step 3 (wake log subscription):

- **Phrases changed.** CloudWatch filter patterns did not match quoted phrases containing `:` or `-`
  against the real logs, so two phrases from section 4 are shortened:
  `Handling EventBridge scheduled` (was `… scheduled pre-warm`) and `Scaling down GPU ASG` (was
  `EventBridge guard: Scaling down`). The parser in `twin/ingest.py` uses the same five phrases, and a
  test keeps it equal to the filter in `infra/ingest.tf`.
- **Checked against 30 days of real logs** before deploying: the five-phrase filter matched 114 lines
  (22 pre-warms, 3 accepted jobs, 30 wake starts, 40 guard scale-downs, 19 launch resumes), none of
  them `Received event:` or error lines. Run locally through the parser, they gave 160 allowlisted
  events with pseudonymous job ids and no scanner hits. The local copy of the lines was deleted.
- **Not yet seen end to end in AWS**: no matching line has been written since the filter was attached.
  The first will be the next 06:55 UTC pre-warm or the next accepted job.

Step 4 (exporter, `exporter/`):

- **How step rows are written** changed the design. The platform's `record_step` rewrites a row on
  every state change: `started_at` keeps the first write, `completed_at` is the latest write and
  `state` the latest state. So the exporter does not track transitions. When any of a job's rows
  changes (cursor on `completed_at`), it reads all that job's rows and derives the job's events from
  them (`job_events`), with stable keys. A restart re-sends the last 6 hours, and ingest collapses
  the repeats.
- **What that cannot show**: a step's intermediate state is overwritten, so "LAYA is scanning" is
  not seen on its own; the gate result arrives with its outcome. A failed verification is
  timestamped just before the next generation attempt starts.
- **SQL** is limited to three queries with explicit columns (`SQLS` in `exporter.py`); a test fails if
  any selects a private column or touches the outbox.
- **Pod Security**: the namespace cannot enforce "baseline" or "restricted", because both forbid the
  one read-only hostPath (the job store). It warns and audits at "restricted" instead; the pod itself
  meets "restricted" otherwise (non-root, read-only root filesystem, no capabilities, seccomp).
- **Packaging**: `exporter/kustomization.yaml` sits next to `exporter.py` because kustomize's
  ConfigMap generator cannot read files outside its directory. Image `python:3.12-slim` pinned to its
  multi-arch index digest.
- **Tests** (13): every outcome's mapping, re-derivation stability, read-only open, job store
  unavailable, Kubernetes change detection and read failures, signing (checked by the real ingest
  verifier), backoff, heartbeat, queue cap, and the full path exporter → ingest → telemetry → public
  files with secret text planted in every private column.
- **Not deployed.** The cluster only runs while the platform is awake, and section 11 asks for a dev
  cluster test first. `exporter/README.md` has the checks and the three deploy commands.

### Step 5: guided tour

- **Content**: `web/src/content/tour.ts`, 13 stops in the order of section 9. Each stop is
  `{objectId, panel?, title, caption, scenario, anchor}`. Instead of a fixed `atSeconds`, each stop is
  anchored to the first event of a kind in its sample scenario (for example `gpu.instance` running), so
  the stops stay right when sample durations change. The LAYA gate stop uses the "Rejected by LAYA"
  sample; every other stop uses "Cold start, GPU job". The last stop frames the whole desk and
  highlights the ledger instead of an object.
- **Playback** (`store.ts`): a stop loads its scenario if needed, frames its object (the inspector
  opens), and plays a 2.5 s lead-in at 1× that pauses 0.4 s after the anchor event. Moving forward
  inside the same run by up to 12 s of play time plays through instead of jumping. Under reduced
  motion it cuts straight to the stop, paused, and the camera cuts instead of gliding.
- **UI** (`ui/Tour.tsx`): the tour panel takes the replay bar's place and says SAMPLE. It has Back,
  Next (named after the next stop), Finish and ×. Left and right arrows move between stops, and Escape
  ends the tour. Choosing Live or another run also ends it. The playing event's caption is shown under
  the stop text. On phones the inspector is hidden during the tour (the stop text stands in for it),
  the ledger is shown for the last stop, and the header buttons use short labels (Tour, Labels, Log).
- **Offline**: needs only sample data. Without billing data the ledger's asleep-floor row reads
  "not loaded" during the last stop.
- **Tests** (6, `web/src/content/tour.test.ts`): every stop resolves to a real scenario, object and
  event; stops in one run move forward in time; the copy passes the same identifier patterns as the
  redaction scanner; each stop lands with its event applied and its object framed (the reject stop
  with the GPU still off); with motion, the lead-in pauses exactly at the stop; leaving for Live or
  another run ends the tour. Checked in the browser at desktop and 375 px width.

### Step 5: 2D fallback

- **View** (`web/src/ui/Schematic.tsx`): an SVG schematic drawn from the same `WorldState` the 3D desk
  uses, so Live, Replay, the tour, the inspector, the ledger and the event log work unchanged. A header
  button switches between 3D and 2D; the choice is remembered in the browser (`localStorage`, wrapped so
  a private window just forgets it). Without WebGL the schematic is the only view and the button is
  hidden. The old "can't show the 3D view" message and the forced event log are gone.
- **Layout** (`web/src/ui/schematicLayout.ts`): five districts as on the desk: control plane and GPU
  platforms at the back, queues across the middle, always-on pieces at the front left, the archive at
  the front right. Below 640 px the districts stack in the order work flows (always on, queues, control
  plane, GPU, archive) and scroll; the scroll area starts below the status line and a selected box
  (for example a tour stop) is scrolled into view above the bottom panel.
- **State** (`web/src/ui/status.ts`): each box shows the object's name and a short state ("Running",
  "3 waiting", "Locked"). The colour comes from the same state and never stands alone. Inferred states
  have a dashed outline and also say "inferred". Each box is a keyboard-reachable button whose
  accessible name is the name, state and number of jobs.
- **Tickets**: jobs are dots in the box of their location (the worker's tickets sit on platform
  services), coloured by the same stamp as the 3D tickets; a hollow dot is held by the worker. The
  placement rule, including unnamed tickets from polled queue depth, moved from `scene/movers.tsx` to
  `model/tickets.ts` so both views draw exactly the same tickets.
- **Not drawn in 2D**: the pulses travelling between objects and the cables. The event log carries the
  same sequence as text.
- **Tests** (6, `web/src/ui/schematic.test.ts`): both layouts place every object once, inside its
  district, with no overlaps; every object has a non-empty state of at most 18 characters at every
  event of every sample run; queue dots match the 3D rule and never count a job twice; inferred states
  say so in text; a server-side render has one labelled, focusable button per object. Checked in the
  browser at desktop and 375 px, in Replay and in the tour. The automatic switch without WebGL was not
  exercised in a browser (it needs a browser with WebGL off).

## 15. Open questions for the owner

- Approve items 3 and 4 in section 10, separately.
- HMAC (recommended, no platform IAM change) or IAM-authenticated ingest for the exporter.
- Is there a dev cluster to test the exporter on before it runs on the live control plane?
- The project runs under AWS-managed SCPs and RCPs. Before step 2, confirm they allow a Lambda function
  URL with `AuthType NONE`; if not, the exporter needs the IAM-authenticated alternative in section 3.
- Should job types be shown on public tickets (for example "CV tailoring"), or only "job"? They are
  allowlisted and contain no content, but they do say what kind of work the platform does.
