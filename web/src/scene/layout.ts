import type { ObjectId } from "../content/components";
import type { JobLocation } from "../model/state";

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
  workflowDlq: [-1, 0, 4],
  gpuQueue: [2.2, 0, -0.8],
  gpuDlq: [2.2, 0, 1.6],
  keda: [3.9, 0, -0.6],
  s3: [8.4, 0, 4.2],
  vpc: [1.2, 0, -4.4],
  controlPlane: [-6.4, PLATFORM_Y, -4.6],
  pods: [-6.4, PLATFORM_Y + 3, -4.6],
  watchdog: [-4.5, PLATFORM_Y, -2.8],
  laya: [-2.3, PLATFORM_Y, -3.4],
  autoscaler: [0, PLATFORM_Y + 3.9, -6.3],
  gpuNode: [6.6, PLATFORM_Y, -4.6],
  guard: [6.6, PLATFORM_Y, -3.4],
  modelVolume: [9.4, PLATFORM_Y, -4.4],
  vllm: [6.6, PLATFORM_Y + 1.2, -4.6],
};

export const PLATFORMS = {
  a: { center: [-5, 0, -4.4] as [number, number, number], size: [10, PLATFORM_Y, 6.4] as [number, number, number], zone: "eu-north-1a" },
  c: { center: [7.4, 0, -4.4] as [number, number, number], size: [8, PLATFORM_Y, 6.4] as [number, number, number], zone: "eu-north-1c" },
};

/** Where tickets rest for each job location (top surface centres). */
export const ANCHOR: Record<JobLocation, [number, number, number]> = {
  arch: [-6.2, 0.95, 5],
  workflow: [-1.6, 0.28, 1.6],
  worker: [-4.7, PLATFORM_Y + 1.6, -4.6],
  laya: [-2.3, PLATFORM_Y + 0.75, -3.4],
  gpuQueue: [1.6, 0.28, -0.8],
  core: [6.6, PLATFORM_Y + 2.1, -4.6],
  crate: [7.8, 0.45, 4.2],
  workflowDlq: [-1, 0.25, 4],
  gpuDlq: [2.2, 0.25, 1.6],
};

/** Per-location stacking: offset applied for the n-th ticket at that spot. */
export function stackOffset(loc: JobLocation, n: number): [number, number, number] {
  switch (loc) {
    case "workflow":
    case "gpuQueue":
      return [n * 0.85, 0, 0];
    case "crate":
      return [(n % 3) * 0.8, Math.floor(n / 3) * 0.12, 0];
    default:
      return [0, n * 0.12, 0];
  }
}
