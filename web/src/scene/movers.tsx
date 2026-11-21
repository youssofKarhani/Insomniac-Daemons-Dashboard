import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { JobView } from "../model/state";
import { lastIndexAt } from "../model/replay";
import { ticketsByLocation, type TicketTone } from "../model/tickets";
import { useDashboard } from "../store";
import { C, RM, W, approach } from "./kit";
import { ticketDrawn, ticketOffset } from "./layout";
import { CABLE_EDGES, along, type Route } from "./routes";
import { marksAt, newPose, poseAt, restingAt, slotAt, type Marks } from "./ticketPath";
import { pulseFor, pulseWindows, routeOf, PULSE_SPEED } from "./signals";

const STAMP: Record<TicketTone, string> = {
  plain: C.ticket,
  pass: C.aqua,
  reject: C.grey,
  warn: C.amber,
  fail: C.red,
  decided: C.lavEdge,
};

const Yv = new THREE.Vector3(0, 1, 0);

function Ticket({ job }: { job: JobView }) {
  const g = useRef<THREE.Group>(null);
  const placed = useRef(false);
  const pose = useMemo(newPose, []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const upV = useMemo(() => new THREE.Vector3(), []);
  const marks = useMemo<Marks>(() => ({ tone: "plain", pips: 0, held: false }), []);
  const stamp = useRef<THREE.MeshBasicMaterial>(null);
  const pips = useRef<(THREE.Mesh | null)[]>([]);
  const band = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    const m = g.current;
    if (!m) return;
    const rm = RM();
    const w = W();
    const t = rm ? Infinity : w.t;
    const all = [...Object.values(w.jobs), ...Object.values(w.anon)];
    poseAt(job, t, ticketOffset(job.location, slotAt(all, job, t), job, w.archived), pose);
    marksAt(job, t, marks);
    stamp.current?.color.set(STAMP[marks.tone]);
    pips.current.forEach((p, i) => p && (p.visible = i < marks.pips));
    if (band.current) band.current.visible = marks.held;
    q.setFromUnitVectors(Yv, upV.set(...pose.up));
    const { playing, mode } = useDashboard.getState();
    // While playing, follow the pose closely (this also smooths a slot change in a queue).
    // When paused or scrubbing, sit exactly where the job is.
    if (!placed.current || rm || !(playing || mode === "live")) {
      m.position.set(...pose.pos);
      m.quaternion.copy(q);
      placed.current = true;
      return;
    }
    const k = 14;
    m.position.x = approach(m.position.x, pose.pos[0], k, dt);
    m.position.y = approach(m.position.y, pose.pos[1], k, dt);
    m.position.z = approach(m.position.z, pose.pos[2], k, dt);
    m.quaternion.slerp(q, 1 - Math.exp(-10 * Math.min(dt, 0.05)));
  });
  return (
    <group ref={g}>
      <mesh>
        <boxGeometry args={[0.75, 0.1, 0.52]} />
        <meshBasicMaterial color={C.ticket} toneMapped={false} />
      </mesh>
      <mesh position={[0.18, 0.06, 0]}>
        <boxGeometry args={[0.24, 0.03, 0.24]} />
        <meshBasicMaterial ref={stamp} color={C.ticket} toneMapped={false} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(p) => (pips.current[i] = p)} visible={false} position={[-0.26 + i * 0.11, 0.06, -0.17]}>
          <boxGeometry args={[0.07, 0.03, 0.07]} />
          <meshBasicMaterial color={C.amber} toneMapped={false} />
        </mesh>
      ))}
      {/* Held by the worker: a claim band across the ticket instead of the ticket floating. */}
      <mesh ref={band} visible={false} position={[-0.12, 0.065, 0]}>
        <boxGeometry args={[0.09, 0.04, 0.56]} />
        <meshBasicMaterial color={C.violet} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Job tickets, each riding the belts along its own hop history. */
export function Tickets() {
  const jobs = useDashboard((s) => s.world.jobs);
  const anon = useDashboard((s) => s.world.anon);
  const archived = useDashboard((s) => s.world.archived);
  const placed = useMemo(() => {
    const out: { job: JobView }[] = [];
    for (const [loc, list] of ticketsByLocation({ jobs, anon })) {
      list.forEach((job) => {
        if (ticketDrawn(loc, job, archived)) out.push({ job });
      });
    }
    return out;
  }, [jobs, anon, archived]);
  return (
    <group>
      {placed.map(({ job }) => (
        <Ticket key={job.id} job={job} />
      ))}
    </group>
  );
}

// ---- Signals: light pulses travelling along the cables ---------------------

const LOOKBACK_MS = 8_000;
const POOL = 18;
const TRAIL = 4;
const TRAIL_GAP = 0.16;
const TOKENS = 5;

export function Signals() {
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const at = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  // Colours are parsed once, not every frame.
  const colors = useMemo(() => new Map<string, THREE.Color>(), []);
  const color = (hex: string) => {
    let c = colors.get(hex);
    if (!c) colors.set(hex, (c = new THREE.Color(hex)));
    return c;
  };
  /** Places pulse mesh `i` at distance `d` along `r`, hidden while that point is inside an object. */
  const put = (i: number, r: Route, d: number, hex: string, scale: number) => {
    const m = meshes.current[i];
    if (!m) return;
    const seg = along(r, d, at);
    if (seg && seg.edge >= 0 && CABLE_EDGES[seg.edge].line === "hidden") {
      m.visible = false;
      return;
    }
    m.position.set(at[0], at[1] + 0.06, at[2]);
    m.scale.setScalar(scale);
    (m.material as THREE.MeshBasicMaterial).color.copy(color(hex));
    m.visible = true;
  };
  useFrame(() => {
    const { history, reducedMotion } = useDashboard.getState();
    const world = W();
    let used = 0;
    if (!reducedMotion && !RM()) {
      const t = world.t;
      const ev = history;
      // Start at the playhead: later events have not happened yet.
      for (let i = lastIndexAt(ev, t); i >= 0 && used < POOL; i -= 1) {
        const e = ev[i];
        if (t - e.ts > LOOKBACK_MS) break;
        const spec = pulseFor(e);
        if (!spec) continue;
        const r = routeOf(spec.stops);
        const depart = pulseWindows(ev).get(e.id)?.depart ?? e.ts;
        if (t < depart) continue;
        const head = ((t - depart) / 1000) * (spec.speed ?? PULSE_SPEED);
        if (head - (TRAIL - 1) * TRAIL_GAP > r.len) continue;
        for (let k = 0; k < TRAIL && used < POOL; k += 1) {
          const d = head - k * TRAIL_GAP;
          if (d < 0 || d > r.len) continue;
          put(used++, r, d, spec.color, 1 - k * 0.22);
        }
      }
      // Token stream from the model back to the LiteLLM gateway while a job is being generated.
      const generating = Object.values(world.jobs).some((j) => j.location === "core" && restingAt(j, t) === "core");
      if (generating) {
        const r = routeOf(["gpu", "litellm"]);
        for (let k = 0; k < TOKENS && used < POOL; k += 1) {
          const d = ((((t / 1000) * PULSE_SPEED * 0.6 + (k * r.len) / TOKENS) % r.len) + r.len) % r.len;
          put(used++, r, d, C.violet, 0.6);
        }
      }
    }
    for (let i = used; i < POOL; i += 1) {
      const m = meshes.current[i];
      if (m) m.visible = false;
    }
  });
  return (
    <group>
      {Array.from({ length: POOL }, (_, i) => (
        <mesh key={i} ref={(m) => (meshes.current[i] = m)} visible={false}>
          <sphereGeometry args={[0.11, 10, 8]} />
          <meshBasicMaterial color={C.aqua} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
