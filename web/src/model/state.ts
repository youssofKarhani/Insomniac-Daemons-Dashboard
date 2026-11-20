import type { Confidence } from "./events";

export type CpState = "stopped" | "pending" | "running" | "stopping";
export type GpuState = "none" | "launching" | "running" | "terminating" | "launch_failed";
export type VllmState = "absent" | "pending" | "loading" | "ready";
export type Market = "on-demand" | "spot";

/** Where a job's ticket sits in the scene. Each maps to an anchor in the world layout. */
export type JobLocation =
  | "arch"
  | "workflow"
  | "worker"
  | "laya"
  | "gpuQueue"
  | "core"
  | "crate"
  | "workflowDlq"
  | "gpuDlq";

export type JobStep =
  | "arrived"
  | "queued"
  | "picked"
  | "scanning"
  | "waiting_gpu"
  | "generating"
  | "verifying"
  | "retrying"
  | "done";

export type QueueName = "workflow" | "gpu" | "workflowDlq" | "gpuDlq";
export const QUEUE_LOCATION: Record<QueueName, JobLocation> = {
  workflow: "workflow",
  gpu: "gpuQueue",
  workflowDlq: "workflowDlq",
  gpuDlq: "gpuDlq",
};

/**
 * Named jobs whose message still counts in each queue's depth: waiting in the tray, or
 * held in flight by the worker (being scanned, waiting for or using the GPU). Live
 * telemetry draws unnamed tickets only for depth beyond these, so no job appears twice.
 */
const HELD_AT: Record<QueueName, JobLocation[]> = {
  workflow: ["workflow", "worker", "laya"],
  gpu: ["gpuQueue", "core"],
  workflowDlq: ["workflowDlq"],
  gpuDlq: ["gpuDlq"],
};

export function namedPerQueue(jobs: Record<string, JobView>): Record<QueueName, number> {
  const out: Record<QueueName, number> = { workflow: 0, gpu: 0, workflowDlq: 0, gpuDlq: 0 };
  for (const j of Object.values(jobs)) {
    for (const q of Object.keys(HELD_AT) as QueueName[]) {
      if (HELD_AT[q].includes(j.location) && (j.step !== "done" || q === "workflowDlq" || q === "gpuDlq")) out[q] += 1;
    }
  }
  return out;
}

export type Outcome ="completed" | "rejected" | "needs_review" | "decided" | "dlq";

/** One move of a job's ticket: where it went and the source time of the event that moved it. */
export interface Hop {
  to: JobLocation;
  at: number;
}

export interface JobView {
  id: string;
  jobType: string;
  location: JobLocation;
  step: JobStep;
  /** True while a GPU-queue message is held by the worker but not yet being generated. */
  inFlight: boolean;
  gate?: "pass" | "reject" | "decision";
  attempts: number;
  receiveCount: number;
  verifyPassed?: boolean;
  outcome?: Outcome;
  enqueuedAt: number;
  finishedAt?: number;
  /** Order within its location, for stacking tickets. */
  seq: number;
  /** Every move so far, oldest first. The scene replays them along the belts. */
  hops: Hop[];
  /** Set on unnamed tickets: the queue whose polled depth they stand for. */
  queue?: QueueName;
  /** Its place in the archive's pile, numbered in arrival order and never reused. */
  archiveSlot?: number;
}

export interface WorldState {
  /** Source time of the playhead (ms). Set by the caller after reducing. */
  t: number;
  cp: { state: CpState; since: number; podsReady: boolean; podsConfidence: Confidence };
  gpu: {
    state: GpuState;
    since: number;
    market: Market;
    ebsAttached: boolean;
    joined: boolean;
    spotWarningAt?: number;
    /** Source time of the last finished GPU work, for the cooldown ring. */
    lastWorkAt?: number;
  };
  vllm: { state: VllmState; since: number; confidence: Confidence };
  asg: { desired: 0 | 1; by: string; since: number };
  keda: { replicas: 0 | 1; since: number };
  guardLocked: boolean;
  watchdogIdleSince?: number;
  ssmOpen: boolean;
  /** Last time each always-on piece flashed. */
  pulses: { gateway?: number; route?: string; lambda?: number; clock?: number; crate?: number };
  jobs: Record<string, JobView>;
  /**
   * Unnamed tickets for polled depth beyond the named jobs. They ride in from the front door
   * when the depth rises and leave for the archive when it falls, like any other ticket.
   */
  anon: Record<string, JobView>;
  anonSeq: number;
  /** Tickets that have reached the archive so far (the next archive slot). */
  archived: number;
  /** Polled queue counts. Live telemetry knows how many messages wait, not which jobs they are. */
  queueDepth: Record<QueueName, { visible: number; inFlight: number }>;
  counters: Record<Outcome, number>;
  /** Accumulated running seconds, for cost estimates. */
  runtime: { gpuMs: number; cpMs: number };
  lastEventId?: string;
  lastEventTs?: number;
  seen: Record<string, true>;
  seq: number;
}

export function initialState(t = 0): WorldState {
  return {
    t,
    cp: { state: "stopped", since: t, podsReady: false, podsConfidence: "inferred" },
    gpu: { state: "none", since: t, market: "on-demand", ebsAttached: false, joined: false },
    vllm: { state: "absent", since: t, confidence: "inferred" },
    asg: { desired: 0, by: "initial", since: t },
    keda: { replicas: 0, since: t },
    guardLocked: true,
    ssmOpen: false,
    pulses: {},
    jobs: {},
    anon: {},
    anonSeq: 0,
    archived: 0,
    queueDepth: {
      workflow: { visible: 0, inFlight: 0 },
      gpu: { visible: 0, inFlight: 0 },
      workflowDlq: { visible: 0, inFlight: 0 },
      gpuDlq: { visible: 0, inFlight: 0 },
    },
    counters: { completed: 0, rejected: 0, needs_review: 0, decided: 0, dlq: 0 },
    runtime: { gpuMs: 0, cpMs: 0 },
    seen: {},
    seq: 0,
  };
}

/** The world as seen at time `now`: the reduced state with its clock moved forward. */
export function worldAt(w: WorldState, now: number): WorldState {
  return w.t === now ? w : { ...w, t: now };
}

/** Pulses, travelling signals and tickets riding the belts finish within this long after their event. */
export const MOTION_AFTER_EVENT_MS = 10_000;

/**
 * True when nothing in the scene moves with time: everything is off and the last event and
 * pulse are long enough ago that their animations have finished. Live then needs to advance
 * its clock only for the text that counts time ("Asleep for 2 h").
 */
export function isStill(w: WorldState, now: number): boolean {
  if (w.cp.state !== "stopped" || w.gpu.state !== "none" || w.vllm.state !== "absent") return false;
  const recent = (t?: number) => t !== undefined && now - t < MOTION_AFTER_EVENT_MS;
  const p = w.pulses;
  return !recent(w.lastEventTs) && !recent(p.clock) && !recent(p.gateway) && !recent(p.lambda) && !recent(p.crate);
}

/** Running time including the open interval up to `t`. */
export function runtimeAt(s: WorldState, t: number): { gpuMs: number; cpMs: number } {
  const gpuOpen = s.gpu.state === "running" || s.gpu.state === "terminating" || s.gpu.state === "launching";
  const cpOpen = s.cp.state !== "stopped";
  return {
    gpuMs: s.runtime.gpuMs + (gpuOpen ? Math.max(0, t - s.gpu.since) : 0),
    cpMs: s.runtime.cpMs + (cpOpen ? Math.max(0, t - s.cp.since) : 0),
  };
}
