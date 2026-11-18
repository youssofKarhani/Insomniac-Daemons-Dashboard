import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { TwinEvent } from "../model/events";
import { QUEUE_LOCATION, namedPerQueue, type JobView, type QueueName } from "../model/state";
import { useTwin } from "../store";
import { C, RM, W, approach } from "./kit";
import { ANCHOR, POS, stackOffset } from "./layout";

const CRATE_VISIBLE = 6;
const MAX_ANON = 6;

function stampColor(j: JobView): string {
  if (j.outcome === "dlq") return C.red;
  if (j.outcome === "rejected") return C.grey;
  if (j.outcome === "needs_review") return C.amber;
  if (j.outcome === "decided") return C.lavEdge;
  if (j.outcome === "completed") return C.aqua;
  if (j.step === "retrying") return C.amber;
  if (j.step === "verifying") return j.verifyPassed ? C.aqua : C.amber;
  if (j.gate === "pass") return C.aqua;
  if (j.gate === "reject") return C.grey;
  return C.ticket;
}

function Ticket({ job, target }: { job: JobView; target: [number, number, number] }) {
  const g = useRef<THREE.Group>(null);
  const placed = useRef(false);
  useFrame((_, dt) => {
    const m = g.current;
    if (!m) return;
    const lift = job.inFlight ? 0.25 + 0.05 * Math.sin(W().t / 300) : 0;
    if (!placed.current) {
      m.position.set(target[0], target[1] + lift, target[2]);
      placed.current = true;
      return;
    }
    const k = 4.5;
    m.position.x = approach(m.position.x, target[0], k, dt);
    m.position.y = approach(m.position.y, target[1] + lift, k, dt);
    m.position.z = approach(m.position.z, target[2], k, dt);
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
    </group>
  );
}

/** Job tickets, each easing toward the anchor of its current location. */
export function Tickets() {
  const jobs = useTwin((s) => s.world.jobs);
  const depth = useTwin((s) => s.world.queueDepth);
  const placed = useMemo(() => {
    const byLoc = new Map<string, JobView[]>();
    for (const j of Object.values(jobs)) {
      const list = byLoc.get(j.location) ?? [];
      list.push(j);
      byLoc.set(j.location, list);
    }
    // Live telemetry reports how many messages wait, not which jobs: draw unnamed tickets
    // only for depth beyond the named jobs that queue is still holding.
    const named = namedPerQueue(jobs);
    for (const [q, d] of Object.entries(depth) as [QueueName, { visible: number; inFlight: number }][]) {
      const loc = QUEUE_LOCATION[q];
      const list = byLoc.get(loc) ?? [];
      const missing = Math.min(MAX_ANON, d.visible + d.inFlight - named[q]);
      for (let i = 0; i < missing; i += 1) {
        list.push({
          id: `anon-${q}-${i}`,
          jobType: "unknown",
          location: loc,
          step: "queued",
          inFlight: i < d.inFlight,
          attempts: 0,
          receiveCount: 0,
          enqueuedAt: 0,
          seq: -100 + i,
        });
      }
      byLoc.set(loc, list);
    }
    const out: { job: JobView; target: [number, number, number] }[] = [];
    for (const [loc, list] of byLoc) {
      list.sort((a, b) => a.seq - b.seq);
      const shown = loc === "crate" ? list.slice(-CRATE_VISIBLE) : list;
      shown.forEach((job, n) => {
        const a = ANCHOR[job.location];
        const o = stackOffset(job.location, n);
        out.push({ job, target: [a[0] + o[0], a[1] + o[1], a[2] + o[2]] });
      });
    }
    return out;
  }, [jobs, depth]);
  return (
    <group>
      {placed.map(({ job, target }) => (
        <Ticket key={job.id} job={job} target={target} />
      ))}
    </group>
  );
}

// ---- Signals: short light pulses travelling between objects ---------------

type P3 = [number, number, number];
const up = (p: P3, y: number): P3 => [p[0], p[1] + y, p[2]];

interface Path {
  from: P3;
  to: P3;
  color: string;
  dur: number;
}

/** Which events send a pulse, and where. Purely a function of the event, so seeking is safe. */
function pathFor(e: TwinEvent): Path | null {
  switch (e.kind) {
    case "cp.state":
      return e.data.state === "pending" ? { from: up(POS.lambda, 1.6), to: up(POS.controlPlane, 2.2), color: C.aqua, dur: 1600 } : null;
    case "ingress.prewarm":
      return { from: up(POS.clock, 1.5), to: up(POS.lambda, 1.4), color: C.lavEdge, dur: 1200 };
    case "keda.scale":
      return e.data.replicas === 1 ? { from: up(POS.gpuQueue, 0.4), to: up(POS.keda, 1.2), color: C.violet, dur: 900 } : null;
    case "asg.desired":
      return e.data.desired === 1 ? { from: up(POS.controlPlane, 3.2), to: up(POS.gpuNode, 2.6), color: C.violet, dur: 2000 } : null;
    case "node.joined":
      return { from: up(POS.gpuNode, 1.2), to: up(POS.controlPlane, 1.4), color: C.violet, dur: 1800 };
    case "ebs.attached":
      return { from: up(POS.modelVolume, 0.9), to: up(POS.gpuNode, 0.9), color: C.violet, dur: 900 };
    case "guard.latch":
      return e.data.locked ? { from: up(POS.lambda, 1.4), to: up(POS.guard, 0.4), color: C.amber, dur: 2200 } : null;
    default:
      return null;
  }
}

const POOL = 14;
const TRAIL = 4;

export function Signals() {
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const { world, timeline, reducedMotion } = useTwin.getState();
    let used = 0;
    if (!reducedMotion && !RM()) {
      const t = world.t;
      const ev = timeline.events;
      for (let i = ev.length - 1; i >= 0 && used < POOL; i -= 1) {
        const e = ev[i];
        if (e.ts > t) continue;
        if (t - e.ts > 2400) break;
        const path = pathFor(e);
        if (!path) continue;
        const f = (t - e.ts) / path.dur;
        if (f > 1) continue;
        for (let k = 0; k < TRAIL && used < POOL; k += 1) {
          const fk = Math.max(0, f - k * 0.04);
          const m = meshes.current[used++];
          if (!m) continue;
          tmp.set(...path.from).lerp(new THREE.Vector3(...path.to), fk);
          tmp.y += Math.sin(fk * Math.PI) * 1.2;
          m.position.copy(tmp);
          m.scale.setScalar(1 - k * 0.22);
          (m.material as THREE.MeshBasicMaterial).color.set(path.color);
          m.visible = true;
        }
      }
      // Token stream while a job is being generated.
      const generating = Object.values(world.jobs).some((j) => j.location === "core");
      if (generating) {
        for (let k = 0; k < 5 && used < POOL; k += 1) {
          const f = ((t / 900 + k / 5) % 1 + 1) % 1;
          const m = meshes.current[used++];
          if (!m) continue;
          tmp.set(...up(POS.gpuNode, 1.8)).lerp(new THREE.Vector3(...up(POS.controlPlane, 2.6)), f);
          tmp.y += Math.sin(f * Math.PI) * 0.9;
          m.position.copy(tmp);
          m.scale.setScalar(0.6);
          (m.material as THREE.MeshBasicMaterial).color.set(C.violet);
          m.visible = true;
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
