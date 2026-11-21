import type { Hop, JobLocation, JobView } from "../model/state";
import { ticketTone, type TicketTone } from "../model/tickets";
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

const soloCache = new WeakMap<Hop[], Run[]>();
const sharedCache = new WeakMap<Hop[], Run[]>();

function durationFor(len: number, start: number, at: number): number {
  const boost = Math.min(MAX_BOOST, 1 + Math.max(0, start - at) / 1000);
  return len > 0 ? Math.max(MIN_HOP_MS, (len / (SPEED * boost)) * 1000) : 0;
}

/** One ticket's rides on its own, ignoring every other ticket. */
function solo(hops: Hop[]): Run[] {
  const hit = soloCache.get(hops);
  if (hit) return hit;
  const runs: Run[] = [];
  let prevEnd = -Infinity;
  let prevLoc: JobLocation | undefined;
  let from = ORIGIN;
  for (const h of hops) {
    const to = LOCATION_NODE[h.to];
    const route = BELTS.route(from, to);
    const start = Math.max(h.at, prevEnd + (prevLoc ? (DWELL[prevLoc] ?? 0) : 0));
    const dur = durationFor(route.len, start, h.at);
    runs.push({ route, to: h.to, start, end: start + dur });
    prevEnd = start + dur;
    prevLoc = h.to;
    from = to;
  }
  soloCache.set(hops, runs);
  return runs;
}

/** A ticket's rides: from the shared schedule when its world has been scheduled, else on its own. */
export function runsOf(hops: Hop[]): Run[] {
  return sharedCache.get(hops) ?? solo(hops);
}

/** A ticket following another along the same belt keeps at least this far behind it. */
const FOLLOW_MS = 700;
const scheduled = new WeakMap<object, WeakSet<object>>();

/**
 * Plans every ticket's rides together so belts are shared like real conveyors: a ride waits
 * while another ticket uses any of the same belts the other way, and a ticket following another
 * along a belt stays behind it. Rides are planned in the order their events happened, so a new
 * ticket can only wait for earlier ones, never move them: the plan is the same at every seek.
 */
export function scheduleWorld(w: { jobs: Record<string, JobView>; anon: Record<string, JobView> }) {
  let byAnon = scheduled.get(w.jobs);
  if (!byAnon) scheduled.set(w.jobs, (byAnon = new WeakSet()));
  if (byAnon.has(w.anon)) return;
  byAnon.add(w.anon);
  const tickets = [...Object.values(w.jobs), ...Object.values(w.anon)].filter((t) => t.hops.length > 0);
  const requests = tickets
    .flatMap((t) => t.hops.map((h, k) => ({ t, k, at: h.at })))
    .sort((x, y) => x.at - y.at || (x.t.id < y.t.id ? -1 : x.t.id > y.t.id ? 1 : 0) || x.k - y.k);
  const state = new Map<string, { runs: Run[]; prevEnd: number; prevLoc?: JobLocation; from: keyof typeof BELTS.nodes }>();
  const placed: { id: string; run: Run; edges: Map<number, number> }[] = [];
  for (const { t, k, at } of requests) {
    let st = state.get(t.id);
    if (!st) state.set(t.id, (st = { runs: [], prevEnd: -Infinity, from: ORIGIN }));
    const h = t.hops[k];
    const to = LOCATION_NODE[h.to];
    const route = BELTS.route(st.from, to);
    const edges = new Map<number, number>();
    for (const seg of route.segs) if (seg.edge >= 0) edges.set(seg.edge, seg.dir);
    let start = Math.max(at, st.prevEnd + (st.prevLoc ? (DWELL[st.prevLoc] ?? 0) : 0));
    let dur = durationFor(route.len, start, at);
    for (let pass = 0, moved = true; moved && pass < 30; pass += 1) {
      moved = false;
      for (const o of placed) {
        if (o.id === t.id || o.run.end <= start || o.run.start >= start + dur) continue;
        let shared = false;
        let opposite = false;
        for (const [e, d] of edges) {
          const od = o.edges.get(e);
          if (od === undefined) continue;
          shared = true;
          if (od !== d) opposite = true;
        }
        if (!shared) continue;
        if (opposite) {
          start = o.run.end + 50;
          moved = true;
        } else {
          if (start < o.run.start + FOLLOW_MS) {
            start = o.run.start + FOLLOW_MS;
            moved = true;
          }
          if (start + dur < o.run.end + FOLLOW_MS) dur = o.run.end + FOLLOW_MS - start;
        }
        if (moved) {
          dur = Math.max(dur, durationFor(route.len, start, at));
          break;
        }
      }
    }
    const run: Run = { route, to: h.to, start, end: start + dur };
    st.runs.push(run);
    st.prevEnd = run.end;
    st.prevLoc = h.to;
    st.from = to;
    placed.push({ id: t.id, run, edges });
  }
  for (const t of tickets) sharedCache.set(t.hops, state.get(t.id)!.runs);
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

/** A ticket that has just left a place keeps its slot there until it has cleared the exit. */
const CLEAR_MS = 900;
function clearing(o: JobView, loc: JobLocation, t: number): boolean {
  const runs = runsOf(o.hops);
  const k = runs.length - 1;
  if (k < 1 || o.hops[k - 1].to !== loc) return false;
  return t < runs[k].start + CLEAR_MS;
}

/**
 * The ticket's slot at its place at time `t`: how many tickets are ahead of it there. Tickets
 * still physically at the front (resting, or just leaving) count, so the queue only moves up
 * once the one in front has cleared, never through it.
 */
export function slotAt(all: Iterable<JobView>, job: JobView, t: number): number {
  let n = 0;
  for (const o of all) {
    if (o.id === job.id) continue;
    if (o.location === job.location ? o.seq < job.seq : clearing(o, job.location, t)) n += 1;
  }
  return n;
}

export interface Marks {
  tone: TicketTone;
  /** Amber pips: failed GPU attempts the ticket has come back from. */
  pips: number;
  /** The worker's claim band: shown only while the ticket waits in the GPU queue. */
  held: boolean;
}

/**
 * What the ticket shows at time `t`. A mark appears when the ticket physically reaches the
 * station that gives it: LAYA's verdict at LAYA, a retry pip on returning to the queue, the
 * final result on arrival at the archive or a dead-letter bin. Never before.
 */
export function marksAt(job: JobView, t: number, out: Marks): Marks {
  const runs = runsOf(job.hops);
  let done = 0;
  while (done < runs.length && runs[done].end <= t) done += 1;
  let tone: TicketTone = "plain";
  let pips = 0;
  let prev: JobLocation | undefined;
  for (let k = 0; k < done; k += 1) {
    const to = runs[k].to;
    if (to === "laya") {
      if (prev === "core") tone = job.verifyPassed ? "pass" : "warn";
      else if (job.gate === "pass") tone = "pass";
      else if (job.gate === "reject") tone = "reject";
    }
    if (to === "gpuQueue" && prev === "core") {
      tone = "warn";
      pips += 1;
    }
    prev = to;
  }
  const arrived = done === runs.length;
  if (arrived && job.outcome) tone = ticketTone(job);
  out.tone = runs.length === 0 ? ticketTone(job) : tone;
  out.pips = Math.min(3, job.receiveCount, runs.length === 0 ? job.receiveCount : pips);
  out.held = job.inFlight && (runs.length === 0 || (arrived && runs[runs.length - 1].to === "gpuQueue"));
  return out;
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
  const rest = (p: P3, k = 1) => {
    out.pos[0] = p[0] + offset[0] * k;
    out.pos[1] = p[1] + offset[1] * k;
    out.pos[2] = p[2] + offset[2] * k;
    return out;
  };
  if (runs.length === 0) return rest(BELTS.nodes[LOCATION_NODE[job.location]]);
  let run = runs[0];
  for (const r of runs) if (r.start <= t) run = r;
  // The slot offset belongs to the ticket's current place: only the ride into it ends there.
  const mine = run === runs[runs.length - 1] ? 1 : 0;
  const segs = run.route.segs;
  if (t >= run.end || segs.length === 0) return rest(BELTS.nodes[LOCATION_NODE[run.to]], mine);

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
    const o = i === segs.length - 1 ? k * mine : 0;
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
