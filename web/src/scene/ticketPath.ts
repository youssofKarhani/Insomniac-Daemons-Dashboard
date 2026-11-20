import type { Hop, JobLocation, JobView } from "../model/state";
import { BELTS, BELT_EDGES, LOCATION_NODE, ORIGIN, type P3, type Route } from "./routes";

/**
 * Where a ticket is at a given source time, as a pure function of its hop history. Each hop
 * rides the belts from the previous place to the next. A hop that starts late (the ticket was
 * still travelling when the next event came) runs faster, so the scene catches up with the
 * events instead of drifting behind them. Being pure, it is exact when seeking and at any
 * replay speed.
 */

/** Belt speed in desk units per second of source time. */
const SPEED = 4.5;
const MAX_BOOST = 3.5;
const MIN_HOP_MS = 500;
/**
 * Shortest stay at a station before the ticket may leave, so its work is seen: LAYA scans it,
 * the worker takes it. Events there can be 0.4 s apart, faster than any belt.
 */
const DWELL: Partial<Record<JobLocation, number>> = { laya: 900, worker: 500 };

export interface Run {
  route: Route;
  to: JobLocation;
  start: number;
  end: number;
}

const runsCache = new WeakMap<Hop[], Run[]>();

export function runsOf(hops: Hop[]): Run[] {
  const hit = runsCache.get(hops);
  if (hit) return hit;
  const runs: Run[] = [];
  let prevEnd = -Infinity;
  let prevLoc: JobLocation | undefined;
  let from = ORIGIN;
  for (const h of hops) {
    const to = LOCATION_NODE[h.to];
    const route = BELTS.route(from, to);
    const start = Math.max(h.at, prevEnd + (prevLoc ? (DWELL[prevLoc] ?? 0) : 0));
    const boost = Math.min(MAX_BOOST, 1 + Math.max(0, start - h.at) / 1000);
    const dur = route.len > 0 ? Math.max(MIN_HOP_MS, (route.len / (SPEED * boost)) * 1000) : 0;
    runs.push({ route, to: h.to, start, end: start + dur });
    prevEnd = start + dur;
    prevLoc = h.to;
    from = to;
  }
  runsCache.set(hops, runs);
  return runs;
}

/**
 * Where the ticket physically rests at `t`, or undefined while it rides a belt. This can lag the
 * job's logical location; stations react to the ticket being there, so the scene stays coherent.
 */
export function restingAt(job: JobView, t: number): JobLocation | undefined {
  const runs = runsOf(job.hops);
  if (runs.length === 0) return job.location;
  let run = runs[0];
  for (const r of runs) if (r.start <= t) run = r;
  return t >= run.end ? run.to : undefined;
}

/** When the ticket last came to rest at `loc`, or undefined if it has not yet. */
export function arrivedAt(job: JobView, loc: JobLocation, t: number): number | undefined {
  const runs = runsOf(job.hops);
  const last = runs[runs.length - 1];
  return last && last.to === loc && last.end <= t ? last.end : undefined;
}

const Y: P3 = [0, 1, 0];

/** The belt surface's normal for a segment: tilted on ramps, straight up on lifts and drops. */
export function upOf(a: P3, b: P3): P3 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const h = Math.hypot(dx, dz);
  if (h < 1e-6 || Math.abs(dy) > 2 * h) return Y;
  const L = Math.hypot(h, dy);
  return [(-dx * dy) / h / L, h / L, (-dz * dy) / h / L];
}

const UPRIGHT = new Set(["lift", "drop", "none"]);
const EDGE_UP: P3[] = BELT_EDGES.map((e) => (UPRIGHT.has(e.kind) ? Y : upOf(BELTS.nodes[e.from], BELTS.nodes[e.to])));

export interface Pose {
  pos: P3;
  up: P3;
  /** Belt edge the ticket is on while moving, else -1. */
  edge: number;
  /** Distance from the edge's `from` end, for driving the belt surface. */
  s: number;
  moving: boolean;
}

export const newPose = (): Pose => ({ pos: [0, 0, 0], up: [0, 1, 0], edge: -1, s: 0, moving: false });

const ease = (f: number) => 0.5 - 0.5 * Math.cos(Math.PI * f);

/** The ticket's pose at source time `t`. `offset` is its stacking offset at its current place. */
export function poseAt(job: JobView, t: number, offset: P3, out: Pose): Pose {
  out.edge = -1;
  out.s = 0;
  out.moving = false;
  out.up = Y;
  const runs = runsOf(job.hops);
  const rest = (p: P3) => {
    out.pos[0] = p[0] + offset[0];
    out.pos[1] = p[1] + offset[1];
    out.pos[2] = p[2] + offset[2];
    return out;
  };
  if (runs.length === 0) return rest(BELTS.nodes[LOCATION_NODE[job.location]]);
  let run = runs[0];
  for (const r of runs) if (r.start <= t) run = r;
  const segs = run.route.segs;
  if (t >= run.end || segs.length === 0) return rest(BELTS.nodes[LOCATION_NODE[run.to]]);

  const f = Math.max(0, (t - run.start) / (run.end - run.start));
  let d = ease(f) * run.route.len;
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    if (d > s.len && i < segs.length - 1) {
      d -= s.len;
      continue;
    }
    const k = s.len > 0 ? Math.min(1, d / s.len) : 1;
    // The last segment ends at the ticket's own slot, not the place's front slot.
    const o = i === segs.length - 1 ? k : 0;
    for (let a = 0; a < 3; a += 1) out.pos[a] = s.a[a] + (s.b[a] - s.a[a]) * k + offset[a] * o;
    if (s.edge >= 0) {
      out.edge = s.edge;
      out.s = s.dir === 1 ? d : s.len - d;
      out.up = EDGE_UP[s.edge];
    }
    out.moving = true;
    break;
  }
  return out;
}
