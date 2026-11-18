# Sleepless Twin

An interactive isometric digital twin of the scale-to-zero AI platform on AWS ("My Sleepless Slaves").

- Brief: [docs/brief.html](docs/brief.html)
- Design direction (Phase A): [docs/design.html](docs/design.html)

## Status: Phase B, day-one prototype

Static site, no AWS connection yet. Everything moving on screen comes from **sample traces** generated from the platform's real configuration timings (`web/src/model/timings.ts`). The UI labels them as samples.

- **Live**: shows the platform asleep and says telemetry is not connected yet.
- **Replay**: 7 sample runs (cold GPU job, LAYA reject, decision-only, verification failure, retries to DLQ, pre-warm with no work, warm second job), with timeline, speed, stepping and captions.
- **Explore**: click or Tab through any object for a plain-language and an engineering explanation.

## Run

```bash
cd web
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # reducer, scenario invariants, replay seek
pnpm build
```

## How it works

```
TwinEvent[] ──> reduce() ──> WorldState ──> scene objects ease toward it each frame
   (sample traces now,         (pure, idempotent,     (procedural boxes in web/src/scene)
    AWS telemetry later)        shared by Live and Replay)
```

- `web/src/model/`: event schema, reducer, replay timeline (long waits compressed and marked).
- `web/src/data/scenarios.ts`: sample trace generator.
- `web/src/scene/`: procedural isometric kit and every object.
- `web/src/content/`: inspector copy and captions. Public-safe: no IDs or URLs.

## Phase C: real telemetry (built, not yet deployed)

```
EventBridge (EC2 state, Spot warning, GPU launch failure) ─┐
EventBridge schedule, 1 min (queues, GPU group, latch) ────┼─> Lambda telemetry ─> DynamoDB (events, runs)
                                                           │      (concurrency 1)  └─> S3 live.json, runs/*.json
EventBridge schedule, daily ──> Lambda costs (Cost Explorer, Pricing API) ───────────> S3 costs.json
                                                                       CloudFront (GET only, CORS) ─> site
```

- `telemetry/`: Python 3.12 Lambdas. Every published document passes an allowlist and a scanner that blocks ARNs, account ids, resource ids, IPs and URLs (`twin/redact.py`).
- `infra/`: Terraform for the twin's own resources. Platform resources are only looked up by name; none are modified.
- A *run* is one wake session of the control plane.
- What is observed vs inferred today: control-plane and GPU instance states, queue depths, GPU group capacity and launch lock are **observed**. Pod readiness is **inferred** (40 s after the host runs). KEDA, vLLM and job identities need the in-cluster exporter (Phase D) and are not shown live.
- Freshness depends on the source: EC2 state changes arrive in seconds; queue counts and GPU group size are polled each minute, so up to about 75 s behind. Each object's inspector says which applies.
- Per-object contract (source, states, freshness, connections, fallback): [docs/component-spec.md](docs/component-spec.md).

### Local check without AWS

```bash
cd telemetry && uv run --group dev pytest
uv run --group dev python scripts/make_fixture.py ../web/public/dev-data
cd ../web && pnpm dev --mode fixture   # Live and Replay read the fixture files
```

### Deploy (needs AWS credentials; creates resources)

```bash
cd infra
terraform init
terraform plan -out twin.plan
terraform apply twin.plan
```

Then build the site with `VITE_TWIN_DATA_URL` set to the `data_base_url` output, and add the site's origin to `allowed_origins`.

The ingest Lambda (Phase D) refuses all input until its two secrets are set. Set each once with a random value; Terraform never holds them:

```powershell
foreach ($n in (terraform output -json ingest_secret_params | ConvertFrom-Json)) { $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); aws ssm put-parameter --name $n --type SecureString --overwrite --value ([Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')) | Out-Null }
```

`terraform output ingest_url` is a write endpoint: it goes only into the exporter's configuration, never into the site or this repository. Expected running cost is well under $5/month (Lambda and EventBridge within free tier, CloudFront and S3 cents, Cost Explorer about $0.90 for three requests a day). Billed figures are shown as usage before credits, with credits on their own line.

## Phase D: application-level telemetry

- `telemetry/twin/ingest.py`: ingest Lambda (signed exporter batches, wake Lambda log lines). Deployed.
- Wake Lambda log subscription (five fixed phrases). Deployed.
- `exporter/`: read-only in-cluster exporter for job steps and pod, KEDA, vLLM and autoscaler state. Built and tested; the owner deploys it, see [exporter/README.md](exporter/README.md).
- Spec and as-built notes: [docs/phase-d-spec.md](docs/phase-d-spec.md).

```bash
cd exporter && uv run --group dev pytest   # exporter, end to end through ingest and telemetry
```

## Rules

See [CLAUDE.md](CLAUDE.md). The platform repository is read-only reference material.
