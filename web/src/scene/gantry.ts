import type { WorldState } from "../model/state";
import { POS, PLATFORM_Y } from "./layout";
import { CABLES, cableRoute } from "./routes";

/**
 * The capacity arm is an overhead crane. Its rail runs from a mast on the tower, over the GPU
 * cradle, into the capacity bay where cassettes are kept. A GPU never appears or vanishes in the
 * open: the carriage carries it out of the bay, lowers it into the cradle, and later lifts it
 * out and carries it back.
 *
 * Everything here is a pure function of the world at source time `t`, so seeking and every
 * replay speed show the same motion. Each sequence fits inside the real-speed window that
 * replay keeps after an event (REALTIME_AFTER_EVENT_MS), so it is never fast-forwarded.
 */

/** Rail centre height. The carriage hangs under it. */
export const RAIL_Y = 4.6;
/** Carriage home, inside the capacity bay. */
export const X_BAY = CABLES.nodes.armBay[0];
export const X_CRADLE = POS.gpuNode[0];
/** Cassette bottom while carried (clears the model drive and the cradle rails). */
export const CARRY_BOTTOM = 2.0;
/** Cassette bottom when seated in the cradle. */
export const SEAT_BOTTOM = PLATFORM_Y + 0.55;
export const CASSETTE_H = 1.15;
/** Hook height when gripping: on the lifting lug that sits on top of the cassette. */
export const LUG_H = 0.06;
const GRIP = CASSETTE_H + LUG_H;
/** Hook bar height when raised under the carriage. */
export const HOOK_UP = 4.05;

const PICK = 600;
const LOWER = 1100;
const RELEASE = 500;
const HOOK = 500;
const LIFT = 1100;
const TRAVEL = (Math.abs(X_BAY - X_CRADLE) / 3.5) * 1000;

/** The command pulse runs along the rail from the tower to the carriage before it moves. */
export const ARM_PULSE_SPEED = 14;
export const ARM_DELAY = (cableRoute(["tower", "armBay"]).len / ARM_PULSE_SPEED) * 1000;

const DELIVERY = PICK + TRAVEL + LOWER + RELEASE + TRAVEL;

export interface GantryPose {
  carriageX: number;
  /** Height of the hook bar. */
  hookY: number;
  /** False once the cassette is back in the bay, or before one is ordered. */
  cassette: boolean;
  cassetteX: number;
  cassetteBottom: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (f: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(f));
const lerp = (a: number, b: number, f: number) => a + (b - a) * ease(f);

function idle(out: GantryPose) {
  out.carriageX = X_BAY;
  out.hookY = HOOK_UP;
  out.cassette = false;
  out.cassetteX = X_BAY;
  out.cassetteBottom = CARRY_BOTTOM;
  return out;
}

function seated(out: GantryPose, carriageX = X_BAY, hookY = HOOK_UP) {
  out.carriageX = carriageX;
  out.hookY = hookY;
  out.cassette = true;
  out.cassetteX = X_CRADLE;
  out.cassetteBottom = SEAT_BOTTOM;
  return out;
}

function carried(out: GantryPose, x: number, bottom: number) {
  out.carriageX = x;
  out.cassette = true;
  out.cassetteX = x;
  out.cassetteBottom = bottom;
  out.hookY = bottom + GRIP;
  return out;
}

/** Bay → cradle. `e` is ms since the carriage got its order. */
function deliver(e: number, out: GantryPose): GantryPose {
  if (e < 0) return idle(out);
  // Hook goes down onto the stored cassette inside the bay.
  if (e < PICK) {
    carried(out, X_BAY, CARRY_BOTTOM);
    out.hookY = lerp(HOOK_UP, CARRY_BOTTOM + GRIP, e / PICK);
    return out;
  }
  e -= PICK;
  if (e < TRAVEL) return carried(out, lerp(X_BAY, X_CRADLE, e / TRAVEL), CARRY_BOTTOM);
  e -= TRAVEL;
  if (e < LOWER) return carried(out, X_CRADLE, lerp(CARRY_BOTTOM, SEAT_BOTTOM, e / LOWER));
  e -= LOWER;
  if (e < RELEASE) return seated(out, X_CRADLE, lerp(SEAT_BOTTOM + GRIP, HOOK_UP, e / RELEASE));
  e -= RELEASE;
  if (e < TRAVEL) return seated(out, lerp(X_CRADLE, X_BAY, e / TRAVEL));
  return seated(out);
}

/** Cradle → bay. `e` is ms since the carriage got its order; `liftAt` is when it may lift. */
function remove(e: number, liftAt: number, out: GantryPose): GantryPose {
  if (e < TRAVEL) return seated(out, lerp(X_BAY, X_CRADLE, e / TRAVEL));
  if (e < TRAVEL + HOOK) return seated(out, X_CRADLE, lerp(HOOK_UP, SEAT_BOTTOM + GRIP, (e - TRAVEL) / HOOK));
  // Hooked on, waiting for the instance to actually stop.
  const lift = Math.max(TRAVEL + HOOK, liftAt);
  if (e < lift) return seated(out, X_CRADLE, SEAT_BOTTOM + GRIP);
  e -= lift;
  if (e < LIFT) return carried(out, X_CRADLE, lerp(SEAT_BOTTOM, CARRY_BOTTOM, e / LIFT));
  e -= LIFT;
  if (e < TRAVEL) return carried(out, lerp(X_CRADLE, X_BAY, e / TRAVEL), CARRY_BOTTOM);
  e -= TRAVEL;
  // Set down in the bay's rack, then the hook comes back up empty.
  if (e < PICK) {
    carried(out, X_BAY, CARRY_BOTTOM);
    out.hookY = lerp(CARRY_BOTTOM + GRIP, HOOK_UP, e / PICK);
    return out;
  }
  return idle(out);
}

export const newGantryPose = (): GantryPose => idle({} as GantryPose);

export function gantryAt(w: WorldState, t: number, out: GantryPose): GantryPose {
  const g = w.gpu.state;
  const leaving = g === "terminating" || g === "launch_failed";
  const ordered = w.asg.desired === 1 ? w.asg.since + ARM_DELAY : undefined;

  // When the carriage is told to take the cassette away: the group going to zero (after the
  // command reaches it), or the instance stopping on its own (Spot reclaim, failed launch).
  let removeAt: number | undefined;
  if (w.asg.desired === 0 && g !== "none") removeAt = w.asg.since + ARM_DELAY;
  if (leaving) removeAt = removeAt === undefined ? w.gpu.since : Math.min(removeAt, w.gpu.since);
  // A delivery still under way finishes first.
  if (removeAt !== undefined && ordered !== undefined) removeAt = Math.max(removeAt, ordered + DELIVERY);

  if (removeAt !== undefined && t >= removeAt) {
    const liftAt = leaving ? w.gpu.since - removeAt : Infinity;
    return remove(t - removeAt, liftAt, out);
  }
  if (ordered !== undefined) {
    // Running with no delivery seen (for example, live telemetry starting mid-run): seated.
    if (t < ordered && g === "running") return seated(out);
    return deliver(t - ordered, out);
  }
  if (removeAt !== undefined) return seated(out);
  return g === "none" ? idle(out) : seated(out);
}
