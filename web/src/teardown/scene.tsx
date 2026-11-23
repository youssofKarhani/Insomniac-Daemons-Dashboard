import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Assembly, PartDef, Shape, Tone } from "../content/assemblies";
import { C, W, RM } from "../scene/kit";
import { motion, partExplode, sequenceAt, SEQ, useTeardown } from "./store";

const TONE: Record<Tone, string> = {
  shell: "#3d4796",
  board: "#2b3474",
  chip: "#5b55c6",
  module: "#6f68d8",
  store: "#4658ae",
  glass: "#262d6c",
};

/** Edge line patterns: solid observed or static, dashed inferred, dotted not observed. */
const DASH = { inferred: [0.09, 0.06], exporter: [0.025, 0.05] } as const;

function geometryFor(shape: Shape): THREE.BufferGeometry {
  switch (shape.kind) {
    case "box":
      return new THREE.BoxGeometry(...shape.size);
    case "cyl":
      return new THREE.CylinderGeometry(shape.r, shape.r, shape.h, 32);
    case "ring":
      return new THREE.TorusGeometry(shape.r, shape.tube, 10, 36);
    case "ball":
      return new THREE.IcosahedronGeometry(shape.r, 2);
  }
}

/** Live registry of the part groups, so the label layer can find each part's position. */
const partNodes = new Map<string, THREE.Object3D>();
/** Current explode amount of each part, written by the parts and read by the labels. */
const partE = new Map<string, number>();

const tmp = new THREE.Color();
const tmp2 = new THREE.Color();
const AQUA = new THREE.Color(C.aqua);
const WHITE = new THREE.Color("#ffffff");
const EDGE = new THREE.Color(C.lavEdge);

/** `housing`: the first group to come off; the x-ray toggle makes it see-through. */
function Part({ part, groupIndex, groups, housing }: { part: PartDef; groupIndex: number; groups: number; housing: boolean }) {
  const node = useRef<THREE.Group>(null);
  const face = useRef<THREE.MeshLambertMaterial>(null);
  const glow = useRef(0);
  const geo = useMemo(() => geometryFor(part.shape), [part.shape]);
  const edges = useMemo(() => {
    const g = new THREE.EdgesGeometry(geo, 20);
    const dash = part.live === "inferred" || part.live === "exporter" ? DASH[part.live] : null;
    const mat = dash
      ? new THREE.LineDashedMaterial({ color: C.lavEdge, dashSize: dash[0], gapSize: dash[1], transparent: true })
      : new THREE.LineBasicMaterial({ color: C.lavEdge, transparent: true });
    const lines = new THREE.LineSegments(g, mat);
    if (dash) lines.computeLineDistances();
    return lines;
  }, [geo, part.live]);
  const base = useMemo(() => new THREE.Color(TONE[part.tone]), [part.tone]);
  const at = useMemo(() => new THREE.Vector3(...part.at), [part.at]);
  const out = useMemo(() => new THREE.Vector3(...part.out), [part.out]);

  useEffect(() => {
    if (node.current) partNodes.set(part.id, node.current);
    return () => {
      partNodes.delete(part.id);
      partE.delete(part.id);
    };
  }, [part.id]);

  useFrame((_, dt) => {
    const n = node.current;
    const m = face.current;
    if (!n || !m) return;
    const e = partExplode(motion.explode, groupIndex, groups);
    partE.set(part.id, e);
    n.position.lerpVectors(at, out, e);

    const ui = useTeardown.getState();
    const target = part.active ? part.active(W()) : 0;
    glow.current = RM() ? target : glow.current + (target - glow.current) * (1 - Math.exp(-6 * Math.min(dt, 0.05)));
    const g = glow.current;

    const ghost = ui.isolate !== null && ui.isolate !== part.group;
    const xray = ui.xray && housing;
    const opacity = ghost ? 0.06 : xray ? 0.14 : part.tone === "glass" ? 0.85 : 1;
    m.opacity += (opacity - m.opacity) * Math.min(1, dt * 10);
    // `transparent` stays on: switching it changes the compiled shader (the OPAQUE define).
    m.depthWrite = m.opacity > 0.5;
    m.color.copy(tmp.copy(base).lerp(AQUA, 0.6 * g));
    m.emissive.copy(tmp2.copy(AQUA).multiplyScalar(0.35 * g));

    const lm = edges.material as THREE.LineBasicMaterial;
    const selected = ui.part === part.id;
    lm.color.copy(selected ? WHITE : tmp.copy(EDGE).lerp(AQUA, g));
    lm.opacity = ghost ? 0.12 : xray ? 0.5 : 1;
  });

  const onClick = (ev: ThreeEvent<MouseEvent>) => {
    const ui = useTeardown.getState();
    if (ui.isolate !== null && ui.isolate !== part.group) return;
    ev.stopPropagation();
    ui.set({ part: ui.part === part.id ? null : part.id });
  };
  const onOver = (ev: ThreeEvent<PointerEvent>) => {
    const ui = useTeardown.getState();
    if (ui.isolate !== null && ui.isolate !== part.group) return;
    ev.stopPropagation();
    document.body.style.cursor = "pointer";
  };
  const onOut = () => {
    document.body.style.cursor = "";
  };

  return (
    <group ref={node} position={part.at} rotation={part.rot}>
      <mesh geometry={geo} onClick={onClick} onPointerOver={onOver} onPointerOut={onOut}>
        <meshLambertMaterial ref={face} color={TONE[part.tone]} transparent opacity={1} />
      </mesh>
      <primitive object={edges} />
    </group>
  );
}

/** Moves the explode amount: scrubbed, playing the sequence, or easing to the chosen state. */
function Driver() {
  useFrame((_, dt) => {
    const ui = useTeardown.getState();
    // Capped so a stalled tab resumes smoothly, high enough that a slow GPU still keeps time.
    const step = Math.min(dt, 0.1);
    if (motion.scrub !== null) {
      motion.dir = Math.sign(motion.scrub - motion.explode);
      motion.explode = motion.scrub;
      return;
    }
    if (ui.playing) {
      motion.seqT += step;
      const s = sequenceAt(motion.seqT);
      motion.explode = s.e;
      motion.dir = s.dir;
      return;
    }
    const target = ui.exploded ? 1 : 0;
    if (RM()) {
      motion.explode = target;
      motion.dir = 0;
      return;
    }
    const rate = 1 / (target > motion.explode ? SEQ.apart : SEQ.together);
    const d = target - motion.explode;
    motion.dir = Math.abs(d) < 1e-4 ? 0 : Math.sign(d);
    motion.explode += Math.sign(d) * Math.min(Math.abs(d), rate * step);
  });
  return null;
}

interface Controls {
  autoRotate: boolean;
  getAzimuthalAngle: () => number;
  target: THREE.Vector3;
  update: () => void;
}

function bounds(parts: PartDef[]) {
  const box = new THREE.Box3();
  for (const p of parts) {
    box.expandByPoint(new THREE.Vector3(...p.out));
    box.expandByPoint(new THREE.Vector3(...p.at));
  }
  return { c: box.getCenter(new THREE.Vector3()), r: Math.max(1.2, box.getSize(new THREE.Vector3()).length() / 2) };
}

/**
 * Frames the exploded object, or the isolated assembly when one is chosen, and keeps the
 * turntable in step with the Display toggle. The user can still orbit and zoom freely; a new
 * framing eases in only when the object, the isolation or the window size changes.
 */
function Rig({ assembly }: { assembly: Assembly }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const size = useThree((s) => s.size);
  const turntable = useTeardown((s) => s.turntable);
  const isolate = useTeardown((s) => s.isolate);
  const goal = useRef<{ c: THREE.Vector3; d: number; t: number } | null>(null);
  const first = useRef(true);

  useEffect(() => {
    const whole = bounds(assembly.parts);
    const focus = isolate ? bounds(assembly.parts.filter((p) => p.group === isolate)) : whole;
    // On wide screens the model shares the width with two panel columns and two label columns.
    const usable = size.width > 860 ? Math.max(size.width * 0.42, size.width - 640 - 360) : size.width;
    const aspect = Math.max(0.35, usable / Math.max(1, size.height - 200));
    const fit = (r: number) => (r * assembly.frame) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, aspect);
    // Phones lose the top and bottom of the screen to the panels, so stand further back.
    const d = fit(focus.r) * (isolate ? 1.25 : 0.78) * (size.width > 860 ? 1 : 1.3);
    camera.near = 0.1;
    camera.far = 200;
    camera.updateProjectionMatrix();
    if (first.current || RM()) {
      // First framing: a fixed three-quarter view.
      first.current = false;
      const dir = new THREE.Vector3(0.62, 0.42, 0.92).normalize();
      camera.position.copy(focus.c).addScaledVector(dir, d);
      if (controls) {
        controls.target.copy(focus.c);
        controls.update();
      }
      goal.current = null;
      return;
    }
    goal.current = { c: focus.c, d, t: 1.4 };
  }, [assembly, camera, controls, isolate, size.width, size.height]);

  useFrame((_, dt) => {
    if (!controls) return;
    controls.autoRotate = turntable && !RM();
    const a = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
    motion.angle = (a + 360) % 360;
    const g = goal.current;
    if (!g) return;
    g.t -= dt;
    const k = 1 - Math.exp(-5 * Math.min(dt, 0.1));
    // Keep the viewing direction, move the target and the distance.
    const offset = camera.position.clone().sub(controls.target);
    const dist = offset.length();
    controls.target.lerp(g.c, k);
    offset.setLength(dist + (g.d - dist) * k);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    if (g.t <= 0) goal.current = null;
  });
  return null;
}

function Floor() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.005, 0]}>
        <circleGeometry args={[5.6, 64]} />
        <meshBasicMaterial color="#1b2453" />
      </mesh>
      {[2.4, 4.2, 5.6].map((r) => (
        <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
          <ringGeometry args={[r - 0.012, r + 0.012, 96]} />
          <meshBasicMaterial color={C.lavEdge} transparent opacity={0.22} />
        </mesh>
      ))}
      {Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2;
        const long = i % 4 === 0;
        return (
          <mesh key={i} position={[Math.cos(a) * 5.6, 0.003, Math.sin(a) * 5.6]} rotation={[-Math.PI / 2, 0, -a]}>
            <planeGeometry args={[long ? 0.3 : 0.14, 0.02]} />
            <meshBasicMaterial color={C.lavEdge} transparent opacity={long ? 0.5 : 0.25} />
          </mesh>
        );
      })}
    </group>
  );
}

export interface LeaderEls {
  label: HTMLDivElement;
  line: SVGPolylineElement;
  dot: SVGCircleElement;
}
/** Filled by the label layer (DOM), read by Leaders (inside the canvas). */
export const leaderEls = new Map<string, LeaderEls>();

const v = new THREE.Vector3();
const LABEL_GAP = 38;
/** Room kept for the sequence bar and the mode word under the model. */
const BOTTOM_KEEP = 190;
const TOP_KEEP = 96;

interface Item {
  id: string;
  x: number;
  y: number;
  ly: number;
  left: boolean;
  width: number;
}

const hide = (els: LeaderEls) => {
  els.label.style.opacity = "0";
  els.line.style.opacity = "0";
  els.dot.style.opacity = "0";
};

/** Projects each labelled part to the screen and lays its label out in a column on its side. */
function Leaders({ assembly }: { assembly: Assembly }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const items = useRef<Item[]>([]);
  useFrame(() => {
    const ui = useTeardown.getState();
    const { width: w, height: h } = size;
    const cx = w / 2;
    // Labels stay between the side panels.
    const lp = document.querySelector(".td-left")?.getBoundingClientRect();
    const rp = document.querySelector(".td-right")?.getBoundingClientRect();
    const leftLimit = w > 860 && lp && lp.width > 0 ? lp.right + 12 : 12;
    const rightLimit = w > 860 && rp && rp.width > 0 ? rp.left - 12 : w - 12;
    const list = items.current;
    list.length = 0;
    // Repeated parts (memory sticks, weight shards) are labelled once.
    const named = new Set<string>();
    for (const p of assembly.parts) {
      const els = leaderEls.get(p.id);
      if (!els?.label || !els.line || !els.dot) continue;
      const e = partE.get(p.id) ?? 0;
      const hasText = p.spec !== "" || p.key;
      const wanted =
        ui.part === p.id ||
        (ui.labels && hasText && !named.has(p.name) && (ui.isolate === null ? p.key === true : ui.isolate === p.group));
      if (wanted) named.add(p.name);
      // Between narrow panels there is no room for a column of labels; the part card says it all.
      const room = rightLimit - leftLimit > 620;
      const visible = wanted && (e > 0.55 || ui.part === p.id) && w > 860 && (room || ui.part === p.id);
      const n = partNodes.get(p.id);
      if (!visible || !n) {
        hide(els);
        continue;
      }
      n.getWorldPosition(v).project(camera);
      if (v.z > 1) {
        hide(els);
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      list.push({ id: p.id, x, y, ly: y, left: x < cx, width: els.label.offsetWidth });
    }
    for (const left of [true, false]) {
      const side = list.filter((it) => it.left === left).sort((a, b) => a.y - b.y);
      let prev = TOP_KEEP - LABEL_GAP;
      for (const it of side) {
        it.ly = Math.max(it.y, prev + LABEL_GAP);
        prev = it.ly;
      }
      // Pull the column back up if it ran into the sequence bar.
      const over = prev - (h - BOTTOM_KEEP);
      if (over > 0) for (const it of side) it.ly -= over;
    }
    for (const it of list) {
      const els = leaderEls.get(it.id)!;
      const lx = it.left
        ? Math.max(leftLimit + it.width, Math.min(it.x - 60, cx - w * 0.16))
        : Math.min(rightLimit - it.width, Math.max(it.x + 60, cx + w * 0.16));
      const elbow = it.left ? lx + 18 : lx - 18;
      els.label.style.opacity = "1";
      els.label.style.transform = `translate(${lx}px, ${it.ly}px) translate(${it.left ? "-100%" : "0"}, -50%)`;
      els.label.classList.toggle("left", it.left);
      els.line.setAttribute("points", `${it.x},${it.y} ${elbow},${it.ly} ${lx},${it.ly}`);
      els.line.style.opacity = "1";
      els.dot.setAttribute("cx", String(it.x));
      els.dot.setAttribute("cy", String(it.y));
      els.dot.style.opacity = "1";
    }
  });
  return null;
}

export function TeardownCanvas({ assembly }: { assembly: Assembly }) {
  const groupIndex = useMemo(() => new Map(assembly.groups.map((g, i) => [g.id, i])), [assembly]);
  const set = useTeardown((s) => s.set);
  return (
    <Canvas dpr={[1, 2]} gl={{ antialias: true }} onPointerMissed={() => set({ part: null })}>
      <color attach="background" args={[C.bg]} />
      <PerspectiveCamera makeDefault fov={32} position={[8, 6, 10]} />
      <OrbitControls makeDefault enableDamping autoRotateSpeed={0.7} minPolarAngle={0.25} maxPolarAngle={1.45} minDistance={4} maxDistance={40} enablePan={false} />
      <ambientLight intensity={0.6} color="#c2c0ff" />
      <directionalLight position={[4, 12, 7]} intensity={1.7} />
      <directionalLight position={[-7, 4, -5]} intensity={0.35} color="#7f8cff" />
      <Floor />
      <Driver />
      <Rig assembly={assembly} />
      {assembly.parts.map((p) => (
        <Part key={p.id} part={p} groupIndex={groupIndex.get(p.group) ?? 0} groups={assembly.groups.length} housing={p.group === assembly.groups[0]?.id} />
      ))}
      <Leaders assembly={assembly} />
    </Canvas>
  );
}
