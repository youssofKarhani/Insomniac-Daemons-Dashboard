# Teardown parts inventory

What each scene object is really made of, for the exploded ("teardown") view. Each part says what it
does, its key numbers, where the fact comes from, and whether the dashboard can drive it live.

Sources: the platform repo (read only, no secrets files opened) and AWS documentation, surveyed
2026-11-23. Platform paths are relative to the platform repo root. Where the platform's docs and its
code disagree, the code wins and the row says so.

**Live column:** `observed` = an existing event drives it · `inferred` = derived, drawn dashed ·
`exporter` = needs the Phase D in-cluster exporter · `static` = configuration, never changes at run time.

**Public-safety:** the public copy keeps names, roles and numbers only. Never ports, CIDRs, instance or
ASG names, queue URLs, token or env-var names, bucket names. Those appear below only where they explain
the structure and must be dropped when copied into `components.ts`.

---

## Which objects have something inside

| Object | Opens into | Depth |
| --- | --- | --- |
| Control tower | Host → K3s → pods → modules inside each pod | Deep (4 levels) |
| GPU cassette | Instance → GPU, disks, boot sequence → vLLM → model | Deep (3 levels) |
| Model drive | Volume → filesystem → two model folders → shards | Medium |
| Wake switch (Lambda) | Router → four handlers → stop guard | Medium |
| Front door (API Gateway) | Route → integration → stage, CORS | Shallow, but corrects a mistake (below) |
| Inbox / GPU tray + bins (SQS) | Queue settings → redrive → DLQ | Shallow |
| Archive (S3) | Three prefixes, lifecycle, public access block | Shallow |
| Network (VPC) | Two subnets, route table, internet gateway, security group | Medium |
| Capacity arm (Cluster Autoscaler) | Node group, scale-up / scale-down rules | Shallow |
| Demand lever (KEDA) | Trigger, auth, scaled target | Shallow |
| LAYA gate | Model, three question types, gate and verify thresholds | Medium |
| Idle timer | Timer → four idle checks → shutdown steps | Medium, very visual |
| Clock, latch, terminal | One rule / one action each | Close-up only |

---

## 1. Control tower: EC2 t3.medium + K3s

```
Tower
├─ Instance (t3.medium)
│  ├─ CPU: 2 vCPU Intel Xeon (up to 3.1 GHz), burstable, 24 CPU credits/h      static
│  ├─ Memory: 4 GiB, plus 2 GB swapfile                                          static
│  ├─ Root disk: 30 GB gp3 (OS, job database, model cache for LAYA)              static
│  └─ Nitro hypervisor card                                                      static
├─ Host services (systemd, outside Kubernetes)
│  ├─ Idle timer  → see §11                                                      inferred
│  ├─ Graceful-shutdown hook: on boot resumes GPU launches;                      observed (guard.latch)
│  │   on shutdown sets GPU group to 0 and suspends launches (45 s budget)
│  └─ SSM agent (operator console, §14)                                          exporter
├─ K3s server (single node, SQLite datastore, Traefik off)
│  ├─ Built-ins: CoreDNS, Flannel network, containerd                            static
│  └─ Namespaces: infra · inference · kube-system
├─ Pods: infra namespace
│  ├─ Orchestrator (FastAPI)                                                     inferred (pods.ready)
│  │   ├─ API key guard
│  │   ├─ Job intake: idempotency check → record → store payload → enqueue
│  │   └─ Status endpoint (queue depths, gateway cold/starting/ready)
│  ├─ Job store (SQLite, WAL) shared by orchestrator and worker
│  │   ├─ jobs table (with lease owner and expiry)
│  │   ├─ job_steps table (one row per step attempt)
│  │   └─ outbox table (PENDING → DISPATCHED)
│  ├─ AI worker: two loops run side by side
│  │   ├─ Workflow loop (CPU tier): validate → decide → dispatch to GPU queue
│  │   └─ GPU loop: generate → verify → regenerate once → save → ack
│  ├─ LiteLLM gateway: five model aliases → one served model (qwen-general)
│  └─ LAYA decision service → its own object, §10
├─ Pods: kube-system
│  ├─ Cluster Autoscaler → §8                                                    observed (asg.desired)
│  └─ KEDA operator + ScaledObject → §9                                          exporter
└─ Mock inference (test backend for mock-* aliases)                              not shown publicly
```

Facts: instance type and disk from `terraform/dev/variables.tf:18`, `terraform/modules/control_plane/main.tf:77-134`;
CPU figures from the AWS T3 page; pods from `k8s/orchestrator`, `k8s/worker`, `k8s/litellm`;
job store `services/common/job_store.py:97-168`; worker loops `services/ai_worker/worker.py:902-938`.

**Teardown animation:** roof hatch opens (exists today in `Pods`) → walls lift off as a shell →
three layers separate vertically: host hardware (bottom), K3s + host services (middle), pods (top).
The LAYA gate, idle dial and capacity arm, today placed beside the tower, fly in to their layer to show
they run on this machine. Clicking the worker pod opens its two loops (next section).

### 1a. Inside the worker: the job's steps

The step ids already written to `job_steps` give a precise sub-stage strip for the worker pod:

| Loop | Steps | Notes |
| --- | --- | --- |
| Workflow (CPU) | VALIDATING → DECIDING → WAITING_GPU | Lease 120 s. Decision-only jobs finish here. Below 0.35 relevance → REJECTED. |
| GPU | GENERATING → VERIFYING → (GENERATING → VERIFYING) → COMPLETED / NEEDS_REVIEW | Lease 180 s. At most two generations. Ack only after the result is saved. |

Live today: only `job.*` counts from the queues. Per-step state needs the exporter (Phase D).

## 2. GPU cassette: Auto Scaling group, g5.xlarge

```
Cassette
├─ Instance (g5.xlarge, On-Demand: Spot blocked by an org policy)
│  ├─ GPU: NVIDIA A10G Tensor Core, 24 GB VRAM                                   static
│  ├─ CPU: 4 vCPU AMD EPYC 7R32 · Memory 16 GiB                                  static
│  ├─ Local NVMe: 250 GB, holds container images (lost on stop)                  static
│  └─ Root disk: 80 GB gp3, deleted with the instance                            static
├─ Boot sequence (six steps, each a lamp)                                        inferred from gpu.instance
│  1 read instance metadata · 2 attach model drive · 3 mount it
│  4 check GPU driver · 5 GPU container runtime · 6 join K3s as a tainted GPU node
├─ NVIDIA device plugin (advertises the GPU to Kubernetes)                       exporter
└─ vLLM server → §3                                                               exporter (vllm.state)
Group: min 0 · desired 0/1 · max 1 · pinned to the second AZ                      observed (asg.desired)
```

Facts: `terraform/modules/gpu_nodes/main.tf:53-297`, `k8s/inference/nvidia-device-plugin.yaml`;
hardware from the AWS G5 page.

**Teardown animation:** cassette slides out of the cradle, side panel drops: GPU card, NVMe stick,
root disk and the docked model drive separate. The six boot lamps run along its spine.

## 3. Model core: vLLM

```
vLLM (one replica, scaled 0↔1 by KEDA)
├─ Model: Qwen3-30B-A3B Instruct, AWQ 4-bit, mixture of experts (~3B active)     static
├─ Context window 8,192 tokens · up to 4 sequences at once                       static
├─ VRAM budget: 90% of 24 GB                                                      static
├─ Reads weights from the model drive (mounted read path)                         observed (ebs.attached)
└─ Health: startup ≤ ~10.5 min allowed; load 60–90 s in practice                  exporter
```

Facts: `k8s/inference/vllm.yaml:31-88`. Platform docs say 0.92 VRAM and CUDA graphs; the manifest runs
0.90 with eager mode: code wins.

## 4. Model drive: EBS gp3 50 GB

```
Drive
├─ Volume: 50 GB gp3 · 3,000 IOPS · 125 MiB/s (the gp3 baseline)                 static
├─ Filesystem: ext4, labelled model-cache, formatted only if blank               static
├─ Slot 1: qwen-general: 54 files, 4 weight shards, ~18.1 GB (~35% of disk)       observed when docked
└─ Slot 2: qwen-coder: folder reserved; downloaded only by an optional job,       static ("reserved")
           never served (coding alias points at qwen-general)
```

Facts: `gpu_nodes/main.tf:6-163`, `docs/architecture/ARCHITECTURE-VERIFICATION.md:57,71`;
gp3 baseline from AWS EBS docs. **Teardown:** drive lifts open, the general slot shows four shard bars
filled to 35%, the coder slot hollow and dashed.

## 5. Wake switch: Lambda (Python 3.12, 128 MB, 30 s)

```
Relay
├─ Event router: schedule? → prewarm · EC2 state change? → stop guard · else → HTTP
├─ HTTP handlers
│  ├─ health (open)
│  ├─ wake: start tower if stopped, resume GPU launches                          observed (lambda.invoked)
│  ├─ status: tower state + queue counts
│  └─ jobs: validate → large payload (>128 KB) to S3 → enqueue → wake → 202       observed (ingress.request)
├─ Token check (shared key, constant-time compare)
└─ Stop guard: tower stopping → GPU group to 0, launches suspended               observed (guard.latch)
```

Facts: `services/wake_lambda/handler.py:66-406`, `terraform/modules/serverless_wake/main.tf:100-118`.

## 6. Front door: API Gateway HTTP API

```
Arch
├─ One catch-all route ($default)
├─ Lambda proxy integration (payload format 2.0)
├─ Stage $default, auto-deploy
└─ CORS: any origin; no throttling, no authorizer (the token is checked inside the Lambda)
```

**Correction for the scene:** the arch draws four route lights and the inspector says "Routes: /jobs,
/wake, /status, /health". At the gateway there is one route; the four paths are told apart by the
Lambda's router (§5). The teardown should show a single lane through the arch that splits inside the
relay. Facts: `serverless_wake/main.tf:126-168`.

## 7. Queues: SQS ×4

| Queue | Visibility | Retention | Redrive | Live |
| --- | --- | --- | --- | --- |
| Inbox (workflow) | 300 s (worker uses 120 s per receive) | 1 day | → inbox bin after 3 receives | observed (polled) |
| Inbox bin (DLQ) | default | 14 days | — | observed |
| GPU tray | 360 s, worker extends every 30 s | 1 day | → GPU bin after 3 receives | observed |
| GPU bin (DLQ) | default | 14 days | — | observed |

All: 256 KB max message, client long-polls 2 s, default encryption. **Teardown:** the tray lifts to
show three counters (visible · in flight · delayed, the same three the idle timer reads) and the
redrive chute to its bin labelled "after 3 tries". Facts: `terraform/modules/sqs/main.tf`.

## 8. Capacity arm: Cluster Autoscaler

Node group 0..1 named explicitly · least-waste expander · scale-down after 2 min unneeded and 2 min
after a scale-up · runs pinned on the tower. Can scale from zero because the group carries a node
template (4 CPU, 16 GiB, 1 GPU, GPU taint). Facts: `k8s/autoscaler/cluster-autoscaler.yaml:111-131`.
Platform docs say 10 min; manifest says 2 min (code wins; dashboard already says 2 min).

## 9. Demand lever: KEDA

Trigger: GPU queue, 1 message per replica, counts in-flight · polls 15 s · cooldown 120 s · target the
vLLM deployment 0↔1 · AWS auth via pod identity (falls back to the node role). The KEDA operator
itself is not installed by the repo; only its objects are. Facts: `k8s/keda/scaledobject.yaml:6-46`.

## 10. LAYA gate: decision service

```
Gate
├─ Model: ModernBERT-large, ~421M parameters, one forward pass, 2 CPU threads    static
├─ Question types: yes/no · choice · score
├─ Entry beam: relevance < 0.35 → reject, GPU never wakes (fails open)            exporter (laya.gate)
├─ Exit beam: verify ≥ 0.40 → pass; else one regeneration (fails closed)          exporter (laya.verify)
└─ Latency ~35–50 ms per decision (platform docs)
```

Facts: `k8s/decision_service/deployment.yaml`, `services/ai_worker/worker.py:592-813`.

## 11. Idle timer: systemd watchdog

```
Dial
├─ Timer: first check 10 min after boot, then every 5 min
├─ Four checks, all must be quiet:
│  ├─ both queues: 0 visible, 0 in flight, 0 delayed
│  ├─ job store: 0 live leases, 0 pending outbox
│  ├─ orchestrator: 0 pending, 0 active
│  └─ GPU group: desired 0, no instances
├─ Threshold: 30 min quiet
└─ Shutdown: GPU group to 0 → power off
```

**Teardown:** the dial splits into four quadrant lamps, each one of the checks. Three of the four can
be lit from data we already have (queue counts, GPU group); the job store check needs the exporter.
The platform's docs say the timer runs every 60 s; the unit file says 5 min (code wins).
Facts: `services/control_plane/idle_watchdog.py:84-293`, `k3s-idle-shutdown.timer:4-6`.

## 12. Archive: S3

Three prefixes: inputs (large payloads, deleted after 30 days) · outputs (results) · deployments
(deploy bundle, not shown publicly). All four public-access blocks on. No versioning; default
encryption only. Facts: `terraform/modules/s3/main.tf`.

## 13. Network: VPC

Two public subnets in two AZs sharing one route table to an internet gateway; no NAT gateway; no VPC
endpoints (AWS calls go out through the gateway). One shared security group: everything allowed inside
the VPC, no SSH, API ports closed to the internet by default and blocked at plan time from being opened
to everyone. Facts: `terraform/modules/networking/main.tf`, `control_plane/main.tf:22-63`.
Public copy: no CIDRs.

## 14. Clock, latch, terminal (close-up only)

- **Clock:** one EventBridge cron rule, 06:55 UTC daily → Lambda.
- **Latch:** one EventBridge rule on tower stopping/stopped → Lambda stop guard (§5).
- **Terminal:** Session Manager through the instance role; no key pairs, no SSH; also the deploy path
  (Run Command).

---

## Mismatches found in the dashboard's own copy

| Where | Says | Platform code says |
| --- | --- | --- |
| `components.ts` gateway | Four routes | One `$default` route; the Lambda routes paths |
| `component-spec.md` "Not yet covered" | Wake API has no authoriser | True at the gateway; the Lambda checks a shared token |
| `components.ts` pods | Orchestrator, worker, LiteLLM | Also the job store (SQLite on the host), and LAYA is a pod too |

## Not shown in the teardown

Mock inference, the init-models job, deploy scripts, the K8s secret, Terraform state handling, the
budget. They are test or operational tooling, or would leak operational detail.
