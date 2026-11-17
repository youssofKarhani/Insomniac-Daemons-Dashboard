import { create } from "zustand";
import { buildScenario, SCENARIOS } from "./data/scenarios";
import type { TwinEvent } from "./model/events";
import { ReplayCursor, buildTimeline, playToSrc, type Timeline } from "./model/replay";
import { initialState, type WorldState } from "./model/state";
import type { ObjectId } from "./content/components";

export type Mode = "live" | "replay";

const reducedMotionQuery =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

interface TwinStore {
  mode: Mode;
  scenarioId: string;
  timeline: Timeline;
  cursor: ReplayCursor;
  /** Play time in ms along the (compressed) timeline. */
  play: number;
  playing: boolean;
  speed: number;
  world: WorldState;
  /** Events at or before the playhead, newest last. */
  history: TwinEvent[];
  selected: ObjectId | null;
  labels: boolean;
  reducedMotion: boolean;

  setMode: (m: Mode) => void;
  loadScenario: (id: string) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  seek: (play: number) => void;
  step: (dir: 1 | -1) => void;
  tick: (dtMs: number) => void;
  select: (id: ObjectId | null) => void;
  setLabels: (on: boolean) => void;
}

function prepare(id: string) {
  const timeline = buildTimeline(buildScenario(id));
  const cursor = new ReplayCursor(timeline);
  return { timeline, cursor };
}

function stateAtPlay(timeline: Timeline, cursor: ReplayCursor, play: number) {
  const src = playToSrc(timeline, play);
  const world = cursor.stateAt(src);
  const history = cursor.eventsUpTo(src);
  return { world, history };
}

const first = prepare(SCENARIOS[0].id);
/** Live has no telemetry yet: it shows the platform asleep at the end of the last sample run. */
const asleep = stateAtPlay(first.timeline, first.cursor, first.timeline.playDuration);

export const useTwin = create<TwinStore>((set, get) => ({
  mode: "live",
  scenarioId: SCENARIOS[0].id,
  timeline: first.timeline,
  cursor: first.cursor,
  play: first.timeline.playDuration,
  playing: false,
  speed: 1,
  world: asleep.world,
  history: asleep.history,
  selected: null,
  // Labels crowd a phone screen; tapping an object still shows its name.
  labels: typeof window === "undefined" || window.innerWidth >= 760,
  reducedMotion: reducedMotionQuery?.matches ?? false,

  setMode: (mode) => {
    if (mode === "live") {
      const { timeline, cursor } = get();
      set({ mode, playing: false, play: timeline.playDuration, ...stateAtPlay(timeline, cursor, timeline.playDuration) });
    } else {
      set({ mode });
      get().seek(0);
      set({ playing: true });
    }
  },
  loadScenario: (id) => {
    const { timeline, cursor } = prepare(id);
    set({ scenarioId: id, timeline, cursor, play: 0, mode: "replay", playing: true, ...stateAtPlay(timeline, cursor, 0) });
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
    set({ play: p, ...stateAtPlay(timeline, cursor, p) });
  },
  step: (dir) => {
    const { timeline, world } = get();
    const now = world.t;
    const ev = timeline.events;
    const target = dir > 0 ? ev.find((e) => e.ts > now + 1) : [...ev].reverse().find((e) => e.ts < now - 1);
    if (!target) return;
    const segIdx = timeline.segments.findIndex((s) => target.ts >= s.srcStart && target.ts <= s.srcEnd);
    const seg = timeline.segments[segIdx];
    if (!seg) return;
    const f = (target.ts - seg.srcStart) / (seg.srcEnd - seg.srcStart || 1);
    set({ playing: false });
    get().seek(seg.playStart + f * (seg.playEnd - seg.playStart) + 1);
  },
  tick: (dtMs) => {
    const { playing, play, speed, timeline, mode } = get();
    if (!playing || mode !== "replay") return;
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
}));

reducedMotionQuery?.addEventListener?.("change", (e) => useTwin.setState({ reducedMotion: e.matches }));

export const initialWorld = initialState;
