import { create } from "zustand";
import { buildScenario, SCENARIOS } from "./data/scenarios";
import {
  DATA_URL,
  STALE_AFTER_MS,
  fetchCosts,
  fetchLive,
  fetchRun,
  fetchRunIndex,
  type CostsDoc,
  type LiveDoc,
  type RunSummary,
} from "./data/remote";
import type { DashboardEvent } from "./model/events";
import { ReplayCursor, buildTimeline, playToSrc, srcToPlay, type Timeline } from "./model/replay";
import { initialState, isStill, worldAt, type WorldState } from "./model/state";
import type { ObjectId } from "./content/components";
import { TOUR, stopTime } from "./content/tour";
import { signalArrival } from "./scene/signals";

export type Mode = "live" | "replay";
export type View = "3d" | "2d";

const VIEW_KEY = "sleepless-twin.view";
function savedView(): View {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(VIEW_KEY) === "2d" ? "2d" : "3d";
  } catch {
    return "3d";
  }
}

/** What Replay is showing: a generated sample or a run recorded by the telemetry stack. */
export type Source = { kind: "sample"; id: string } | { kind: "run"; id: string; start: number };

export type LiveStatus = "off" | "connecting" | "connected" | "stale" | "error";

const reducedMotionQuery =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

interface DashboardStore {
  mode: Mode;
  source: Source;
  timeline: Timeline;
  cursor: ReplayCursor;
  /** Play time in ms along the (compressed) timeline. Replay only. */
  play: number;
  playing: boolean;
  speed: number;
  /**
   * Reduced state. Replaced only when an event applies, so components that select from
   * it re-render on events, not on every frame. Its `t` is the last event's time; the
   * current time is `now` (use worldAt(world, now) where the clock matters).
   */
  world: WorldState;
  /** Source time of the playhead (Replay) or the wall clock (Live). Changes every frame. */
  now: number;
  /** Events at or before the playhead (or now, in Live), newest last. */
  history: DashboardEvent[];
  selected: ObjectId | null;
  labels: boolean;
  reducedMotion: boolean;
  /** 3D desk or 2D schematic. Both draw the same world state. */
  view: View;
  /** Object shown taken apart in the teardown view, or null. */
  teardown: ObjectId | null;

  live: { status: LiveStatus; generatedAt?: number; run?: LiveDoc["run"]; exporterAt?: number; error?: string };
  recorded: RunSummary[];
  costs: CostsDoc | null;
  loading: boolean;
  /** Index of the current guided-tour stop, or null when no tour is running. */
  tour: number | null;
  /** Replay pauses on reaching this play time (used by the tour). */
  playUntil: number | null;

  setMode: (m: Mode) => void;
  loadSource: (key: string) => Promise<void>;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  seek: (play: number) => void;
  step: (dir: 1 | -1) => void;
  tick: (dtMs: number) => void;
  select: (id: ObjectId | null) => void;
  setLabels: (on: boolean) => void;
  setView: (v: View) => void;
  setTeardown: (id: ObjectId | null) => void;
  refreshLive: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  refreshCosts: () => Promise<void>;
  startTour: () => void;
  tourGo: (index: number) => void;
  endTour: () => void;
}

/** The tour lands this far after its anchor event, so the event's effect is on screen. */
export const TOUR_AFTER_MS = 400;
/** Lead-in played before a stop's event when the tour jumps there. */
export const TOUR_LEAD_MS = 2_500;
/** Moving forward by up to this much play time, the tour plays through instead of jumping. */
export const TOUR_PLAY_THROUGH_MS = 12_000;

export const sourceKey = (s: Source) => `${s.kind}:${s.id}`;

function prepare(events: DashboardEvent[]) {
  const timeline = buildTimeline(events);
  const cursor = new ReplayCursor(timeline);
  return { timeline, cursor };
}

function stateAtPlay(timeline: Timeline, cursor: ReplayCursor, play: number) {
  const src = playToSrc(timeline, play);
  return { world: cursor.baseAt(src), now: src, history: cursor.eventsUpTo(src) };
}

/** Live view at the current wall-clock time. */
function stateAtNow(cursor: ReplayCursor) {
  const now = Date.now();
  return { world: cursor.baseAt(now), now, history: cursor.eventsUpTo(now) };
}

/** Keeps the previous history array when nothing new happened, so log and captions don't re-render every frame. */
function stableHistory<T extends { history: DashboardEvent[] }>(next: T, prev: DashboardEvent[]): T {
  const same = next.history.length === prev.length && next.history[next.history.length - 1] === prev[prev.length - 1];
  return same ? { ...next, history: prev } : next;
}

// Live keeps its own feed so switching modes never mixes it with a replay.
let liveFeed: { timeline: Timeline; cursor: ReplayCursor } = prepare([]);
let liveAbort: AbortController | null = null;

const first = prepare(buildScenario(SCENARIOS[0].id));
/** Without telemetry, Live shows the platform asleep where the last sample run ended. */
const asleep = stateAtPlay(first.timeline, first.cursor, first.timeline.playDuration);

export const useDashboard = create<DashboardStore>((set, get) => ({
  mode: "live",
  source: { kind: "sample", id: SCENARIOS[0].id },
  timeline: first.timeline,
  cursor: first.cursor,
  play: first.timeline.playDuration,
  playing: false,
  speed: 1,
  world: DATA_URL ? initialState(Date.now()) : asleep.world,
  now: DATA_URL ? Date.now() : asleep.now,
  history: DATA_URL ? [] : asleep.history,
  selected: null,
  // Labels crowd a phone screen; tapping an object still shows its name.
  // Labels need room: below 1280 px they collide on the desk. Hover or tap still shows a name.
  labels: typeof window === "undefined" || window.innerWidth >= 1280,
  reducedMotion: reducedMotionQuery?.matches ?? false,
  view: savedView(),
  teardown: null,

  live: { status: DATA_URL ? "connecting" : "off" },
  recorded: [],
  costs: null,
  loading: false,
  tour: null,
  playUntil: null,

  setMode: (mode) => {
    set({ tour: null, playUntil: null });
    if (mode === "live") {
      set({ mode, playing: false });
      if (DATA_URL) set(stateAtNow(liveFeed.cursor));
      else {
        const { timeline, cursor } = get();
        set({ play: timeline.playDuration, ...stateAtPlay(timeline, cursor, timeline.playDuration) });
      }
    } else {
      set({ mode });
      get().seek(0);
      set({ playing: true });
    }
  },

  loadSource: async (key) => {
    set({ tour: null, playUntil: null });
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    let events: DashboardEvent[];
    let source: Source;
    if (kind === "run") {
      set({ loading: true });
      try {
        const doc = await fetchRun(id);
        events = doc.events;
        source = { kind: "run", id, start: doc.run.start };
      } catch (err) {
        console.warn("Could not load run", err);
        set({ loading: false });
        return;
      }
    } else {
      events = buildScenario(id);
      source = { kind: "sample", id };
    }
    const { timeline, cursor } = prepare(events);
    set({ source, timeline, cursor, play: 0, mode: "replay", playing: true, loading: false, ...stateAtPlay(timeline, cursor, 0) });
  },

  setPlaying: (playing) => {
    const { play, timeline } = get();
    if (playing && play >= timeline.playDuration) get().seek(0);
    set({ playing });
  },
  setSpeed: (speed) => set({ speed }),
  seek: (play) => {
    const { timeline, cursor } = get();
    const p = Math.max(0, Math.min(timeline.playDuration, play));
    set({ play: p, ...stableHistory(stateAtPlay(timeline, cursor, p), get().history) });
  },
  step: (dir) => {
    const { timeline, now } = get();
    const ev = timeline.events;
    const target = dir > 0 ? ev.find((e) => e.ts > now + 1) : [...ev].reverse().find((e) => e.ts < now - 1);
    if (!target) return;
    const seg = timeline.segments.find((s) => target.ts >= s.srcStart && target.ts <= s.srcEnd);
    if (!seg) return;
    const f = (target.ts - seg.srcStart) / (seg.srcEnd - seg.srcStart || 1);
    set({ playing: false });
    get().seek(seg.playStart + f * (seg.playEnd - seg.playStart) + 1);
  },
  tick: (dtMs) => {
    const { playing, play, speed, timeline, mode, live } = get();
    if (mode === "live") {
      if (!DATA_URL) return;
      const next = stableHistory(stateAtNow(liveFeed.cursor), get().history);
      // While everything sleeps nothing moves with time, so the clock only needs to tick once a
      // second (for "Asleep for …"). The 3D view then stops rendering until something happens.
      const prev = get();
      const changed = next.world !== prev.world || next.history !== prev.history;
      if (changed || !isStill(next.world, next.now) || next.now - prev.now >= 1_000) set(next);
      if (live.generatedAt !== undefined) {
        const stale = Date.now() - live.generatedAt > STALE_AFTER_MS;
        if (stale && live.status === "connected") set({ live: { ...live, status: "stale" } });
        if (!stale && live.status === "stale") set({ live: { ...live, status: "connected" } });
      }
      return;
    }
    if (!playing) return;
    const next = play + dtMs * speed;
    const until = get().playUntil;
    if (until !== null && next >= until) {
      get().seek(until);
      set({ playing: false, playUntil: null });
      return;
    }
    if (next >= timeline.playDuration) {
      get().seek(timeline.playDuration);
      set({ playing: false });
      return;
    }
    get().seek(next);
  },
  select: (selected) => set({ selected }),
  setTeardown: (teardown) => set({ teardown }),
  setLabels: (labels) => set({ labels }),
  setView: (view) => {
    set({ view });
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Private windows may block storage; the choice then lasts for this visit only.
    }
  },

  refreshLive: async () => {
    if (!DATA_URL) return;
    liveAbort?.abort();
    liveAbort = new AbortController();
    try {
      const doc = await fetchLive(liveAbort.signal);
      const prev = get().live;
      // Rebuild only when the feed changed; the cursor then catches up incrementally.
      if (doc.generatedAt !== prev.generatedAt || doc.events.length !== liveFeed.timeline.events.length) {
        liveFeed = prepare(doc.events);
      }
      const stale = Date.now() - doc.generatedAt > STALE_AFTER_MS;
      set({ live: { status: stale ? "stale" : "connected", generatedAt: doc.generatedAt, run: doc.run, exporterAt: doc.exporterAt } });
      if (get().mode === "live") set(stateAtNow(liveFeed.cursor));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      set({ live: { ...get().live, status: "error", error: (err as Error).message } });
    }
  },
  refreshRuns: async () => {
    if (!DATA_URL) return;
    try {
      set({ recorded: await fetchRunIndex() });
    } catch (err) {
      console.warn("Could not load recorded runs", err);
    }
  },
  refreshCosts: async () => {
    if (!DATA_URL) return;
    try {
      set({ costs: await fetchCosts() });
    } catch (err) {
      console.warn("Could not load costs", err);
    }
  },

  startTour: () => get().tourGo(0),
  tourGo: (index) => {
    const stop = TOUR[Math.max(0, Math.min(TOUR.length - 1, index))];
    const i = TOUR.indexOf(stop);
    let { source, timeline, cursor } = get();
    const fresh = source.kind !== "sample" || source.id !== stop.scenario;
    if (fresh) {
      source = { kind: "sample", id: stop.scenario };
      ({ timeline, cursor } = prepare(buildScenario(stop.scenario)));
    }
    const ts = stopTime(stop, timeline.events);
    const arrival = ts === null || get().reducedMotion ? ts : Math.max(ts,
      ...timeline.events.filter((e) => e.ts === ts).map((e) => signalArrival(e, timeline.events)));
    const target = arrival === null ? timeline.playDuration : Math.min(timeline.playDuration, srcToPlay(timeline, arrival) + TOUR_AFTER_MS);
    const from = get().play;
    const playThrough = !fresh && target > from && target - from <= TOUR_PLAY_THROUGH_MS;
    const start = get().reducedMotion ? target : playThrough ? from : Math.max(0, target - TOUR_LEAD_MS);
    set({
      mode: "replay",
      tour: i,
      source,
      timeline,
      cursor,
      selected: stop.objectId,
      speed: 1,
      playing: start < target,
      playUntil: start < target ? target : null,
      play: start,
      ...stateAtPlay(timeline, cursor, start),
    });
  },
  endTour: () => set({ tour: null, playUntil: null, playing: false, selected: null }),
}));

/** The world at the current time. Allocates only when the clock moved; prefer selecting fields. */
export const currentWorld = (s: { world: WorldState; now: number }) => worldAt(s.world, s.now);

reducedMotionQuery?.addEventListener?.("change", (e) => useDashboard.setState({ reducedMotion: e.matches }));
