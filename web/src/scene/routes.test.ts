import { describe, expect, it } from "vitest";
import { buildScenario, SCENARIOS } from "../data/scenarios";
import { reduceAll } from "../model/reduce";
import { initialState, type JobLocation } from "../model/state";
import { BELTS, CABLES, LOCATION_NODE, ORIGIN, cableRoute } from "./routes";
import { newPose, poseAt, runsOf } from "./ticketPath";

/** Every move the reducer makes between places. */
const MOVES: [JobLocation | "origin", JobLocation][] = [
  ["origin", "arch"],
  ["origin", "workflow"],
  ["arch", "workflow"],
  ["workflow", "worker"],
  ["worker", "laya"],
  ["worker", "workflow"],
  ["worker", "crate"],
  ["laya", "gpuQueue"],
  ["laya", "crate"],
  ["laya", "workflow"],
  ["laya", "core"],
  ["gpuQueue", "core"],
  ["core", "laya"],
  ["core", "gpuQueue"],
  ["core", "crate"],
  ["workflow", "workflowDlq"],
  ["gpuQueue", "gpuDlq"],
];

describe("belts", () => {
  it("joins every move with belts, never a straight jump", () => {
    for (const [from, to] of MOVES) {
      const r = BELTS.route(from === "origin" ? ORIGIN : LOCATION_NODE[from], LOCATION_NODE[to]);
      expect(r.segs.length, `${from} -> ${to}`).toBeGreaterThan(0);
      expect(r.segs.every((s) => s.edge >= 0), `${from} -> ${to}`).toBe(true);
    }
  });

  it("follows each sample job from the front door to where it ends, along connected belts", () => {
    for (const sc of SCENARIOS) {
      const w = reduceAll(buildScenario(sc.id), initialState());
      for (const job of Object.values(w.jobs)) {
        const runs = runsOf(job.hops);
        expect(runs.length, sc.id).toBe(job.hops.length);
        for (let i = 1; i < runs.length; i += 1) expect(runs[i].start).toBeGreaterThanOrEqual(runs[i - 1].end);
        // Consecutive segments touch: no teleporting between belts.
        for (const r of runs) {
          for (let k = 1; k < r.route.segs.length; k += 1) expect(r.route.segs[k].a).toEqual(r.route.segs[k - 1].b);
        }
        const end = poseAt(job, Infinity, [0, 0, 0], newPose());
        expect(end.pos).toEqual(BELTS.nodes[LOCATION_NODE[job.location]]);
      }
    }
  });
});

describe("cables", () => {
  it("connects every signal's stops", () => {
    const stops = [
      ["net", "lambda"],
      ["clock", "lambda"],
      ["lambda", "tower"],
      ["wdBack", "tower"],
      ["gqSensor", "keda"],
      ["tower", "gpu"],
      ["drive", "gpu"],
      ["tower", "lambda", "guard"],
      ["ssmBack", "tower"],
      ["gpu", "litellm"],
      ["tower", "armBay"],
    ] as const;
    for (const s of stops) {
      const r = cableRoute(s);
      expect(r.segs.every((x) => x.edge >= 0), s.join(">")).toBe(true);
    }
    // The stop guard is reached from the wake switch directly, not through the tower.
    const guard = CABLES.route("lambda", "guard");
    expect(guard.segs.some((x) => x.b === CABLES.nodes.tower)).toBe(false);
  });
});
