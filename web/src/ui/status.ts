import type { ObjectId } from "../content/components";
import type { WorldState } from "../model/state";
import { ticketsByLocation } from "../model/tickets";
import { CONFIG } from "../model/timings";
import { duration } from "./format";

/**
 * Short state label for each object, used by the 2D schematic. The tone picks a
 * colour, but the text always says the same thing, so colour is never the only cue.
 */
export type Tone = "off" | "idle" | "always" | "busy" | "starting" | "warn" | "fail";

export interface Status {
  tone: Tone;
  text: string;
  inferred?: boolean;
}

/** An always-on piece shows as busy for this long after it fires. */
const PULSE_MS = 3_000;

export function statusOf(id: ObjectId, w: WorldState, tickets = ticketsByLocation(w.jobs, w.queueDepth)): Status {
  const n = (loc: Parameters<typeof tickets.get>[0]) => tickets.get(loc)?.length ?? 0;
  const recent = (t?: number) => t !== undefined && w.t - t >= 0 && w.t - t < PULSE_MS;
  const towerUp = w.cp.state === "running";
  switch (id) {
    case "clock":
      return recent(w.pulses.clock) ? { tone: "busy", text: "Firing" } : { tone: "always", text: `Next ${CONFIG.prewarmUtc} UTC` };
    case "gateway":
      return recent(w.pulses.gateway) ? { tone: "busy", text: "Request in" } : { tone: "always", text: "Open" };
    case "lambda":
      return recent(w.pulses.lambda) ? { tone: "busy", text: "Switching" } : { tone: "always", text: "Ready" };
    case "ssm":
      return w.ssmOpen ? { tone: "busy", text: "Session open" } : { tone: "always", text: "No session" };
    case "vpc":
      return { tone: "always", text: "Always on" };
    case "s3":
      return recent(w.pulses.crate) ? { tone: "busy", text: "Writing" } : { tone: "always", text: `${w.counters.completed + w.counters.needs_review + w.counters.rejected + w.counters.decided} stored` };
    case "workflowQueue":
      return n("workflow") ? { tone: "busy", text: `${n("workflow")} waiting` } : { tone: "idle", text: "Empty" };
    case "gpuQueue":
      return n("gpuQueue") ? { tone: "busy", text: `${n("gpuQueue")} waiting` } : { tone: "idle", text: "Empty" };
    case "workflowDlq":
      return n("workflowDlq") ? { tone: "fail", text: `${n("workflowDlq")} dead letter${n("workflowDlq") === 1 ? "" : "s"}` } : { tone: "idle", text: "Empty" };
    case "gpuDlq":
      return n("gpuDlq") ? { tone: "fail", text: `${n("gpuDlq")} dead letter${n("gpuDlq") === 1 ? "" : "s"}` } : { tone: "idle", text: "Empty" };
    case "keda":
      return w.keda.replicas ? { tone: "busy", text: "Wants 1 server", inferred: true } : { tone: "idle", text: "Wants none" };
    case "controlPlane":
      if (w.cp.state === "stopped") return { tone: "off", text: "Off" };
      if (w.cp.state === "pending") return { tone: "starting", text: "Starting" };
      if (w.cp.state === "stopping") return { tone: "starting", text: "Stopping" };
      return { tone: "busy", text: "Running" };
    case "pods":
      return w.cp.podsReady ? { tone: "busy", text: "Ready", inferred: w.cp.podsConfidence === "inferred" } : { tone: "off", text: "Off" };
    case "laya": {
      const j = Object.values(w.jobs).find((x) => x.location === "laya");
      if (j?.step === "verifying") return { tone: j.verifyPassed ? "busy" : "warn", text: j.verifyPassed ? "Answer passes" : "Answer fails" };
      if (j) return { tone: j.gate === "reject" ? "warn" : "busy", text: j.gate === "reject" ? "Rejecting" : "Triaging" };
      return w.cp.podsReady ? { tone: "idle", text: "Idle" } : { tone: "off", text: "Off" };
    }
    case "watchdog":
      if (!towerUp) return { tone: "off", text: "Off" };
      return w.watchdogIdleSince !== undefined
        ? { tone: "warn", text: `Quiet ${duration(Math.max(0, w.t - w.watchdogIdleSince))}` }
        : { tone: "idle", text: "Busy, reset" };
    case "autoscaler":
      return w.asg.desired ? { tone: "busy", text: "Holding 1 GPU" } : { tone: "idle", text: "No GPU" };
    case "gpuNode":
      if (w.gpu.spotWarningAt !== undefined && w.gpu.state === "running") return { tone: "warn", text: "Reclaim warning" };
      if (w.gpu.state === "none") return { tone: "off", text: "None" };
      if (w.gpu.state === "launching") return { tone: "starting", text: "Launching" };
      if (w.gpu.state === "terminating") return { tone: "starting", text: "Stopping" };
      if (w.gpu.state === "launch_failed") return { tone: "fail", text: "No capacity" };
      return { tone: "busy", text: w.gpu.market === "spot" ? "Running (Spot)" : "Running" };
    case "guard":
      return w.guardLocked ? { tone: "idle", text: "Locked" } : { tone: "busy", text: "Open" };
    case "modelVolume":
      return w.gpu.ebsAttached ? { tone: "busy", text: "Attached" } : { tone: "idle", text: "Parked" };
    case "vllm": {
      const inferred = w.vllm.confidence === "inferred";
      if (w.vllm.state === "ready") return { tone: "busy", text: n("core") ? "Generating" : "Ready", inferred };
      if (w.vllm.state === "loading") return { tone: "starting", text: "Loading", inferred };
      if (w.vllm.state === "pending") return { tone: "starting", text: "Waiting for GPU", inferred };
      return { tone: "off", text: "Off" };
    }
  }
}
