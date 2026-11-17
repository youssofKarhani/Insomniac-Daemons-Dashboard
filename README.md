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

## Rules

See [CLAUDE.md](CLAUDE.md). The platform repository is read-only reference material.
