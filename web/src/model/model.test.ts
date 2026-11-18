import { describe, expect, it } from "vitest";
import { SCENARIOS, buildScenario } from "../data/scenarios";
import { parseEvents, sortEvents, type TwinEvent } from "./events";
import { reduce, reduceAll } from "./reduce";
import { ReplayCursor, buildTimeline, playToSrc, srcToPlay } from "./replay";
import { initialState, type WorldState } from "./state";
import { CONFIG, fullColdStartSampleSeconds, gpuStartSampleSeconds } from "./timings";

function finalState(events: TwinEvent[]): WorldState {
  return reduceAll(sortEvents(events), initialState(0));
}

/** Invariants that must hold after every single event of every scenario. */
function checkInvariants(s: WorldState, e: TwinEvent) {
  const where = `${e.id} (${e.kind})`;
  if (s.vllm.state === "ready") {
    expect(s.gpu.state, where).toBe("running");
    expect(s.gpu.joined, where).toBe(true);
  }
  // Desired drops to 0 just before termination begins, so only launching requires desired=1.
  if (s.gpu.state === "launching") {
    expect(s.asg.desired, where).toBe(1);
  }
  for (const job of Object.values(s.jobs)) {
    if (job.location === "core") {
      expect(job.gate, `${where} job ${job.id}`).toBe("pass");
      expect(s.vllm.state, `${where} job ${job.id}`).toBe("ready");
    }
    if (job.location === "worker" || job.location === "laya") {
      expect(s.cp.state, `${where} job ${job.id}`).toBe("running");
    }
    if (job.outcome === "completed") expect(job.verifyPassed, where).toBe(true);
  }
  if (s.cp.state === "stopped") {
    expect(s.gpu.state === "running" || s.gpu.state === "launching", where).toBe(false);
  }
}

describe("events", () => {
  it("every scenario produces schema-valid events with unique ids", () => {
    for (const sc of SCENARIOS) {
      const ev = buildScenario(sc.id);
      expect(() => parseEvents(ev)).not.toThrow();
      expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
    }
  });
});

describe("reducer", () => {
  it("holds invariants after every event in every scenario", () => {
    for (const sc of SCENARIOS) {
      let s = initialState(0);
      for (const e of sortEvents(buildScenario(sc.id))) {
        s = reduce(s, e);
        checkInvariants(s, e);
      }
    }
  });

  it("is idempotent by event id", () => {
    const ev = buildScenario("cold-gpu");
    const once = finalState(ev);
    const twice = finalState([...ev, ...ev]);
    expect(twice.counters).toEqual(once.counters);
    expect(twice.runtime).toEqual(once.runtime);
  });

  it("every scenario ends asleep with the guard latched", () => {
    for (const sc of SCENARIOS) {
      const s = finalState(buildScenario(sc.id));
      expect(s.cp.state, sc.id).toBe("stopped");
      expect(s.gpu.state, sc.id).toBe("none");
      expect(s.vllm.state, sc.id).toBe("absent");
      expect(s.asg.desired, sc.id).toBe(0);
      expect(s.guardLocked, sc.id).toBe(true);
    }
  });

  it("ends each scenario with the expected outcome", () => {
    const expected: Record<string, Partial<WorldState["counters"]>> = {
      "cold-gpu": { completed: 1 },
      "laya-reject": { rejected: 1 },
      "decision-only": { decided: 1 },
      "needs-review": { needs_review: 1 },
      "retry-dlq": { dlq: 1 },
      prewarm: {},
      "warm-pair": { completed: 2 },
    };
    for (const sc of SCENARIOS) {
      const s = finalState(buildScenario(sc.id));
      const want = { completed: 0, rejected: 0, needs_review: 0, decided: 0, dlq: 0, ...expected[sc.id] };
      expect(s.counters, sc.id).toEqual(want);
    }
  });

  it("CPU-only scenarios never start the GPU", () => {
    for (const id of ["laya-reject", "decision-only", "prewarm"]) {
      const s = finalState(buildScenario(id));
      expect(s.runtime.gpuMs, id).toBe(0);
    }
  });

  it("dead-letters only after maxReceiveCount failures", () => {
    const s = finalState(buildScenario("retry-dlq"));
    const job = Object.values(s.jobs)[0];
    expect(job.location).toBe("gpuDlq");
    expect(job.receiveCount).toBe(CONFIG.maxReceiveCount);
  });

  it("keeps the GPU start inside the documented range and the full cold start longer", () => {
    const gpu = gpuStartSampleSeconds();
    expect(gpu).toBeGreaterThanOrEqual(CONFIG.coldStartSeconds[0]);
    expect(gpu).toBeLessThanOrEqual(CONFIG.coldStartSeconds[1]);
    expect(fullColdStartSampleSeconds()).toBeGreaterThan(CONFIG.coldStartSeconds[1]);
  });

  it("the warm job skips the cold start", () => {
    const ev = sortEvents(buildScenario("warm-pair"));
    const launches = ev.filter((e) => e.kind === "gpu.instance" && e.data.state === "launching");
    expect(launches).toHaveLength(1);
  });
});

describe("live telemetry", () => {
  it("tracks polled queue depth without inventing jobs", () => {
    const ev: TwinEvent = { id: "q1", ts: 10, kind: "queue.depth", confidence: "observed", data: { queue: "gpu", visible: 2, inFlight: 1 } };
    const s = reduce(initialState(0), ev);
    expect(s.queueDepth.gpu).toEqual({ visible: 2, inFlight: 1 });
    expect(Object.keys(s.jobs)).toHaveLength(0);
    const bad = reduce(s, { ...ev, id: "q2", data: { queue: "nope", visible: 5, inFlight: 0 } });
    expect(bad.queueDepth).toEqual(s.queueDepth);
  });
});

describe("replay", () => {
  const tl = buildTimeline(buildScenario("cold-gpu"));

  it("compresses long gaps and maps time both ways", () => {
    expect(tl.segments.some((s) => s.compressed)).toBe(true);
    expect(tl.playDuration).toBeLessThan(tl.srcEnd - tl.srcStart);
    for (const p of [0, 1234, tl.playDuration / 3, tl.playDuration / 2, tl.playDuration - 1]) {
      expect(srcToPlay(tl, playToSrc(tl, p))).toBeCloseTo(p, 3);
    }
  });

  it("seeking backward gives the same state as replaying from the start", () => {
    const cursor = new ReplayCursor(tl, 5);
    const end = cursor.stateAt(tl.srcEnd);
    const mid = playToSrc(tl, tl.playDuration * 0.4);
    const viaSeek = cursor.stateAt(mid);
    const fresh = new ReplayCursor(tl, 5).stateAt(mid);
    expect(viaSeek).toEqual(fresh);
    expect(end.cp.state).toBe("stopped");
  });
});
