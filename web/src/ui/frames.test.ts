import { describe, expect, it } from "vitest";
import { OBJECT_IDS } from "../content/components";
import { buildScenario } from "../data/scenarios";
import { sortEvents } from "../model/events";
import { reduce } from "../model/reduce";
import { lastIndexAt } from "../model/replay";
import { MOTION_AFTER_EVENT_MS, initialState, isStill } from "../model/state";
import { currentWorld, useTwin } from "../store";
import { boxKey, boxViews } from "./status";

/** Re-render budget: playback between events must not hand panels a new world. */
describe("per-frame updates", () => {
  it("keeps the world object between events and moves only the clock", () => {
    useTwin.getState().loadSource("sample:cold-gpu");
    const s0 = useTwin.getState();
    const evs = s0.timeline.events;
    // Find a quiet stretch (8 s between events) and start after the 3 s flash of the earlier event.
    const i = evs.findIndex((e, k) => k > 0 && e.ts - evs[k - 1].ts > 8_000);
    const start = evs[i - 1].ts + 3_500;
    useTwin.getState().seek(0);
    // Seek by play time until just past the earlier event, then step frame by frame.
    let p = 0;
    while (useTwin.getState().now < start) useTwin.getState().seek((p += 16));
    const world = useTwin.getState().world;
    const history = useTwin.getState().history;
    const keys = OBJECT_IDS.map((id) => boxKey(boxViews(currentWorld(useTwin.getState()))[id])).join();
    const now0 = useTwin.getState().now;
    for (let k = 0; k < 20; k += 1) useTwin.getState().seek((p += 16));
    const s = useTwin.getState();
    expect(s.now).toBeGreaterThan(now0);
    expect(s.now).toBeLessThan(evs[i].ts);
    expect(s.world).toBe(world);
    expect(s.history).toBe(history);
    // The schematic's keys only change when a box's drawing does.
    expect(OBJECT_IDS.map((id) => boxKey(boxViews(currentWorld(s))[id])).join()).toBe(keys);
  });

  it("applies an event exactly when the playhead reaches it", () => {
    const s = useTwin.getState();
    const before = s.world;
    const e = s.timeline.events.find((x) => x.ts > s.now)!;
    while (useTwin.getState().now < e.ts) useTwin.getState().seek(useTwin.getState().play + 16);
    expect(useTwin.getState().world).not.toBe(before);
    expect(useTwin.getState().world.lastEventId).toBe(e.id);
  });
});

describe("on-demand rendering", () => {
  it("calls the scene still only when everything is off and the last motion has finished", () => {
    const events = buildScenario("prewarm");
    let w = initialState(events[0].ts - 60_000);
    expect(isStill(w, w.t)).toBe(true);
    const seen: boolean[] = [];
    for (const e of events) {
      w = reduce(w, e);
      seen.push(isStill(w, e.ts));
    }
    // Every moment of the pre-warm, from the clock firing to the tower stopping, moves.
    expect(seen.every((x) => !x)).toBe(true);
    const end = events[events.length - 1].ts;
    expect(isStill(w, end + MOTION_AFTER_EVENT_MS - 1)).toBe(false);
    expect(isStill(w, end + MOTION_AFTER_EVENT_MS)).toBe(true);
  });

  it("finds the last event at or before a time", () => {
    const ev = sortEvents(buildScenario("cold-gpu"));
    expect(lastIndexAt(ev, ev[0].ts - 1)).toBe(-1);
    expect(lastIndexAt(ev, ev[ev.length - 1].ts + 1)).toBe(ev.length - 1);
    for (let i = 0; i < ev.length; i += 1) {
      const j = lastIndexAt(ev, ev[i].ts);
      expect(ev[j].ts).toBe(ev[i].ts);
      expect(j === ev.length - 1 || ev[j + 1].ts > ev[i].ts).toBe(true);
    }
  });
});
