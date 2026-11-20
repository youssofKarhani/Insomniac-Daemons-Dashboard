import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { TwinEvent } from "../model/events";
import type { JobView } from "../model/state";
import { lastIndexAt } from "../model/replay";
import { ticketsByLocation, ticketTone, type TicketTone } from "../model/tickets";
import { useTwin } from "../store";
import { C, RM, W, approach } from "./kit";
import { ticketDrawn, ticketOffset } from "./layout";
import { CABLE_EDGES, along, cableRoute, type CableNode, type Route } from "./routes";
import { newPose, poseAt, restingAt } from "./ticketPath";
import { ARM_PULSE_SPEED } from "./gantry";

const STAMP: Record<TicketTone, string> = {
  plain: C.ticket,
  pass: C.aqua,
  reject: C.grey,
  warn: C.amber,
  fail: C.red,
  decided: C.lavEdge,
};
const stampColor = (j: JobView) => STAMP[ticketTone(j)];

const Yv = new THREE.Vector3(0, 1, 0);

function Ticket({ job, offset }: { job: JobView; offset: [number, number, number] }) {
  const g = useRef<THREE.Group>(null);
  const placed = useRef(false);
  const pose = useMemo(newPose, []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const upV = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const m = g.current;
    if (!m) return;
    const rm = RM();
    poseAt(job, rm ? Infinity : W().t, offset, pose);
    q.setFromUnitVectors(Yv, upV.set(...pose.up));
    const { playing, mode } = useTwin.getState();
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
        <meshBasicMaterial color={stampColor(job)} toneMapped={false} />
      </mesh>
      {Array.from({ length: Math.min(job.receiveCount, 3) }, (_, i) => (
        <mesh key={i} position={[-0.26 + i * 0.11, 0.06, -0.17]}>
          <boxGeometry args={[0.07, 0.03, 0.07]} />
          <meshBasicMaterial color={C.amber} toneMapped={false} />
        </mesh>
      ))}
      {/* Held by the worker: a claim band across the ticket instead of the ticket floating. */}
      {job.inFlight && (
        <mesh position={[-0.12, 0.065, 0]}>
          <boxGeometry args={[0.09, 0.04, 0.56]} />
          <meshBasicMaterial color={C.violet} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/** Job tickets, each riding the belts along its own hop history. */
export function Tickets() {
  const jobs = useTwin((s) => s.world.jobs);
  const anon = useTwin((s) => s.world.anon);
  const archived = useTwin((s) => s.world.archived);
  const placed = useMemo(() => {
    const out: { job: JobView; offset: [number, number, number] }[] = [];
    for (const [loc, list] of ticketsByLocation({ jobs, anon })) {
      list.forEach((job, n) => {
        if (ticketDrawn(loc, job, archived)) out.push({ job, offset: ticketOffset(loc, n, job, archived) });
      });
    }
    return out;
  }, [jobs, anon, archived]);
  return (
    <group>
      {placed.map(({ job, offset }) => (
        <Ticket key={job.id} job={job} offset={offset} />
      ))}
    </group>
  );
}

// ---- Signals: light pulses travelling along the cables ---------------------

interface PulseSpec {
  stops: readonly CableNode[];
  color: string;
  /** Desk units per second; defaults to PULSE_SPEED. */
  speed?: number;
}

/** Which events send a pulse, and along which cables. Purely a function of the event, so seeking is safe. */
function pulseFor(e: TwinEvent): PulseSpec | null {
  switch (e.kind) {
    case "ingress.request":
      return { stops: ["net", "lambda"], color: C.lavEdge };
    case "ingress.prewarm":
      return { stops: ["clock", "lambda"], color: C.lavEdge };
    case "cp.state":
      if (e.data.state === "pending") return { stops: ["lambda", "tower"], color: C.aqua };
      if (e.data.state === "stopping") return { stops: ["wdBack", "tower"], color: C.lav };
      return null;
    case "keda.scale":
      return e.data.replicas === 1 ? { stops: ["gqSensor", "keda"], color: C.violet } : null;
    case "asg.desired":
      // The autoscaler's order runs along the arm's rail to the carriage, which then moves.
      return { stops: ["tower", "armBay"], color: C.violet, speed: ARM_PULSE_SPEED };
    case "node.joined":
      return { stops: ["gpu", "tower"], color: C.violet };
    case "ebs.attached":
      return { stops: ["drive", "gpu"], color: C.violet };
    case "guard.latch":
      // Locking follows the tower stopping: EventBridge tells the wake switch, which locks the guard.
      return e.data.locked
        ? { stops: ["tower", "lambda", "guard"], color: C.amber }
        : { stops: ["lambda", "guard"], color: C.amber };
    case "ssm.session":
      return e.data.open ? { stops: ["ssmBack", "tower"], color: C.violet } : null;
    default:
      return null;
  }
}

const routeCache = new Map<string, Route>();
function routeOf(stops: readonly CableNode[]): Route {
  const key = stops.join(">");
  let r = routeCache.get(key);
  if (!r) routeCache.set(key, (r = cableRoute(stops)));
  return r;
}

/** Pulse speed along a cable, desk units per second of source time. */
const PULSE_SPEED = 7;
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
    const { timeline, reducedMotion } = useTwin.getState();
    const world = W();
    let used = 0;
    if (!reducedMotion && !RM()) {
      const t = world.t;
      const ev = timeline.events;
      // Start at the playhead: later events have not happened yet.
      for (let i = lastIndexAt(ev, t); i >= 0 && used < POOL; i -= 1) {
        const e = ev[i];
        if (t - e.ts > LOOKBACK_MS) break;
        const spec = pulseFor(e);
        if (!spec) continue;
        const r = routeOf(spec.stops);
        const head = ((t - e.ts) / 1000) * (spec.speed ?? PULSE_SPEED);
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
