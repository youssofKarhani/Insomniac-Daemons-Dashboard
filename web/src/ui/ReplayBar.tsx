import { useEffect, useMemo, useRef } from "react";
import { caption } from "../content/captions";
import { SCENARIOS } from "../data/scenarios";
import type { EventKind } from "../model/events";
import { srcToPlay } from "../model/replay";
import type { RunSummary } from "../data/remote";
import { sourceKey, useTwin } from "../store";
import { clockUtc, dateUtc, duration } from "./format";

function runLabel(r: RunSummary): string {
  const gpu = r.gpuLaunches > 0 ? `GPU ${duration(r.gpuSeconds * 1000)}` : "CPU only";
  return `${dateUtc(r.start)} ${clockUtc(r.start).slice(0, 5)} · ${gpu}`;
}

const SPEEDS = [1, 4, 15, 60];

function tone(kind: EventKind): string {
  if (kind.startsWith("gpu") || kind.startsWith("vllm") || kind === "keda.scale" || kind === "asg.desired" || kind === "node.joined" || kind === "ebs.attached")
    return "violet";
  if (kind === "job.failed" || kind === "job.dlq" || kind === "spot.warning" || kind === "guard.latch") return "amber";
  if (kind.startsWith("laya") || kind.startsWith("job")) return "aqua";
  return "lav";
}

/**
 * Playhead, scrubber and clock change every frame, so they write to the DOM directly from a
 * store subscription instead of re-rendering the bar. The playhead moves with a transform.
 */
function useFrameWriter(write: (s: ReturnType<typeof useTwin.getState>) => void) {
  const fn = useRef(write);
  fn.current = write;
  useEffect(() => {
    fn.current(useTwin.getState());
    return useTwin.subscribe((s) => fn.current(s));
  }, []);
}

function ClockText() {
  const el = useRef<HTMLSpanElement>(null);
  const last = useRef("");
  useFrameWriter((s) => {
    const text = `${dateUtc(s.now)} · ${clockUtc(s.now)} UTC`;
    if (el.current && text !== last.current) {
      el.current.textContent = text;
      last.current = text;
    }
  });
  return <span className="clock" title="Source time (UTC)" ref={el} />;
}

function Scrubber({ total }: { total: number }) {
  const head = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { setPlaying, seek } = useTwin.getState();
  useFrameWriter((s) => {
    const pct = Math.max(0, Math.min(100, (s.play / (s.timeline.playDuration || 1)) * 100));
    if (head.current) head.current.style.transform = `translateX(${pct}%)`;
    if (input.current && document.activeElement !== input.current) input.current.value = String(s.play);
  });
  return (
    <>
      <span className="head-track" ref={head} aria-hidden="true">
        <span className="head" />
      </span>
      <label className="visually-hidden" htmlFor="scrub">
        Playhead
      </label>
      <input
        id="scrub"
        ref={input}
        type="range"
        min={0}
        max={total}
        step={10}
        defaultValue={0}
        onChange={(e) => {
          setPlaying(false);
          seek(Number(e.target.value));
        }}
      />
    </>
  );
}

export function ReplayBar() {
  const timeline = useTwin((s) => s.timeline);
  const playing = useTwin((s) => s.playing);
  const speed = useTwin((s) => s.speed);
  const source = useTwin((s) => s.source);
  const recorded = useTwin((s) => s.recorded);
  const loading = useTwin((s) => s.loading);
  const last = useTwin((s) => s.history[s.history.length - 1]);
  const { setPlaying, setSpeed, step, loadSource } = useTwin.getState();

  const total = timeline.playDuration || 1;
  const ticks = useMemo(
    () => timeline.events.map((e) => ({ id: e.id, left: (srcToPlay(timeline, e.ts) / total) * 100, tone: tone(e.kind), inferred: e.confidence === "inferred" })),
    [timeline, total],
  );
  const breaks = useMemo(
    () => timeline.segments.filter((s) => s.compressed).map((s) => ({ left: (s.playStart / total) * 100, width: ((s.playEnd - s.playStart) / total) * 100, real: s.srcEnd - s.srcStart })),
    [timeline, total],
  );

  return (
    <section className="panel replay" aria-label="Replay controls">
      <p className="caption" aria-live="polite">
        {last ? caption(last) : "Press play to start the run."}
        {last?.confidence === "inferred" && <span className="tag-inferred">inferred</span>}
      </p>
      <div className="replay-row">
        <label className="visually-hidden" htmlFor="scenario">
          Run to replay
        </label>
        <select id="scenario" value={sourceKey(source)} onChange={(e) => loadSource(e.target.value)} disabled={loading}>
          {recorded.length > 0 && (
            <optgroup label="Recorded runs">
              {recorded.map((r) => (
                <option key={r.id} value={`run:${r.id}`}>
                  {runLabel(r)}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Samples">
            {SCENARIOS.map((s) => (
              <option key={s.id} value={`sample:${s.id}`}>
                {s.title}
              </option>
            ))}
          </optgroup>
        </select>
        <div className="transport">
          <button className="icon" onClick={() => step(-1)} aria-label="Previous event">
            ⏮
          </button>
          <button className="icon primary" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button className="icon" onClick={() => step(1)} aria-label="Next event">
            ⏭
          </button>
        </div>
        <div className="seg small" role="group" aria-label="Speed">
          {SPEEDS.map((sp) => (
            <button key={sp} className={sp === speed ? "on" : ""} aria-pressed={sp === speed} onClick={() => setSpeed(sp)}>
              {sp}×
            </button>
          ))}
        </div>
        <ClockText />
      </div>
      <div className="track">
        {breaks.map((b, i) => (
          <span key={i} className="break" style={{ left: `${b.left}%`, width: `${b.width}%` }} title={`${Math.round(b.real / 1000)} s compressed`} />
        ))}
        {ticks.map((t) => (
          <span key={t.id} className={`tick ${t.tone}${t.inferred ? " inferred" : ""}`} style={{ left: `${t.left}%` }} />
        ))}
        <Scrubber total={total} />
      </div>
      <p className="legend muted small">
        Hatched stretches are long waits shown faster than real time. Pale markers are inferred, not observed.
      </p>
    </section>
  );
}
