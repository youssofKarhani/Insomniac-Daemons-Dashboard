import type { ObjectId } from "../content/components";
import type { JobLocation } from "../model/state";

/**
 * Layout of the 2D schematic. The districts match the 3D desk: the two platforms at the
 * back, queues across the middle, always-on pieces at the front left, the archive at the
 * front right. "tall" stacks the districts in the order work flows, for phones.
 */
export const BOX_W = 150;
export const BOX_H = 66;
const GAP = 12;
const PAD = 14;
const HEAD = 30;

export interface District {
  id: string;
  label: string;
  objects: ObjectId[];
  /** Platforms are drawn as raised slabs, like the desk. */
  platform?: boolean;
}

export const DISTRICTS: Record<string, District> = {
  always: { id: "always", label: "Always on", objects: ["clock", "gateway", "lambda", "ssm", "vpc"] },
  queues: { id: "queues", label: "Queues", objects: ["workflowQueue", "workflowDlq", "gpuQueue", "gpuDlq", "keda"] },
  cp: { id: "cp", label: "Control plane · eu-north-1a", objects: ["controlPlane", "pods", "laya", "watchdog", "autoscaler"], platform: true },
  gpu: { id: "gpu", label: "GPU · eu-north-1c", objects: ["gpuNode", "vllm", "guard", "modelVolume"], platform: true },
  archive: { id: "archive", label: "Archive", objects: ["s3"] },
};

/** Which box shows the tickets at each job location. */
export const LOCATION_BOX: Record<JobLocation, ObjectId> = {
  arch: "gateway",
  workflow: "workflowQueue",
  worker: "pods",
  laya: "laya",
  gpuQueue: "gpuQueue",
  core: "vllm",
  crate: "s3",
  workflowDlq: "workflowDlq",
  gpuDlq: "gpuDlq",
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  districts: (Rect & { district: District })[];
  boxes: Record<ObjectId, Rect>;
}

type Placement = { id: keyof typeof DISTRICTS; x: number; y: number; cols: number };

const WIDE: Placement[] = [
  { id: "cp", x: 0, y: 0, cols: 3 },
  { id: "gpu", x: 680, y: 0, cols: 2 },
  { id: "queues", x: 0, y: 236, cols: 5 },
  { id: "always", x: 0, y: 360, cols: 5 },
  { id: "archive", x: 842, y: 236, cols: 1 },
];

const TALL_ORDER: (keyof typeof DISTRICTS)[] = ["always", "queues", "cp", "gpu", "archive"];

function size(cols: number, count: number) {
  const rows = Math.ceil(count / cols);
  return { w: cols * BOX_W + (cols - 1) * GAP + 2 * PAD, h: HEAD + rows * BOX_H + (rows - 1) * GAP + PAD };
}

export function layout(kind: "wide" | "tall"): Layout {
  let placements: Placement[];
  if (kind === "wide") placements = WIDE;
  else {
    let y = 0;
    placements = TALL_ORDER.map((id) => {
      const p = { id, x: 0, y, cols: 2 };
      y += size(2, DISTRICTS[id].objects.length).h + 18;
      return p;
    });
  }
  const districts: Layout["districts"] = [];
  const boxes = {} as Record<ObjectId, Rect>;
  let width = 0;
  let height = 0;
  for (const p of placements) {
    const d = DISTRICTS[p.id];
    const s = size(p.cols, d.objects.length);
    districts.push({ x: p.x, y: p.y, w: s.w, h: s.h, district: d });
    d.objects.forEach((id, i) => {
      const col = i % p.cols;
      const row = Math.floor(i / p.cols);
      boxes[id] = { x: p.x + PAD + col * (BOX_W + GAP), y: p.y + HEAD + row * (BOX_H + GAP), w: BOX_W, h: BOX_H };
    });
    width = Math.max(width, p.x + s.w);
    height = Math.max(height, p.y + s.h);
  }
  return { width, height, districts, boxes };
}
