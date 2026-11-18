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
import type { TwinEvent } from "./model/events";
import { ReplayCursor, buildTimeline, playToSrc, type Timeline } from "./model/replay";
import { initialState, type WorldState } from "./model/state";
import type { ObjectId } from "./content/components";

export type Mode = "live" | "replay";

/** What Replay is showing: a generated sample or a run recorded by the telemetry stack. */
export type Source = { kind: "sample"; id: string } | { kind: "run"; id: string; start: number };

export type LiveStatus = "off" | "connecting" | "connected" | "stale" | "error";

const reducedMotionQuery =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

interface TwinStore {
  mode: Mode;
  source: Source;
  timeline: Timeline;
  cursor: ReplayCursor;
  /** Play time in ms along the (compressed) timeline. Replay only. */
  play: number;
  playing: boolean;
  speed: number;
  world: WorldState;
  /** Events at or before the playhead (or now, in Live), newest last. */
  history: TwinEvent[];
  selected: ObjectId | null;
  labels: boolean;
  reducedMotion: boolean;

  live: { status: LiveStatus; generatedAt?: number; run?: LiveDoc["run"]; error?: string };
  recorded: RunSummary[];
  costs: CostsDoc | null;
  loading: boolean;

  setMode: (m: Mode) => void;
  loadSource: (key: string) => Promise<void>;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  seek: (play: number) => void;
  step: (dir: 1 | -1) => void;
  tick: (dtMs: number) => void;
  select: (id: ObjectId | null) => void;
  setLabels: (on: boolean) => void;
  refreshLive: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  refreshCosts: () => Promise<void>;
}

export const sourceKey = (s: Source) => `${s.kind}:${s.id}`;

function prepare(events: TwinEvent[]) {
  const timeline = buildTimeline(events);
  const cursor = new ReplayCursor(timeline);
  return { timeline, cursor };
}

function stateAtPlay(timeline: Timeline, cursor: ReplayCursor, play: number) {
  const src = playToSrc(timeline, play);
  return { world: cursor.stateAt(src), history: cursor.eventsUpTo(src) };
}

/** Live view at the current wall-clock time. */
function stateAtNow(cursor: ReplayCursor) {
  const now = Date.now();
  return { world: { ...cursor.stateAt(now), t: now }, history: cursor.eventsUpTo(now) };
}

/** Keeps the previous history array when nothing new happened, so log and captions don't re-render every frame. */
function stableHistory<T extends { history: TwinEvent[] }>(next: T, prev: TwinEvent[]): T {
  const same = next.history.length === prev.length && next.history[next.history.length - 1] === prev[prev.length - 1];
  return same ? { ...next, history: prev } : next;
}

// Live keeps its own feed so switching modes never mixes it with a replay.
let liveFeed: { timeline: Timeline; cursor: ReplayCursor } = prepare([]);
let liveAbort: AbortController | null = null;

const first = prepare(buildScenario(SCENARIOS[0].id));
/** Without telemetry, Live shows the platform asleep where the last sample run ended. */
const asleep = stateAtPlay(first.timeline, first.cursor, first.timeline.playDuration);

export const useTwin = create<TwinStore>((set, get) => ({
  mode: "live",
  source: { kind: "sample", id: SCENARIOS[0].id },
  timeline: first.timeline,
  cursor: first.cursor,
  play: first.timeline.playDuration,
  playing: false,
  speed: 1,
  world: DATA_URL ? initialState(Date.now()) : asleep.world,
  history: DATA_URL ? [] : asleep.history,
  selected: null,
  // Labels crowd a phone screen; tapping an object still shows its name.
  labels: typeof window === "undefined" || window.innerWidth >= 760,
  reducedMotion: reducedMotionQuery?.matches ?? false,

  live: { status: DATA_URL ? "connecting" : "off" },
  recorded: [],
  costs: null,
  loading: false,

  setMode: (mode) => {
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
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    let events: TwinEvent[];
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
    const { timeline, world } = get();
    const now = world.t;
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
      set(stableHistory(stateAtNow(liveFeed.cursor), get().history));
      if (live.generatedAt !== undefined) {
        const stale = Date.now() - live.generatedAt > STALE_AFTER_MS;
        if (stale && live.status === "connected") set({ live: { ...live, status: "stale" } });
        if (!stale && live.status === "stale") set({ live: { ...live, status: "connected" } });
      }
      return;
    }
    if (!playing) return;
    const next = play + dtMs * speed;
    if (next >= timeline.playDuration) {
      get().seek(timeline.playDuration);
      set({ playing: false });
      return;
    }
    get().seek(next);
  },
  select: (selected) => set({ selected }),
  setLabels: (labels) => set({ labels }),

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
      set({ live: { status: stale ? "stale" : "connected", generatedAt: doc.generatedAt, run: doc.run } });
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
}));

reducedMotionQuery?.addEventListener?.("change", (e) => useTwin.setState({ reducedMotion: e.matches }));
