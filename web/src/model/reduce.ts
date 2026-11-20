import { bool, num, str, type TwinEvent } from "./events";
import type { CpState, GpuState, JobLocation, JobView, Market, Outcome, QueueName, VllmState, WorldState } from "./state";

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
  return s;
}

export function reduceAll(events: readonly TwinEvent[], start: WorldState): WorldState {
  let s = start;
  for (const e of events) s = reduce(s, e);
  return s;
}
