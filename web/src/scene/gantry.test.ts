import { describe, expect, it } from "vitest";
import { buildScenario, SCENARIOS } from "../data/scenarios";
import { reduce } from "../model/reduce";
import { initialState, type WorldState } from "../model/state";
import { CARRY_BOTTOM, LUG_H, CASSETTE_H, SEAT_BOTTOM, X_BAY, X_CRADLE, gantryAt, newGantryPose } from "./gantry";

/** World states at every step of `dt` ms across a scenario. */
function* walk(id: string, dt = 50): Generator<WorldState> {
  const events = buildScenario(id);
  let w = initialState(events[0].ts - 1000);
  let i = 0;
  for (let t = events[0].ts - 1000; t <= events[events.length - 1].ts + 10_000; t += dt) {
    while (i < events.length && events[i].ts <= t) w = reduce(w, events[i++]);
    yield { ...w, t };
  }
}

describe("capacity arm", () => {
  it("moves the cassette continuously, only while hooked, and it appears and disappears only inside the bay", () => {
    for (const sc of SCENARIOS) {
      let prev: ReturnType<typeof newGantryPose> | undefined;
      for (const w of walk(sc.id)) {
        const g = gantryAt(w, w.t, newGantryPose());
        if (prev) {
          // 50 ms steps: nothing may jump.
          expect(Math.abs(g.carriageX - prev.carriageX), sc.id).toBeLessThan(0.4);
          expect(Math.abs(g.hookY - prev.hookY), sc.id).toBeLessThan(0.4);
          if (g.cassette && prev.cassette) {
            const moved = Math.abs(g.cassetteX - prev.cassetteX) + Math.abs(g.cassetteBottom - prev.cassetteBottom) > 1e-9;
            expect(Math.abs(g.cassetteX - prev.cassetteX) + Math.abs(g.cassetteBottom - prev.cassetteBottom), sc.id).toBeLessThan(0.4);
            // A moving cassette hangs from the hook (gripping at the start or end of the step).
            const grips = (p: typeof g) => Math.abs(p.hookY - (p.cassetteBottom + CASSETTE_H + LUG_H)) < 1e-6;
            if (moved) expect(grips(g) || grips(prev), sc.id).toBe(true);
          }
          if (g.cassette !== prev.cassette) {
            const at = g.cassette ? g : prev;
            expect(at.cassetteX, sc.id).toBe(X_BAY);
            expect(at.cassetteBottom, sc.id).toBe(CARRY_BOTTOM);
          }
        }
        if (w.gpu.state === "running" && w.asg.desired === 1) {
          expect(g.cassette, sc.id).toBe(true);
          expect(g.cassetteX, sc.id).toBe(X_CRADLE);
          expect(g.cassetteBottom, sc.id).toBe(SEAT_BOTTOM);
        }
        prev = g;
      }
    }
  });

  it("is never there when no GPU was ordered", () => {
    for (const id of ["laya-reject", "decision-only", "prewarm"]) {
      for (const w of walk(id, 500)) expect(gantryAt(w, w.t, newGantryPose()).cassette, id).toBe(false);
    }
  });
});
