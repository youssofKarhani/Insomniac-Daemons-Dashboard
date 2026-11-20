import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

interface OrbitControlsImpl {
  target: THREE.Vector3;
  minZoom: number;
  maxZoom: number;
  update: () => void;
}
import { useTwin } from "../store";
import { C, W, approach, demand, wake } from "./kit";
import { DESK_ROTATION, POS } from "./layout";
import { Tickets, Signals } from "./movers";
import { Belts, Cables, Lift } from "./conveyors";
import {
  Clock,
  Crate,
  Desk,
  Gantry,
  Gateway,
  GpuDlq,
  GpuNode,
  GpuQueue,
  Guard,
  Keda,
  Lambda,
  Laya,
  ModelVolume,
  Platforms,
  Pods,
  Ssm,
  Tower,
  VllmHandle,
  Watchdog,
  WorkflowDlq,
  WorkflowQueue,
} from "./objects";

const AXIS = new THREE.Vector3(0, 1, 0);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);

function deskToWorld(p: [number, number, number]) {
  return new THREE.Vector3(...p).applyAxisAngle(AXIS, DESK_ROTATION);
}

/**
 * Lighting for the two-tone look of the reference renders: a strong key from almost straight
 * above (bright tops), a little toward the viewer (mid-tone fronts), little on the right
 * faces (deep sides), over a low ambient. It rises when the control plane is awake.
 */
function Lights() {
  const amb = useRef<THREE.AmbientLight>(null);
  const key = useRef<THREE.DirectionalLight>(null);
  useFrame((_, dt) => {
    const w = W();
    const awake = w.cp.state === "stopped" ? 0 : w.cp.state === "running" ? 1 : 0.6;
    if (amb.current) amb.current.intensity = approach(amb.current.intensity, 0.5 + 0.25 * awake, 1.5, dt);
    if (key.current) key.current.intensity = approach(key.current.intensity, 1.5 + 0.5 * awake, 1.5, dt);
  });
  return (
    <>
      <ambientLight ref={amb} intensity={0.5} color="#b9b8ff" />
      <directionalLight ref={key} position={[2, 14, 5]} intensity={1.5} color="#ffffff" />
      <directionalLight position={[-8, 6, -4]} intensity={0.2} color="#7f8cff" />
    </>
  );
}

/** Fits the desk to the viewport and eases the camera target to the selected object. */
function CameraRig() {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const selected = useTwin((s) => s.selected);
  // The desk's isometric footprint is about 31 x 22 world units; leave room for the overlays.
  // On phones the desk is cropped slightly at the sides so objects stay tappable.
  const baseZoom = useMemo(
    () => (size.width < 760 ? Math.max(9, size.width / 26) : Math.max(9, Math.min(size.width / 36, size.height / 27))),
    [size.width, size.height],
  );
  const zoomTarget = useRef(baseZoom);
  const target = useRef(HOME_TARGET.clone());

  useEffect(() => {
    camera.zoom = baseZoom;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.minZoom = baseZoom * 0.75;
      controls.maxZoom = baseZoom * 4;
    }
  }, [baseZoom, camera, controls]);

  useEffect(() => {
    if (selected) {
      const p = deskToWorld(POS[selected]);
      p.y += 1;
      target.current.copy(p);
      zoomTarget.current = baseZoom * 1.9;
    } else {
      target.current.copy(HOME_TARGET);
      zoomTarget.current = baseZoom;
    }
    animating.current = 1.6;
  }, [selected, baseZoom]);

  const animating = useRef(0);
  useFrame((_, dt) => {
    if (!controls || animating.current <= 0) return;
    animating.current -= dt;
    const t = controls.target;
    const prev = t.clone();
    t.x = approach(t.x, target.current.x, 4, dt);
    t.y = approach(t.y, target.current.y, 4, dt);
    t.z = approach(t.z, target.current.z, 4, dt);
    camera.position.add(t.clone().sub(prev));
    camera.zoom = approach(camera.zoom, zoomTarget.current, 4, dt);
    camera.updateProjectionMatrix();
    controls.update();
  });
  return null;
}

/** The slowest easing in the scene (rate 1.2/s) is within 1% of its target after this long. */
const SETTLE_MS = 4_000;
/**
 * The canvas renders on demand. Any store change (a new event, the playhead moving, a
 * selection) requests frames for SETTLE_MS so everything can ease to its new target. Hover
 * wakes it from Pickable; orbiting and zooming request their own frames through the camera
 * controls. A sleeping platform with nothing changing draws nothing, instead of redrawing the
 * same picture 60 times a second, and moving the mouse over it costs nothing either.
 */
function DemandDriver() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    demand.invalidate = invalidate;
    const unsub = useTwin.subscribe(() => wake(SETTLE_MS));
    wake(SETTLE_MS);
    return () => {
      unsub();
      demand.invalidate = () => {};
    };
  }, [invalidate]);
  useFrame(() => {
    if (performance.now() < demand.until) invalidate();
  });
  return null;
}

export function World() {
  const select = useTwin((s) => s.select);
  return (
    <Canvas
      dpr={[1, 2]}
      frameloop="demand"
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onPointerMissed={() => select(null)}
      aria-hidden="true"
    >
      <color attach="background" args={[C.bg]} />
      <OrthographicCamera makeDefault position={[30, 26, 30]} near={-100} far={300} />
      <OrbitControls
        makeDefault
        enableDamping
        target={[0, 0, 0]}
        minPolarAngle={0.55}
        maxPolarAngle={1.2}
        minAzimuthAngle={Math.PI / 4 - 0.5}
        maxAzimuthAngle={Math.PI / 4 + 0.5}
        screenSpacePanning
      />
      <DemandDriver />
      <CameraRig />
      <Lights />
      <group rotation={[0, DESK_ROTATION, 0]}>
        <Desk />
        <Cables />
        <Belts />
        <Lift />
        <Platforms />
        <Clock />
        <Gateway />
        <Lambda />
        <Ssm />
        <WorkflowQueue />
        <WorkflowDlq />
        <GpuQueue />
        <GpuDlq />
        <Keda />
        <Crate />
        <Tower />
        <Pods />
        <Watchdog />
        <Laya />
        <Gantry />
        <GpuNode />
        <VllmHandle />
        <Guard />
        <ModelVolume />
        <Tickets />
        <Signals />
      </group>
    </Canvas>
  );
}
