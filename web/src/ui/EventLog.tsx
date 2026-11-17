import { caption } from "../content/captions";
import { useTwin } from "../store";
import { clockUtc } from "./format";

/** Text mirror of the scene: every event up to the playhead, newest first. */
export function EventLog({ onClose }: { onClose?: () => void }) {
  const history = useTwin((s) => s.history);
  const items = history.slice(-80).reverse();
  return (
    <aside className="panel log" aria-label="Event log">
      <div className="insp-head">
        <span className="eyebrow">Event log</span>
        {onClose && (
          <button className="icon" onClick={onClose} aria-label="Close event log">
            ×
          </button>
        )}
      </div>
      <ol>
        {items.map((e) => (
          <li key={e.id}>
            <time>{clockUtc(e.ts)}</time>
            <span>
              {caption(e)}
              {e.confidence === "inferred" && <span className="tag-inferred">inferred</span>}
            </span>
          </li>
        ))}
        {items.length === 0 && <li className="muted">No events yet.</li>}
      </ol>
    </aside>
  );
}
