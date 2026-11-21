# Dashboard exporter (Phase D step 4)

A read-only pod on the control plane that tells the dashboard what AWS cannot see: job steps
(from the platform's SQLite job store) and pod, KEDA, vLLM, GPU-node and autoscaler state
(from the Kubernetes API). Spec: [docs/phase-d-spec.md](../docs/phase-d-spec.md), section 3.

- `exporter.py`: the whole program, standard library only. Runs from a ConfigMap on a stock
  `python:3.12-slim` image pinned by digest, so there is nothing to build or push.
- `k8s/`: namespace, read-only RBAC, Deployment. `kustomization.yaml` ties them together.
- `tests/`: runs against a WAL-mode SQLite file with the platform's schema, and end to end
  through the dashboard's real ingest and telemetry code.

## What it reads, and what it never reads

| Source | Read | Never read |
| --- | --- | --- |
| `jobs.db` (read-only mount, `mode=ro`) | `job_steps`: job id, step, attempt, state, timestamps. `jobs`: job id, job type, status, whether a result exists | payloads, results, result keys, step outputs, errors, idempotency keys, leases, the outbox |
| Kubernetes API (`get`, `list`) | Deployments in `personal-ai-infra` and `vllm-inference`; vLLM pods; nodes labelled `g5.xlarge`; autoscaler `TriggeredScaleUp` / `ScaleDown` events | secrets, configmaps, logs, anything writable |

Raw job ids leave the pod only inside signed batches to the dashboard's ingest Lambda, which
replaces them with pseudonyms before anything is stored.

## Effect on the platform

- Writes nothing to the cluster or the database. Does not touch SQS, leases, the outbox or the
  GPU group, so the idle watchdog is unaffected and it can never keep the platform awake.
- 25m CPU / 48 Mi requested, 100m / 96 Mi limit.

## Before deploying: test on a dev cluster

The job store runs in WAL mode. A read-only connection on a read-only mount works only while
the `-wal` and `-shm` files exist, which they do while the orchestrator and worker hold the
database open. Check on a dev cluster that:

1. The pod starts and logs `dashboard exporter started`, then no `job store unavailable` warning
   while the platform pods run.
2. The pod (uid 65534) can read `/data/jobs.db`, `jobs.db-wal` and `jobs.db-shm`. If not,
   `ls -l /var/lib/personal-ai/data` on the node shows the modes; the files need to be
   world-readable, or the pod's `runAsGroup` must match their group.
3. Submitting one job of each outcome shows its steps in the dashboard's `live.json` within
   about 30 s, with `exporterAt` updating every minute.
4. With both queues empty, the tower still stops after 30 idle minutes.

## Deploy (owner)

Run from this repository with `kubectl` pointed at the cluster (for example through the
usual SSM port forward). The Secret holds the ingest URL and the HMAC key; neither is ever
committed.

```powershell
kubectl create namespace sleepless-twin --dry-run=client -o yaml | kubectl apply -f -
```

```powershell
kubectl -n sleepless-twin create secret generic twin-exporter --from-literal=INGEST_URL="$(terraform -chdir=infra output -raw ingest_url)" --from-literal=HMAC_KEY="$(aws ssm get-parameter --name /sleepless-twin/ingest-hmac --with-decryption --query Parameter.Value --output text)"
```

```powershell
kubectl apply -k exporter
```

Turn it off: `kubectl -n sleepless-twin scale deploy/twin-exporter --replicas=0`.
Remove it: `kubectl delete -k exporter` and `kubectl delete namespace sleepless-twin`.
Rotate the key: write a new value to the SSM parameter, recreate the Secret, then
`kubectl -n sleepless-twin rollout restart deploy/twin-exporter`.

## Tests

```powershell
cd exporter; uv run --group dev pytest
```
