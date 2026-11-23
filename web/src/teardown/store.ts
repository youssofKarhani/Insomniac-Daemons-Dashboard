import { create } from "zustand";

/**
 * UI state of the teardown view. The explode amount itself (0 assembled .. 1 apart) changes every
 * frame, so it lives in `motion` and is read inside useFrame; the store holds only choices.
 */
interface TeardownStore {
  /** Exploded target when not playing the sequence. */
  exploded: boolean;
  /** Auto sequence: take apart, hold, reassemble, hold. */
  playing: boolean;
  labels: boolean;
  turntable: boolean;
  xray: boolean;
  isolate: string | null;
  part: string | null;
  set: (p: Partial<Omit<TeardownStore, "set" | "reset">>) => void;
  reset: () => void;
}

const INITIAL = { exploded: true, playing: false, labels: true, turntable: true, xray: false, isolate: null, part: null };

export const useTeardown = create<TeardownStore>((set) => ({
  ...INITIAL,
  set: (p) => set(p),
  reset: () => set(INITIAL),
}));

/**
 * Per-frame values shared between the scene (writer) and the HUD (reader through rAF).
 * `scrub` is set by the timeline slider: while it is non-null the explode amount follows it.
 */
export const motion = {
  explode: 0,
  /** +1 coming apart, -1 coming together, 0 still. */
  dir: 0,
  /** Turntable angle in degrees, 0..360. */
  angle: 0,
  scrub: null as number | null,
  /** Seconds into the auto sequence. */
  seqT: 0,
};

/** Auto sequence timing in seconds: apart, hold, together, hold. */
export const SEQ = { apart: 3.2, holdOut: 3.5, together: 2.6, holdIn: 1.8 };
export const SEQ_TOTAL = SEQ.apart + SEQ.holdOut + SEQ.together + SEQ.holdIn;

/** Explode amount along the auto sequence at time `t` (seconds, wraps). */
export function sequenceAt(t: number): { e: number; dir: number } {
  const u = ((t % SEQ_TOTAL) + SEQ_TOTAL) % SEQ_TOTAL;
  if (u < SEQ.apart) return { e: u / SEQ.apart, dir: 1 };
  if (u < SEQ.apart + SEQ.holdOut) return { e: 1, dir: 0 };
  const v = u - SEQ.apart - SEQ.holdOut;
  if (v < SEQ.together) return { e: 1 - v / SEQ.together, dir: -1 };
  return { e: 0, dir: 0 };
}

/** State to state easing, cubic-bezier(0.65, 0, 0.35, 1) approximated by a smooth cubic. */
export function easeInOut(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Each group leaves in turn: group k of n starts at k/n of the first STAGGER of the timeline.
 * Coming back together runs the same curve backwards, so the last group out is the first in.
 */
export const STAGGER = 0.45;
export function partExplode(e: number, groupIndex: number, groups: number): number {
  const start = groups > 1 ? (groupIndex / (groups - 1)) * STAGGER : 0;
  return easeInOut((e - start) / (1 - STAGGER));
}
