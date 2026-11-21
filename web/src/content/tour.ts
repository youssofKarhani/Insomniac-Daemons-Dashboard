import type { EventKind, DashboardEvent } from "../model/events";
import { CONFIG } from "../model/timings";
import type { ObjectId } from "./components";

/**
 * Guided tour (Phase D step 5). Each stop plays a SAMPLE scenario up to one
 * event and frames one object. Stops are anchored to an event rather than a
 * fixed second, so they stay right when sample durations change.
 * Public-safe: plain descriptions only, no identifiers.
 */
export interface TourStop {
  /** Object the camera frames and the inspector opens; null frames the whole desk. */
  objectId: ObjectId | null;
  /** A panel to highlight instead of (or as well as) an object. */
  panel?: "ledger";
  title: string;
  caption: string;
  scenario: string;
  /** The stop lands just after the first event of this kind that matches. "end" means the end of the run. */
  anchor: { kind: EventKind; match?: (e: DashboardEvent) => boolean } | "end";
}

const min = (s: number) => `${Math.round(s / 60)} minutes`;

export const TOUR: TourStop[] = [
  {
    objectId: "gateway",
    title: "The front door",
    caption:
      "Everything starts with a request. The front door is serverless, so it is open around the clock while every machine behind it is switched off.",
    scenario: "cold-gpu",
    anchor: { kind: "ingress.request" },
  },
  {
    objectId: "workflowQueue",
    title: "The inbox",
    caption:
      "The wake switch files the job in the inbox and turns the control tower on. The job simply waits here; nothing is lost while the tower boots.",
    scenario: "cold-gpu",
    anchor: { kind: "job.enqueued", match: (e: DashboardEvent) => e.data.queue === "workflow" },
  },
  {
    objectId: "laya",
    title: "LAYA's gate",
    caption:
      "Before any GPU is used, LAYA scores the job on cheap CPU. In this sample it rejects a job posting as irrelevant, so the expensive part never wakes.",
    scenario: "laya-reject",
    anchor: { kind: "laya.gate" },
  },
  {
    objectId: "gpuQueue",
    title: "The GPU queue",
    caption: "A job that passes the gate moves to the GPU queue. This queue is the only thing that can call for a GPU.",
    scenario: "cold-gpu",
    anchor: { kind: "job.enqueued", match: (e: DashboardEvent) => e.data.queue === "gpu" },
  },
  {
    objectId: "keda",
    title: "The demand lever",
    caption: `KEDA checks the GPU queue every ${CONFIG.kedaPollSeconds} seconds. Seeing work, it asks for one model server, which has nowhere to run yet.`,
    scenario: "cold-gpu",
    anchor: { kind: "keda.scale", match: (e: DashboardEvent) => Number(e.data.replicas) > 0 },
  },
  {
    objectId: "autoscaler",
    title: "The capacity arm",
    caption: "The cluster autoscaler sees a model server with no machine and orders one GPU machine from AWS.",
    scenario: "cold-gpu",
    anchor: { kind: "asg.desired", match: (e: DashboardEvent) => Number(e.data.desired) > 0 },
  },
  {
    objectId: "gpuNode",
    title: "The cassette arrives",
    caption:
      "The GPU machine slides into its cradle. From this moment it is billed by the second, which is why everything else works so hard to keep it away.",
    scenario: "cold-gpu",
    anchor: { kind: "gpu.instance", match: (e: DashboardEvent) => e.data.state === "running" },
  },
  {
    objectId: "vllm",
    title: "The model core",
    caption: `The model loads from the drive and the core lights up. From an idle platform to a ready model takes about ${CONFIG.coldStartSeconds[0]}–${CONFIG.coldStartSeconds[1]} seconds of GPU start, after the tower itself has booted.`,
    scenario: "cold-gpu",
    anchor: { kind: "vllm.state", match: (e: DashboardEvent) => e.data.state === "ready" },
  },
  {
    objectId: "laya",
    title: "LAYA verifies",
    caption: "Qwen writes the answer, and LAYA checks it before anything is kept. A weak answer is written again; repeated failures are stored for a human to review.",
    scenario: "cold-gpu",
    anchor: { kind: "laya.verify" },
  },
  {
    objectId: "s3",
    title: "The archive",
    caption: "The verified result goes into the archive. The job is done; the machines don't know that yet.",
    scenario: "cold-gpu",
    anchor: { kind: "s3.result" },
  },
  {
    objectId: "gpuNode",
    title: "Cooldown and scale-down",
    caption: `After ${CONFIG.kedaCooldownSeconds / 60} quiet minutes KEDA lets the model server go, and ${CONFIG.caScaleDownSeconds / 60} minutes later the autoscaler sends the GPU machine away. GPU billing stops.`,
    scenario: "cold-gpu",
    anchor: { kind: "gpu.instance", match: (e: DashboardEvent) => e.data.state === "terminated" },
  },
  {
    objectId: "watchdog",
    title: "The idle timer",
    caption: `With both queues empty, the idle timer runs for ${min(CONFIG.watchdogIdleSeconds)}, then switches the tower off. The stop guard locks GPU launches so nothing wakes by accident.`,
    scenario: "cold-gpu",
    anchor: { kind: "cp.state", match: (e: DashboardEvent) => e.data.state === "stopped" },
  },
  {
    objectId: null,
    panel: "ledger",
    title: "The asleep floor",
    caption:
      "Asleep, compute costs nothing. What remains is storage: the disks and snapshots that let the platform wake up where it left off. The ledger shows that floor next to the cost of each run.",
    scenario: "cold-gpu",
    anchor: "end",
  },
];

/** Source time a stop lands on, or null if its scenario has no matching event. */
export function stopTime(stop: TourStop, events: readonly DashboardEvent[]): number | null {
  if (stop.anchor === "end") return events.length ? events[events.length - 1].ts : null;
  const { kind, match } = stop.anchor;
  const e = events.find((x) => x.kind === kind && (!match || match(x)));
  return e ? e.ts : null;
}
