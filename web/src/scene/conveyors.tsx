import { Edges } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { WorldState } from "../model/state";
import { ticketsByLocation } from "../model/tickets";
import { useTwin } from "../store";
import { Block, C, Lamp, RM, W, approach, type Num } from "./kit";
import { stackOffset } from "./layout";
import { BELTS, BELT_EDGES, CABLES, CABLE_EDGES, LIFT_EDGE, type CableLine, type P3 } from "./routes";
import { newPose, poseAt, upOf, type Pose } from "./ticketPath";

const BELT_W = 0.7;
const BELT_T = 0.06;
/** Ticket centre sits this far above the belt's centre line (half a ticket plus half a belt). */
const BELT_DROP = 0.05 + BELT_T / 2;
/** Belt stripe period in desk units. */
const STRIPE = 0.3;

const v3 = (p: P3) => new THREE.Vector3(...p);

/** Position and orientation of a flat box laid from a to b, local x along the run. */
function laid(a: P3, b: P3, up: P3, drop: number) {
  const A = v3(a);
  const B = v3(b);
  const dir = B.clone().sub(A);
  const len = dir.length();
  dir.normalize();
  const U = v3(up);
  const side = dir.clone().cross(U).normalize();
  const m = new THREE.Matrix4().makeBasis(dir, U, side);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const pos = A.add(B).multiplyScalar(0.5).addScaledVector(U, -drop);
  return { pos: pos.toArray() as P3, rot: new THREE.Euler().setFromQuaternion(q).toArray().slice(0, 3) as P3, len };
}

let stripeImage: HTMLCanvasElement | null = null;
function stripeTexture(len: number) {
  if (!stripeImage) {
    stripeImage = document.createElement("canvas");
    stripeImage.width = 32;
    stripeImage.height = 8;
    const g = stripeImage.getContext("2d")!;
    g.fillStyle = "#28316a";
    g.fillRect(0, 0, 32, 8);
    g.fillStyle = "#353f80";
    g.fillRect(0, 0, 9, 8);
  }
  const t = new THREE.CanvasTexture(stripeImage);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(len / STRIPE, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Poses of every named ticket at the playhead, shared by the belts and the lift each frame. */
function usePoses() {
  const poses = useRef(new Map<string, Pose>());
  const off = useMemo<P3>(() => [0, 0, 0], []);
  return (w: WorldState) => {
    const t = RM() ? Infinity : w.t;
    const seen = new Set<string>();
    for (const [loc, list] of ticketsByLocation(w.jobs, w.queueDepth)) {
      list.forEach((job, n) => {
        if (job.hops.length === 0) return;
        const o = stackOffset(loc, n);
        off[0] = o[0];
        off[1] = o[1];
        off[2] = o[2];
        let p = poses.current.get(job.id);
        if (!p) poses.current.set(job.id, (p = newPose()));
        poseAt(job, t, off, p);
        seen.add(job.id);
      });
    }
    for (const id of poses.current.keys()) if (!seen.has(id)) poses.current.delete(id);
    return poses.current;
  };
}

/** Conveyor belts and chutes. A belt's surface runs only while it carries a ticket, at the ticket's speed. */
export function Belts() {
  const drawn = useMemo(
    () =>
      BELT_EDGES.flatMap((e, i) => {
        if (e.kind !== "belt" && e.kind !== "chute") return [];
        const a = BELTS.nodes[e.from];
        const b = BELTS.nodes[e.to];
        const l = laid(a, b, upOf(a, b), BELT_DROP);
        return [{ i, ...l, tex: stripeTexture(l.len) }];
      }),
    [],
  );
  // Square pads where a belt turns, so corners are closed.
  const pads = useMemo(() => {
    const dirs = new Map<string, THREE.Vector3[]>();
    for (const d of drawn) {
      const e = BELT_EDGES[d.i];
      const dir = v3(BELTS.nodes[e.to]).sub(v3(BELTS.nodes[e.from])).normalize();
      for (const k of [e.from, e.to]) dirs.set(k, [...(dirs.get(k) ?? []), dir]);
    }
    const out: P3[] = [];
    for (const [k, list] of dirs) {
      const turns = list.some((x) => list.some((y) => Math.abs(x.dot(y)) < 0.999));
      if (turns) {
        const p = BELTS.nodes[k as keyof typeof BELTS.nodes];
        out.push([p[0], p[1] - BELT_DROP, p[2]]);
      }
    }
    return out;
  }, [drawn]);

  const texByEdge = useMemo(() => new Map(drawn.map((d) => [d.i, d.tex])), [drawn]);
  const last = useRef(new Map<string, { edge: number; s: number }>());
  const poses = usePoses();
  useFrame(() => {
    const now = poses(W());
    for (const [id, p] of now) {
      const prev = last.current.get(id);
      if (p.edge >= 0 && prev && prev.edge === p.edge) {
        const tex = texByEdge.get(p.edge);
        if (tex) tex.offset.x -= (p.s - prev.s) / STRIPE;
      }
      last.current.set(id, { edge: p.edge, s: p.s });
    }
    for (const id of last.current.keys()) if (!now.has(id)) last.current.delete(id);
  });

  return (
    <group>
      {drawn.map((d) => (
        <mesh key={d.i} position={d.pos} rotation={d.rot}>
          <boxGeometry args={[d.len, BELT_T, BELT_W]} />
          <meshLambertMaterial map={d.tex} />
          <Edges threshold={15} color={C.dimEdge} />
        </mesh>
      ))}
      {pads.map((p, i) => (
        <mesh key={i} position={p}>
          <boxGeometry args={[BELT_W, BELT_T * 0.98, BELT_W]} />
          <meshLambertMaterial color="#28316a" />
        </mesh>
      ))}
    </group>
  );
}

/** The lift on the tower's east face: its car carries tickets between platform A and the roof. */
export function Lift() {
  const car = useRef<THREE.Group>(null);
  const e = BELT_EDGES[LIFT_EDGE];
  const low = BELTS.nodes[e.from];
  const high = BELTS.nodes[e.to];
  const carLow = low[1] - BELT_DROP;
  const carHigh = high[1] - BELT_DROP;
  const poses = usePoses();
  useFrame((_, dt) => {
    const g = car.current;
    if (!g) return;
    const w = W();
    const now = poses(w);
    let riding: number | undefined;
    for (const p of now.values()) if (p.edge === LIFT_EDGE) riding = p.pos[1] - BELT_DROP;
    if (riding !== undefined) {
      g.position.y = riding;
      return;
    }
    // Parked at the top while a ticket is with the worker (it will ride back down), else at the bottom.
    const waitingUp = Object.values(w.jobs).some((j) => j.location === "worker");
    const { playing, mode } = useTwin.getState();
    const target = waitingUp ? carHigh : carLow;
    g.position.y = playing || mode === "live" ? approach(g.position.y, target, 3, dt) : target;
  });
  const p: Num = () => (W().cp.state === "stopped" ? 0.3 : 0.8);
  const railX = -5.36;
  const h = carHigh - carLow + 0.4;
  return (
    <group>
      <Block size={[0.08, h, 0.08]} position={[railX, carLow + h / 2 - 0.1, low[2] - 0.36]} power={p} />
      <Block size={[0.08, h, 0.08]} position={[railX, carLow + h / 2 - 0.1, low[2] + 0.36]} power={p} />
      <Block size={[0.12, 0.1, 0.84]} position={[railX, carHigh + 0.3, low[2]]} power={p} />
      <group ref={car} position={[0, carLow, 0]}>
        <Block size={[0.76, BELT_T, 0.66]} position={[low[0], 0, low[2]]} power={p} />
      </group>
    </group>
  );
}

const cpUp = (w: WorldState) => w.cp.state !== "stopped";
const LINE: Record<Exclude<CableLine, "hidden">, { color: string; on: Num }> = {
  net: { color: C.lav, on: () => 0.35 },
  cp: { color: C.aqua, on: () => (cpUp(W()) ? 0.8 : 0) },
  gpu: { color: C.violet, on: () => (W().gpu.state !== "none" ? 0.8 : 0) },
  guard: { color: C.amber, on: () => (W().guardLocked ? 0.35 : 0.15) },
  ops: { color: C.lav, on: () => (cpUp(W()) ? 0.5 : 0.15) },
};

/** Cables on the desk and platforms. Signal pulses travel only along these. */
export function Cables() {
  const runs = useMemo(
    () =>
      CABLE_EDGES.flatMap((e, i) => {
        if (e.line === "hidden") return [];
        const a = CABLES.nodes[e.from];
        const b = CABLES.nodes[e.to];
        const vertical = Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]) < 1e-6;
        // Risers lie flat against the tower's east face.
        const l = laid(a, b, vertical ? [1, 0, 0] : upOf(a, b), 0);
        return [{ i, line: e.line, ...l }];
      }),
    [],
  );
  return (
    <group>
      {runs.map((r) => (
        <Lamp
          key={r.i}
          position={r.pos}
          rotation={r.rot}
          size={[r.len + 0.06, 0.02, 0.06]}
          on={LINE[r.line].on}
          color={LINE[r.line].color}
          offColor={C.deskEdge}
        />
      ))}
    </group>
  );
}
