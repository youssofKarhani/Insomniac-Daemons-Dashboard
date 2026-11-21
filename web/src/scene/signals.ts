import type { TwinEvent } from "../model/events";
import { cableRoute, type CableNode, type Route } from "./routes";
import { ARM_PULSE_SPEED } from "./gantry";

interface PulseSpec {
  stops: readonly CableNode[];
  color: string;
  /** Desk units per second; defaults to PULSE_SPEED. */
  speed?: number;
}

/** Which events send a pulse, and along which cables. Purely a function of the event, so seeking is safe. */
export function pulseFor(e: TwinEvent): PulseSpec | null {
  switch (e.kind) {
    case "ingress.request":
      return { stops: ["net", "lambda"], color: "#c3bdff" };
    case "ingress.prewarm":
      return { stops: ["clock", "lambda"], color: "#c3bdff" };
    case "cp.state":
      if (e.data.state === "pending") return { stops: ["lambda", "tower"], color: "#5fd3c0" };
      if (e.data.state === "stopping") return { stops: ["wdBack", "tower"], color: "#8a82e0" };
      return null;
    case "keda.scale":
      return e.data.replicas === 1 ? { stops: ["gqSensor", "keda"], color: "#b07cff" } : null;
    case "asg.desired":
      // The autoscaler's order runs along the arm's rail to the carriage, which then moves.
      return { stops: ["tower", "armBay"], color: "#b07cff", speed: ARM_PULSE_SPEED };
    case "node.joined":
      return { stops: ["gpu", "tower"], color: "#b07cff" };
    case "ebs.attached":
      return { stops: ["drive", "gpu"], color: "#b07cff" };
    case "guard.latch":
      // Locking follows the tower stopping: EventBridge tells the wake switch, which locks the guard.
      return e.data.locked
        ? { stops: ["tower", "lambda", "guard"], color: "#f2b866" }
        : { stops: ["lambda", "guard"], color: "#f2b866" };
    case "ssm.session":
      return e.data.open ? { stops: ["ssmBack", "tower"], color: "#b07cff" } : null;
    default:
      return null;
  }
}

const routeCache = new Map<string, Route>();
export function routeOf(stops: readonly CableNode[]): Route {
  const key = stops.join(">");
  let r = routeCache.get(key);
  if (!r) routeCache.set(key, (r = cableRoute(stops)));
  return r;
}

/** Pulse speed along a cable, desk units per second of source time. */
export const PULSE_SPEED = 7;

export function signalArrival(e: TwinEvent): number {
  const spec = pulseFor(e);
  return spec ? e.ts + routeOf(spec.stops).len / (spec.speed ?? PULSE_SPEED) * 1000 : e.ts;
}
