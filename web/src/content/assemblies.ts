/**
 * Teardown assemblies: what an object is made of, where each part sits when assembled and where
 * it flies to when the object is taken apart. Facts come from docs/teardown-parts.md (platform
 * code and AWS documentation). Public-safe: names, roles and numbers only, never identifiers,
 * ports, network ranges or URLs.
 *
 * Coordinates are in teardown units, y up, the object standing on the floor at the origin.
 */
import type { WorldState } from "../model/state";
import type { ObjectId } from "./components";

export type V3 = [number, number, number];

/** How the dashboard knows a part's state. Drawn solid, dashed (inferred) or dotted (not observed). */
export type Live = "observed" | "inferred" | "exporter" | "static";

export type Shape =
  | { kind: "box"; size: V3 }
  | { kind: "cyl"; r: number; h: number }
  | { kind: "ring"; r: number; tube: number }
  | { kind: "ball"; r: number };

export type Tone = "shell" | "board" | "chip" | "module" | "store" | "glass";

export interface PartDef {
  id: string;
  name: string;
  /** One short line under the name: the key numbers. */
  spec: string;
  group: string;
  shape: Shape;
  /** Assembled position. */
  at: V3;
  /** Exploded position. */
  out: V3;
  rot?: V3;
  tone: Tone;
  live: Live;
  /** 0..1: how hard the part is working now. Drives the accent glow. */
  active?: (w: WorldState) => number;
  /** Labelled whenever labels are on; other parts are labelled when their group is isolated. */
  key?: boolean;
  /** Longer explanation for the part card. */
  detail?: string[];
}

export type StatusTone = "on" | "off" | "starting" | "inferred" | "exporter" | "static";

export interface GroupDef {
  id: string;
  name: string;
  spec: string;
  status: (w: WorldState) => { text: string; tone: StatusTone };
}

export interface Readout {
  label: string;
  value: string;
  tone?: StatusTone;
}

export interface Assembly {
  id: ObjectId;
  code: string;
  title: string;
  subtitle: string;
  /** Groups in teardown order: the first comes off first. */
  groups: GroupDef[];
  parts: PartDef[];
  status: (w: WorldState) => { text: string; tone: StatusTone };
  readouts: (w: WorldState) => Readout[];
  /** Camera distance multiplier for the exploded view. */
  frame: number;
}

const cpRunning = (w: WorldState) => (w.cp.state === "running" ? 1 : w.cp.state === "pending" || w.cp.state === "stopping" ? 0.5 : 0);
const podsUp = (w: WorldState) => (w.cp.state === "running" && w.cp.podsReady ? 1 : 0);
const gpuUp = (w: WorldState) => (w.gpu.state === "running" ? 1 : w.gpu.state === "launching" || w.gpu.state === "terminating" ? 0.5 : 0);
const vllmLevel = (w: WorldState) => ({ absent: 0, pending: 0.25, loading: 0.6, ready: 1 })[w.vllm.state];
const jobsAt = (w: WorldState, ...locs: string[]) =>
  Object.values(w.jobs).filter((j) => j.step !== "done" && locs.includes(j.location)).length;
const busy = (n: number) => (n > 0 ? 1 : 0);

const cpStatus = (w: WorldState): { text: string; tone: StatusTone } => {
  switch (w.cp.state) {
    case "running":
      return { text: "Running", tone: "on" };
    case "pending":
      return { text: "Booting", tone: "starting" };
    case "stopping":
      return { text: "Stopping", tone: "starting" };
    default:
      return { text: "Asleep", tone: "off" };
  }
};
const podsStatus = (w: WorldState): { text: string; tone: StatusTone } =>
  podsUp(w) ? { text: "Ready (inferred)", tone: "inferred" } : { text: "Not running", tone: "off" };
const gpuStatus = (w: WorldState): { text: string; tone: StatusTone } => {
  switch (w.gpu.state) {
    case "running":
      return { text: "Running", tone: "on" };
    case "launching":
      return { text: "Launching", tone: "starting" };
    case "terminating":
      return { text: "Handing back", tone: "starting" };
    case "launch_failed":
      return { text: "Launch failed", tone: "off" };
    default:
      return { text: "None", tone: "off" };
  }
};
const exporter = () => ({ text: "Needs exporter", tone: "exporter" as const });

const depth = (w: WorldState, q: "workflow" | "gpu") => {
  const d = w.queueDepth[q];
  return `${d.visible} waiting · ${d.inFlight} in flight`;
};

// ---- Control tower -----------------------------------------------------------------------

const tower: Assembly = {
  id: "controlPlane",
  code: "CP-1",
  title: "Control tower",
  subtitle: "Amazon EC2 t3.medium · K3s single node",
  frame: 1,
  status: cpStatus,
  readouts: (w) => [
    { label: "Instance", value: cpStatus(w).text, tone: cpStatus(w).tone },
    { label: "Platform services", value: podsStatus(w).text, tone: podsStatus(w).tone },
    { label: "Inbox", value: depth(w, "workflow") },
    { label: "GPU queue", value: depth(w, "gpu") },
    { label: "Jobs on the worker", value: String(jobsAt(w, "worker", "laya")) },
    { label: "GPU group", value: w.asg.desired === 1 ? "1 requested" : "0" },
  ],
  groups: [
    { id: "shell", name: "Shell", spec: "Instance housing · status window", status: cpStatus },
    { id: "hardware", name: "Hardware", spec: "2 vCPU · 4 GiB · 30 GB gp3", status: cpStatus },
    { id: "host", name: "Host services", spec: "systemd units outside Kubernetes", status: cpStatus },
    { id: "k3s", name: "K3s node", spec: "Kubernetes, job store, scalers", status: cpStatus },
    { id: "pods", name: "Platform pods", spec: "Orchestrator · worker · LiteLLM · LAYA", status: podsStatus },
  ],
  parts: [
    // Shell: comes off first, panels fly straight out.
    { id: "shell-front", name: "Front panel", spec: "Status window shows the boot", group: "shell", tone: "shell", live: "observed",
      shape: { kind: "box", size: [2, 3, 0.08] }, at: [0, 1.5, 0.96], out: [0, 1.5, 3.4] },
    { id: "status-window", name: "Status window", spec: "Lit while the instance runs", group: "shell", tone: "glass", live: "observed",
      shape: { kind: "box", size: [1.1, 0.6, 0.04] }, at: [0, 2.2, 1.02], out: [0, 2.2, 3.46], active: cpRunning },
    { id: "shell-back", name: "Back panel", spec: "", group: "shell", tone: "shell", live: "static",
      shape: { kind: "box", size: [2, 3, 0.08] }, at: [0, 1.5, -0.96], out: [0, 1.5, -3.4] },
    { id: "shell-left", name: "Side panel", spec: "", group: "shell", tone: "shell", live: "static",
      shape: { kind: "box", size: [0.08, 3, 1.84] }, at: [-0.96, 1.5, 0], out: [-3.6, 1.5, 0] },
    { id: "shell-right", name: "Side panel", spec: "", group: "shell", tone: "shell", live: "static",
      shape: { kind: "box", size: [0.08, 3, 1.84] }, at: [0.96, 1.5, 0], out: [3.6, 1.5, 0] },
    { id: "roof", name: "Roof hatch", spec: "Opens when the pods start", group: "shell", tone: "shell", live: "inferred",
      shape: { kind: "box", size: [2, 0.08, 2] }, at: [0, 3.04, 0], out: [0, 6.3, 0] },

    // Hardware: the bottom layer, stays low and spreads out.
    { id: "base", name: "Chassis base", spec: "", group: "hardware", tone: "board", live: "static",
      shape: { kind: "box", size: [2.1, 0.12, 2.1] }, at: [0, 0.06, 0], out: [0, 0.06, 0] },
    { id: "mainboard", name: "Mainboard", spec: "", group: "hardware", tone: "board", live: "static",
      shape: { kind: "box", size: [1.7, 0.05, 1.7] }, at: [0, 0.2, 0], out: [0, 0.32, 0] },
    { id: "cpu", name: "vCPU ×2", spec: "Intel Xeon · up to 3.1 GHz · burstable", group: "hardware", tone: "chip", live: "observed", key: true,
      shape: { kind: "box", size: [0.42, 0.08, 0.42] }, at: [-0.4, 0.27, -0.3], out: [-0.9, 1.0, -0.6], active: cpRunning,
      detail: ["Earns 24 CPU credits an hour and can burst above its baseline.", "Runs everything on the tower: Kubernetes, the pods and the host services."] },
    { id: "memory-a", name: "Memory 4 GiB", spec: "Plus a 2 GB swapfile", group: "hardware", tone: "chip", live: "static", key: true,
      shape: { kind: "box", size: [0.08, 0.3, 1.0] }, at: [0.25, 0.37, 0], out: [0.6, 1.05, 0],
      detail: ["4 GiB of memory; the boot script adds a 2 GB swapfile so a memory spike doesn't kill a pod."] },
    { id: "memory-b", name: "Memory", spec: "", group: "hardware", tone: "chip", live: "static",
      shape: { kind: "box", size: [0.08, 0.3, 1.0] }, at: [0.4, 0.37, 0], out: [0.85, 1.05, 0] },
    { id: "root-disk", name: "Root disk", spec: "30 GB gp3 · OS, job store, LAYA cache", group: "hardware", tone: "store", live: "static", key: true,
      shape: { kind: "box", size: [0.6, 0.14, 0.4] }, at: [-0.4, 0.3, 0.45], out: [-1.6, 0.6, 1.5],
      detail: ["Kept when the tower stops (stopped, not terminated), so it boots in about a minute with its data intact.", "Holds the job database and the LAYA model files."] },
    { id: "nitro", name: "Nitro card", spec: "Hypervisor, EBS and network offload", group: "hardware", tone: "board", live: "static", key: true,
      shape: { kind: "box", size: [0.06, 0.4, 0.6] }, at: [0.75, 0.45, -0.5], out: [1.9, 0.75, -1.3],
      detail: ["T3 instances run on the AWS Nitro System: dedicated hardware plus a lightweight hypervisor."] },

    // Host services: systemd, outside Kubernetes.
    { id: "host-plate", name: "Host OS", spec: "Ubuntu 24.04", group: "host", tone: "board", live: "static",
      shape: { kind: "box", size: [1.8, 0.05, 1.8] }, at: [0, 1.0, 0], out: [0, 1.95, 0] },
    { id: "idle-timer", name: "Idle timer", spec: "Checks every 5 min · off after 30 quiet min", group: "host", tone: "module", live: "inferred", key: true,
      shape: { kind: "cyl", r: 0.28, h: 0.1 }, at: [-0.5, 1.1, 0.3], out: [-1.3, 2.1, 0.9],
      active: (w) => (w.cp.state === "running" && w.watchdogIdleSince !== undefined ? 1 : 0),
      detail: ["Four checks must all be quiet: both queues empty, no live leases or pending outbox in the job store, the orchestrator idle, the GPU group at zero.", "After 30 quiet minutes it sets the GPU group to 0 and powers the tower off."] },
    { id: "shutdown-hook", name: "Shutdown hook", spec: "GPU group to 0 on stop · 45 s budget", group: "host", tone: "module", live: "observed", key: true,
      shape: { kind: "box", size: [0.35, 0.25, 0.25] }, at: [0.1, 1.15, 0.4], out: [0.3, 2.15, 1.3],
      detail: ["On boot it lets the GPU group launch again; on shutdown it sets the group to 0 and suspends launches.", "A second layer behind the stop guard on the cradle."] },
    { id: "ssm-agent", name: "SSM agent", spec: "Operator access · no SSH, no open ports", group: "host", tone: "module", live: "exporter",
      shape: { kind: "box", size: [0.3, 0.2, 0.3] }, at: [0.55, 1.13, -0.3], out: [1.5, 2.1, -0.8] },

    // K3s node.
    { id: "k3s-plate", name: "K3s server", spec: "Single node · SQLite datastore", group: "k3s", tone: "board", live: "inferred", key: true,
      shape: { kind: "box", size: [1.8, 0.06, 1.8] }, at: [0, 1.6, 0], out: [0, 3.35, 0], active: podsUp,
      detail: ["A one-node Kubernetes cluster. Its built-ins are CoreDNS, the Flannel pod network and containerd; the Traefik ingress is turned off."] },
    { id: "coredns", name: "CoreDNS", spec: "Names inside the cluster", group: "k3s", tone: "module", live: "inferred",
      shape: { kind: "box", size: [0.35, 0.2, 0.35] }, at: [-0.55, 1.75, -0.5], out: [-1.2, 3.55, -1.0], active: podsUp },
    { id: "flannel", name: "Flannel", spec: "Pod network across both nodes", group: "k3s", tone: "module", live: "inferred",
      shape: { kind: "box", size: [0.35, 0.2, 0.35] }, at: [0, 1.75, -0.5], out: [0, 3.55, -1.25], active: podsUp },
    { id: "containerd", name: "containerd", spec: "Runs the container images", group: "k3s", tone: "module", live: "inferred",
      shape: { kind: "box", size: [0.35, 0.2, 0.35] }, at: [0.55, 1.75, -0.5], out: [1.2, 3.55, -1.0], active: podsUp },
    { id: "store-jobs", name: "Job store", spec: "SQLite · jobs table with leases", group: "k3s", tone: "store", live: "exporter", key: true,
      shape: { kind: "cyl", r: 0.25, h: 0.13 }, at: [-0.45, 1.72, 0.35], out: [-1.5, 3.5, 1.0],
      active: (w) => busy(jobsAt(w, "worker", "laya", "core")),
      detail: ["One SQLite file on the tower's disk, shared by the orchestrator and the worker.", "A job is leased while a loop works on it (120 s on the CPU loop, 180 s on the GPU loop)."] },
    { id: "store-steps", name: "job_steps", spec: "One row per step attempt", group: "k3s", tone: "store", live: "exporter",
      shape: { kind: "cyl", r: 0.25, h: 0.13 }, at: [-0.45, 1.87, 0.35], out: [-1.5, 3.8, 1.0] },
    { id: "store-outbox", name: "Outbox", spec: "PENDING → DISPATCHED to the GPU queue", group: "k3s", tone: "store", live: "exporter",
      shape: { kind: "cyl", r: 0.25, h: 0.13 }, at: [-0.45, 2.02, 0.35], out: [-1.5, 4.1, 1.0],
      detail: ["Written before a job is sent to the GPU queue, so a crash between the two can be replayed when the worker restarts."] },
    { id: "autoscaler", name: "Cluster Autoscaler", spec: "GPU group 0–1 · removes it after 2 min", group: "k3s", tone: "module", live: "observed", key: true,
      shape: { kind: "box", size: [0.3, 0.3, 0.3] }, at: [0.45, 1.85, 0.4], out: [1.5, 3.65, 1.0], active: (w) => w.asg.desired,
      detail: ["Sees the model server waiting with nowhere to run and sets the GPU group to 1.", "Can scale from zero because the group carries a template: 4 CPU, 16 GiB, 1 GPU."] },
    { id: "keda", name: "KEDA", spec: "Polls the GPU queue every 15 s · cooldown 120 s", group: "k3s", tone: "module", live: "exporter", key: true,
      shape: { kind: "box", size: [0.2, 0.35, 0.2] }, at: [0.05, 1.85, 0.45], out: [0.3, 3.7, 1.6], active: (w) => w.keda.replicas,
      detail: ["Asks for one model server as soon as one message waits (in-flight messages count too), and for none after two quiet minutes."] },

    // Pods: the top layer.
    { id: "pod-plate", name: "Infra namespace", spec: "", group: "pods", tone: "board", live: "inferred",
      shape: { kind: "box", size: [1.8, 0.05, 1.8] }, at: [0, 2.35, 0], out: [0, 4.85, 0], active: podsUp },
    { id: "orchestrator", name: "Orchestrator", spec: "FastAPI · job intake and status", group: "pods", tone: "module", live: "inferred", key: true,
      shape: { kind: "box", size: [0.45, 0.42, 0.5] }, at: [-0.6, 2.6, -0.35], out: [-1.7, 5.15, -0.7], active: podsUp,
      detail: ["Checks for a repeated request, records the job, stores the payload, then queues it.", "Reports queue depths and whether the model gateway is cold, starting or ready."] },
    { id: "worker", name: "AI worker", spec: "Two loops side by side", group: "pods", tone: "module", live: "inferred", key: true,
      shape: { kind: "box", size: [0.5, 0.42, 0.5] }, at: [0, 2.6, -0.35], out: [0, 5.15, -1.0], active: (w) => Math.max(podsUp(w) * 0.4, busy(jobsAt(w, "worker", "laya", "core"))),
      detail: ["Takes one message at a time from each queue and extends its hold every 30 s while it waits on the model.", "Deletes a message only after the result is saved, so a crash never loses a job."] },
    { id: "loop-cpu", name: "CPU loop", spec: "Validate → decide → dispatch", group: "pods", tone: "glass", live: "exporter",
      shape: { kind: "ring", r: 0.12, tube: 0.025 }, at: [-0.1, 2.6, -0.35], out: [-0.45, 5.85, -1.0], active: (w) => busy(jobsAt(w, "worker", "laya")),
      detail: ["Steps: VALIDATING → DECIDING → WAITING_GPU.", "Decision-only jobs finish here on CPU; jobs scoring under 0.35 are rejected and the GPU never wakes."] },
    { id: "loop-gpu", name: "GPU loop", spec: "Generate → verify → save", group: "pods", tone: "glass", live: "exporter",
      shape: { kind: "ring", r: 0.12, tube: 0.025 }, at: [0.1, 2.6, -0.35], out: [0.45, 5.85, -1.0], active: (w) => busy(jobsAt(w, "core")),
      detail: ["Steps: GENERATING → VERIFYING, at most twice, then COMPLETED or NEEDS_REVIEW."] },
    { id: "litellm", name: "LiteLLM gateway", spec: "5 model aliases → one served model", group: "pods", tone: "module", live: "inferred", key: true,
      shape: { kind: "box", size: [0.45, 0.42, 0.5] }, at: [0.6, 2.6, -0.35], out: [1.7, 5.15, -0.7], active: podsUp,
      detail: ["fast, reasoning, coding, writing and agent all route to qwen-general on the GPU.", "Two retries, 120 s timeout per request."] },
    { id: "laya", name: "LAYA", spec: "ModernBERT on CPU · gate 0.35 · verify 0.40", group: "pods", tone: "module", live: "exporter", key: true,
      shape: { kind: "box", size: [0.5, 0.35, 0.4] }, at: [-0.3, 2.58, 0.4], out: [-0.9, 5.1, 1.1], active: (w) => busy(jobsAt(w, "laya")),
      detail: ["About 421M parameters, one forward pass, two CPU threads, around 35–50 ms per decision.", "Fails open at the gate (the job proceeds) and closed at verification (needs review)."] },
  ],
};

// ---- GPU cassette ------------------------------------------------------------------------

const cassette: Assembly = {
  id: "gpuNode",
  code: "GPU-1",
  title: "GPU cassette",
  subtitle: "EC2 Auto Scaling group · g5.xlarge · On-Demand",
  frame: 0.92,
  status: gpuStatus,
  readouts: (w) => [
    { label: "Instance", value: gpuStatus(w).text, tone: gpuStatus(w).tone },
    { label: "GPU group", value: `${w.asg.desired} of max 1` },
    { label: "Joined the cluster", value: w.gpu.joined ? "Yes" : "No" },
    { label: "Model drive", value: w.gpu.ebsAttached ? "Docked" : "Detached", tone: w.gpu.ebsAttached ? "on" : "off" },
    { label: "Model server", value: w.vllm.state === "absent" ? "Absent" : w.vllm.state[0].toUpperCase() + w.vllm.state.slice(1), tone: w.vllm.confidence === "inferred" ? "inferred" : undefined },
    { label: "GPU queue", value: depth(w, "gpu") },
  ],
  groups: [
    { id: "chassis", name: "Chassis", spec: "Sled, cover, bezel", status: gpuStatus },
    { id: "boot", name: "Boot sequence", spec: "Six steps from launch to node", status: (w) => (w.gpu.joined ? { text: "Joined", tone: "on" } : gpuStatus(w)) },
    { id: "compute", name: "Compute", spec: "A10G 24 GB · 4 vCPU · 16 GiB", status: gpuStatus },
    { id: "storage", name: "Storage", spec: "NVMe 250 GB · root 80 GB · model drive 50 GB", status: (w) => (w.gpu.ebsAttached ? { text: "Drive docked", tone: "on" } : { text: "Drive detached", tone: "off" }) },
    { id: "serving", name: "Model serving", spec: "vLLM · Qwen3-30B-A3B", status: exporter },
  ],
  parts: [
    { id: "tray", name: "Sled", spec: "", group: "chassis", tone: "board", live: "static",
      shape: { kind: "box", size: [2.4, 0.08, 1.6] }, at: [0, 0.04, 0], out: [0, 0.04, 0] },
    { id: "cover", name: "Top cover", spec: "", group: "chassis", tone: "shell", live: "static",
      shape: { kind: "box", size: [2.4, 0.06, 1.6] }, at: [0, 1.0, 0], out: [0, 4.4, 0] },
    { id: "side", name: "Side panel", spec: "", group: "chassis", tone: "shell", live: "static",
      shape: { kind: "box", size: [0.06, 0.92, 1.6] }, at: [-1.2, 0.52, 0], out: [-3.6, 0.52, 0] },
    { id: "back", name: "Back panel", spec: "", group: "chassis", tone: "shell", live: "static",
      shape: { kind: "box", size: [2.4, 0.92, 0.06] }, at: [0, 0.52, -0.8], out: [0, 0.52, -3.0] },
    { id: "bezel", name: "Front bezel", spec: "Boot lamps", group: "chassis", tone: "shell", live: "observed",
      shape: { kind: "box", size: [2.4, 0.92, 0.06] }, at: [0, 0.52, 0.8], out: [0, 0.52, 3.2] },

    ...(
      [
        ["Read metadata", "Instance identity, AWS CLI"],
        ["Attach model drive", "Finds it by tag · never creates one"],
        ["Mount it", "ext4 · formatted only if blank"],
        ["Check GPU driver", "nvidia-smi"],
        ["GPU container runtime", "NVIDIA toolkit for containerd"],
        ["Join K3s", "Tainted so only GPU work lands here"],
      ] as const
    ).map(([name, spec], i): PartDef => ({
      id: `boot-${i + 1}`,
      name: `${i + 1} · ${name}`,
      spec,
      group: "boot",
      tone: "glass",
      live: "inferred",
      shape: { kind: "box", size: [0.14, 0.1, 0.05] },
      at: [-0.95 + i * 0.18, 0.78, 0.85],
      out: [-1.9 + i * 0.62, 1.7, 3.5],
      // Lamps fill in order while the node starts; all lit once it has joined.
      active: (w) => (w.gpu.joined ? 1 : w.gpu.state === "launching" ? (i < 2 ? 1 : 0.3) : w.gpu.state === "running" ? (i < 5 ? 1 : 0.4) : 0),
      key: i === 0 || i === 5,
    })),

    { id: "gpu-board", name: "Mainboard", spec: "", group: "compute", tone: "board", live: "static",
      shape: { kind: "box", size: [2.2, 0.04, 1.4] }, at: [0, 0.12, 0], out: [0, 0.3, 0] },
    { id: "a10g", name: "NVIDIA A10G", spec: "24 GB VRAM · Tensor Cores", group: "compute", tone: "module", live: "observed", key: true,
      shape: { kind: "box", size: [1.2, 0.22, 0.9] }, at: [-0.35, 0.45, -0.1], out: [-0.7, 2.3, -0.4], active: gpuUp,
      detail: ["One GPU. The model server may use 90% of its memory; only one 30B model fits at a time."] },
    { id: "fan-a", name: "Cooling", spec: "", group: "compute", tone: "chip", live: "static",
      shape: { kind: "cyl", r: 0.17, h: 0.04 }, at: [-0.65, 0.58, -0.1], out: [-1.0, 2.75, -0.4], active: gpuUp },
    { id: "fan-b", name: "Cooling", spec: "", group: "compute", tone: "chip", live: "static",
      shape: { kind: "cyl", r: 0.17, h: 0.04 }, at: [-0.05, 0.58, -0.1], out: [-0.4, 2.75, -0.4], active: gpuUp },
    { id: "epyc", name: "vCPU ×4", spec: "AMD EPYC 7R32", group: "compute", tone: "chip", live: "observed", key: true,
      shape: { kind: "box", size: [0.4, 0.06, 0.4] }, at: [0.55, 0.18, -0.3], out: [1.0, 1.4, -0.9], active: gpuUp },
    { id: "dimm-a", name: "Memory 16 GiB", spec: "", group: "compute", tone: "chip", live: "static", key: true,
      shape: { kind: "box", size: [0.06, 0.25, 0.7] }, at: [0.85, 0.27, -0.25], out: [1.7, 1.5, -0.6] },
    { id: "dimm-b", name: "Memory", spec: "", group: "compute", tone: "chip", live: "static",
      shape: { kind: "box", size: [0.06, 0.25, 0.7] }, at: [0.98, 0.27, -0.25], out: [1.95, 1.5, -0.6] },
    { id: "device-plugin", name: "Device plugin", spec: "Tells Kubernetes the GPU exists", group: "compute", tone: "module", live: "exporter",
      shape: { kind: "box", size: [0.25, 0.15, 0.25] }, at: [-1.0, 0.2, 0.5], out: [-2.4, 1.3, 1.2] },

    { id: "nvme", name: "Local NVMe", spec: "250 GB · container images · lost on stop", group: "storage", tone: "store", live: "static", key: true,
      shape: { kind: "box", size: [0.35, 0.03, 0.12] }, at: [0.55, 0.16, 0.45], out: [1.1, 1.0, 1.4] },
    { id: "gpu-root", name: "Root disk", spec: "80 GB gp3 · deleted with the node", group: "storage", tone: "store", live: "static", key: true,
      shape: { kind: "box", size: [0.4, 0.12, 0.3] }, at: [0.95, 0.2, 0.45], out: [2.2, 0.8, 1.2] },
    { id: "drive", name: "Model drive", spec: "EBS gp3 50 GB · 3,000 IOPS · 125 MiB/s", group: "storage", tone: "store", live: "observed", key: true,
      shape: { kind: "box", size: [0.6, 0.7, 1.2] }, at: [1.55, 0.4, 0], out: [3.8, 0.5, 0], active: (w) => (w.gpu.ebsAttached ? 1 : 0),
      detail: ["Kept between GPU visits so a new machine does not download 18 GB every time.", "Lives in the second Availability Zone, which is why the GPU is pinned there."] },
    ...[0, 1, 2, 3].map((i): PartDef => ({
      id: `shard-${i + 1}`,
      name: "qwen-general",
      spec: "4 weight shards · ~18 GB · 35% of the drive",
      group: "storage",
      tone: "chip",
      live: "observed",
      shape: { kind: "box", size: [0.08, 0.4, 0.16] },
      at: [1.55, 0.4, 0.38 - i * 0.2],
      out: [3.8, 2.0, 0.6 - i * 0.28],
      active: (w) => (w.vllm.state === "loading" || w.vllm.state === "ready" ? 1 : 0),
      key: i === 0,
    })),
    { id: "coder-slot", name: "qwen-coder slot", spec: "Reserved · not served", group: "storage", tone: "glass", live: "static", key: true,
      shape: { kind: "box", size: [0.08, 0.4, 0.36] }, at: [1.55, 0.4, -0.38], out: [3.8, 2.0, -0.85],
      detail: ["The folder exists on the drive but the coder model is not served; the coding alias points at qwen-general."] },

    { id: "vllm", name: "vLLM", spec: "Qwen3-30B-A3B · AWQ 4-bit · 8,192 ctx · 4 at once", group: "serving", tone: "glass", live: "exporter", key: true,
      shape: { kind: "ball", r: 0.2 }, at: [-0.35, 0.45, -0.1], out: [-0.7, 3.7, -0.4], active: vllmLevel,
      detail: ["Scaled between 0 and 1 replicas by KEDA. Loading the model takes 60–90 s.", "A mixture-of-experts model: about 3B of its 30B parameters work on each token."] },
  ],
};

export const ASSEMBLIES: Partial<Record<ObjectId, Assembly>> = {
  controlPlane: tower,
  gpuNode: cassette,
};

export const LIVE_LABEL: Record<Live, string> = {
  observed: "Observed",
  inferred: "Inferred",
  exporter: "Not observed",
  static: "Static",
};
