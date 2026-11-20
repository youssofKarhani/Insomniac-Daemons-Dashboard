import { useEffect, useMemo, useRef, useState } from "react";
import { DATA_URL, LIVE_POLL_MS } from "../data/remote";
import { World } from "../scene/World";
import { useTwin } from "../store";
import { Inspector } from "./Inspector";
import { Ledger } from "./Ledger";
import { EventLog } from "./EventLog";
import { ObjectNav } from "./ObjectNav";
import { ReplayBar } from "./ReplayBar";
import { StatusLine } from "./StatusLine";
import { Tour } from "./Tour";
import { Schematic } from "./Schematic";
import { TOUR } from "../content/tour";

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

/** Polls the public telemetry while the tab is visible. Does nothing without VITE_TWIN_DATA_URL. */
function useTelemetry() {
  useEffect(() => {
    if (!DATA_URL) return;
    const s = useTwin.getState();
    s.refreshLive();
    s.refreshRuns();
    s.refreshCosts();
    const every = (ms: number, fn: () => void) =>
      window.setInterval(() => {
        if (!document.hidden) fn();
      }, ms);
    const timers = [
      every(LIVE_POLL_MS, () => useTwin.getState().refreshLive()),
      every(60_000, () => useTwin.getState().refreshRuns()),
      every(30 * 60_000, () => useTwin.getState().refreshCosts()),
    ];
    const onVisible = () => {
      if (!document.hidden) useTwin.getState().refreshLive();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      timers.forEach((t) => window.clearInterval(t));
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/**
 * Publishes the height of the header and status line as --chrome-h on the app, so panels
 * below them start under them however many rows they wrap to.
 */
function useChromeHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const app = el?.parentElement;
    if (!el || !app || typeof ResizeObserver === "undefined") return;
    const set = () => app.style.setProperty("--chrome-h", `${Math.ceil(el.getBoundingClientRect().bottom)}px`);
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => ro.disconnect();
  }, []);
  return ref;
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const s = useTwin.getState();
      if (s.tour !== null) {
        // During the tour the arrows move between stops; Escape leaves it.
        if (e.key === "ArrowRight" && s.tour < TOUR.length - 1) s.tourGo(s.tour + 1);
        else if (e.key === "ArrowLeft" && s.tour > 0) s.tourGo(s.tour - 1);
        else if (e.key === "Escape") s.endTour();
        else if (e.key === "1") s.setMode("live");
        else if (e.key === "2") s.setMode("replay");
        return;
      }
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
  useTelemetry();
  useKeyboard();
  const webgl = useMemo(hasWebGL, []);
  const mode = useTwin((s) => s.mode);
  const setMode = useTwin((s) => s.setMode);
  const labels = useTwin((s) => s.labels);
  const setLabels = useTwin((s) => s.setLabels);
  const [logOpen, setLogOpen] = useState(false);
  const touring = useTwin((s) => s.tour !== null);
  const chosenView = useTwin((s) => s.view);
  const setView = useTwin((s) => s.setView);
  // Without WebGL the schematic is the only view.
  const view = webgl ? chosenView : "2d";
  const hasSelection = useTwin((s) => s.selected !== null);
  const chromeRef = useChromeHeight();
  const startTour = useTwin((s) => s.startTour);
  const tourPanel = useTwin((s) => (s.tour !== null ? TOUR[s.tour].panel : undefined));

  return (
    <div className={`app view-${view}${hasSelection ? " has-selection" : ""}${touring ? " touring" : ""}${tourPanel ? ` touring-${tourPanel}` : ""}`}>
      <div className="stage">
        {view === "3d" ? <World /> : <Schematic />}
      </div>

      <div className="chrome" ref={chromeRef}>
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
          <button className="ghost" aria-pressed={touring} onClick={startTour} disabled={touring}>
            <span className="wide-only">Guided tour</span>
            <span className="narrow-only">Tour</span>
          </button>
          {webgl && (
            <button
              className="ghost"
              onClick={() => setView(view === "3d" ? "2d" : "3d")}
              aria-label={view === "3d" ? "Switch to the 2D schematic" : "Switch to the 3D desk"}
              title={view === "3d" ? "Switch to the 2D schematic" : "Switch to the 3D desk"}
            >
              {view === "3d" ? "2D" : "3D"}
            </button>
          )}
          {view === "3d" && (
            <button className="ghost labels-toggle" aria-pressed={labels} onClick={() => setLabels(!labels)}>
              <span className="wide-only">{labels ? "Hide labels" : "Show labels"}</span>
              <span className="narrow-only">Labels</span>
            </button>
          )}
          <button className="ghost" aria-pressed={logOpen} onClick={() => setLogOpen(!logOpen)}>
            <span className="wide-only">Event log</span>
            <span className="narrow-only">Log</span>
          </button>
        </div>
      </header>

      <StatusLine />
      </div>
      <ObjectNav />
      <Inspector />
      <Ledger />
      {touring ? <Tour /> : mode === "replay" && <ReplayBar />}
      {logOpen && <EventLog onClose={() => setLogOpen(false)} />}
    </div>
  );
}
