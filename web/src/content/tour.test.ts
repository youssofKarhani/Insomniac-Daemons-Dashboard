import { describe, expect, it } from "vitest";
import { buildScenario, SCENARIOS } from "../data/scenarios";
import { useTwin, TOUR_AFTER_MS } from "../store";
import { OBJECT_IDS } from "./components";
import { TOUR, stopTime } from "./tour";

/** Same families the telemetry redaction scanner blocks: ARNs, account ids, resource ids, IPs, URLs. */
const FORBIDDEN_TEXT = [/arn:aws/i, /\d{12}/, /(i|vol|subnet|vpc|sg|asg)-[0-9a-f]{6,}/i, /\d{1,3}(\.\d{1,3}){3}/, /https?:\/\//i, /execute-api/i];

describe("guided tour", () => {
  it("every stop names a real scenario, object and anchor event", () => {
    expect(TOUR.length).toBe(13);
    for (const stop of TOUR) {
      expect(SCENARIOS.some((s) => s.id === stop.scenario)).toBe(true);
      if (stop.objectId) expect(OBJECT_IDS).toContain(stop.objectId);
      expect(stopTime(stop, buildScenario(stop.scenario)), stop.title).not.toBeNull();
    }
  });

  it("stops in the same scenario move forward in time", () => {
    let prev = { scenario: "", ts: -Infinity };
    for (const stop of TOUR) {
      const ts = stopTime(stop, buildScenario(stop.scenario))!;
      if (stop.scenario === prev.scenario) expect(ts, stop.title).toBeGreaterThanOrEqual(prev.ts);
      prev = { scenario: stop.scenario, ts };
    }
  });

  it("copy is public-safe", () => {
    for (const stop of TOUR) for (const re of FORBIDDEN_TEXT) expect(`${stop.title} ${stop.caption}`).not.toMatch(re);
  });

  it("lands on each stop with its event applied and its object framed", () => {
    useTwin.setState({ reducedMotion: true });
    TOUR.forEach((stop, i) => {
      useTwin.getState().tourGo(i);
      const s = useTwin.getState();
      expect(s.tour).toBe(i);
      expect(s.mode).toBe("replay");
      expect(s.source).toEqual({ kind: "sample", id: stop.scenario });
      expect(s.selected).toBe(stop.objectId);
      expect(s.playing).toBe(false);
      const ts = stopTime(stop, s.timeline.events)!;
      expect(s.history[s.history.length - 1].ts).toBeGreaterThanOrEqual(ts);
    });
    // The reject stop really shows a rejection, and the GPU never woke.
    const reject = TOUR.findIndex((t) => t.scenario === "laya-reject");
    useTwin.getState().tourGo(reject);
    expect(useTwin.getState().world.gpu.state).toBe("none");
    useTwin.getState().endTour();
    expect(useTwin.getState().tour).toBeNull();
  });

  it("with motion, plays a lead-in and pauses just after the stop's event", () => {
    useTwin.setState({ reducedMotion: false });
    useTwin.getState().tourGo(6);
    let s = useTwin.getState();
    expect(s.playing).toBe(true);
    const until = s.playUntil!;
    for (let k = 0; k < 400 && useTwin.getState().playing; k += 1) useTwin.getState().tick(50);
    s = useTwin.getState();
    expect(s.playing).toBe(false);
    expect(s.play).toBe(until);
    const ts = stopTime(TOUR[6], s.timeline.events)!;
    expect(s.world.gpu.state).toBe("running");
    expect(s.world.t).toBeGreaterThan(ts);
    expect(TOUR_AFTER_MS).toBeGreaterThan(0);
  });

  it("leaving for Live or another run ends the tour", () => {
    useTwin.getState().tourGo(2);
    useTwin.getState().setMode("live");
    expect(useTwin.getState().tour).toBeNull();
    useTwin.getState().tourGo(2);
    useTwin.getState().loadSource("sample:prewarm");
    expect(useTwin.getState().tour).toBeNull();
  });
});
