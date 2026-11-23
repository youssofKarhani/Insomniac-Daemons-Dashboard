import { Edges, Html, type EdgesRef } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { ASSEMBLIES } from "../content/assemblies";
import { OBJECTS, type ObjectId } from "../content/components";
import { worldAt, type WorldState } from "../model/state";
import { useDashboard } from "../store";
import { SignalWorld } from "./signalWorld";
import { scheduleWorld } from "./ticketPath";

/** Palette taken from the owner's isometric renders. */
export const C = {
  bg: "#161f45",
  desk: "#1e2857",
  deskEdge: "#2f3a78",
  platform: "#28336c",
  dim: "#323c7a",
  dimEdge: "#4a55a0",
  lav: "#8a82e0",
  lavEdge: "#c3bdff",
  side: "#252f66",
  aqua: "#5fd3c0",
  violet: "#b07cff",
  amber: "#f2b866",
  red: "#ff8a8a",
  off: "#1a2250",
  ticket: "#d6d1ff",
  grey: "#7b80a8",
} as const;

export type Num = () => number;
export const one: Num = () => 1;

/** Shortcuts for reading the shared world state inside useFrame without re-rendering. */
const signalWorld = new SignalWorld();
let wCache: { base: WorldState | null; history: unknown; now: number; rm: boolean; w: WorldState | null } = { base: null, history: null, now: NaN, rm: false, w: null };
/** The displayed world waits for cable arrivals; reduced motion shows telemetry immediately. */
export const W = (): WorldState => {
  const s = useDashboard.getState();
  if (wCache.base !== s.world || wCache.history !== s.history || wCache.now !== s.now || wCache.rm !== s.reducedMotion) {
    wCache = { base: s.world, history: s.history, now: s.now, rm: s.reducedMotion,
      w: s.reducedMotion ? worldAt(s.world, s.now) : signalWorld.at(s.world, s.history, s.now) };
    scheduleWorld(wCache.w!);
  }
  return wCache.w!;
};
export const RM = () => useDashboard.getState().reducedMotion;

/** 1 at `ts`, fading to 0 over `dur` ms of source time. */
export function flash(ts: number | undefined, t: number, dur = 1500): number {
  if (ts === undefined || t < ts) return 0;
  return Math.max(0, 1 - (t - ts) / dur);
}

export function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

/** Frame-rate independent exponential approach. Instant in reduced-motion mode. */
export function approach(current: number, target: number, lambda: number, dt: number) {
  if (RM()) return target;
  // On demand rendering, the first frame after an idle spell reports the whole gap as dt;
  // cap it so motion eases from where it was instead of snapping.
  const step = Math.min(dt, 0.05);
  return current + (target - current) * (1 - Math.exp(-lambda * step));
}

/**
 * On-demand rendering: the canvas draws while `until` is in the future. DemandDriver (World.tsx)
 * registers the canvas's invalidate; anything that starts a local animation calls wake().
 */
export const demand = { until: 0, invalidate: () => {} };
export function wake(ms: number) {
  demand.until = Math.max(demand.until, performance.now() + ms);
  demand.invalidate();
}
/** The hover ring eases at rate 12/s; it is settled within this long. */
const HOVER_SETTLE_MS = 600;

/** A number that eases toward `target()` every frame. */
export function useEased(target: Num, lambda = 6) {
  const v = useRef(target());
  useFrame((_, dt) => {
    v.current = approach(v.current, target(), lambda, Math.min(dt, 0.1));
  });
  return v;
}

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

interface BlockProps {
  size: [number, number, number];
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** 0 = asleep colours, 1 = awake colours. */
  power?: Num;
  dim?: string;
  lit?: string;
  edgeDim?: string;
  edgeLit?: string;
  children?: ReactNode;
}

/** Flat-shaded box with bright edges: the basic brick of the scene. */
export function Block({
  size,
  position,
  rotation,
  power = one,
  dim = C.dim,
  lit = C.lav,
  edgeDim = C.dimEdge,
  edgeLit = C.lavEdge,
  children,
}: BlockProps) {
  const mat = useRef<THREE.MeshLambertMaterial>(null);
  const edges = useRef<EdgesRef>(null);
  const p = useEased(power, 4);
  useFrame(() => {
    const k = clamp01(p.current);
    if (mat.current) mat.current.color.copy(tmpA.set(dim).lerp(tmpB.set(lit), k));
    const em = edges.current?.material as { color?: THREE.Color } | undefined;
    if (em?.color) em.color.copy(tmpA.set(edgeDim).lerp(tmpB.set(edgeLit), k));
  });
  return (
    <mesh position={position} rotation={rotation}>
      <boxGeometry args={size} />
      <meshLambertMaterial ref={mat} color={dim} />
      <Edges ref={edges} threshold={15} color={edgeDim} />
      {children}
    </mesh>
  );
}

interface LampProps {
  size?: [number, number, number];
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** 0..1 brightness. */
  on: Num;
  color?: (() => string) | string;
  offColor?: string;
}

/** Emissive indicator light. */
export function Lamp({ size = [0.22, 0.1, 0.06], position, rotation, on, color = C.aqua, offColor = C.off }: LampProps) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const v = useEased(on, 10);
  useFrame(() => {
    if (!mat.current) return;
    const c = typeof color === "function" ? color() : color;
    mat.current.color.copy(tmpA.set(offColor).lerp(tmpB.set(c), clamp01(v.current)));
  });
  return (
    <mesh position={position} rotation={rotation}>
      <boxGeometry args={size} />
      <meshBasicMaterial ref={mat} color={offColor} toneMapped={false} />
    </mesh>
  );
}

/** Ring of small segments that fills clockwise with `progress()` (0..1). Hidden when progress < 0. */
export function ProgressRing({
  radius,
  progress,
  color = C.aqua,
  segments = 36,
  position,
  rotation,
  seg = 0.12,
}: {
  radius: number;
  progress: Num;
  color?: string;
  segments?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  seg?: number;
}) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const items = useMemo(
    () =>
      Array.from({ length: segments }, (_, i) => {
        const a = (i / segments) * Math.PI * 2 - Math.PI / 2;
        return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, a };
      }),
    [radius, segments],
  );
  useFrame(() => {
    const p = progress();
    refs.current.forEach((m, i) => {
      if (!m) return;
      m.visible = p >= 0;
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = i / segments < p ? 1 : 0.16;
    });
  });
  return (
    <group position={position} rotation={rotation}>
      {items.map((it, i) => (
        <mesh key={i} ref={(m) => (refs.current[i] = m)} position={[it.x, it.y, 0]} rotation={[0, 0, it.a]}>
          <boxGeometry args={[seg * 0.6, seg, 0.03]} />
          <meshBasicMaterial color={color} transparent opacity={0.16} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

let shadowTex: THREE.Texture | null = null;
/** A soft-edged dark rectangle, drawn once and shared by every contact shadow. */
function softShadow() {
  if (shadowTex) return shadowTex;
  const n = 64;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      // Distance outside an inner rectangle, faded over the outer band.
      const dx = Math.max(0, Math.abs(x + 0.5 - n / 2) - n * 0.28) / (n * 0.22);
      const dy = Math.max(0, Math.abs(y + 0.5 - n / 2) - n * 0.28) / (n * 0.22);
      const a = Math.max(0, 1 - Math.hypot(dx, dy));
      const i = (y * n + x) * 4;
      img.data[i + 3] = Math.round(255 * a * a * (3 - 2 * a));
    }
  }
  g.putImageData(img, 0, 0);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

/** Soft contact shadow under an object, offset toward the viewer like the reference renders. */
export function ContactShadow({ size, y = 0.004 }: { size: [number, number]; y?: number }) {
  const tex = useMemo(softShadow, []);
  return (
    <mesh position={[0.08, y, 0.2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
      <planeGeometry args={[size[0] + 0.9, size[1] + 0.9]} />
      <meshBasicMaterial map={tex} color="#05081c" transparent opacity={0.6} depthWrite={false} />
    </mesh>
  );
}

/** Small ring bolt, as on the bases in the reference renders. Faces +z unless rotated. */
export function Bolt({ position, rotation, r = 0.08 }: { position: [number, number, number]; rotation?: [number, number, number]; r?: number }) {
  return (
    <mesh position={position} rotation={rotation}>
      <torusGeometry args={[r, r * 0.3, 8, 20]} />
      <meshBasicMaterial color={C.lav} />
    </mesh>
  );
}

/** Wraps an object so it can be hovered, clicked and labelled. */
export function Pickable({
  id,
  position,
  labelY = 2,
  footprint = [2, 2],
  showLabel = true,
  labelAt,
  shadow = true,
  children,
}: {
  id: ObjectId;
  position: [number, number, number];
  labelY?: number;
  /** Label position relative to the object, overriding labelY. */
  labelAt?: [number, number, number];
  footprint?: [number, number];
  /** False hides the always-on label (hover and selection still show it). */
  showLabel?: boolean;
  /** False for objects with no footprint of their own (overhead or invisible handles). */
  shadow?: boolean;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const selected = useDashboard((s) => s.selected === id);
  const labels = useDashboard((s) => s.labels);
  const select = useDashboard((s) => s.select);
  const ring = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((_, dt) => {
    if (ring.current) ring.current.opacity = approach(ring.current.opacity, selected ? 0.9 : hover ? 0.45 : 0, 12, dt);
  });
  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(true);
    wake(HOVER_SETTLE_MS);
    document.body.style.cursor = "pointer";
  };
  const onOut = () => {
    setHover(false);
    wake(HOVER_SETTLE_MS);
    document.body.style.cursor = "";
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    select(selected ? null : id);
  };
  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    if (!ASSEMBLIES[id]) return;
    e.stopPropagation();
    select(id);
    useDashboard.getState().setTeardown(id);
  };
  return (
    <group position={position} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} onDoubleClick={onDoubleClick}>
      {shadow && footprint[0] > 0.2 && footprint[1] > 0.2 && <ContactShadow size={footprint} />}
      {children}
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[footprint[0] + 0.5, footprint[1] + 0.5]} />
        <meshBasicMaterial ref={ring} color={C.aqua} transparent opacity={0} depthWrite={false} />
      </mesh>
      {((labels && showLabel) || hover || selected) && (
        <Html position={labelAt ?? [0, labelY, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div className={`label${selected ? " is-selected" : ""}`}>{OBJECTS[id].name}</div>
        </Html>
      )}
    </group>
  );
}
