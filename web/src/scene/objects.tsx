import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { CONFIG, SAMPLE } from "../model/timings";
import { useTwin } from "../store";
import type { JobLocation, WorldState } from "../model/state";
import { Block, Bolt, C, Lamp, Pickable, ProgressRing, RM, W, approach, clamp01, flash, type Num } from "./kit";
import { PLATFORMS, POS, PLATFORM_Y } from "./layout";
import { arrivedAt, restingAt } from "./ticketPath";
import { CARRY_BOTTOM, CASSETTE_H, LUG_H, RAIL_Y, SEAT_BOTTOM, X_BAY, gantryAt, newGantryPose } from "./gantry";

// ---- derived signals (pure functions of world state) ---------------------

const cpUp = (w: WorldState) => w.cp.state !== "stopped";
const servicesUp = (w: WorldState) => w.cp.state === "running" && w.cp.podsReady;
const gpuPresent = (w: WorldState) => w.gpu.state !== "none";
/** The job whose ticket is physically at `loc` (it may still be on its way there after the event). */
const jobAt = (w: WorldState, loc: JobLocation) =>
  Object.values(w.jobs).find((j) => (RM() ? j.location === loc : restingAt(j, w.t) === loc));

/** Restful glow for always-on managed services, brighter when they act. */
const managed = (f: number) => 0.45 + 0.55 * f;

function bootProgress(w: WorldState): number {
  const dt = w.t - w.cp.since;
  switch (w.cp.state) {
    case "pending":
      return clamp01(dt / (SAMPLE.cpBootSeconds * 1000));
    case "running":
      return 1;
    case "stopping":
      return 1 - clamp01(dt / (SAMPLE.cpStopSeconds * 1000));
    default:
      return 0;
  }
}

/** Breathing factor for inferred states: the visual sign that the twin derived this. */
function breathe(t: number, inferred: boolean) {
  return inferred ? 0.75 + 0.25 * Math.sin(t / 380) : 1;
}

// ---- Ingress ------------------------------------------------------------

export function Clock() {
  const hand = useRef<THREE.Group>(null);
  useFrame(() => {
    const w = W();
    const f = flash(w.pulses.clock, w.t, 2500);
    // Rest at 06:55; a fired schedule sweeps the hand a full turn.
    const rest = -((55 / 60) * Math.PI * 2);
    if (hand.current) hand.current.rotation.z = rest - f * Math.PI * 2;
  });
  const p: Num = () => managed(flash(W().pulses.clock, W().t, 2500));
  return (
    <Pickable id="clock" position={POS.clock} labelAt={[-0.2, 0, 1.3]} footprint={[1.4, 1.2]}>
      <Block size={[1.4, 0.35, 1.2]} position={[0, 0.175, 0]} power={p} />
      <Block size={[0.25, 0.7, 0.25]} position={[0, 0.7, 0]} power={p} />
      <Bolt position={[0.71, 0.18, 0.15]} rotation={[0, Math.PI / 2, 0]} />
      <mesh position={[0, 1.55, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.62, 0.62, 0.16, 40]} />
        <meshLambertMaterial color={C.lav} />
      </mesh>
      {/* Dial face, rim and the four quarter marks. */}
      <mesh position={[0, 1.55, 0.082]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.54, 0.54, 0.01, 40]} />
        <meshBasicMaterial color={"#1a1d52"} />
      </mesh>
      <mesh position={[0, 1.55, 0.085]}>
        <torusGeometry args={[0.56, 0.03, 8, 48]} />
        <meshBasicMaterial color={C.lavEdge} />
      </mesh>
      {[0, 1, 2, 3].map((k) => (
        <mesh key={k} position={[0.42 * Math.sin((k * Math.PI) / 2), 1.55 + 0.42 * Math.cos((k * Math.PI) / 2), 0.09]} rotation={[0, 0, (-k * Math.PI) / 2]}>
          <boxGeometry args={[0.04, 0.12, 0.01]} />
          <meshBasicMaterial color={C.aqua} />
        </mesh>
      ))}
      <mesh position={[0.42, 2.02, 0]} rotation={[0, 0, -0.7]}>
        <boxGeometry args={[0.2, 0.12, 0.2]} />
        <meshBasicMaterial color={C.violet} />
      </mesh>
      <group ref={hand} position={[0, 1.55, 0.1]}>
        <mesh position={[0, 0.2, 0]}>
          <boxGeometry args={[0.05, 0.4, 0.02]} />
          <meshBasicMaterial color={C.aqua} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.055, 0.055, 0.03, 16]} />
          <meshBasicMaterial color={C.aqua} />
        </mesh>
      </group>
      <Lamp position={[0.45, 0.36, 0.61]} on={() => flash(W().pulses.clock, W().t, 4000)} />
    </Pickable>
  );
}

const ROUTES = ["/jobs", "/wake", "/status", "/health"];

export function Gateway() {
  const p: Num = () => managed(flash(W().pulses.gateway, W().t, 1800));
  return (
    <Pickable id="gateway" position={POS.gateway} labelY={3.4} footprint={[2.6, 1.6]}>
      <Block size={[2.6, 0.75, 1.6]} position={[0, 0.375, 0]} power={p} />
      <Block size={[0.45, 1.9, 0.45]} position={[-0.85, 1.7, 0]} power={p} />
      <Block size={[0.45, 1.9, 0.45]} position={[0.85, 1.7, 0]} power={p} />
      <Block size={[2.15, 0.45, 0.55]} position={[0, 2.85, 0]} power={p} />
      <Bolt position={[-1.0, 0.42, 0.81]} />
      <Bolt position={[1.0, 0.42, 0.81]} />
      {/* Slot the job ticket rises out of. */}
      <mesh position={[0, 0.752, 0]}>
        <boxGeometry args={[0.9, 0.004, 0.62]} />
        <meshBasicMaterial color={C.off} />
      </mesh>
      {ROUTES.map((r, i) => (
        <Lamp
          key={r}
          position={[-0.85, 2.3 - i * 0.24, 0.235]}
          size={[0.24, 0.1, 0.03]}
          on={() => {
            const w = W();
            return w.pulses.route === r ? flash(w.pulses.gateway, w.t, 2200) : 0.15;
          }}
        />
      ))}
    </Pickable>
  );
}

export function Lambda() {
  const arm = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const w = W();
    const closed = flash(w.pulses.lambda, w.t, 1600) > 0 ? 1 : 0;
    if (arm.current) arm.current.rotation.z = approach(arm.current.rotation.z, closed ? -0.05 : 0.55, 14, dt);
  });
  const p: Num = () => managed(flash(W().pulses.lambda, W().t, 1600));
  return (
    <Pickable id="lambda" position={POS.lambda} labelY={2.6} footprint={[1.6, 1.1]}>
      <Block size={[1.6, 0.4, 1.1]} position={[0, 0.2, 0]} power={p} />
      <Bolt position={[-0.62, 0.405, 0.38]} rotation={[-Math.PI / 2, 0, 0]} r={0.07} />
      <Bolt position={[0.62, 0.405, -0.38]} rotation={[-Math.PI / 2, 0, 0]} r={0.07} />
      <Bolt position={[0.62, 0.405, 0.38]} rotation={[-Math.PI / 2, 0, 0]} r={0.07} />
      {/* Foot pads under the post and the contact. */}
      <mesh position={[-0.5, 0.42, 0]}>
        <boxGeometry args={[0.46, 0.04, 0.46]} />
        <meshBasicMaterial color={"#1a1d52"} />
      </mesh>
      <mesh position={[0.55, 0.42, 0]}>
        <boxGeometry args={[0.38, 0.04, 0.38]} />
        <meshBasicMaterial color={"#1a1d52"} />
      </mesh>
      <Block size={[0.3, 1.3, 0.3]} position={[-0.5, 1.05, 0]} power={p} />
      <mesh position={[-0.5, 1.65, 0.17]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.06, 16]} />
        <meshBasicMaterial color={"#1a1d52"} />
      </mesh>
      <group ref={arm} position={[-0.5, 1.65, 0]}>
        <Block size={[1.05, 0.12, 0.14]} position={[0.52, 0, 0]} power={p} />
      </group>
      <Block size={[0.22, 0.95, 0.22]} position={[0.55, 0.875, 0]} power={p} />
      <Lamp position={[0.55, 1.4, 0.12]} size={[0.16, 0.12, 0.03]} on={() => flash(W().pulses.lambda, W().t, 2500)} />
    </Pickable>
  );
}

export function Ssm() {
  return (
    <Pickable id="ssm" position={POS.ssm} labelY={2.1} footprint={[1.3, 1]}>
      <Block size={[1.3, 0.35, 1]} position={[0, 0.175, 0]} power={() => 0.45} />
      <Block size={[1.1, 0.8, 0.14]} position={[0, 0.85, -0.2]} rotation={[-0.25, 0, 0]} power={() => 0.45} />
      <Lamp position={[0, 0.86, -0.12]} rotation={[-0.25, 0, 0]} size={[0.9, 0.55, 0.02]} on={() => (W().ssmOpen ? 1 : 0)} color={C.violet} />
      {/* Prompt on the screen. */}
      <group position={[0, 0.86, -0.1]} rotation={[-0.25, 0, 0]}>
        <mesh position={[-0.3, 0.13, 0.012]} rotation={[0, 0, -0.6]}>
          <boxGeometry args={[0.1, 0.025, 0.005]} />
          <meshBasicMaterial color={C.aqua} />
        </mesh>
        <mesh position={[-0.3, 0.07, 0.012]} rotation={[0, 0, 0.6]}>
          <boxGeometry args={[0.1, 0.025, 0.005]} />
          <meshBasicMaterial color={C.aqua} />
        </mesh>
        <mesh position={[-0.17, 0.05, 0.012]}>
          <boxGeometry args={[0.1, 0.025, 0.005]} />
          <meshBasicMaterial color={C.aqua} />
        </mesh>
      </group>
      {/* Keyboard. */}
      <Block size={[1.0, 0.06, 0.42]} position={[0, 0.38, 0.22]} power={() => 0.45} />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (
        <mesh key={k} position={[-0.33 + (k % 4) * 0.22, 0.42, 0.13 + Math.floor(k / 4) * 0.18]}>
          <boxGeometry args={[0.15, 0.025, 0.12]} />
          <meshBasicMaterial color={"#1a1d52"} />
        </mesh>
      ))}
      <Bolt position={[0.66, 0.18, 0.2]} rotation={[0, Math.PI / 2, 0]} />
    </Pickable>
  );
}

// ---- Buffer -------------------------------------------------------------

type Side = "n" | "s" | "e" | "w";
/** A gap in one wall, `at` measured along that wall from its centre. Belts and chutes pass through these. */
interface Opening {
  side: Side;
  at: number;
}
const GAP = 0.9;

function Tray({
  width = 2.6,
  depth = 1.4,
  power,
  trim,
  openings = [],
}: {
  width?: number;
  depth?: number;
  power: Num;
  trim?: string;
  openings?: Opening[];
}) {
  const h = 0.3;
  const wall = 0.08;
  const edge = trim ?? C.lavEdge;
  const walls = (["n", "s", "w", "e"] as Side[]).flatMap((side) => {
    const alongX = side === "n" || side === "s";
    const span = alongX ? width : depth;
    let pieces: [number, number][] = [[-span / 2, span / 2]];
    for (const o of openings.filter((x) => x.side === side)) {
      const c0 = o.at - GAP / 2;
      const c1 = o.at + GAP / 2;
      pieces = pieces.flatMap(([a, b]) => {
        const out: [number, number][] = [];
        if (c0 > a) out.push([a, Math.min(b, c0)]);
        if (c1 < b) out.push([Math.max(a, c1), b]);
        return out.filter(([x, y]) => y - x > 0.01);
      });
    }
    const fixed = side === "n" ? -depth / 2 : side === "s" ? depth / 2 : side === "w" ? -width / 2 : width / 2;
    return pieces.map(([a, b], i) => {
      const mid = (a + b) / 2;
      const len = b - a;
      return alongX ? (
        <Block key={side + i} size={[len, h, wall]} position={[mid, h / 2, fixed]} power={power} edgeLit={edge} />
      ) : (
        <Block key={side + i} size={[wall, h, len]} position={[fixed, h / 2, mid]} power={power} edgeLit={edge} />
      );
    });
  });
  return (
    <group>
      <Block size={[width, 0.12, depth]} position={[0, 0.06, 0]} power={power} edgeLit={edge} />
      {walls}
    </group>
  );
}

export function WorkflowQueue() {
  const p: Num = () => {
    const w = W();
    return managed(Object.values(w.jobs).some((j) => j.location === "workflow") ? 1 : 0);
  };
  return (
    <Pickable id="workflowQueue" position={POS.workflowQueue} labelAt={[0, 0, 1.25]} footprint={[2.6, 1.4]}>
      {/* In at the tail (south), out at the head (north) to the worker, west to dead letters. */}
      <Tray
        power={p}
        openings={[
          { side: "s", at: 0.84 },
          { side: "n", at: -0.8 },
          { side: "w", at: 0 },
        ]}
      />
    </Pickable>
  );
}

export function GpuQueue() {
  const p: Num = () => {
    const w = W();
    return managed(Object.values(w.jobs).some((j) => j.location === "gpuQueue") ? 1 : 0);
  };
  return (
    <Pickable id="gpuQueue" position={POS.gpuQueue} labelAt={[-0.4, 0, 1.25]} footprint={[2.6, 1.4]}>
      {/* In at the tail (west), out at the head (north) to the GPU, east to dead letters. */}
      <Tray
        power={p}
        trim={C.violet}
        openings={[
          { side: "w", at: 0 },
          { side: "n", at: 0.8 },
          { side: "e", at: 0 },
        ]}
      />
    </Pickable>
  );
}

function Bin({ id, loc, depth, from }: { id: "workflowDlq" | "gpuDlq"; loc: "workflowDlq" | "gpuDlq"; depth: number; from: Side }) {
  const has: Num = () => (Object.values(W().jobs).some((j) => j.location === loc) ? 1 : 0);
  return (
    <Pickable id={id} position={POS[id]} labelAt={[0, 0, 1.0]} footprint={[1.2, depth]}>
      <Tray width={1.2} depth={depth} power={() => 0.4} openings={[{ side: from, at: 0 }]} />
      <Lamp position={[0, 0.2, depth / 2 + 0.02]} size={[0.3, 0.1, 0.03]} on={has} color={C.amber} />
    </Pickable>
  );
}
// Each bin sits against its queue's side wall; the dead-letter chute runs through both walls.
export const WorkflowDlq = () => <Bin id="workflowDlq" loc="workflowDlq" depth={0.9} from="e" />;
export const GpuDlq = () => <Bin id="gpuDlq" loc="gpuDlq" depth={0.8} from="w" />;

/** Source time the most recent result landed in the archive (after riding the chute in). */
function lastArchived(w: WorldState): number | undefined {
  let best: number | undefined;
  for (const j of Object.values(w.jobs)) {
    if (j.location !== "crate") continue;
    const a = arrivedAt(j, "crate", w.t);
    if (a !== undefined && (best === undefined || a > best)) best = a;
  }
  return best;
}

export function Crate() {
  const p: Num = () => managed(flash(lastArchived(W()), W().t, 2500));
  return (
    <Pickable id="s3" position={POS.s3} labelY={2.1} footprint={[2.6, 1.8]}>
      <group>
        <Block size={[2.6, 0.14, 1.8]} position={[0, 0.07, 0]} power={p} />
        <Block size={[2.6, 0.8, 0.1]} position={[0, 0.4, -0.85]} power={p} />
        <Block size={[2.6, 0.8, 0.1]} position={[0, 0.4, 0.85]} power={p} />
        <Block size={[0.1, 0.8, 1.8]} position={[-1.25, 0.4, 0]} power={p} />
        <Block size={[0.1, 0.8, 1.8]} position={[1.25, 0.4, 0]} power={p} />
        <Block size={[2.6, 0.08, 1.0]} position={[0, 1.05, -1.2]} rotation={[0.9, 0, 0]} power={p} />
      </group>
      <Lamp position={[0.9, 0.55, 0.91]} size={[0.3, 0.12, 0.03]} on={() => flash(lastArchived(W()), W().t, 3000)} />
      <Bolt position={[1.31, 0.4, 0.45]} rotation={[0, Math.PI / 2, 0]} />
    </Pickable>
  );
}

// ---- Zone A: control plane ----------------------------------------------

export function Tower() {
  const strips = [0, 1, 2, 3, 4, 5];
  const p: Num = () => bootProgress(W());
  return (
    <Pickable id="controlPlane" position={POS.controlPlane} labelY={4.6} footprint={[2, 2]}>
      <Block size={[2, 3, 2]} position={[0, 1.5, 0]} power={p} />
      <Lamp position={[0, 2.2, 1.01]} size={[1.1, 0.6, 0.02]} on={() => bootProgress(W())} color={C.aqua} />
      {/* Power button and vent stripes on the front. */}
      <Bolt position={[0.72, 2.78, 1.01]} r={0.1} />
      {[0, 1, 2].map((k) => (
        <mesh key={k} position={[-0.25, 1.3 - k * 0.16, 1.006]}>
          <boxGeometry args={[0.9, 0.07, 0.01]} />
          <meshBasicMaterial color={C.lav} />
        </mesh>
      ))}
      {strips.map((i) => (
        <Lamp
          key={i}
          position={[1.01, 0.4 + i * 0.42, 0]}
          rotation={[0, Math.PI / 2, 0]}
          size={[1.2, 0.12, 0.02]}
          on={() => (bootProgress(W()) * strips.length > i + 0.2 ? 1 : 0)}
          color={C.aqua}
        />
      ))}
    </Pickable>
  );
}

// The worker pod sits at the front-right corner, next to the lift that brings it tickets.
const POD_NAMES = ["orchestrator", "litellm", "worker"];
/** Housing on the tower roof the pods live in: they rise out through a hatch when started. */
const HOUSING = { w: 1.7, d: 0.8, h: 0.5, wall: 0.06 };

export function Pods() {
  const plate = useRef<THREE.Group>(null);
  const hatch = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const up = servicesUp(W());
    const h = hatch.current;
    const pl = plate.current;
    if (!h || !pl) return;
    // Opening: hatch first, then the plate rises. Closing: plate first, then the hatch.
    const open = -Math.PI / 2;
    const hatchTarget = up || pl.position.y > 0.03 ? open : 0;
    h.rotation.x = approach(h.rotation.x, hatchTarget, 5, dt);
    const plateTarget = up && h.rotation.x < open * 0.85 ? HOUSING.h - 0.02 : 0;
    pl.position.y = approach(pl.position.y, plateTarget, 4, dt);
  });
  const p: Num = () => {
    const w = W();
    return servicesUp(w) ? breathe(w.t, w.cp.podsConfidence === "inferred") : 0;
  };
  const hp: Num = () => (cpUp(W()) ? 0.7 : 0.3);
  const { w, d, h, wall } = HOUSING;
  return (
    <Pickable id="pods" position={POS.pods} labelY={1.5} footprint={[1.6, 1.2]} shadow={false}>
      <Block size={[w, h, wall]} position={[0, h / 2, -d / 2 + wall / 2]} power={hp} />
      <Block size={[w, h, wall]} position={[0, h / 2, d / 2 - wall / 2]} power={hp} />
      <Block size={[wall, h, d]} position={[-w / 2 + wall / 2, h / 2, 0]} power={hp} />
      <Block size={[wall, h, d]} position={[w / 2 - wall / 2, h / 2, 0]} power={hp} />
      {/* Elevator plate carrying the three pods. */}
      <group ref={plate}>
        <Block size={[w - wall * 2, 0.04, d - wall * 2]} position={[0, 0.02, 0]} power={hp} />
        {POD_NAMES.map((n, i) => (
          <Block key={n} size={[0.45, 0.42, 0.6]} position={[(i - 1) * 0.55, 0.25, 0]} power={p} />
        ))}
      </group>
      {/* Hatch hinged at the back edge: lies flat when closed, stands up when open. */}
      <group ref={hatch} position={[0, h, -d / 2]}>
        <Block size={[w, 0.05, d]} position={[0, 0.025, d / 2]} power={hp} />
      </group>
    </Pickable>
  );
}


export function Watchdog() {
  const progress: Num = () => {
    const w = W();
    if (w.cp.state !== "running" || w.watchdogIdleSince === undefined) return -1;
    return clamp01((w.t - w.watchdogIdleSince) / (CONFIG.watchdogIdleSeconds * 1000));
  };
  return (
    <Pickable id="watchdog" position={POS.watchdog} labelAt={[0, 0, 0.9]} footprint={[0.9, 0.9]}>
      <Block size={[0.9, 0.3, 0.6]} position={[0, 0.15, 0]} power={() => (cpUp(W()) ? 0.8 : 0)} />
      <ProgressRing radius={0.42} progress={progress} position={[0, 0.95, 0]} color={C.lav} seg={0.1} />
    </Pickable>
  );
}

export function Laya() {
  const beamColor = () => {
    const j = jobAt(W(), "laya");
    if (!j) return C.aqua;
    if (j.step === "verifying") return j.verifyPassed ? C.aqua : C.amber;
    if (j.gate === "reject") return C.grey;
    if (j.gate === "decision") return C.lavEdge;
    return C.aqua;
  };
  const p: Num = () => (servicesUp(W()) ? 1 : 0);
  return (
    <Pickable id="laya" position={POS.laya} labelY={2.4} footprint={[1.8, 1.2]}>
      <Block size={[1.8, 0.2, 1.2]} position={[0, 0.1, 0]} power={p} />
      <Block size={[0.24, 1.5, 0.3]} position={[-0.75, 0.95, 0]} power={p} />
      <Block size={[0.24, 1.5, 0.3]} position={[0.75, 0.95, 0]} power={p} />
      <Block size={[1.74, 0.22, 0.34]} position={[0, 1.8, 0]} power={p} />
      <Lamp position={[0, 0.95, 0]} size={[1.24, 1.5, 0.03]} on={() => (jobAt(W(), "laya") ? 0.85 : 0)} color={beamColor} offColor={C.side} />
    </Pickable>
  );
}

/** Shared per frame by the arm and the cassette, so they never disagree. */
const gantry = newGantryPose();
let gantryT = NaN;
let gantryW: WorldState | null = null;
function gantryNow() {
  const w = W();
  if (w !== gantryW || w.t !== gantryT) {
    gantryAt(w, RM() ? Infinity : w.t, gantry);
    gantryW = w;
    gantryT = w.t;
  }
  return gantry;
}

/** Rail ends and supports, desk coordinates. */
const RAIL_FROM = -5.5;
const BAY = { x0: 10.3, x1: 12.7, z0: -5.5, z1: -3.7, top: PLATFORM_Y + 3.6 };
const RAIL_TO = BAY.x1;
const PORTALS = [-1.0, 4.0];
/** Doorway in the bay's west wall the carried cassette passes through. */
const DOOR = { y0: CARRY_BOTTOM - 0.1, y1: CARRY_BOTTOM + CASSETTE_H + LUG_H + 0.15, half: 0.85 };
/** Slot for the hoist cables in the roof and above the doorway. */
const SLOT = 0.12;
const CARRIAGE_Y = RAIL_Y - 0.2;

/**
 * The capacity arm: an overhead crane from a mast on the tower roof, over the GPU cradle, into
 * the capacity bay where GPU cassettes are kept. The carriage carries them in and out.
 */
export function Gantry() {
  const carriage = useRef<THREE.Group>(null);
  const hook = useRef<THREE.Group>(null);
  const cables = useRef<THREE.Group>(null);
  const door = useRef<THREE.Group>(null);
  const o = POS.autoscaler;
  useFrame((_, dt) => {
    const gp = gantryNow();
    if (carriage.current) carriage.current.position.x = gp.carriageX - o[0];
    const drop = CARRIAGE_Y - 0.175 - gp.hookY;
    if (hook.current) hook.current.position.y = -0.175 - drop;
    if (cables.current) {
      cables.current.scale.y = Math.max(0.001, drop);
      cables.current.position.y = -0.175 - drop / 2;
    }
    if (door.current) {
      // Open while a cassette hangs at carrying height (in the bay or on its way through).
      const open = gp.cassette && gp.cassetteBottom > SEAT_BOTTOM + 0.5 ? 1 : 0;
      const { playing, mode } = useTwin.getState();
      const target = -(DOOR.y1 - DOOR.y0) * open;
      door.current.position.y = playing || mode === "live" ? approach(door.current.position.y, target, 6, dt) : target;
    }
  });
  const p: Num = () => (cpUp(W()) ? 0.7 : 0.3);
  const bayP: Num = () => 0.55;
  const legH = RAIL_Y - 0.06 - PLATFORM_Y;
  const bayH = BAY.top - PLATFORM_Y;
  const bx = (BAY.x0 + BAY.x1) / 2;
  const bz = (BAY.z0 + BAY.z1) / 2;
  const bd = BAY.z1 - BAY.z0;
  const wall = 0.12;
  return (
    <Pickable id="autoscaler" position={o} labelY={0.6} footprint={[0.01, 0.01]}>
      <group position={[-o[0], -o[1], -o[2]]}>
        {/* Rail, with a mast on the tower roof, two portal frames and the bay roof under it. */}
        <Block size={[RAIL_TO - RAIL_FROM, 0.12, 0.2]} position={[(RAIL_FROM + RAIL_TO) / 2, RAIL_Y, -4.6]} power={p} />
        <Block size={[0.14, RAIL_Y - 3.4, 0.14]} position={[RAIL_FROM + 0.05, (RAIL_Y + 3.4) / 2, -4.6]} power={p} />
        {PORTALS.map((x) => (
          <group key={x}>
            <Block size={[0.14, legH, 0.14]} position={[x, PLATFORM_Y + legH / 2, -5.4]} power={p} />
            <Block size={[0.14, legH, 0.14]} position={[x, PLATFORM_Y + legH / 2, -3.8]} power={p} />
            <Block size={[0.14, 0.1, 1.74]} position={[x, RAIL_Y - 0.11, -4.6]} power={p} />
          </group>
        ))}
        <Block size={[0.2, RAIL_Y - 0.06 - BAY.top, 0.2]} position={[BAY.x0 + 0.3, (RAIL_Y - 0.06 + BAY.top) / 2, -4.6]} power={p} />
        <Block size={[0.2, RAIL_Y - 0.06 - BAY.top, 0.2]} position={[BAY.x1 - 0.3, (RAIL_Y - 0.06 + BAY.top) / 2, -4.6]} power={p} />

        {/* Capacity bay: closed except for the doorway; GPU cassettes are kept inside. */}
        <Block size={[wall, bayH, bd]} position={[BAY.x1 - wall / 2, PLATFORM_Y + bayH / 2, bz]} power={bayP} edgeLit={C.violet} />
        <Block size={[BAY.x1 - BAY.x0, bayH, wall]} position={[bx, PLATFORM_Y + bayH / 2, BAY.z0 + wall / 2]} power={bayP} edgeLit={C.violet} />
        <Block size={[BAY.x1 - BAY.x0, bayH, wall]} position={[bx, PLATFORM_Y + bayH / 2, BAY.z1 - wall / 2]} power={bayP} edgeLit={C.violet} />
        {[-1, 1].map((sgn) => (
          <Block
            key={sgn}
            size={[BAY.x1 - BAY.x0, wall, bd / 2 - SLOT / 2]}
            position={[bx, BAY.top - wall / 2, -4.6 + sgn * (SLOT / 2 + (bd / 2 - SLOT / 2) / 2)]}
            power={bayP}
            edgeLit={C.violet}
          />
        ))}
        {/* West wall around the doorway. */}
        <Block size={[wall, DOOR.y0 - PLATFORM_Y, bd]} position={[BAY.x0 + wall / 2, (PLATFORM_Y + DOOR.y0) / 2, bz]} power={bayP} edgeLit={C.violet} />
        {[-1, 1].map((sgn) => (
          <Block
            key={sgn}
            size={[wall, BAY.top - DOOR.y1, bd / 2 - SLOT / 2]}
            position={[BAY.x0 + wall / 2, (BAY.top + DOOR.y1) / 2, -4.6 + sgn * (SLOT / 2 + (bd / 2 - SLOT / 2) / 2)]}
            power={bayP}
            edgeLit={C.violet}
          />
        ))}
        {[-1, 1].map((sgn) => (
          <Block
            key={sgn}
            size={[wall, DOOR.y1 - DOOR.y0, bd / 2 - DOOR.half]}
            position={[BAY.x0 + wall / 2, (DOOR.y0 + DOOR.y1) / 2, bz + sgn * (DOOR.half + (bd / 2 - DOOR.half) / 2)]}
            power={bayP}
            edgeLit={C.violet}
          />
        ))}
        {/* Dark interior. */}
        <mesh position={[bx + wall / 2, PLATFORM_Y + 0.005, bz]}>
          <boxGeometry args={[BAY.x1 - BAY.x0 - wall * 2, 0.01, bd - wall * 2]} />
          <meshBasicMaterial color={C.off} />
        </mesh>
        {/* Roll-down door: drops into the wall below the doorway when open. */}
        <group ref={door}>
          <Block size={[0.06, DOOR.y1 - DOOR.y0, DOOR.half * 2]} position={[BAY.x0 + wall / 2, (DOOR.y0 + DOOR.y1) / 2, bz]} power={bayP} edgeLit={C.violet} />
        </group>
      </group>

      <group ref={carriage} position={[X_BAY - o[0], CARRIAGE_Y - o[1], -4.6 - o[2]]}>
        <Block size={[0.7, 0.35, 0.5]} position={[0, 0, 0]} power={p} />
        <Lamp position={[0, 0, 0.26]} size={[0.2, 0.1, 0.03]} on={() => (W().asg.desired === 1 ? 1 : 0)} color={C.violet} />
        {/* Hoist: two cables down to the hook bar. Unit height, scaled to the drop. */}
        <group ref={cables}>
          <mesh position={[-0.45, 0, 0]}>
            <boxGeometry args={[0.03, 1, 0.03]} />
            <meshBasicMaterial color={C.lavEdge} />
          </mesh>
          <mesh position={[0.45, 0, 0]}>
            <boxGeometry args={[0.03, 1, 0.03]} />
            <meshBasicMaterial color={C.lavEdge} />
          </mesh>
        </group>
        <group ref={hook}>
          <Block size={[1.2, 0.07, 0.24]} position={[0, 0.035, 0]} power={p} />
        </group>
      </group>
    </Pickable>
  );
}

// ---- Bridge -------------------------------------------------------------

export function Keda() {
  const rod = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const on = W().keda.replicas === 1;
    if (rod.current) rod.current.rotation.z = approach(rod.current.rotation.z, on ? -0.6 : 0.6, 8, dt);
  });
  const p: Num = () => (servicesUp(W()) ? 0.8 : 0);
  return (
    <Pickable id="keda" position={POS.keda} labelAt={[1.4, 0.2, 0.4]} footprint={[0.8, 0.8]}>
      <Block size={[0.8, 0.3, 0.8]} position={[0, 0.15, 0]} power={p} />
      <group ref={rod} position={[0, 0.3, 0]}>
        <Block size={[0.1, 1.0, 0.1]} position={[0, 0.5, 0]} power={p} />
        <Lamp position={[0, 1.05, 0]} size={[0.24, 0.24, 0.24]} on={() => (W().keda.replicas === 1 ? 1 : 0.1)} color={C.violet} />
      </group>
    </Pickable>
  );
}

// ---- Zone C: GPU --------------------------------------------------------

function loadProgress(w: WorldState): number {
  if (w.vllm.state === "ready") return 1;
  if (w.vllm.state === "loading") return clamp01((w.t - w.vllm.since) / (SAMPLE.modelLoadSeconds * 1000)) * 0.95;
  return 0;
}

const VIOLET = new THREE.Color(C.violet);

export function GpuNode() {
  const cassette = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const coreMat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((_, dt) => {
    const w = W();
    if (cassette.current) {
      // Carried by the capacity arm; never moves on its own.
      const gp = gantryNow();
      cassette.current.position.x = gp.cassetteX - POS.gpuNode[0];
      cassette.current.position.y = gp.cassetteBottom - POS.gpuNode[1];
      cassette.current.visible = gp.cassette;
    }
    if (core.current && coreMat.current) {
      const fill = loadProgress(w);
      core.current.scale.x = approach(core.current.scale.x, Math.max(0.02, fill), 3, dt);
      core.current.position.x = 0.1 - 0.8 * (1 - core.current.scale.x);
      const generating = !!jobAt(w, "core");
      const pulse = generating ? 0.65 + 0.35 * Math.sin(w.t / 140) : fill > 0 ? breathe(w.t, w.vllm.confidence === "inferred") * 0.8 : 0;
      coreMat.current.color.set(C.off).lerp(VIOLET, pulse);
    }
  });
  const cradleP: Num = () => (gpuPresent(W()) ? 1 : 0.35);
  const cassP: Num = () => (W().gpu.state === "running" ? 1 : 0.6);
  return (
    <Pickable id="gpuNode" position={POS.gpuNode} labelY={3.6} footprint={[2.8, 1.8]}>
      <Block size={[2.8, 0.4, 1.8]} position={[0, 0.2, 0]} power={cradleP} edgeLit={C.violet} />
      <Block size={[2.8, 0.25, 0.14]} position={[0, 0.5, -0.82]} power={cradleP} />
      <Block size={[2.8, 0.25, 0.14]} position={[0, 0.5, 0.82]} power={cradleP} />
      <group ref={cassette} position={[X_BAY - POS.gpuNode[0], CARRY_BOTTOM - POS.gpuNode[1], 0]} visible={false}>
        {/* Case: open at the front, on four feet that stand on the cradle base. */}
        <Block size={[2.3, 0.08, 1.4]} position={[0, 0.04, 0]} power={cassP} edgeLit={C.violet} />
        <Block size={[2.3, 0.08, 1.4]} position={[0, CASSETTE_H - 0.04, 0]} power={cassP} edgeLit={C.violet} />
        <Block size={[2.3, CASSETTE_H, 0.06]} position={[0, CASSETTE_H / 2, -0.67]} power={cassP} edgeLit={C.violet} />
        <Block size={[0.08, CASSETTE_H, 1.4]} position={[-1.11, CASSETTE_H / 2, 0]} power={cassP} edgeLit={C.violet} />
        <Block size={[0.08, CASSETTE_H, 1.4]} position={[1.11, CASSETTE_H / 2, 0]} power={cassP} edgeLit={C.violet} />
        {[-1, 1].flatMap((sx) =>
          [-1, 1].map((sz) => (
            <Block key={`${sx}${sz}`} size={[0.18, 0.15, 0.18]} position={[sx * 0.95, -0.075, sz * 0.55]} power={cassP} />
          )),
        )}
        {/* The GPU card: board, edge connector, bracket, and a finned heatsink. */}
        <mesh position={[0.05, 0.5, -0.05]}>
          <boxGeometry args={[1.75, 0.5, 0.03]} />
          <meshBasicMaterial color="#1f5a52" />
        </mesh>
        <mesh position={[0.1, 0.13, 0.0]}>
          <boxGeometry args={[1.0, 0.07, 0.16]} />
          <meshBasicMaterial color={"#1a1d52"} />
        </mesh>
        <Block size={[0.06, 0.78, 0.26]} position={[-0.86, 0.55, 0.08]} power={cassP} />
        <Block size={[1.6, 0.44, 0.22]} position={[0.1, 0.62, 0.1]} power={() => 0.35} edgeLit={C.lavEdge} />
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <mesh key={k} position={[0.1, 0.44 + k * 0.07 + (k > 2 ? 0.08 : 0), 0.215]}>
            <boxGeometry args={[1.56, 0.014, 0.01]} />
            <meshBasicMaterial color={C.lavEdge} />
          </mesh>
        ))}
        {/* Model core: the glowing strip along the heatsink fills as the model loads. */}
        <mesh ref={core} position={[0.1, 0.65, 0.22]}>
          <boxGeometry args={[1.6, 0.07, 0.02]} />
          <meshBasicMaterial ref={coreMat} color={C.off} toneMapped={false} />
        </mesh>
        {/* Ports and the Spot warning light on the side. */}
        <mesh position={[1.16, 0.72, 0.25]}>
          <boxGeometry args={[0.02, 0.1, 0.16]} />
          <meshBasicMaterial color={"#1a1d52"} />
        </mesh>
        <mesh position={[1.16, 0.48, 0.25]}>
          <boxGeometry args={[0.02, 0.08, 0.2]} />
          <meshBasicMaterial color={"#1a1d52"} />
        </mesh>
        <Lamp position={[1.16, 0.95, 0.45]} size={[0.02, 0.12, 0.12]} on={() => (W().gpu.spotWarningAt ? 1 : 0)} color={C.amber} />
        {/* Lifting lug the hook bar engages. */}
        <Block size={[1.0, LUG_H, 0.2]} position={[0, CASSETTE_H + LUG_H / 2, 0]} power={cassP} />
      </group>
      {/* KEDA cooldown: model ready but idle */}
      <ProgressRing
        radius={1.75}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.06, 0]}
        color={C.violet}
        segments={48}
        progress={() => {
          const w = W();
          if (w.vllm.state !== "ready" || jobAt(w, "core") || w.gpu.lastWorkAt === undefined) return -1;
          if (Object.values(w.jobs).some((j) => j.location === "gpuQueue")) return -1;
          return clamp01((w.t - w.gpu.lastWorkAt) / (CONFIG.kedaCooldownSeconds * 1000));
        }}
      />
      {/* Cluster Autoscaler scale-down: node unneeded */}
      <ProgressRing
        radius={1.95}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.06, 0]}
        color={C.lavEdge}
        segments={48}
        progress={() => {
          const w = W();
          // Only after KEDA was seen releasing the model server during this GPU's life; live
          // telemetry without the in-cluster exporter never reports that, so no ring is drawn.
          if (w.gpu.state !== "running" || w.vllm.state !== "absent" || w.keda.replicas !== 0 || w.keda.since < w.gpu.since) return -1;
          return clamp01((w.t - w.keda.since) / (CONFIG.caScaleDownSeconds * 1000));
        }}
      />
    </Pickable>
  );
}

/** The model core is part of the cassette; this invisible handle lets visitors select it on its own. */
export function VllmHandle() {
  const present = useTwin((s) => s.world.gpu.state !== "none");
  return (
    <Pickable id="vllm" position={POS.vllm} labelY={2.4} footprint={[0.01, 0.01]} showLabel={present}>
      <mesh position={[0, 0.6, 0.75]} visible={false}>
        <boxGeometry args={[1.8, 0.6, 0.2]} />
        <meshBasicMaterial />
      </mesh>
    </Pickable>
  );
}

/** The stop guard's boom pivots at the cradle's west end, at seat height. */
const BOOM_PIVOT: [number, number, number] = [5.3 - POS.guard[0], 1.1 - POS.guard[1], -4.6 - POS.guard[2]];
const BOOM_LEN = 2.6;

export function Guard() {
  const latch = useRef<THREE.Group>(null);
  const boom = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const locked = W().guardLocked;
    if (latch.current) latch.current.rotation.x = approach(latch.current.rotation.x, locked ? 0 : -1.2, 8, dt);
    // Locked: the boom lies across the cradle, so no cassette can be set down. Released: it stands up.
    if (boom.current) boom.current.rotation.z = approach(boom.current.rotation.z, locked ? 0 : Math.PI / 2, 4, dt);
  });
  return (
    <Pickable id="guard" position={POS.guard} labelY={1.3} footprint={[0.7, 0.4]}>
      <Block size={[0.7, 0.3, 0.3]} position={[0, 0.15, 0]} power={() => 0.5} />
      <group ref={latch} position={[0, 0.3, 0.1]}>
        <Block size={[0.5, 0.35, 0.12]} position={[0, 0.17, 0]} power={() => 0.5} />
      </group>
      <Lamp position={[0, 0.15, 0.16]} size={[0.3, 0.1, 0.02]} on={() => (W().guardLocked ? 1 : 0)} color={C.amber} />
      <Block size={[0.16, BOOM_PIVOT[1] + 0.05, 0.16]} position={[BOOM_PIVOT[0], (BOOM_PIVOT[1] - 0.05) / 2, BOOM_PIVOT[2]]} power={() => 0.5} />
      <group ref={boom} position={BOOM_PIVOT}>
        <Block size={[BOOM_LEN, 0.1, 0.1]} position={[BOOM_LEN / 2, 0, 0]} power={() => (W().guardLocked ? 1 : 0.4)} lit={C.amber} edgeLit={C.amber} />
      </group>
    </Pickable>
  );
}

export function ModelVolume() {
  const drive = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (drive.current) drive.current.position.x = approach(drive.current.position.x, W().gpu.ebsAttached ? -0.9 : 0, 3, dt);
  });
  return (
    <Pickable id="modelVolume" position={POS.modelVolume} labelY={2} footprint={[1.1, 1.5]}>
      <group ref={drive}>
        <Block size={[1.1, 0.95, 1.5]} position={[0, 0.475, 0]} power={() => (W().gpu.ebsAttached ? 1 : 0.55)} dim="#2c3474" lit="#5b56c4" />
        <Lamp position={[-0.2, 0.96, -0.3]} size={[0.5, 0.03, 0.22]} on={() => (loadProgress(W()) > 0 ? 1 : 0.15)} color={C.violet} />
        <Lamp position={[-0.2, 0.96, 0.3]} size={[0.5, 0.03, 0.22]} on={() => 0.15} color={C.violet} />
        {/* Front: a grid of storage slots and a pull handle. */}
        {Array.from({ length: 20 }, (_, k) => (
          <mesh key={k} position={[-0.4 + (k % 5) * 0.2, 0.2 + Math.floor(k / 5) * 0.16, 0.755]}>
            <boxGeometry args={[0.17, 0.12, 0.01]} />
            <meshBasicMaterial color={k % 5 === 1 || k % 5 === 3 ? "#5b56c4" : "#262b6a"} />
          </mesh>
        ))}
        <mesh position={[0, 0.86, 0.77]}>
          <boxGeometry args={[0.36, 0.05, 0.04]} />
          <meshBasicMaterial color={"#1a1d52"} />
        </mesh>
        <Bolt position={[0.56, 0.3, 0.3]} rotation={[0, Math.PI / 2, 0]} />
      </group>
    </Pickable>
  );
}

// ---- Ground: desk, platforms, rails ---------------------------------------

export function Platforms() {
  const aEdge: Num = () => (cpUp(W()) ? 1 : 0.15);
  const cEdge: Num = () => (gpuPresent(W()) ? 1 : 0.15);
  return (
    <Pickable id="vpc" position={POS.vpc} labelY={0.9} footprint={[0.01, 0.01]}>
      <group position={[-POS.vpc[0], 0, -POS.vpc[2]]}>
        <Block size={PLATFORMS.a.size} position={[PLATFORMS.a.center[0], PLATFORM_Y / 2, PLATFORMS.a.center[2]]} power={aEdge} dim={C.platform} lit={C.platform} edgeDim={C.deskEdge} edgeLit={C.aqua} />
        <Block size={PLATFORMS.c.size} position={[PLATFORMS.c.center[0], PLATFORM_Y / 2, PLATFORMS.c.center[2]]} power={cEdge} dim={C.platform} lit={C.platform} edgeDim={C.deskEdge} edgeLit={C.violet} />
        {/* Network bridge between the zones, flush with both platforms. */}
        <Block size={[PLATFORMS.c.center[0] - PLATFORMS.c.size[0] / 2 - (PLATFORMS.a.center[0] + PLATFORMS.a.size[0] / 2), PLATFORM_Y, 1.2]} position={[1.7, PLATFORM_Y / 2, -4.6]} power={() => (W().gpu.joined ? 1 : 0)} dim={C.platform} lit={C.platform} edgeDim={C.deskEdge} edgeLit={C.violet} />
      </group>
    </Pickable>
  );
}

export function Desk() {
  return (
    <group>
      <mesh position={[0, -0.2, 0]}>
        <boxGeometry args={[26, 0.4, 17]} />
        <meshLambertMaterial color={C.desk} />
      </mesh>
      <gridHelper args={[26, 26, C.deskEdge, C.deskEdge]} position={[0, 0.005, 0]} scale={[1, 1, 17 / 26]} />
    </group>
  );
}
