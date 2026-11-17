import type { ObjectId } from "../content/components";
import type { WorldState } from "../model/state";
import { CONFIG } from "../model/timings";
import { duration } from "./format";

const count = (w: WorldState, loc: string) => Object.values(w.jobs).filter((j) => j.location === loc).length;
const inferred = (yes: boolean) => (yes ? " (inferred)" : "");

/** One-line live state for the inspector, in plain words. */
export function describe(id: ObjectId, w: WorldState): string {
  const since = (ms: number) => duration(Math.max(0, w.t - ms));
  switch (id) {
    case "clock":
      return `Next run at ${CONFIG.prewarmUtc} UTC.`;
    case "gateway":
    case "lambda":
    case "guard":
    case "s3":
    case "ssm":
    case "vpc":
    case "modelVolume":
      if (id === "guard") return w.guardLocked ? "Locked: GPU launches are suspended." : "Open: GPU launches allowed.";
      if (id === "modelVolume") return w.gpu.ebsAttached ? "Attached to the GPU machine." : "Parked, waiting for a GPU machine.";
      if (id === "ssm") return w.ssmOpen ? "A session is open." : "No session open.";
      return "Always on. Costs nothing while idle.";
    case "workflowQueue":
      return `${count(w, "workflow")} waiting.`;
    case "gpuQueue": {
      const n = count(w, "gpuQueue");
      const held = Object.values(w.jobs).filter((j) => j.location === "gpuQueue" && j.inFlight).length;
      return `${n} waiting${held ? `, ${held} held by the worker` : ""}.`;
    }
    case "workflowDlq":
      return `${count(w, "workflowDlq")} dead-lettered.`;
    case "gpuDlq":
      return `${count(w, "gpuDlq")} dead-lettered.`;
    case "keda":
      return w.keda.replicas ? `Asking for 1 model server for ${since(w.keda.since)}${inferred(true)}.` : "Asking for none.";
    case "controlPlane":
      if (w.cp.state === "stopped") return `Stopped for ${since(w.cp.since)}.`;
      if (w.cp.state === "pending") return `Starting (${since(w.cp.since)}).`;
      if (w.cp.state === "stopping") return "Shutting down.";
      return `Running for ${since(w.cp.since)}.`;
    case "pods":
      return w.cp.podsReady ? `Ready${inferred(w.cp.podsConfidence === "inferred")}.` : "Not running.";
    case "laya": {
      const j = Object.values(w.jobs).find((x) => x.location === "laya");
      if (!j) return w.cp.podsReady ? "Idle." : "Not running.";
      return j.step === "verifying" ? `Checking an answer: ${j.verifyPassed ? "pass" : "fail"}.` : `Triaging a job: ${j.gate}.`;
    }
    case "watchdog":
      if (w.cp.state !== "running") return "Not running.";
      return w.watchdogIdleSince !== undefined ? `Quiet for ${since(w.watchdogIdleSince)} of 30 min.` : "Platform busy; timer reset.";
    case "autoscaler":
      return w.asg.desired ? "Holding one GPU machine." : "No GPU machine requested.";
    case "gpuNode": {
      const m = w.gpu.market === "spot" ? "Spot" : "On-Demand";
      if (w.gpu.state === "none") return "No machine. $0.00/h.";
      if (w.gpu.state === "launching") return `Launching (${m}).`;
      if (w.gpu.state === "terminating") return "Shutting down.";
      if (w.gpu.state === "launch_failed") return "Launch failed: no capacity.";
      return `Running (${m}) for ${since(w.gpu.since)}.`;
    }
    case "vllm":
      if (w.vllm.state === "ready") {
        const busy = Object.values(w.jobs).some((j) => j.location === "core");
        return `${busy ? "Generating" : "Ready, idle"}${inferred(w.vllm.confidence === "inferred")}.`;
      }
      if (w.vllm.state === "loading") return `Loading qwen-general${inferred(true)}.`;
      if (w.vllm.state === "pending") return "Waiting for a GPU machine.";
      return "Not running.";
  }
}
