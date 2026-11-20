import type { JobLocation, JobView, WorldState } from "./state";

/**
 * Tickets at each location, oldest first: named jobs and the unnamed tickets that stand in for
 * polled depth no named job accounts for (see reconcileAnon). Shared by the 3D scene and the
 * 2D schematic so both show the same tickets.
 */
export function ticketsByLocation(w: Pick<WorldState, "jobs" | "anon">): Map<JobLocation, JobView[]> {
  const byLoc = new Map<JobLocation, JobView[]>();
  for (const j of [...Object.values(w.jobs), ...Object.values(w.anon)]) {
    const list = byLoc.get(j.location) ?? [];
    list.push(j);
    byLoc.set(j.location, list);
  }
  for (const list of byLoc.values()) list.sort((a, b) => a.seq - b.seq);
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
