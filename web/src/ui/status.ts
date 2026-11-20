import { OBJECT_IDS, type ObjectId } from "../content/components";
import type { JobView, WorldState } from "../model/state";
import { ticketsByLocation, ticketTone, type TicketTone } from "../model/tickets";
import { LOCATION_BOX } from "./schematicLayout";
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

/** Everything one schematic box draws. */
export interface BoxView {
  status: Status;
  /** Newest tickets at this box, at most MAX_DOTS. */
  dots: { id: string; tone: TicketTone; held: boolean }[];
  /** All tickets at this box, including those not drawn. */
  total: number;
}

export const MAX_DOTS = 6;

export function boxViews(w: WorldState): Record<ObjectId, BoxView> {
  const tickets = ticketsByLocation(w.jobs, w.queueDepth);
  const at = new Map<ObjectId, JobView[]>();
  for (const [loc, list] of tickets) {
    const id = LOCATION_BOX[loc];
    at.set(id, [...(at.get(id) ?? []), ...list]);
  }
  const out = {} as Record<ObjectId, BoxView>;
  for (const id of OBJECT_IDS) {
    const all = at.get(id) ?? [];
    out[id] = {
      status: statusOf(id, w, tickets),
      dots: all.slice(-MAX_DOTS).map((j) => ({ id: j.id, tone: ticketTone(j), held: j.inFlight })),
      total: all.length,
    };
  }
  return out;
}

/** A string that changes exactly when the box's drawing changes, for cheap equality checks. */
export function boxKey(v: BoxView): string {
  const s = v.status;
  return `${s.tone}|${s.text}|${s.inferred ? 1 : 0}|${v.total}|${v.dots.map((d) => `${d.id}:${d.tone}:${d.held ? 1 : 0}`).join(",")}`;
}
