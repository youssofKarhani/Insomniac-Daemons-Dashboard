import { bool, num, str, type TwinEvent } from "../model/events";

const JOB_TYPES: Record<string, string> = {
  tailor_cv: "CV tailoring",
  tailor_cover_letter: "cover letter",
  job_analysis: "job posting analysis",
  application_reasoning: "application answer",
  news_summarization: "news briefing",
  decision_classification: "classification",
  general_inference: "general",
};

export function jobLabel(type: string): string {
  return JOB_TYPES[type] ?? type.replace(/_/g, " ");
}

/** One plain-language sentence per event, for captions and the event log. */
export function caption(e: TwinEvent): string {
  switch (e.kind) {
    case "ingress.request":
      return `A ${jobLabel(str(e, "jobType", "new"))} job arrives at the front door.`;
    case "ingress.prewarm":
      return "06:55 UTC: the morning schedule fires.";
    case "lambda.invoked":
      return str(e, "action") === "wake" ? "The wake switch flips." : "The wake switch files the job in the inbox.";
    case "job.enqueued":
      return str(e, "queue") === "gpu" ? "The job moves to the GPU queue." : "The job waits in the inbox.";
    case "cp.state": {
      const s = str(e, "state");
      if (s === "pending") return "The control tower is switched on.";
      if (s === "running") return "The control tower is up.";
      if (s === "stopping") return "30 quiet minutes: the tower shuts down.";
      return "The tower is off. Compute cost is back to zero.";
    }
    case "pods.ready":
      return "Platform services are ready on the tower.";
    case "job.dequeued":
      return str(e, "queue") === "gpu" ? "The worker holds the job while the GPU gets ready." : "The worker takes the job from the inbox.";
    case "laya.gate": {
      const r = str(e, "result");
      const p = num(e, "probability").toFixed(2);
      if (r === "reject") return `LAYA rejects it (relevance ${p}). The GPU never wakes.`;
      if (r === "decision") return "LAYA answers this one on its own, on CPU.";
      return `LAYA lets it through (relevance ${p}).`;
    }
    case "keda.scale":
      return num(e, "replicas") > 0 ? "Work in the GPU queue: KEDA asks for a model server." : "Two quiet minutes: KEDA releases the model server.";
    case "vllm.state": {
      const s = str(e, "state");
      if (s === "pending") return "The model server is waiting for a GPU machine.";
      if (s === "loading") return "The model is loading from the drive.";
      if (s === "ready") return "The model is ready.";
      return "The model server is gone.";
    }
    case "asg.desired":
      return num(e, "desired") > 0 ? "The autoscaler orders one GPU machine." : "The autoscaler sends the GPU machine away.";
    case "gpu.instance": {
      const s = str(e, "state");
      const market = str(e, "market") === "spot" ? "Spot" : "On-Demand";
      if (s === "launching") return `A GPU machine (${market}) is launching.`;
      if (s === "running") return "The GPU machine is running. Billing has started.";
      if (s === "terminating") return "The GPU machine is shutting down.";
      if (s === "launch_failed") return "No GPU capacity available. The job keeps waiting.";
      return "The GPU machine is gone. GPU billing stops.";
    }
    case "ebs.attached":
      return "The model drive is attached.";
    case "node.joined":
      return "The GPU machine joins the cluster.";
    case "job.generate":
      return num(e, "attempt") > 1 ? `Qwen writes again (attempt ${num(e, "attempt")}).` : "Qwen writes the answer.";
    case "laya.verify":
      return bool(e, "passed") ? "LAYA checks the answer: it passes." : "LAYA checks the answer: it fails.";
    case "job.failed":
      return `The attempt failed; the job goes back to its queue (${num(e, "receiveCount")} of 3).`;
    case "job.dlq":
      return "Third failure: the job moves to the dead-letter bin.";
    case "job.finished": {
      const o = str(e, "outcome");
      if (o === "needs_review") return "Stored, marked for human review.";
      if (o === "rejected") return "Rejection stored in the archive.";
      if (o === "decided") return "Decision stored. No GPU was used.";
      return "Result stored in the archive.";
    }
    case "s3.result":
      return "A result is written to the archive.";
    case "spot.warning":
      return "AWS will reclaim the Spot machine in 2 minutes.";
    case "watchdog.idle":
      return bool(e, "idle") ? "Nothing to do. The idle timer starts." : "Activity: the idle timer resets.";
    case "guard.latch":
      return bool(e, "locked") ? "The stop guard locks GPU launches." : "GPU launches are allowed again.";
    case "ssm.session":
      return bool(e, "open") ? "An operator session opens." : "The operator session closes.";
  }
}
