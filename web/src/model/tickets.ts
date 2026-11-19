import { QUEUE_LOCATION, namedPerQueue, type JobLocation, type JobView, type QueueName, type WorldState } from "./state";

export const CRATE_VISIBLE = 6;
export const MAX_ANON = 6;

/**
 * Tickets to draw at each location, oldest first. Shared by the 3D scene and the 2D
 * schematic so both show the same jobs. Live telemetry reports how many messages wait,
 * not which jobs: unnamed tickets are drawn only for depth beyond the named jobs that
 * queue is still holding, so no job appears twice.
 */
export function ticketsByLocation(jobs: WorldState["jobs"], depth: WorldState["queueDepth"]): Map<JobLocation, JobView[]> {
  const byLoc = new Map<JobLocation, JobView[]>();
  for (const j of Object.values(jobs)) {
    const list = byLoc.get(j.location) ?? [];
    list.push(j);
    byLoc.set(j.location, list);
  }
  const named = namedPerQueue(jobs);
  for (const [q, d] of Object.entries(depth) as [QueueName, { visible: number; inFlight: number }][]) {
    const loc = QUEUE_LOCATION[q];
    const list = byLoc.get(loc) ?? [];
    const missing = Math.min(MAX_ANON, d.visible + d.inFlight - named[q]);
    for (let i = 0; i < missing; i += 1) {
      list.push({
        id: `anon-${q}-${i}`,
        jobType: "unknown",
        location: loc,
        step: "queued",
        inFlight: i < d.inFlight,
        attempts: 0,
        receiveCount: 0,
        enqueuedAt: 0,
        seq: -100 + i,
      });
    }
    byLoc.set(loc, list);
  }
  for (const [loc, list] of byLoc) {
    list.sort((a, b) => a.seq - b.seq);
    if (loc === "crate") byLoc.set(loc, list.slice(-CRATE_VISIBLE));
  }
  return byLoc;
}

export type TicketTone = "plain" | "pass" | "reject" | "warn" | "fail" | "decided";

/** The stamp on a ticket: what has happened to the job so far. */
export function ticketTone(j: JobView): TicketTone {
  if (j.outcome === "dlq") return "fail";
  if (j.outcome === "rejected") return "reject";
  if (j.outcome === "needs_review") return "warn";
  if (j.outcome === "decided") return "decided";
  if (j.outcome === "completed") return "pass";
  if (j.step === "retrying") return "warn";
  if (j.step === "verifying") return j.verifyPassed ? "pass" : "warn";
  if (j.gate === "pass") return "pass";
  if (j.gate === "reject") return "reject";
  return "plain";
}
