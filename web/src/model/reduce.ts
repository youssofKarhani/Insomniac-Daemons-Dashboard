import { bool, num, str, type TwinEvent } from "./events";
import { QUEUE_LOCATION, namedPerQueue, type CpState, type GpuState, type JobLocation, type JobView, type Market, type Outcome, type QueueName, type VllmState, type WorldState } from "./state";

const GPU_BILLED: GpuState[] = ["launching", "running", "terminating"];

function upsertJob(s: WorldState, e: TwinEvent): JobView | undefined {
  if (!e.jobId) return undefined;
  const existing = s.jobs[e.jobId];
  if (existing) return { ...existing };
  return {
    id: e.jobId,
    jobType: str(e, "jobType", "job"),
    location: "arch",
    step: "arrived",
    inFlight: false,
    attempts: 0,
    receiveCount: 0,
    enqueuedAt: e.ts,
    seq: s.seq,
    hops: [],
  };
}

function move(s: WorldState, job: JobView, location: JobLocation, at: number): JobView {
  if (job.location !== location) {
    s.seq += 1;
    job.seq = s.seq;
    job.location = location;
  }
  const last = job.hops[job.hops.length - 1];
  if (!last || last.to !== location) job.hops = [...job.hops, { to: location, at }];
  return job;
}

/**
 * Pure reducer shared by Live and Replay. Idempotent by event id.
 * Returns a new state object; unchanged branches are shared.
 */
export function reduce(prev: WorldState, e: TwinEvent): WorldState {
  if (prev.seen[e.id]) return prev;
  const s: WorldState = {
    ...prev,
    seen: { ...prev.seen, [e.id]: true },
    lastEventId: e.id,
    lastEventTs: e.ts,
    t: Math.max(prev.t, e.ts),
  };

  switch (e.kind) {
    case "ingress.request": {
      s.pulses = { ...s.pulses, gateway: e.ts, route: str(e, "route", "/jobs") };
      const job = upsertJob(s, e);
      if (job) s.jobs = { ...s.jobs, [job.id]: move(s, job, "arch", e.ts) };
      break;
    }
    case "ingress.prewarm":
      s.pulses = { ...s.pulses, clock: e.ts };
      break;
    case "lambda.invoked":
      s.pulses = { ...s.pulses, lambda: e.ts };
      break;
    case "job.enqueued": {
      const job = upsertJob(s, e);
      if (!job) break;
      const gpu = str(e, "queue") === "gpu";
      job.step = gpu ? "waiting_gpu" : "queued";
      job.inFlight = false;
      s.jobs = { ...s.jobs, [job.id]: move(s, job, gpu ? "gpuQueue" : "workflow", e.ts) };
      break;
    }
    case "job.dequeued": {
      const job = upsertJob(s, e);
      if (!job) break;
      if (str(e, "queue") === "gpu") {
        job.inFlight = true;
        s.jobs = { ...s.jobs, [job.id]: move(s, job, "gpuQueue", e.ts) };
      } else {
        job.step = "picked";
        s.jobs = { ...s.jobs, [job.id]: move(s, job, "worker", e.ts) };
      }
      break;
    }
    case "laya.gate": {
      const job = upsertJob(s, e);
      if (!job) break;
      job.step = "scanning";
      const r = str(e, "result");
      job.gate = r === "reject" ? "reject" : r === "decision" ? "decision" : "pass";
      s.jobs = { ...s.jobs, [job.id]: move(s, job, "laya", e.ts) };
      break;
    }
    case "job.generate": {
      const job = upsertJob(s, e);
      if (!job) break;
      job.step = "generating";
      job.inFlight = false;
      job.attempts = Math.max(job.attempts, num(e, "attempt", job.attempts + 1));
      s.jobs = { ...s.jobs, [job.id]: move(s, job, "core", e.ts) };
      break;
    }
    case "laya.verify": {
      const job = upsertJob(s, e);
      if (!job) break;
      job.step = "verifying";
      job.verifyPassed = bool(e, "passed");
      s.jobs = { ...s.jobs, [job.id]: move(s, job, "laya", e.ts) };
      s.gpu = { ...s.gpu, lastWorkAt: e.ts };
      break;
    }
    case "job.failed": {
      const job = upsertJob(s, e);
      if (!job) break;
      const gpu = str(e, "queue") === "gpu";
      job.step = "retrying";
      job.inFlight = false;
      job.receiveCount = Math.max(job.receiveCount, num(e, "receiveCount", job.receiveCount));
      s.jobs = { ...s.jobs, [job.id]: move(s, job, gpu ? "gpuQueue" : "workflow", e.ts) };
      if (gpu) s.gpu = { ...s.gpu, lastWorkAt: e.ts };
      break;
    }
    case "job.dlq": {
      const job = upsertJob(s, e);
      if (!job) break;
      const gpu = str(e, "queue") === "gpu";
      job.step = "done";
      job.outcome = "dlq";
      job.finishedAt = e.ts;
      s.jobs = { ...s.jobs, [job.id]: move(s, job, gpu ? "gpuDlq" : "workflowDlq", e.ts) };
      s.counters = { ...s.counters, dlq: s.counters.dlq + 1 };
      break;
    }
    case "job.finished": {
      const job = upsertJob(s, e);
      if (!job) break;
      const outcome = str(e, "outcome", "completed") as Outcome;
      job.step = "done";
      job.outcome = outcome;
      job.finishedAt = e.ts;
      if (job.archiveSlot === undefined) job.archiveSlot = s.archived++;
      s.jobs = { ...s.jobs, [job.id]: move(s, job, "crate", e.ts) };
      s.counters = { ...s.counters, [outcome]: s.counters[outcome] + 1 };
      if (job.attempts > 0) s.gpu = { ...s.gpu, lastWorkAt: e.ts };
      break;
    }
    case "s3.result":
      s.pulses = { ...s.pulses, crate: e.ts };
      break;
    case "cp.state": {
      const next = str(e, "state", "stopped") as CpState;
      if (next === s.cp.state) break;
      const runtime = { ...s.runtime };
      if (s.cp.state !== "stopped") runtime.cpMs += Math.max(0, e.ts - s.cp.since);
      s.runtime = runtime;
      s.cp = {
        ...s.cp,
        state: next,
        since: e.ts,
        podsReady: next === "running" ? s.cp.podsReady : false,
      };
      if (next !== "running") s.watchdogIdleSince = undefined;
      break;
    }
    case "pods.ready":
      s.cp = { ...s.cp, podsReady: bool(e, "ready", true), podsConfidence: e.confidence };
      break;
    case "keda.scale":
      s.keda = { replicas: num(e, "replicas") > 0 ? 1 : 0, since: e.ts };
      break;
    case "vllm.state":
      s.vllm = { state: str(e, "state", "absent") as VllmState, since: e.ts, confidence: e.confidence };
      break;
    case "asg.desired":
      s.asg = { desired: num(e, "desired") > 0 ? 1 : 0, by: str(e, "by", "unknown"), since: e.ts };
      break;
    case "gpu.instance": {
      const raw = str(e, "state", "none");
      const next: GpuState = raw === "terminated" ? "none" : (raw as GpuState);
      const runtime = { ...s.runtime };
      if (GPU_BILLED.includes(s.gpu.state)) runtime.gpuMs += Math.max(0, e.ts - s.gpu.since);
      s.runtime = runtime;
      const gone = next === "terminating" || next === "launch_failed" || next === "none";
      s.gpu = {
        ...s.gpu,
        state: next,
        since: e.ts,
        market: (str(e, "market") as Market) || s.gpu.market,
        ebsAttached: gone ? false : s.gpu.ebsAttached,
        joined: gone ? false : s.gpu.joined,
        spotWarningAt: next === "launching" ? undefined : s.gpu.spotWarningAt,
      };
      break;
    }
    case "ebs.attached":
      s.gpu = { ...s.gpu, ebsAttached: bool(e, "attached", true) };
      break;
    case "node.joined":
      s.gpu = { ...s.gpu, joined: bool(e, "joined", true) };
      break;
    case "spot.warning":
      s.gpu = { ...s.gpu, spotWarningAt: e.ts };
      break;
    case "watchdog.idle":
      s.watchdogIdleSince = bool(e, "idle", true) ? e.ts : undefined;
      break;
    case "guard.latch":
      s.guardLocked = bool(e, "locked", true);
      break;
    case "ssm.session":
      s.ssmOpen = bool(e, "open", true);
      break;
    case "queue.depth": {
      const q = str(e, "queue") as QueueName;
      if (!(q in s.queueDepth)) break;
      s.queueDepth = { ...s.queueDepth, [q]: { visible: Math.max(0, num(e, "visible")), inFlight: Math.max(0, num(e, "inFlight")) } };
      break;
    }
  }
  reconcileAnon(s, e.ts, e.kind === "queue.depth");
  return s;
}

/** At most this many unnamed tickets per queue are drawn. */
export const MAX_ANON = 6;
/** Unnamed tickets kept after they reach the archive (older ones are deep in its pile). */
const MAX_ARCHIVED_ANON = 30;
const QUEUES: QueueName[] = ["workflow", "gpu", "workflowDlq", "gpuDlq"];

/**
 * Keeps one unnamed ticket for each polled message no named job accounts for. Only a depth
 * poll can add tickets; job events can only retire them, so a job finishing before the next
 * poll never makes a phantom ticket appear.
 */
function reconcileAnon(s: WorldState, ts: number, allowGrow: boolean) {
  const named = namedPerQueue(s.jobs);
  let anon = s.anon;
  const edit = () => {
    if (anon === s.anon) anon = { ...s.anon };
  };
  for (const q of QUEUES) {
    const loc = QUEUE_LOCATION[q];
    const d = s.queueDepth[q];
    const want = Math.max(0, Math.min(MAX_ANON, d.visible + d.inFlight - named[q]));
    const active = Object.values(anon)
      .filter((a) => a.queue === q && a.location === loc)
      .sort((a, b) => a.seq - b.seq);
    for (let i = active.length; allowGrow && i < want; i += 1) {
      edit();
      s.seq += 1;
      s.anonSeq += 1;
      const id = `anon-${q}-${s.anonSeq}`;
      const t: JobView = { id, jobType: "unknown", location: loc, step: "queued", inFlight: false, attempts: 0, receiveCount: 0, enqueuedAt: ts, seq: s.seq, hops: [{ to: loc, at: ts }], queue: q };
      anon[id] = t;
      active.push(t);
    }
    // The oldest leave first, along the belts to the archive.
    while (active.length > want) {
      const a = active.shift()!;
      edit();
      s.seq += 1;
      anon[a.id] = { ...a, location: "crate", step: "done", inFlight: false, finishedAt: ts, seq: s.seq, archiveSlot: s.archived++, hops: [...a.hops, { to: "crate", at: ts }] };
    }
    // The oldest messages are the ones a worker holds.
    active.forEach((a, i) => {
      const held = i < d.inFlight;
      if (anon[a.id].inFlight !== held) {
        edit();
        anon[a.id] = { ...anon[a.id], inFlight: held };
      }
    });
  }
  const archived = Object.values(anon).filter((a) => a.location === "crate");
  if (archived.length > MAX_ARCHIVED_ANON) {
    edit();
    archived.sort((a, b) => a.seq - b.seq);
    for (const a of archived.slice(0, archived.length - MAX_ARCHIVED_ANON)) delete anon[a.id];
  }
  s.anon = anon;
}

export function reduceAll(events: readonly TwinEvent[], start: WorldState): WorldState {
  let s = start;
  for (const e of events) s = reduce(s, e);
  return s;
}
