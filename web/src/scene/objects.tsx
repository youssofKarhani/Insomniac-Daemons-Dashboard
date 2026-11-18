import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { CONFIG, SAMPLE } from "../model/timings";
import { useTwin } from "../store";
import type { WorldState } from "../model/state";
import { Block, C, Lamp, Pickable, ProgressRing, W, approach, clamp01, flash, type Num } from "./kit";
import { PLATFORMS, POS, PLATFORM_Y } from "./layout";

// ---- derived signals (pure functions of world state) ---------------------

const cpUp = (w: WorldState) => w.cp.state !== "stopped";
const servicesUp = (w: WorldState) => w.cp.state === "running" && w.cp.podsReady;
const gpuPresent = (w: WorldState) => w.gpu.state !== "none";
const jobAt = (w: WorldState, loc: string) => Object.values(w.jobs).find((j) => j.location === loc);

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
    <Pickable id="clock" position={POS.clock} labelY={2.4} footprint={[1.4, 1.2]}>
      <Block size={[1.4, 0.35, 1.2]} position={[0, 0.175, 0]} power={p} />
      <Block size={[0.25, 0.7, 0.25]} position={[0, 0.7, 0]} power={p} />
      <mesh position={[0, 1.55, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.62, 0.62, 0.16, 40]} />
        <meshLambertMaterial color={C.lav} />
      </mesh>
      <group ref={hand} position={[0, 1.55, 0.1]}>
        <mesh position={[0, 0.24, 0]}>
          <boxGeometry args={[0.06, 0.48, 0.04]} />
          <meshBasicMaterial color={C.side} />
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
      <Block size={[0.3, 1.3, 0.3]} position={[-0.5, 1.05, 0]} power={p} />
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
    </Pickable>
  );
}

// ---- Buffer -------------------------------------------------------------

function Tray({ width = 2.6, depth = 1.4, power, trim }: { width?: number; depth?: number; power: Num; trim?: string }) {
  const h = 0.3;
  const wall = 0.08;
  return (
    <group>
      <Block size={[width, 0.12, depth]} position={[0, 0.06, 0]} power={power} edgeLit={trim ?? C.lavEdge} />
      <Block size={[width, h, wall]} position={[0, h / 2, -depth / 2]} power={power} edgeLit={trim ?? C.lavEdge} />
      <Block size={[width, h, wall]} position={[0, h / 2, depth / 2]} power={power} edgeLit={trim ?? C.lavEdge} />
      <Block size={[wall, h, depth]} position={[-width / 2, h / 2, 0]} power={power} edgeLit={trim ?? C.lavEdge} />
      <Block size={[wall, h, depth]} position={[width / 2, h / 2, 0]} power={power} edgeLit={trim ?? C.lavEdge} />
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
      <Tray power={p} />
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
      <Tray power={p} trim={C.violet} />
    </Pickable>
  );
}

function Bin({ id, loc }: { id: "workflowDlq" | "gpuDlq"; loc: "workflowDlq" | "gpuDlq" }) {
  const has: Num = () => (Object.values(W().jobs).some((j) => j.location === loc) ? 1 : 0);
  return (
    <Pickable id={id} position={POS[id]} labelAt={[0, 0, 1.0]} footprint={[1.2, 0.9]}>
      <Tray width={1.2} depth={0.9} power={() => 0.4} />
      <Lamp position={[0, 0.2, 0.47]} size={[0.3, 0.1, 0.03]} on={has} color={C.amber} />
    </Pickable>
  );
}
export const WorkflowDlq = () => <Bin id="workflowDlq" loc="workflowDlq" />;
export const GpuDlq = () => <Bin id="gpuDlq" loc="gpuDlq" />;

export function Crate() {
  const p: Num = () => managed(flash(W().pulses.crate, W().t, 2500));
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
      <Lamp position={[0.9, 0.55, 0.91]} size={[0.3, 0.12, 0.03]} on={() => flash(W().pulses.crate, W().t, 3000)} />
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
      <Block size={[1.2, 0.12, 1.2]} position={[0, 3.06, 0]} power={p} />
      <Lamp position={[0, 2.2, 1.01]} size={[1.1, 0.6, 0.02]} on={() => bootProgress(W())} color={C.aqua} />
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

const POD_NAMES = ["orchestrator", "worker", "litellm"];
export function Pods() {
  const refs = useRef<(THREE.Group | null)[]>([]);
  useFrame((_, dt) => {
    const w = W();
    const up = servicesUp(w) ? 1 : 0;
    refs.current.forEach((g, i) => {
      if (!g) return;
      const target = up ? 0.3 : -0.25;
      g.position.y = approach(g.position.y, target, 6 - i, dt);
      g.scale.setScalar(approach(g.scale.x, up ? 1 : 0.6, 6, dt));
    });
  });
  const p: Num = () => {
    const w = W();
    return servicesUp(w) ? breathe(w.t, w.cp.podsConfidence === "inferred") : 0;
  };
  return (
    <Pickable id="pods" position={POS.pods} labelY={1.5} footprint={[1.6, 1.2]}>
      {POD_NAMES.map((n, i) => (
        <group key={n} ref={(g) => (refs.current[i] = g)} position={[(i - 1) * 0.55, -0.25, 0]}>
          <Block size={[0.45, 0.45, 0.6]} position={[0, 0.22, 0]} power={p} />
        </group>
      ))}
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
      <Lamp position={[0, 1.0, 0]} size={[1.24, 1.3, 0.03]} on={() => (jobAt(W(), "laya") ? 0.85 : 0)} color={beamColor} offColor={C.side} />
    </Pickable>
  );
}

export function Gantry() {
  const carriage = useRef<THREE.Group>(null);
  const fromX = -5.4 - POS.autoscaler[0];
  const toX = POS.gpuNode[0] - POS.autoscaler[0];
  useFrame((_, dt) => {
    const w = W();
    const reaching = w.asg.desired === 1 && cpUp(w);
    if (carriage.current) carriage.current.position.x = approach(carriage.current.position.x, reaching ? toX : fromX, 1.2, dt);
  });
  const p: Num = () => (servicesUp(W()) ? 0.7 : 0);
  return (
    <Pickable id="autoscaler" position={POS.autoscaler} labelY={0.9} footprint={[0.01, 0.01]}>
      <Block size={[toX - fromX + 1.2, 0.12, 0.18]} position={[(toX + fromX) / 2, 0, 0]} power={p} />
      <group ref={carriage} position={[fromX, 0, 0]}>
        <Block size={[0.6, 0.35, 0.5]} position={[0, -0.2, 0]} power={p} />
        <Lamp position={[0, -0.2, 0.26]} size={[0.2, 0.1, 0.03]} on={() => (W().asg.desired === 1 ? 1 : 0)} color={C.violet} />
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

function cassetteY(w: WorldState): number {
  const seated = 0.55;
  const away = 4.2;
  const dt = w.t - w.gpu.since;
  switch (w.gpu.state) {
    case "launching":
      return away - (away - 1.4) * clamp01(dt / (SAMPLE.gpuLaunchSeconds * 1000));
    case "running":
      return seated;
    case "terminating":
      return seated + (away - seated) * clamp01(dt / (SAMPLE.gpuTerminateSeconds * 1000));
    case "launch_failed":
      return 2.6;
    default:
      return away;
  }
}

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
      cassette.current.position.y = approach(cassette.current.position.y, cassetteY(w), 5, dt);
      const visible = gpuPresent(w) || cassette.current.position.y < 4;
      cassette.current.visible = visible;
    }
    if (core.current && coreMat.current) {
      const fill = loadProgress(w);
      core.current.scale.x = approach(core.current.scale.x, Math.max(0.02, fill), 3, dt);
      core.current.position.x = -0.8 * (1 - core.current.scale.x);
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
      <group ref={cassette} position={[0, 4.2, 0]}>
        <Block size={[2.3, 1.15, 1.4]} position={[0, 0.575, 0]} power={cassP} edgeLit={C.violet} />
        <Block size={[1.9, 0.75, 0.04]} position={[0, 0.575, 0.7]} power={() => 0} dim={C.side} edgeDim={C.violet} />
        <mesh ref={core} position={[0, 0.575, 0.72]}>
          <boxGeometry args={[1.6, 0.4, 0.03]} />
          <meshBasicMaterial ref={coreMat} color={C.off} toneMapped={false} />
        </mesh>
        <Lamp position={[0.95, 0.2, 0.71]} size={[0.14, 0.14, 0.02]} on={() => (W().gpu.spotWarningAt ? 1 : 0)} color={C.amber} />
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

export function Guard() {
  const latch = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (latch.current) latch.current.rotation.x = approach(latch.current.rotation.x, W().guardLocked ? 0 : -1.2, 8, dt);
  });
  return (
    <Pickable id="guard" position={POS.guard} labelY={1.3} footprint={[0.7, 0.4]}>
      <Block size={[0.7, 0.3, 0.3]} position={[0, 0.15, 0]} power={() => 0.5} />
      <group ref={latch} position={[0, 0.3, 0.1]}>
        <Block size={[0.5, 0.35, 0.12]} position={[0, 0.17, 0]} power={() => 0.5} />
      </group>
      <Lamp position={[0, 0.15, 0.16]} size={[0.3, 0.1, 0.02]} on={() => (W().guardLocked ? 1 : 0)} color={C.amber} />
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
        <Block size={[2.6, 0.2, 1.2]} position={[1.6, 0.1, -4.4]} power={() => (W().gpu.joined ? 1 : 0)} dim={C.platform} lit={C.platform} edgeDim={C.deskEdge} edgeLit={C.violet} />
      </group>
    </Pickable>
  );
}

/** Engraved power lines on the desk: lit when the zone they feed is powered. */
export function Rails() {
  const line = (from: [number, number], to: [number, number], on: Num, color: string, key: string) => {
    const dx = to[0] - from[0];
    const dz = to[1] - from[1];
    const len = Math.hypot(dx, dz);
    const ang = Math.atan2(-dz, dx);
    return (
      <Lamp
        key={key}
        position={[(from[0] + to[0]) / 2, 0.015, (from[1] + to[1]) / 2]}
        rotation={[0, ang, 0]}
        size={[len, 0.02, 0.06]}
        on={on}
        color={color}
        offColor={C.deskEdge}
      />
    );
  };
  const cp: Num = () => (cpUp(W()) ? 0.8 : 0);
  const gpu: Num = () => (gpuPresent(W()) ? 0.8 : 0);
  return (
    <group>
      {line([-3, 4.4], [-3, -1.2], cp, C.aqua, "a1")}
      {line([-3, -1.2], [-5.4, -1.2], cp, C.aqua, "a2")}
      {line([3.9, -1.2], [6.6, -1.2], gpu, C.violet, "c1")}
    </group>
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
