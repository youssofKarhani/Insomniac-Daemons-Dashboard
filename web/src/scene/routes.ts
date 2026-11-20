import type { JobLocation } from "../model/state";

/**
 * The physical routes of the desk. Tickets only ever move along BELT edges; signal pulses only
 * ever move along CABLE edges. Both are small graphs: a move between two places follows the
 * shortest chain of edges, so every transition the reducer can produce has a real path.
 *
 * Coordinates are desk coordinates (see layout.ts). A belt node's y is the height of a ticket's
 * centre resting on that belt; a cable node's y is the height of the cable.
 */

export type P3 = [number, number, number];

// ---- generic graph --------------------------------------------------------

export interface GraphEdge<K extends string> {
  from: K;
  to: K;
  /** False: one-way, from `from` to `to` (most belts). */
  bi: boolean;
}

export interface Seg {
  /** Index into the graph's edge list, or -1 for a straight fallback. */
  edge: number;
  /** +1 when travelling from the edge's `from` to its `to`. */
  dir: 1 | -1;
  a: P3;
  b: P3;
  len: number;
}

export interface Route {
  segs: Seg[];
  len: number;
}

const dist = (a: P3, b: P3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

export function makeGraph<K extends string>(nodes: Record<K, P3>, edges: readonly GraphEdge<K>[]) {
  const adj = new Map<K, { to: K; edge: number; dir: 1 | -1; w: number }[]>();
  const add = (a: K, b: K, edge: number, dir: 1 | -1) => {
    const list = adj.get(a) ?? [];
    list.push({ to: b, edge, dir, w: dist(nodes[a], nodes[b]) });
    adj.set(a, list);
  };
  edges.forEach((e, i) => {
    add(e.from, e.to, i, 1);
    if (e.bi) add(e.to, e.from, i, -1);
  });
  const cache = new Map<string, Route>();

  /** Shortest route from `a` to `b` (Dijkstra; the graphs have a few dozen nodes). */
  function route(a: K, b: K): Route {
    const key = `${a}>${b}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const best = new Map<K, number>([[a, 0]]);
    const prev = new Map<K, { from: K; edge: number; dir: 1 | -1 }>();
    const open = new Set<K>([a]);
    while (open.size) {
      let cur: K | undefined;
      for (const k of open) if (cur === undefined || best.get(k)! < best.get(cur)!) cur = k;
      open.delete(cur!);
      if (cur === b) break;
      for (const n of adj.get(cur!) ?? []) {
        const d = best.get(cur!)! + n.w;
        if (d < (best.get(n.to) ?? Infinity)) {
          best.set(n.to, d);
          prev.set(n.to, { from: cur!, edge: n.edge, dir: n.dir });
          open.add(n.to);
        }
      }
    }
    const segs: Seg[] = [];
    if (a !== b) {
      if (!prev.has(b)) {
        // No belt joins these places: a straight move is the honest fallback.
        segs.push({ edge: -1, dir: 1, a: nodes[a], b: nodes[b], len: dist(nodes[a], nodes[b]) });
      } else {
        for (let k: K = b; k !== a; ) {
          const p = prev.get(k)!;
          segs.unshift({ edge: p.edge, dir: p.dir, a: nodes[p.from], b: nodes[k], len: dist(nodes[p.from], nodes[k]) });
          k = p.from;
        }
      }
    }
    const r = { segs, len: segs.reduce((s, x) => s + x.len, 0) };
    cache.set(key, r);
    return r;
  }
  return { nodes, edges, route };
}

// ---- belts ----------------------------------------------------------------

/**
 * Ticket heights: 0.11 on a desk belt, 0.19 on a tray belt, 0.51 on a platform belt,
 * 0.66 on the LAYA base, 0.82 on the front door's base, 3.45 on the tower roof.
 */
const BELT_NODES = {
  // Front door: the ticket is printed inside the base and rises through the slot.
  origin: [-6.2, 0.45, 5.0],
  arch: [-6.2, 0.82, 5.0],
  gwBack: [-6.2, 0.82, 4.25],
  gwFoot: [-6.2, 0.11, 3.1],
  // Inbound line to the inbox tail.
  inEnd: [-0.16, 0.11, 3.1],
  wfIn: [-0.16, 0.19, 2.3],
  wfTail: [-0.16, 0.19, 1.6],
  workflow: [-1.8, 0.19, 1.6],
  // Inbox head, out through the north wall and up the ramp onto platform A.
  wfNorth: [-1.8, 0.19, 0.9],
  wfOut: [-1.8, 0.11, 0.5],
  upFoot: [-1.8, 0.11, -0.5],
  upTop: [-1.8, 0.51, -1.3],
  // Platform A main line (z = -1.9).
  aLift: [-5.0, 0.51, -1.9],
  aJ: [-2.3, 0.51, -1.9],
  aIn: [-1.8, 0.51, -1.9],
  aD: [-0.7, 0.51, -1.9],
  aE: [-0.05, 0.51, -1.9],
  // Lift on the tower's east face up to the worker pod on the roof.
  liftFront: [-5.0, 0.51, -3.4],
  liftLow: [-5.0, 0.51, -3.85],
  liftHigh: [-5.0, 3.45, -3.85],
  worker: [-5.75, 3.45, -3.85],
  // Through the LAYA gate and out the back to the bridge.
  layaFront: [-2.3, 0.51, -2.4],
  layaIn: [-2.3, 0.66, -2.85],
  laya: [-2.3, 0.66, -3.4],
  layaOut: [-2.3, 0.66, -3.95],
  layaBack: [-2.3, 0.51, -4.35],
  aBack: [-2.3, 0.51, -4.6],
  // Across the network bridge to the cassette's input dock.
  core: [4.75, 0.51, -4.6],
  cJ: [4.75, 0.51, -2.75],
  gqRampTop: [3.45, 0.51, -2.75],
  gqRampFoot: [3.0, 0.11, -1.95],
  gqNorth: [3.0, 0.19, -1.5],
  // GPU queue: in at the west wall, head at the east end.
  gqIn: [0.95, 0.19, -0.8],
  gqTail: [1.36, 0.19, -0.8],
  gpuQueue: [3.0, 0.19, -0.8],
  // Results: down from platform A, along the trunk, up the chute and into the archive.
  downTop: [-0.7, 0.51, -1.3],
  downFoot: [-0.7, 0.11, -0.5],
  trunkW: [-0.7, 0.11, 0.4],
  trunkE: [5.2, 0.11, 0.4],
  crateFoot: [5.2, 0.11, 4.2],
  crateTop: [6.95, 0.95, 4.2],
  crateLip: [7.65, 0.95, 4.2],
  crate: [7.65, 0.19, 4.2],
  // Dead-letter chutes through the trays' side walls.
  wfWest: [-2.3, 0.19, 1.6],
  workflowDlq: [-3.05, 0.19, 1.6],
  gqEast: [3.5, 0.19, -0.8],
  gpuDlq: [4.15, 0.19, -0.8],
} satisfies Record<string, P3>;

export type BeltNode = keyof typeof BELT_NODES;

/** belt: a conveyor drawn and animated; chute: a short slide; lift: the tower lift; none/drop: no surface drawn. */
export type BeltKind = "belt" | "chute" | "lift" | "none" | "drop";

const b = (from: BeltNode, to: BeltNode, kind: BeltKind, bi = false) => ({ from, to, kind, bi });

export const BELT_EDGES = [
  b("origin", "arch", "none"),
  b("arch", "gwBack", "belt"),
  b("gwBack", "gwFoot", "belt"),
  b("gwFoot", "inEnd", "belt"),
  b("inEnd", "wfIn", "belt"),
  b("wfIn", "wfTail", "belt"),
  b("wfTail", "workflow", "belt"),
  b("workflow", "wfNorth", "belt", true),
  b("wfNorth", "wfOut", "belt", true),
  b("wfOut", "upFoot", "belt", true),
  b("upFoot", "upTop", "belt", true),
  b("upTop", "aIn", "belt", true),
  b("aIn", "aJ", "belt", true),
  b("aJ", "aLift", "belt", true),
  b("aLift", "liftFront", "belt", true),
  b("liftFront", "liftLow", "none", true),
  b("liftLow", "liftHigh", "lift", true),
  b("liftHigh", "worker", "none", true),
  b("aJ", "layaFront", "belt", true),
  b("layaFront", "layaIn", "belt", true),
  b("layaIn", "laya", "belt", true),
  b("laya", "layaOut", "belt", true),
  b("layaOut", "layaBack", "belt", true),
  b("layaBack", "aBack", "belt", true),
  b("aBack", "core", "belt", true),
  b("core", "cJ", "belt", true),
  b("cJ", "gqRampTop", "belt", true),
  b("gqRampTop", "gqRampFoot", "belt", true),
  b("gqRampFoot", "gqNorth", "belt", true),
  b("gqNorth", "gpuQueue", "belt", true),
  b("aIn", "aD", "belt", true),
  b("aD", "aE", "belt", true),
  b("aE", "gqIn", "belt"),
  b("gqIn", "gqTail", "belt"),
  b("gqTail", "gpuQueue", "belt"),
  b("aD", "downTop", "belt"),
  b("downTop", "downFoot", "belt"),
  b("downFoot", "trunkW", "belt"),
  b("trunkW", "trunkE", "belt"),
  b("trunkE", "crateFoot", "belt"),
  b("crateFoot", "crateTop", "belt"),
  b("crateTop", "crateLip", "chute"),
  b("crateLip", "crate", "drop"),
  b("workflow", "wfWest", "chute"),
  b("wfWest", "workflowDlq", "chute"),
  b("gpuQueue", "gqEast", "chute"),
  b("gqEast", "gpuDlq", "chute"),
] as const;

export const BELTS = makeGraph<BeltNode>(BELT_NODES, BELT_EDGES);
export const LIFT_EDGE = BELT_EDGES.findIndex((e) => e.kind === "lift");

/** Where a ticket rests at each location (its node on the belts). */
export const LOCATION_NODE: Record<JobLocation, BeltNode> = {
  arch: "arch",
  workflow: "workflow",
  worker: "worker",
  laya: "laya",
  gpuQueue: "gpuQueue",
  core: "core",
  crate: "crate",
  workflowDlq: "workflowDlq",
  gpuDlq: "gpuDlq",
};

/** Where every ticket's first move starts: inside the front door's base. */
export const ORIGIN: BeltNode = "origin";

// ---- cables ---------------------------------------------------------------

/** Desk cables lie at y = 0.03, platform cables at 0.43, roof cables at 3.43. */
const CABLE_NODES = {
  // Internet into the front door, then to the wake switch.
  net: [-5.5, 0.03, 8.45],
  gwFront: [-5.5, 0.03, 5.8],
  gw: [-6.2, 0.4, 5.0],
  gwEast: [-4.9, 0.03, 5.0],
  lmWest: [-3.8, 0.03, 5.0],
  lambda: [-3.0, 0.2, 5.0],
  lmBackW: [-3.3, 0.03, 4.45],
  lmBackE: [-2.6, 0.03, 4.45],
  lmEast: [-2.2, 0.03, 5.0],
  // Morning pre-warm to the wake switch, behind the front door.
  clock: [-9.2, 0.2, 4.6],
  clkBack: [-9.2, 0.03, 4.0],
  clkTurn: [-9.2, 0.03, 3.7],
  clkLm: [-3.3, 0.03, 3.7],
  // Wake switch to the control tower.
  cpA: [-2.6, 0.03, 2.6],
  cpB: [-4.2, 0.03, 2.6],
  cpC: [-4.2, 0.03, -1.15],
  cpD: [-4.2, 0.43, -1.25],
  cpJ: [-4.2, 0.43, -5.1],
  towerEast: [-5.38, 0.43, -5.1],
  tower: [-6.4, 1.5, -4.6],
  // Riser up the tower's east face to the LiteLLM pod on the roof.
  riserLow: [-5.38, 0.43, -5.45],
  riserHigh: [-5.38, 3.43, -5.45],
  roofTurn: [-6.4, 3.43, -5.45],
  litellm: [-6.4, 3.43, -5.05],
  // Across the network bridge to the GPU cradle, and the model drive's lead.
  bridgeW: [0.0, 0.43, -5.1],
  bridgeE: [3.4, 0.43, -5.1],
  gpuWest: [5.2, 0.43, -5.1],
  gpu: [6.6, 1.0, -4.6],
  gpuEast: [8.0, 0.43, -4.4],
  drive: [8.85, 0.43, -4.4],
  // GPU queue depth sensor to the demand lever.
  gqSensor: [1.6, 0.03, -1.55],
  keda: [1.6, 0.03, -1.9],
  // Wake switch to the stop guard (an AWS API call, not through the tower).
  grdB: [5.9, 0.03, 5.0],
  grdC: [5.9, 0.03, -1.15],
  grdD: [5.9, 0.43, -1.25],
  grdE: [5.9, 0.43, -3.0],
  grdF: [6.6, 0.43, -3.0],
  guard: [6.6, 0.43, -3.25],
  // Idle timer and operator console into the tower's front.
  wdBack: [-8.6, 0.43, -2.9],
  wdJ: [-8.6, 0.43, -3.3],
  twFrontA: [-7.0, 0.43, -3.3],
  towerFront: [-7.0, 0.43, -3.6],
  ssmBack: [-10.4, 0.03, -0.1],
  ssmA: [-10.4, 0.03, -1.15],
  ssmB: [-9.6, 0.03, -1.15],
  ssmC: [-9.6, 0.43, -1.25],
  ssmD: [-9.6, 0.43, -3.3],
  // Along the top of the capacity arm's rail, from the tower mast to the carriage's home in the bay.
  armTop: [-5.5, 4.68, -4.6],
  armBay: [11.5, 4.68, -4.6],
} satisfies Record<string, P3>;

export type CableNode = keyof typeof CABLE_NODES;

/** Which power a cable shows at rest. Hidden runs are inside an object and never drawn. */
export type CableLine = "net" | "cp" | "gpu" | "guard" | "ops" | "arm" | "hidden";

const c = (from: CableNode, to: CableNode, line: CableLine) => ({ from, to, line, bi: true });

export const CABLE_EDGES = [
  c("net", "gwFront", "net"),
  c("gwFront", "gw", "hidden"),
  c("gw", "gwEast", "hidden"),
  c("gwEast", "lmWest", "net"),
  c("lmWest", "lambda", "hidden"),
  c("lambda", "lmBackW", "hidden"),
  c("lambda", "lmBackE", "hidden"),
  c("lambda", "lmEast", "hidden"),
  c("clock", "clkBack", "hidden"),
  c("clkBack", "clkTurn", "net"),
  c("clkTurn", "clkLm", "net"),
  c("clkLm", "lmBackW", "net"),
  c("lmBackE", "cpA", "cp"),
  c("cpA", "cpB", "cp"),
  c("cpB", "cpC", "cp"),
  c("cpC", "cpD", "cp"),
  c("cpD", "cpJ", "cp"),
  c("cpJ", "towerEast", "cp"),
  c("towerEast", "tower", "hidden"),
  c("towerEast", "riserLow", "cp"),
  c("riserLow", "riserHigh", "cp"),
  c("riserHigh", "roofTurn", "cp"),
  c("roofTurn", "litellm", "cp"),
  c("cpJ", "bridgeW", "gpu"),
  c("bridgeW", "bridgeE", "gpu"),
  c("bridgeE", "gpuWest", "gpu"),
  c("gpuWest", "gpu", "hidden"),
  c("gpu", "gpuEast", "hidden"),
  c("gpuEast", "drive", "gpu"),
  c("gqSensor", "keda", "ops"),
  c("lmEast", "grdB", "guard"),
  c("grdB", "grdC", "guard"),
  c("grdC", "grdD", "guard"),
  c("grdD", "grdE", "guard"),
  c("grdE", "grdF", "guard"),
  c("grdF", "guard", "guard"),
  c("wdBack", "wdJ", "ops"),
  c("wdJ", "twFrontA", "ops"),
  c("twFrontA", "towerFront", "ops"),
  c("towerFront", "tower", "hidden"),
  c("ssmBack", "ssmA", "ops"),
  c("ssmA", "ssmB", "ops"),
  c("ssmB", "ssmC", "ops"),
  c("ssmC", "ssmD", "ops"),
  c("ssmD", "wdJ", "ops"),
  c("tower", "armTop", "hidden"),
  c("armTop", "armBay", "arm"),
] as const;

export const CABLES = makeGraph<CableNode>(CABLE_NODES, CABLE_EDGES);

/** A route through several cable nodes in order, e.g. tower → wake switch → stop guard. */
export function cableRoute(stops: readonly CableNode[]): Route {
  const segs: Seg[] = [];
  for (let i = 1; i < stops.length; i += 1) segs.push(...CABLES.route(stops[i - 1], stops[i]).segs);
  return { segs, len: segs.reduce((s, x) => s + x.len, 0) };
}

/** Point at distance `d` along a route, and the segment it lies on. */
export function along(r: Route, d: number, out: P3): Seg | undefined {
  let left = Math.max(0, Math.min(d, r.len));
  for (const s of r.segs) {
    if (left <= s.len || s === r.segs[r.segs.length - 1]) {
      const f = s.len > 0 ? Math.min(1, left / s.len) : 1;
      out[0] = s.a[0] + (s.b[0] - s.a[0]) * f;
      out[1] = s.a[1] + (s.b[1] - s.a[1]) * f;
      out[2] = s.a[2] + (s.b[2] - s.a[2]) * f;
      return s;
    }
    left -= s.len;
  }
  return undefined;
}
