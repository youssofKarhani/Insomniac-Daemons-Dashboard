import { sortEvents, type TwinEvent } from "./events";
import { reduce } from "./reduce";
import { initialState, type WorldState } from "./state";

/**
 * Replay timeline: maps play time (what the viewer watches) to source time
 * (what really happened). Gaps longer than `maxGapMs` between consecutive
 * events are squeezed to `maxGapMs` and marked as compressed, so a 30-minute
 * idle wait does not take 30 minutes at 1x.
 */
export interface Segment {
  srcStart: number;
  srcEnd: number;
  playStart: number;
  playEnd: number;
  compressed: boolean;
}

export interface Timeline {
  events: TwinEvent[];
  segments: Segment[];
  srcStart: number;
  srcEnd: number;
  playDuration: number;
}

export const DEFAULT_MAX_GAP_MS = 6_000;
const LEAD_MS = 1_500;
const TAIL_MS = 3_000;

export function buildTimeline(raw: readonly TwinEvent[], maxGapMs = DEFAULT_MAX_GAP_MS): Timeline {
  const events = sortEvents(raw);
  if (events.length === 0) {
    return { events, segments: [], srcStart: 0, srcEnd: 0, playDuration: 0 };
  }
  const srcStart = events[0].ts - LEAD_MS;
  const srcEnd = events[events.length - 1].ts + TAIL_MS;
  const marks = [srcStart, ...events.map((e) => e.ts), srcEnd];
  const segments: Segment[] = [];
  let play = 0;
  for (let i = 1; i < marks.length; i += 1) {
    const a = marks[i - 1];
    const b = marks[i];
    if (b <= a) continue;
    const gap = b - a;
    const compressed = gap > maxGapMs;
    const len = compressed ? maxGapMs : gap;
    segments.push({ srcStart: a, srcEnd: b, playStart: play, playEnd: play + len, compressed });
    play += len;
  }
  return { events, segments, srcStart, srcEnd, playDuration: play };
}

function findSegment<K extends "playStart" | "srcStart">(segs: Segment[], key: K, v: number): Segment | undefined {
  const endKey = key === "playStart" ? "playEnd" : "srcEnd";
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (v < s[key]) hi = mid - 1;
    else if (v > s[endKey]) lo = mid + 1;
    else return s;
  }
  return undefined;
}

export function playToSrc(tl: Timeline, play: number): number {
  if (tl.segments.length === 0) return tl.srcStart;
  if (play <= 0) return tl.srcStart;
  if (play >= tl.playDuration) return tl.srcEnd;
  const s = findSegment(tl.segments, "playStart", play)!;
  const f = (play - s.playStart) / (s.playEnd - s.playStart);
  return s.srcStart + f * (s.srcEnd - s.srcStart);
}

export function srcToPlay(tl: Timeline, src: number): number {
  if (tl.segments.length === 0 || src <= tl.srcStart) return 0;
  if (src >= tl.srcEnd) return tl.playDuration;
  const s = findSegment(tl.segments, "srcStart", src)!;
  const f = (src - s.srcStart) / (s.srcEnd - s.srcStart);
  return s.playStart + f * (s.playEnd - s.playStart);
}

/**
 * Computes world state at any source time. Moving forward applies only new
 * events; moving backward restarts from the nearest snapshot.
 */
export class ReplayCursor {
  private readonly snapshots: { index: number; state: WorldState }[] = [];
  private index = -1; // last applied event index
  private state: WorldState;

  constructor(private readonly tl: Timeline, snapshotEvery = 200) {
    this.state = initialState(tl.srcStart);
    let s = this.state;
    tl.events.forEach((e, i) => {
      s = reduce(s, e);
      if ((i + 1) % snapshotEvery === 0) this.snapshots.push({ index: i, state: s });
    });
  }

  /** Index of the last event with ts <= src, or -1. */
  private lastIndexAt(src: number): number {
    const ev = this.tl.events;
    let lo = 0;
    let hi = ev.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ev[mid].ts <= src) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  stateAt(src: number): WorldState {
    const target = this.lastIndexAt(src);
    if (target < this.index) {
      const snap = [...this.snapshots].reverse().find((sn) => sn.index <= target);
      this.state = snap ? snap.state : initialState(this.tl.srcStart);
      this.index = snap ? snap.index : -1;
    }
    let s = this.state;
    for (let i = this.index + 1; i <= target; i += 1) s = reduce(s, this.tl.events[i]);
    this.state = s;
    this.index = target;
    return { ...s, t: src };
  }

  /** Events that happened at or before `src`, newest last. */
  eventsUpTo(src: number): TwinEvent[] {
    return this.tl.events.slice(0, this.lastIndexAt(src) + 1);
  }
}
