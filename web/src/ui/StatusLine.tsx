import { useShallow } from "zustand/react/shallow";
import { SCENARIOS } from "../data/scenarios";
import { SAMPLE_RATES_USD_PER_HOUR as RATE } from "../model/timings";
import { useTwin } from "../store";
import { duration } from "./format";

export function StatusLine() {
  const mode = useTwin((s) => s.mode);
  const scenarioId = useTwin((s) => s.scenarioId);
  const loadScenario = useTwin((s) => s.loadScenario);
  const status = useTwin(useShallow((s) => {
    const w = s.world;
    const active = Object.values(w.jobs).filter((j) => j.step !== "done").length;
    if (w.cp.state === "stopped") return { tone: "sleep", text: `Asleep${w.cp.since > s.timeline.srcStart ? ` for ${duration(w.t - w.cp.since)}` : ""}` };
    if (w.cp.state === "pending") return { tone: "wake", text: "Waking up" };
    if (w.cp.state === "stopping") return { tone: "wake", text: "Going to sleep" };
    const gpu =
      w.gpu.state === "none" ? "GPU off" : w.vllm.state === "ready" ? "GPU ready" : w.gpu.state === "running" ? "GPU starting" : `GPU ${w.gpu.state}`;
    return { tone: "awake", text: `Awake · ${active} job${active === 1 ? "" : "s"} in progress · ${gpu}` };
  }));
  const rate = useTwin((s) => {
    const w = s.world;
    const gpuOn = w.gpu.state !== "none" && w.gpu.state !== "launch_failed";
    return ((gpuOn ? RATE.gpu : 0) + (w.cp.state !== "stopped" ? RATE.controlPlane : 0)).toFixed(2);
  });
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);

  return (
    <div className="status" role="status">
      <span className={`chip ${status.tone}`}>{status.text}</span>
      <span className="chip rate mobile-only">${rate}/h</span>
      {mode === "live" ? (
        <span className="status-note">
          Not connected to AWS yet. This is where the last sample run ended.
          <button className="link" onClick={() => loadScenario(scenarioId)}>
            Watch a sample run
          </button>
        </span>
      ) : (
        <span className="status-note">
          <span className="sample">Sample</span> {scenario?.title}
        </span>
      )}
    </div>
  );
}
