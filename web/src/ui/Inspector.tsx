import { OBJECT_IDS, OBJECTS } from "../content/components";
import { useTwin } from "../store";
import { describe } from "./describe";

export function Inspector() {
  const selected = useTwin((s) => s.selected);
  const select = useTwin((s) => s.select);
  const mode = useTwin((s) => s.mode);
  const line = useTwin((s) => (s.selected ? describe(s.selected, s.world) : ""));
  if (!selected) return null;
  const info = OBJECTS[selected];
  const i = OBJECT_IDS.indexOf(selected);
  const prev = OBJECT_IDS[(i - 1 + OBJECT_IDS.length) % OBJECT_IDS.length];
  const next = OBJECT_IDS[(i + 1) % OBJECT_IDS.length];
  return (
    <aside className="panel inspector" aria-label={`${info.name} details`}>
      <div className="insp-head">
        <span className="eyebrow">{info.aws}</span>
        <button className="icon" onClick={() => select(null)} aria-label="Close details">
          ×
        </button>
      </div>
      <h2>{info.name}</h2>
      <p className="state" aria-live="polite">
        <span className={`dot ${info.alwaysOn ? "always" : ""}`} aria-hidden="true" />
        {line}
      </p>
      <p>{info.plain}</p>
      {mode === "live" && <p className="muted small">Live data: {info.live}</p>}
      <details>
        <summary>How it works</summary>
        <ul>
          {info.engineer.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <p className="muted">Shown as: {info.object.toLowerCase()}.</p>
      </details>
      <div className="insp-nav">
        <button className="ghost" onClick={() => select(prev)}>
          ← {OBJECTS[prev].name}
        </button>
        <button className="ghost" onClick={() => select(next)}>
          {OBJECTS[next].name} →
        </button>
      </div>
    </aside>
  );
}
