import { describe, expect, it } from "vitest";
import type { DashboardEvent } from "../model/events";
import { reduce } from "../model/reduce";
import { initialState, type QueueName, type WorldState } from "../model/state";
import { ticketsByLocation } from "../model/tickets";
import { archiveDrawn, archiveOffset, archiveSink } from "./layout";
import { runsOf } from "./ticketPath";

let n = 0;
const depth = (w: WorldState, ts: number, queue: QueueName, visible: number, inFlight = 0) =>
  reduce(w, { id: `d${n++}`, ts, kind: "queue.depth", confidence: "observed", data: { queue, visible, inFlight } } as DashboardEvent);

describe("unnamed tickets for polled depth", () => {
  it("ride in from the front door when depth rises and out to the archive when it falls", () => {
    for (const q of ["workflow", "gpu", "workflowDlq", "gpuDlq"] as QueueName[]) {
      let w = initialState(0);
      w = depth(w, 1_000, q, 2);
      const arrived = Object.values(w.anon);
      expect(arrived, q).toHaveLength(2);
      for (const a of arrived) {
        expect(a.hops, q).toEqual([{ to: a.location, at: 1_000 }]);
        // A real belt route from the front door, never a straight jump.
        expect(runsOf(a.hops)[0].route.segs.every((s) => s.edge >= 0), q).toBe(true);
      }
      w = depth(w, 61_000, q, 1);
      const gone = Object.values(w.anon).filter((a) => a.location === "crate");
      expect(gone, q).toHaveLength(1);
      // The oldest leaves first, along belts, and takes the next archive slot.
      expect(gone[0].id, q).toBe(arrived[0].id);
      expect(gone[0].archiveSlot, q).toBe(0);
      const runs = runsOf(gone[0].hops);
      expect(runs[1].route.segs.every((s) => s.edge >= 0), q).toBe(true);
    }
  });

  it("marks the oldest as held by the worker, as many as are in flight", () => {
    let w = depth(initialState(0), 1_000, "gpu", 1, 2);
    const list = ticketsByLocation(w).get("gpuQueue")!;
    expect(list.map((t) => t.inFlight)).toEqual([true, true, false]);
    w = depth(w, 2_000, "gpu", 2, 1);
    expect(ticketsByLocation(w).get("gpuQueue")!.map((t) => t.inFlight)).toEqual([true, false, false]);
  });

  it("never appear between polls because a named job moved", () => {
    let w = depth(initialState(0), 1_000, "workflow", 1);
    const job = (kind: string, ts: number, data: Record<string, unknown> = {}) =>
      (w = reduce(w, { id: `j${n++}`, ts, kind, confidence: "observed", jobId: "job-1", data } as DashboardEvent));
    // The polled message is this named job: it takes the unnamed ticket's place.
    job("ingress.request", 2_000, { route: "/jobs" });
    job("job.enqueued", 2_100, { queue: "workflow" });
    expect(Object.values(w.anon).filter((a) => a.location === "workflow")).toHaveLength(0);
    // It finishes before the next poll: no unnamed ticket pops back in for the stale count.
    job("job.dequeued", 3_000, { queue: "workflow" });
    job("job.finished", 4_000, { outcome: "completed" });
    expect(Object.values(w.anon).filter((a) => a.location === "workflow")).toHaveLength(0);
  });
});

describe("archive", () => {
  it("never moves a result sideways and sinks at most one layer per new result", () => {
    for (let total = 1; total < 60; total += 1) {
      expect(archiveSink(total)).toBeGreaterThanOrEqual(archiveSink(total - 1));
      expect(archiveSink(total) - archiveSink(total - 1)).toBeLessThanOrEqual(0.12 + 1e-9);
      for (let slot = 0; slot < total; slot += 1) {
        const [x, , z] = archiveOffset(slot, total);
        expect([x, z]).toEqual([(slot % 3) * 0.75, 0]);
      }
      // The newest results are always drawn at the rim.
      for (let slot = Math.max(0, total - 6); slot < total; slot += 1) expect(archiveDrawn(slot, total)).toBe(true);
      // The top of the pile never rises above the second layer.
      expect(archiveOffset(total - 1, total)[1]).toBeLessThanOrEqual(0.12 + 1e-9);
    }
  });
});
