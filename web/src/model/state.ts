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

export type Outcome = "completed" | "rejected" | "needs_review" | "decided" | "dlq";

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
    counters: { completed: 0, rejected: 0, needs_review: 0, decided: 0, dlq: 0 },
    runtime: { gpuMs: 0, cpMs: 0 },
    seen: {},
    seq: 0,
  };
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
