import type { ObjectId } from "../content/components";
import type { JobLocation, JobView } from "../model/state";
import { BELTS, LOCATION_NODE } from "./routes";

/**
 * Desk coordinates: x runs toward the lower right of the screen, z toward the
 * lower left; the camera sits on the diagonal, which gives the isometric view.
 * Platform tops sit at y = PLATFORM_Y.
 */
export const PLATFORM_Y = 0.4;
export const DESK_ROTATION = 0;

export const POS: Record<ObjectId, [number, number, number]> = {
  clock: [-9.2, 0, 4.6],
  gateway: [-6.2, 0, 5],
  lambda: [-3, 0, 5],
  ssm: [-10.4, 0, 0.4],
  workflowQueue: [-1, 0, 1.6],
  workflowDlq: [-3.05, 0, 1.6],
  gpuQueue: [2.2, 0, -0.8],
  gpuDlq: [4.15, 0, -0.8],
  keda: [1.6, 0, -2.3],
  s3: [8.4, 0, 4.2],
  vpc: [1.2, 0, -4.4],
  controlPlane: [-6.4, PLATFORM_Y, -4.6],
  pods: [-6.4, PLATFORM_Y + 3, -4.6],
  watchdog: [-8.6, PLATFORM_Y, -2.6],
  laya: [-2.3, PLATFORM_Y, -3.4],
  autoscaler: [3.0, 4.6, -4.6],
  gpuNode: [6.6, PLATFORM_Y, -4.6],
  guard: [6.6, PLATFORM_Y, -3.4],
  modelVolume: [9.4, PLATFORM_Y, -4.4],
  vllm: [6.6, PLATFORM_Y + 1.2, -4.6],
};

export const PLATFORMS = {
  a: { center: [-5, 0, -4.4] as [number, number, number], size: [10, PLATFORM_Y, 6.4] as [number, number, number], zone: "eu-north-1a" },
  // Zone C runs to the desk edge to hold the capacity bay at its far end.
  c: { center: [8.15, 0, -4.4] as [number, number, number], size: [9.5, PLATFORM_Y, 6.4] as [number, number, number], zone: "eu-north-1c" },
};

/** Where tickets rest for each job location: their node on the belts (routes.ts). */
export const ANCHOR = Object.fromEntries(
  (Object.keys(LOCATION_NODE) as JobLocation[]).map((loc) => [loc, BELTS.nodes[LOCATION_NODE[loc]]]),
) as Record<JobLocation, [number, number, number]>;

/** Per-location stacking: offset from the front slot for the n-th ticket at that spot. */
export function stackOffset(loc: JobLocation, n: number): [number, number, number] {
  switch (loc) {
    case "workflow":
      // Head at the west end; later tickets queue behind it toward the tail.
      return [n * 0.82, 0, 0];
    case "gpuQueue":
      // Head at the east end.
      return [-n * 0.82, 0, 0];
    default:
      return [0, n * 0.12, 0];
  }
}

/**
 * The archive is a deep bin set into the desk. Results pile up three to a layer; once the pile
 * passes two layers its floor sinks one layer for each new one, so the newest results stay
 * at the rim and older ones go down into the dark. Nothing is ever taken out.
 */
export const ARCHIVE_LAYER = 0.12;
export function archiveSink(archived: number): number {
  const top = Math.floor(Math.max(0, archived - 1) / 3);
  return Math.max(0, top - 1) * ARCHIVE_LAYER;
}
/** Layers below this depth are out of sight under the rim and are not drawn. */
const ARCHIVE_DRAWN_DEPTH = 0.75;
export function archiveOffset(slot: number, archived: number): [number, number, number] {
  return [(slot % 3) * 0.75, Math.floor(slot / 3) * ARCHIVE_LAYER - archiveSink(archived), 0];
}
export function archiveDrawn(slot: number, archived: number): boolean {
  return archiveOffset(slot, archived)[1] > -ARCHIVE_DRAWN_DEPTH;
}

/** Where a ticket rests relative to its place's anchor. */
export function ticketOffset(loc: JobLocation, n: number, job: JobView, archived: number): [number, number, number] {
  if (loc === "crate" && job.archiveSlot !== undefined) return archiveOffset(job.archiveSlot, archived);
  return stackOffset(loc, n);
}

/** False for tickets deep in the archive's pile, out of sight. */
export function ticketDrawn(loc: JobLocation, job: JobView, archived: number): boolean {
  return !(loc === "crate" && job.archiveSlot !== undefined) || archiveDrawn(job.archiveSlot, archived);
}
