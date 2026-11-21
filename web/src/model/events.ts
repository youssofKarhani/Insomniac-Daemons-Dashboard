import { z } from "zod";

/**
 * Every visual change in the dashboard is caused by one of these events.
 * Kinds follow the real job lifecycle of the platform (see docs/brief.html, section 03).
 * `confidence` says whether the source observed the moment directly or the dashboard derived it.
 */
export const EVENT_KINDS = [
  "ingress.request", // API Gateway received a request. data.route
  "ingress.prewarm", // EventBridge 06:55 UTC cron fired
  "lambda.invoked", // Wake Lambda ran. data.action: enqueue | wake | status
  "job.enqueued", // data.queue: workflow | gpu
  "cp.state", // control-plane EC2 state. data.state: pending | running | stopping | stopped
  "pods.ready", // K3s pods on the control plane are serving. data.ready
  "job.dequeued", // worker received the message. data.queue
  "laya.gate", // LAYA triage. data.result: pass | reject | decision, data.probability
  "keda.scale", // KEDA set vLLM replicas. data.replicas: 0 | 1
  "vllm.state", // data.state: absent | pending | loading | ready
  "asg.desired", // GPU ASG desired capacity. data.desired, data.by
  "gpu.instance", // data.state: launching | running | terminating | terminated | launch_failed, data.market
  "ebs.attached", // model cache volume. data.attached
  "node.joined", // GPU node registered with K3s. data.joined
  "job.generate", // worker called LiteLLM -> vLLM. data.attempt
  "laya.verify", // LAYA checked the output. data.attempt, data.passed
  "job.failed", // processing error; message returns to its queue. data.queue, data.receiveCount
  "job.dlq", // message moved to a dead-letter queue. data.queue
  "job.finished", // data.outcome: completed | rejected | needs_review | decided
  "s3.result", // result object written under outputs/
  "spot.warning", // EC2 Spot interruption warning
  "watchdog.idle", // idle watchdog started (data.idle=true) or reset (false) its timer
  "guard.latch", // EventBridge stop guard: ASG launches suspended (data.locked)
  "ssm.session", // operator session open/closed. data.open
  "queue.depth", // polled counts. data.queue: workflow | gpu | workflowDlq | gpuDlq, data.visible, data.inFlight
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const Primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const DashboardEventSchema = z.object({
  id: z.string().min(1),
  ts: z.number().int().nonnegative(), // source time, ms since epoch
  kind: z.enum(EVENT_KINDS),
  confidence: z.enum(["observed", "inferred"]),
  jobId: z.string().optional(),
  data: z.record(Primitive).default({}),
});

export type DashboardEvent = z.infer<typeof DashboardEventSchema>;
export type Confidence = DashboardEvent["confidence"];

export function parseEvents(raw: unknown): DashboardEvent[] {
  return z.array(DashboardEventSchema).parse(raw);
}

/** Stable order: source time, then id. Used by replay and by live ingestion. */
export function sortEvents(events: readonly DashboardEvent[]): DashboardEvent[] {
  return [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function str(e: DashboardEvent, key: string, fallback = ""): string {
  const v = e.data[key];
  return typeof v === "string" ? v : fallback;
}
export function num(e: DashboardEvent, key: string, fallback = 0): number {
  const v = e.data[key];
  return typeof v === "number" ? v : fallback;
}
export function bool(e: DashboardEvent, key: string, fallback = false): boolean {
  const v = e.data[key];
  return typeof v === "boolean" ? v : fallback;
}
