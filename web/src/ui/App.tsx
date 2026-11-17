import { useEffect, useMemo, useState } from "react";
import { World } from "../scene/World";
import { useTwin } from "../store";
import { Inspector } from "./Inspector";
import { Ledger } from "./Ledger";
import { EventLog } from "./EventLog";
import { ObjectNav } from "./ObjectNav";
import { ReplayBar } from "./ReplayBar";
import { StatusLine } from "./StatusLine";

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function useTicker() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (!document.hidden) useTwin.getState().tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const s = useTwin.getState();
      if (e.key === " " && s.mode === "replay") {
        e.preventDefault();
        s.setPlaying(!s.playing);
      } else if (e.key === "ArrowRight" && s.mode === "replay") s.step(1);
      else if (e.key === "ArrowLeft" && s.mode === "replay") s.step(-1);
      else if (e.key === "Escape") s.select(null);
      else if (e.key === "1") s.setMode("live");
      else if (e.key === "2") s.setMode("replay");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  useTicker();
  useKeyboard();
  const webgl = useMemo(hasWebGL, []);
  const mode = useTwin((s) => s.mode);
  const setMode = useTwin((s) => s.setMode);
  const labels = useTwin((s) => s.labels);
  const setLabels = useTwin((s) => s.setLabels);
  const [logOpen, setLogOpen] = useState(false);

  return (
    <div className="app">
      <div className="stage">
        {webgl ? (
          <World />
        ) : (
          <div className="no-webgl">
            <p>This browser can't show the 3D view. The event log below still follows the run.</p>
          </div>
        )}
      </div>

      <header className="top">
        <div className="brand">
          <h1>Sleepless Twin</h1>
          <p>A scale-to-zero AI platform on AWS, as a living model</p>
        </div>
        <div className="top-actions">
          <div className="seg" role="tablist" aria-label="Mode">
            <button role="tab" aria-selected={mode === "live"} className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>
              Live
            </button>
            <button role="tab" aria-selected={mode === "replay"} className={mode === "replay" ? "on" : ""} onClick={() => setMode("replay")}>
              Replay
            </button>
          </div>
          <button className="ghost" aria-pressed={labels} onClick={() => setLabels(!labels)}>
            {labels ? "Hide labels" : "Show labels"}
          </button>
          <button className="ghost" aria-pressed={logOpen} onClick={() => setLogOpen(!logOpen)}>
            Event log
          </button>
        </div>
      </header>

      <StatusLine />
      <ObjectNav />
      <Inspector />
      <Ledger />
      {mode === "replay" && <ReplayBar />}
      {(logOpen || !webgl) && <EventLog onClose={webgl ? () => setLogOpen(false) : undefined} />}
    </div>
  );
}
