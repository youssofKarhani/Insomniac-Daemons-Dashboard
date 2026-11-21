import type { DashboardEvent } from "../model/events";
import { sortEvents } from "../model/events";
import { ReplayCursor, buildTimeline } from "../model/replay";
import type { WorldState } from "../model/state";
import { signalArrival } from "./signals";

/** Presentation-only timing: telemetry and the event log retain their source timestamps. */
export function signalEvents(events: readonly DashboardEvent[]): DashboardEvent[] {
  const lanes = new Map<string, number>();
  let lambdaArrival = -Infinity;
  return sortEvents(events).map((e) => {
    if (e.kind === "ingress.request" || e.kind === "ingress.prewarm") lambdaArrival = signalArrival(e);
    // The gantry already waits for its command in gantryAt; do not delay it twice.
    const delayed = ["cp.state", "keda.scale", "guard.latch", "ebs.attached", "node.joined", "ssm.session"].includes(e.kind);
    const lane = e.kind === "pods.ready" ? "cp.state" : e.kind;
    let ts = delayed ? signalArrival(e) : e.ts;
    if (e.kind === "lambda.invoked") ts = Math.max(ts, lambdaArrival);
    ts = Math.max(ts, (lanes.get(lane) ?? -Infinity) + 0.001);
    lanes.set(lane, ts);
    return { ...e, ts };
  });
}

export class SignalWorld {
  private history: readonly DashboardEvent[] | null = null;
  private cursor: ReplayCursor | null = null;

  at(base: WorldState, history: readonly DashboardEvent[], now: number): WorldState {
    if (history !== this.history) {
      this.history = history;
      this.cursor = new ReplayCursor(buildTimeline(signalEvents(history)));
    }
    const shown = this.cursor!.stateAt(now);
    return {
      ...base, t: now,
      cp: shown.cp,
      keda: shown.keda,
      guardLocked: shown.guardLocked,
      ssmOpen: shown.ssmOpen,
      gpu: { ...base.gpu, ebsAttached: shown.gpu.ebsAttached, joined: shown.gpu.joined },
      pulses: { ...base.pulses, lambda: shown.pulses.lambda },
    };
  }
}
