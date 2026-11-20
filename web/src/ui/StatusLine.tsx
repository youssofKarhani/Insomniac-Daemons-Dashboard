import { useShallow } from "zustand/react/shallow";
import { STALE_AFTER_MS } from "../data/remote";
import { SCENARIOS } from "../data/scenarios";
import { currentWorld, useTwin, sourceKey } from "../store";
import { useRates } from "./rates";
import { dateUtc, duration } from "./format";

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : `${duration(s * 1000)} ago`;
}

export function StatusLine() {
  const mode = useTwin((s) => s.mode);
  const source = useTwin((s) => s.source);
  const live = useTwin((s) => s.live);
  const recordedRunCount = useTwin((s) => s.recorded.length);
  const loadSource = useTwin((s) => s.loadSource);
  const status = useTwin(
    useShallow((s) => {
      const w = currentWorld(s);
      const active = Object.values(w.jobs).filter((j) => j.step !== "done").length;
      const queued = Object.values(w.queueDepth).reduce((n, q) => n + q.visible + q.inFlight, 0) - w.queueDepth.workflowDlq.visible - w.queueDepth.gpuDlq.visible;
      const work = Math.max(active, queued);
      if (w.cp.state === "stopped") {
        return { tone: "sleep", text: w.cp.since > 0 && w.t - w.cp.since < 30 * 86_400_000 && w.cp.since > s.timeline.srcStart ? `Asleep for ${duration(w.t - w.cp.since)}` : "Asleep" };
      }
      if (w.cp.state === "pending") return { tone: "wake", text: "Waking up" };
      if (w.cp.state === "stopping") return { tone: "wake", text: "Going to sleep" };
      const gpu =
        w.gpu.state === "none" ? "GPU off" : w.vllm.state === "ready" ? "GPU ready" : w.gpu.state === "running" ? "GPU running" : `GPU ${w.gpu.state.replace("_", " ")}`;
      return { tone: "awake", text: `Awake · ${work} job${work === 1 ? "" : "s"} in progress · ${gpu}` };
    }),
  );
  // Only once an exporter has ever reported: then silence while the tower runs means job detail is missing.
  const towerRunning = useTwin((s) => s.world.cp.state === "running");
  const exporterSilent =
    mode === "live" && towerRunning && live.exporterAt !== undefined && live.generatedAt !== undefined && live.generatedAt - live.exporterAt > STALE_AFTER_MS;
  const rate = useRates().nowPerHour;
  const scenario = SCENARIOS.find((s) => s.id === source.id);
  // Re-render once a second for the "updated … ago" text.
  useTwin((s) => (s.mode === "live" ? Math.floor(s.now / 1000) : 0));

  let note: React.ReactNode;
  if (mode === "replay") {
    note =
      source.kind === "run" ? (
        <span className="status-note">
          <span className="recorded">Recorded</span> run of {dateUtc(source.start)}
        </span>
      ) : (
        <span className="status-note">
          <span className="sample">Sample</span> {scenario?.title}
        </span>
      );
  } else if (live.status === "off") {
    note = (
      <span className="status-note">
        Not connected to AWS yet. This is where the last sample run ended.
        <button className="link" onClick={() => loadSource(sourceKey(source))}>
          Watch a sample run
        </button>
      </span>
    );
  } else if (live.status === "connecting") {
    note = <span className="status-note">Connecting to telemetry…</span>;
  } else if (live.status === "error") {
    note = <span className="status-note warn">Telemetry unreachable. Showing the last state received.</span>;
  } else {
    const updated = live.generatedAt ? ago(Date.now() - live.generatedAt) : "";
    note = (
      <span className={`status-note${live.status === "stale" ? " warn" : ""}`}>
        {live.status === "stale" ? `Telemetry stale: last update ${updated}.` : `Live from AWS · updated ${updated}`}
        {exporterSilent && live.status !== "stale" && <span className="warn"> · Job detail unavailable</span>}
        {live.run && !live.run.open && recordedRunCount > 0 && (
          <button className="link" onClick={() => loadSource(`run:${live.run!.id}`)}>
            Replay the last run
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="status" role="status">
      <span className={`chip ${live.status === "stale" && mode === "live" ? "stale" : status.tone}`}>{status.text}</span>
      <span className="chip rate mobile-only">${rate.toFixed(2)}/h</span>
      {note}
    </div>
  );
}
