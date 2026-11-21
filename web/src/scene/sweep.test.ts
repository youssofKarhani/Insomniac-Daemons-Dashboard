import { expect, it } from "vitest";
import { buildScenario, SCENARIOS } from "../data/scenarios";
import { sortEvents } from "../model/events";
import { reduce } from "../model/reduce";
import { initialState, type WorldState } from "../model/state";
import { ticketsByLocation } from "../model/tickets";
import { SignalWorld } from "./signalWorld";
import { ticketOffset } from "./layout";
import { newPose, poseAt, restingAt, runsOf, scheduleWorld, slotAt } from "./ticketPath";
import { CARRY_BOTTOM, SEAT_BOTTOM, X_CRADLE, gantryAt, newGantryPose } from "./gantry";

const STEP = 20;
const WINDOW = 12_000;

/**
 * Steps every sample run at 20 ms and checks the scene as a whole: tickets never jump while
 * riding, never pass through each other, a ride never changes once started, no ticket waits at
 * the worker with the pods down or generates without a seated cassette and a ready model, and
 * no cassette sits in the cradle while the stop guard is locked.
 */
it("plays every sample run without jumps, collisions or out-of-order actions", () => {
  const report: string[] = [];
  for (const sc of SCENARIOS) {
    const events = sortEvents(buildScenario(sc.id));
    const sw = new SignalWorld();
    // Sample densely for WINDOW ms after each event; skip the long idle stretches.
    const times = new Set<number>();
    for (const e of events) for (let t = e.ts; t < e.ts + WINDOW; t += STEP) times.add(t);
    const ts = [...times].sort((a, b) => a - b);
    let base: WorldState = initialState(events[0].ts - 1000);
    let hist: typeof events = [];
    let i = 0;
    const prev = new Map<string, { t: number; p: [number, number, number]; moving: boolean }>();
    const seen = new Set<string>();
    const started = new Map<string, number>();
    const note = (msg: string) => {
      if (!seen.has(msg)) {
        seen.add(msg);
        report.push(`${sc.id}: ${msg}`);
      }
    };
    for (const t of ts) {
      let changed = false;
      while (i < events.length && events[i].ts <= t) {
        base = reduce(base, events[i++]);
        changed = true;
      }
      if (changed) hist = events.slice(0, i);
      const w = sw.at({ ...base, t }, hist, t);
      scheduleWorld(w);
      const pose = newPose();
      const poses: { id: string; p: [number, number, number]; moving: boolean; loc: string }[] = [];
      for (const [loc, list] of ticketsByLocation(w)) {
        list.forEach((job) => {
          poseAt(job, t, ticketOffset(loc, slotAt([...Object.values(w.jobs), ...Object.values(w.anon)], job, t), job, w.archived), pose);
          const p = [...pose.pos] as [number, number, number];
          const pr = prev.get(job.id);
          // A slot change while resting is eased along the belt in the scene; only rides must be continuous.
          if (pr && t - pr.t <= STEP && (pr.moving || pose.moving)) {
            const d = Math.hypot(p[0] - pr.p[0], p[1] - pr.p[1], p[2] - pr.p[2]);
            if (d > 0.6) note(`${job.id} jumps ${d.toFixed(2)} at +${((t - events[0].ts) / 1000).toFixed(2)}s near (${p.map((v) => v.toFixed(1))})`);
          }
          prev.set(job.id, { t, p, moving: pose.moving });
          runsOf(job.hops).forEach((r, k) => {
            const key = `${job.id}#${k}`;
            const was = started.get(key);
            if (was !== undefined && Math.abs(was - r.start) > 1e-6) note(`${key} start moved ${was} -> ${r.start}`);
            if (r.start <= t) started.set(key, r.start);
          });
          poses.push({ id: job.id, p, moving: pose.moving, loc });
          const rest = restingAt(job, t);
          if (rest === "worker" && !(w.cp.state === "running" && w.cp.podsReady)) note(`${job.id} at the worker while pods are down`);
          if (rest === "core" && job.location === "core") {
            const g = gantryAt(w, t, newGantryPose());
            if (!g.cassette || g.cassetteBottom !== SEAT_BOTTOM) note(`${job.id} generating with no seated cassette`);
            if (w.vllm.state !== "ready") note(`${job.id} generating while model is ${w.vllm.state}`);
          }
        });
      }
      for (let a = 0; a < poses.length; a += 1)
        for (let b = a + 1; b < poses.length; b += 1) {
          const A = poses[a].p;
          const B = poses[b].p;
          if (Math.abs(A[1] - B[1]) < 0.1 && Math.hypot(A[0] - B[0], A[2] - B[2]) < 0.5)
            note(`+${((t - events[0].ts) / 1000).toFixed(2)}s ${poses[a].id}@${poses[a].p.map((v) => v.toFixed(2))} overlaps ${poses[b].id}@${poses[b].p.map((v) => v.toFixed(2))} (${poses[a].moving ? "moving" : "rest"}/${poses[b].moving ? "moving" : "rest"}) near ${poses[a].loc}/${poses[b].loc}`);
        }
      const g = gantryAt(w, t, newGantryPose());
      if (g.cassette && w.guardLocked && Math.abs(g.cassetteX - X_CRADLE) < 0.5 && g.cassetteBottom < CARRY_BOTTOM - 0.05)
        note(`cassette in the cradle while the stop guard is locked at +${((t - events[0].ts) / 1000).toFixed(1)}s`);
      if (g.cassette && Math.abs(g.cassetteX - X_CRADLE) < 0.01 && g.cassetteBottom === SEAT_BOTTOM && w.gpu.state === "none")
        note(`cassette seated with no GPU instance`);
    }
  }
  expect(report).toEqual([]);
}, 120_000);
