import { useEffect, useRef, useState } from "react";
import { ASSEMBLIES, LIVE_LABEL, type Assembly, type StatusTone } from "../content/assemblies";
import { currentWorld, useDashboard } from "../store";
import { leaderEls, TeardownCanvas } from "./scene";
import { motion, SEQ_TOTAL, useTeardown } from "./store";
import "./teardown.css";

/** Selects a value derived from the world as a string, so the HUD re-renders only when it changes. */
function useWorldJson<T>(fn: (w: ReturnType<typeof currentWorld>) => T): T {
  const json = useDashboard((s) => JSON.stringify(fn(currentWorld(s))));
  return JSON.parse(json) as T;
}

function Chip({ tone, children }: { tone: StatusTone; children: string }) {
  return <span className={`td-chip tone-${tone}`}>{children}</span>;
}

/** Leader labels: positioned every frame by the scene, so React renders them once. */
function LabelLayer({ assembly }: { assembly: Assembly }) {
  const set = useTeardown((s) => s.set);
  return (
    <>
      <svg className="td-leaders" aria-hidden="true">
        {assembly.parts.map((p) => (
          <g key={p.id}>
            <polyline
              ref={(el) => {
                const cur = leaderEls.get(p.id);
                if (el) leaderEls.set(p.id, { ...(cur as object), line: el } as never);
              }}
              className={`live-${p.live}`}
              style={{ opacity: 0 }}
            />
            <circle
              r={3}
              ref={(el) => {
                const cur = leaderEls.get(p.id);
                if (el) leaderEls.set(p.id, { ...(cur as object), dot: el } as never);
              }}
              style={{ opacity: 0 }}
            />
          </g>
        ))}
      </svg>
      {assembly.parts.map((p) => (
        <div
          key={p.id}
          className="td-label"
          style={{ opacity: 0 }}
          ref={(el) => {
            const cur = leaderEls.get(p.id);
            if (el) leaderEls.set(p.id, { ...(cur as object), label: el } as never);
          }}
          onClick={() => set({ part: p.id })}
        >
          <b>{p.name}</b>
          {p.spec && <span>{p.spec}</span>}
        </div>
      ))}
    </>
  );
}

/** Big mode word and the line under it, written from the animation loop. */
function ModeWord() {
  const word = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const isolate = useTeardown((s) => s.isolate);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const e = motion.explode;
      const text = e < 0.01 ? "Assembled" : e > 0.99 ? "Exploded" : motion.dir < 0 ? "Reassembly" : "Teardown";
      if (word.current && word.current.textContent !== text) word.current.textContent = text;
      if (sub.current) sub.current.textContent = `Turntable ${Math.round(motion.angle)}° · ${Math.round(e * 100)}% apart${isolate ? ` · isolate ${isolate}` : ""}`;
      if (meter.current) meter.current.style.width = `${e * 100}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isolate]);
  return (
    <div className="td-mode" aria-hidden="true">
      <div className="td-eyebrow">Inspection mode</div>
      <div className="td-word" ref={word} />
      <div className="td-sub" ref={sub} />
      <div className="td-apart"><span ref={meter} /></div>
    </div>
  );
}

/** Sequence bar: play the teardown loop or scrub the explode amount by hand. */
function Sequence({ log }: { log: string }) {
  const playing = useTeardown((s) => s.playing);
  const set = useTeardown((s) => s.set);
  const range = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (range.current && motion.scrub === null) range.current.value = String(Math.round(motion.explode * 1000));
      if (time.current) {
        const t = playing ? motion.seqT % SEQ_TOTAL : 0;
        time.current.textContent = playing ? `${t.toFixed(1)} / ${SEQ_TOTAL.toFixed(1)} s` : "manual";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const release = () => {
    if (motion.scrub === null) return;
    set({ exploded: motion.scrub > 0.5 });
    motion.scrub = null;
  };
  return (
    <div className="panel td-seq">
      <div className="td-panel-head">
        <span>Sequence</span>
        <span className="td-log">Operator · {log}</span>
      </div>
      <div className="td-seq-row">
        <button
          className="td-play"
          aria-label={playing ? "Pause the teardown loop" : "Play the teardown loop"}
          onClick={() => {
            if (!playing) motion.seqT = motion.explode >= 0.99 ? 3.2 : motion.explode * 3.2;
            set({ playing: !playing });
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="td-track">
          <div className="td-ends">
            <span>Assembled</span>
            <span ref={time} />
            <span>Apart</span>
          </div>
          <input
            ref={range}
            type="range"
            min={0}
            max={1000}
            defaultValue={1000}
            aria-label="How far apart"
            onPointerDown={() => set({ playing: false })}
            onInput={(e) => {
              set({ playing: false });
              motion.scrub = Number((e.target as HTMLInputElement).value) / 1000;
            }}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={release}
          />
        </div>
      </div>
    </div>
  );
}

export function Teardown() {
  const id = useDashboard((s) => s.teardown);
  const close = useDashboard((s) => s.setTeardown);
  const mode = useDashboard((s) => s.mode);
  const assembly = id ? ASSEMBLIES[id] : undefined;
  const ui = useTeardown();
  const [log, setLog] = useState("open");

  useEffect(() => {
    useTeardown.getState().reset();
    motion.explode = 0;
    motion.scrub = null;
    motion.seqT = 0;
    setLog("exploded on");
  }, [id]);

  const readouts = useWorldJson((w) => (assembly ? assembly.readouts(w) : []));
  const groupStatus = useWorldJson((w) => (assembly ? assembly.groups.map((g) => g.status(w)) : []));
  const status = useWorldJson((w) => (assembly ? assembly.status(w) : { text: "", tone: "off" as StatusTone }));

  if (!assembly) return null;
  const part = assembly.parts.find((p) => p.id === ui.part);
  const toggle = (key: "labels" | "exploded" | "turntable" | "xray") => {
    const on = !ui[key];
    ui.set({ [key]: on, ...(key === "exploded" ? { playing: false } : {}) });
    setLog(`${key === "xray" ? "x-ray" : key} ${on ? "on" : "off"}`);
  };
  const isolate = (g: string | null) => {
    ui.set({ isolate: g, part: null });
    setLog(g ? `isolate ${assembly.groups.find((x) => x.id === g)?.name.toLowerCase()}` : "isolate all");
    if (g && !ui.exploded && !ui.playing) ui.set({ exploded: true });
  };

  return (
    <div className="teardown" role="dialog" aria-modal="true" aria-label={`${assembly.title} taken apart`}>
      <div className="td-stage">
        <TeardownCanvas assembly={assembly} />
        <div className="td-orbit" aria-hidden="true" />
        <LabelLayer assembly={assembly} />
        <ModeWord />
      </div>

      <header className="td-top panel">
        <div className="td-badge">{assembly.code}</div>
        <div className="td-title">
          <span className="td-eyebrow">Teardown · {assembly.subtitle}</span>
          <h2>{assembly.title}</h2>
        </div>
        <div className="td-meta">
          <div>
            <span className="td-eyebrow">Status</span>
            <b className={`tone-${status.tone}`}>{status.text}</b>
          </div>
          <div>
            <span className="td-eyebrow">Source</span>
            <b>{mode === "live" ? "Live" : "Replay"}</b>
          </div>
          <div>
            <span className="td-eyebrow">Parts</span>
            <b>{assembly.parts.filter((p) => p.spec || p.key).length}</b>
          </div>
        </div>
        <button className="icon td-close" onClick={() => close(null)} aria-label="Close the teardown">
          ×
        </button>
      </header>

      <aside className="td-left">
        <section className="panel td-panel">
          <div className="td-panel-head">
            <span>Telemetry</span>
            <span>01</span>
          </div>
          {readouts.map((r) => (
            <div className="td-row" key={r.label}>
              <span>{r.label}</span>
              <b className={r.tone ? `tone-${r.tone}` : ""}>{r.value}</b>
            </div>
          ))}
        </section>
        {part && (
          <section className="panel td-panel td-part" aria-live="polite">
            <div className="td-panel-head">
              <span>Part</span>
              <button className="icon" onClick={() => ui.set({ part: null })} aria-label="Close part details">
                ×
              </button>
            </div>
            <h3>{part.name}</h3>
            {part.spec && <p className="td-spec">{part.spec}</p>}
            {part.detail?.map((d) => (
              <p key={d}>{d}</p>
            ))}
            <p className="td-foot">
              <Chip tone={part.live === "exporter" ? "exporter" : part.live === "inferred" ? "inferred" : part.live === "static" ? "static" : "on"}>
                {LIVE_LABEL[part.live]}
              </Chip>
              <span>{assembly.groups.find((g) => g.id === part.group)?.name}</span>
            </p>
          </section>
        )}
      </aside>

      <aside className="td-right">
        <section className="panel td-panel">
          <div className="td-panel-head">
            <span>Assemblies</span>
            <span>02</span>
          </div>
          <div className="td-chips">
            <button className={ui.isolate === null ? "on" : ""} aria-pressed={ui.isolate === null} onClick={() => isolate(null)}>
              All
            </button>
            {assembly.groups.map((g) => (
              <button key={g.id} className={ui.isolate === g.id ? "on" : ""} aria-pressed={ui.isolate === g.id} onClick={() => isolate(ui.isolate === g.id ? null : g.id)}>
                {g.name}
              </button>
            ))}
          </div>
        </section>
        <section className="panel td-panel">
          <div className="td-panel-head">
            <span>Display</span>
            <span>03</span>
          </div>
          <div className="td-chips">
            {(["labels", "exploded", "turntable", "xray"] as const).map((k) => (
              <button key={k} className={ui[k] ? "on" : ""} aria-pressed={ui[k]} onClick={() => toggle(k)}>
                {k === "xray" ? "X-ray" : k[0].toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
        </section>
        <section className="panel td-panel">
          <div className="td-panel-head">
            <span>Subsystems</span>
            <span>{String(assembly.groups.length).padStart(2, "0")}</span>
          </div>
          <ol className="td-subs">
            {assembly.groups.map((g, i) => (
              <li key={g.id}>
                <button className={ui.isolate === g.id ? "on" : ""} onClick={() => isolate(ui.isolate === g.id ? null : g.id)}>
                  <span className="td-num">{String(i + 1).padStart(2, "0")}</span>
                  <span className="td-sub-name">
                    <b>{g.name}</b>
                    <small>{g.spec}</small>
                  </span>
                  {groupStatus[i] && <Chip tone={groupStatus[i].tone}>{groupStatus[i].text}</Chip>}
                </button>
              </li>
            ))}
          </ol>
        </section>
      </aside>

      <Sequence log={log} />

      <footer className="td-foot-line">
        <span>
          {assembly.parts.filter((p) => p.spec || p.key).length} parts · {assembly.groups.length} assemblies · drag to orbit, scroll to zoom
        </span>
        <span className="td-legend">
          <i className="solid" /> observed or static <i className="dashed" /> inferred <i className="dotted" /> not observed yet
        </span>
      </footer>
    </div>
  );
}
