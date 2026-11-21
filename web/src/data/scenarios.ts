import type { EventKind, DashboardEvent } from "../model/events";
import { CONFIG, SAMPLE } from "../model/timings";

/**
 * Sample traces generated from scenario specs, using timings copied from the
 * platform's config (CONFIG) and placeholder durations (SAMPLE).
 * These are SAMPLE data, labelled as such in the UI, until real runs are recorded.
 */

type Data = DashboardEvent["data"];

class Trace {
  readonly events: DashboardEvent[] = [];
  private n = 0;
  constructor(private readonly prefix: string, public t: number) {}

  /** Advance the clock by `seconds`, then emit. */
  at(seconds: number, kind: EventKind, data: Data = {}, opts: { jobId?: string; inferred?: boolean } = {}) {
    this.t += Math.round(seconds * 1000);
    this.n += 1;
    this.events.push({
      id: `${this.prefix}-${String(this.n).padStart(3, "0")}`,
      ts: this.t,
      kind,
      confidence: opts.inferred ? "inferred" : "observed",
      jobId: opts.jobId,
      data,
    });
    return this;
  }
}

// ---- reusable segments ---------------------------------------------------

function submitViaApi(tr: Trace, jobId: string, jobType: string, wake: boolean) {
  tr.at(0, "ingress.request", { route: "/jobs", jobType }, { jobId });
  tr.at(0.08, "lambda.invoked", { action: "enqueue" });
  tr.at(0.05, "job.enqueued", { queue: "workflow", jobType }, { jobId });
  if (wake) wakeControlPlane(tr, 0.05);
}

function wakeControlPlane(tr: Trace, delay: number) {
  tr.at(delay, "cp.state", { state: "pending" });
  tr.at(0.3, "guard.latch", { locked: false });
  tr.at(SAMPLE.cpBootSeconds, "cp.state", { state: "running" });
  tr.at(SAMPLE.podsReadySeconds, "pods.ready", { ready: true }, { inferred: true });
}

function gpuColdStart(tr: Trace, market: "on-demand" | "spot" = "on-demand") {
  tr.at(SAMPLE.kedaDetectSeconds, "keda.scale", { replicas: 1 }, { inferred: true });
  tr.at(0.5, "vllm.state", { state: "pending" }, { inferred: true });
  tr.at(SAMPLE.caReactSeconds, "asg.desired", { desired: 1, by: "cluster-autoscaler" });
  tr.at(1, "gpu.instance", { state: "launching", market });
  tr.at(SAMPLE.gpuLaunchSeconds, "gpu.instance", { state: "running", market });
  tr.at(SAMPLE.ebsAttachSeconds, "ebs.attached", { attached: true }, { inferred: true });
  tr.at(SAMPLE.nodeJoinSeconds, "node.joined", { joined: true }, { inferred: true });
  tr.at(2, "vllm.state", { state: "loading" }, { inferred: true });
  tr.at(SAMPLE.modelLoadSeconds, "vllm.state", { state: "ready" }, { inferred: true });
}

function gpuWindDown(tr: Trace, afterLastWork = 0) {
  tr.at(afterLastWork + CONFIG.kedaCooldownSeconds, "keda.scale", { replicas: 0 }, { inferred: true });
  tr.at(1, "vllm.state", { state: "absent" }, { inferred: true });
  tr.at(CONFIG.caScaleDownSeconds, "asg.desired", { desired: 0, by: "cluster-autoscaler" });
  tr.at(2, "gpu.instance", { state: "terminating" });
  tr.at(SAMPLE.gpuTerminateSeconds, "gpu.instance", { state: "terminated" });
}

function sleep(tr: Trace, quietSoFar = 0) {
  tr.at(0.5, "watchdog.idle", { idle: true }, { inferred: true });
  tr.at(Math.max(1, CONFIG.watchdogIdleSeconds - quietSoFar), "cp.state", { state: "stopping" });
  tr.at(1.2, "guard.latch", { locked: true });
  tr.at(SAMPLE.cpStopSeconds, "cp.state", { state: "stopped" });
}

/** Worker picks a workflow job, LAYA passes it, it goes to the GPU queue. */
function triageToGpu(tr: Trace, jobId: string, probability = 0.87) {
  tr.at(1.0, "job.dequeued", { queue: "workflow" }, { jobId });
  tr.at(0.4, "laya.gate", { result: "pass", probability }, { jobId });
  tr.at(0.6, "job.enqueued", { queue: "gpu" }, { jobId });
  tr.at(1.0, "job.dequeued", { queue: "gpu" }, { jobId });
}

function generateAndVerify(tr: Trace, jobId: string, attempt: number, passed: boolean) {
  tr.at(0.4, "job.generate", { attempt }, { jobId });
  tr.at(SAMPLE.generationSeconds, "laya.verify", { attempt, passed, probability: passed ? 0.78 : 0.22 }, { jobId });
}

function finish(tr: Trace, jobId: string, outcome: string) {
  tr.at(0.3, "s3.result", {}, { jobId });
  tr.at(0.05, "job.finished", { outcome }, { jobId });
}

// ---- scenarios -----------------------------------------------------------

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  build: (start: number) => DashboardEvent[];
}

const DAY = Date.UTC(2026, 10, 14, 9, 12, 0);

export const SCENARIOS: Scenario[] = [
  {
    id: "cold-gpu",
    title: "Cold start, GPU job",
    summary: "A CV-tailoring job wakes the control plane, passes LAYA, brings up the GPU, is verified and stored. Then everything sleeps.",
    build: (start) => {
      const tr = new Trace("cold", start);
      const j = "job-7f3a";
      submitViaApi(tr, j, "tailor_cv", true);
      triageToGpu(tr, j);
      gpuColdStart(tr);
      generateAndVerify(tr, j, 1, true);
      finish(tr, j, "completed");
      gpuWindDown(tr);
      sleep(tr, CONFIG.kedaCooldownSeconds + CONFIG.caScaleDownSeconds + SAMPLE.gpuTerminateSeconds);
      return tr.events;
    },
  },
  {
    id: "laya-reject",
    title: "Rejected by LAYA",
    summary: "A job posting fails the relevance gate on CPU. The GPU never wakes.",
    build: (start) => {
      const tr = new Trace("reject", start);
      const j = "job-21c9";
      submitViaApi(tr, j, "job_analysis", true);
      tr.at(1.0, "job.dequeued", { queue: "workflow" }, { jobId: j });
      tr.at(0.4, "laya.gate", { result: "reject", probability: 0.14 }, { jobId: j });
      finish(tr, j, "rejected");
      sleep(tr);
      return tr.events;
    },
  },
  {
    id: "decision-only",
    title: "Decision-only job",
    summary: "A classification job is answered entirely by LAYA on the control plane.",
    build: (start) => {
      const tr = new Trace("decide", start);
      const j = "job-0b44";
      submitViaApi(tr, j, "decision_classification", true);
      tr.at(1.0, "job.dequeued", { queue: "workflow" }, { jobId: j });
      tr.at(0.4, "laya.gate", { result: "decision", probability: 0.91 }, { jobId: j });
      finish(tr, j, "decided");
      sleep(tr);
      return tr.events;
    },
  },
  {
    id: "needs-review",
    title: "Verification fails",
    summary: "Qwen's output fails LAYA's check, is regenerated, fails again, and is stored as needs review.",
    build: (start) => {
      const tr = new Trace("review", start);
      const j = "job-9d10";
      submitViaApi(tr, j, "tailor_cover_letter", true);
      triageToGpu(tr, j, 0.81);
      gpuColdStart(tr);
      generateAndVerify(tr, j, 1, false);
      generateAndVerify(tr, j, 2, false);
      finish(tr, j, "needs_review");
      gpuWindDown(tr);
      sleep(tr, CONFIG.kedaCooldownSeconds + CONFIG.caScaleDownSeconds + SAMPLE.gpuTerminateSeconds);
      return tr.events;
    },
  },
  {
    id: "retry-dlq",
    title: "Retries, then dead-letter",
    summary: "The GPU call errors three times. Each time the message returns to the queue; the third failure moves it to the GPU dead-letter queue.",
    build: (start) => {
      const tr = new Trace("dlq", start);
      const j = "job-c2e7";
      submitViaApi(tr, j, "application_reasoning", true);
      triageToGpu(tr, j, 0.76);
      gpuColdStart(tr);
      for (let i = 1; i <= CONFIG.maxReceiveCount; i += 1) {
        tr.at(0.4, "job.generate", { attempt: i }, { jobId: j });
        tr.at(6, "job.failed", { queue: "gpu", receiveCount: i }, { jobId: j });
        if (i < CONFIG.maxReceiveCount) tr.at(20, "job.dequeued", { queue: "gpu" }, { jobId: j });
      }
      tr.at(2, "job.dlq", { queue: "gpu" }, { jobId: j });
      gpuWindDown(tr);
      sleep(tr, CONFIG.kedaCooldownSeconds + CONFIG.caScaleDownSeconds + SAMPLE.gpuTerminateSeconds);
      return tr.events;
    },
  },
  {
    id: "prewarm",
    title: "Pre-warm with no work",
    summary: "The 06:55 UTC schedule wakes the control plane. Nothing arrives, so the watchdog puts it back to sleep.",
    build: () => {
      const tr = new Trace("prewarm", Date.UTC(2026, 10, 15, 6, 55, 0));
      tr.at(0, "ingress.prewarm", {});
      tr.at(0.2, "lambda.invoked", { action: "wake" });
      wakeControlPlane(tr, 0.1);
      sleep(tr);
      return tr.events;
    },
  },
  {
    id: "warm-pair",
    title: "Two jobs, warm GPU",
    summary: "Two jobs arrive close together. The second one lands inside the GPU cooldown and skips the cold start.",
    build: (start) => {
      const tr = new Trace("warm", start);
      const a = "job-4a01";
      const b = "job-4a02";
      submitViaApi(tr, a, "tailor_cv", true);
      tr.at(3, "ingress.request", { route: "/jobs", jobType: "news_summarization" }, { jobId: b });
      tr.at(0.08, "lambda.invoked", { action: "enqueue" });
      tr.at(0.05, "job.enqueued", { queue: "workflow", jobType: "news_summarization" }, { jobId: b });
      triageToGpu(tr, a);
      tr.at(0.5, "job.dequeued", { queue: "workflow" }, { jobId: b });
      tr.at(0.4, "laya.gate", { result: "pass", probability: 0.71 }, { jobId: b });
      tr.at(0.6, "job.enqueued", { queue: "gpu" }, { jobId: b });
      gpuColdStart(tr);
      generateAndVerify(tr, a, 1, true);
      finish(tr, a, "completed");
      tr.at(0.6, "job.dequeued", { queue: "gpu" }, { jobId: b });
      generateAndVerify(tr, b, 1, true);
      finish(tr, b, "completed");
      gpuWindDown(tr);
      sleep(tr, CONFIG.kedaCooldownSeconds + CONFIG.caScaleDownSeconds + SAMPLE.gpuTerminateSeconds);
      return tr.events;
    },
  },
];

export function buildScenario(id: string): DashboardEvent[] {
  const sc = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
  return sc.build(DAY);
}
