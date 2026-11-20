import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { OBJECT_IDS, OBJECTS, type ObjectId } from "../content/components";
import { currentWorld, useTwin } from "../store";
import { layout } from "./schematicLayout";
import { MAX_DOTS, boxKey, boxViews } from "./status";

/** Narrower than this, the districts stack in the order work flows. */
export const TALL_BELOW_PX = 640;

function useTall() {
  const [tall, setTall] = useState(() => typeof window !== "undefined" && window.innerWidth < TALL_BELOW_PX);
  useEffect(() => {
    const on = () => setTall(window.innerWidth < TALL_BELOW_PX);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return tall;
}

/**
 * 2D schematic: the same world state as the 3D desk, drawn as labelled boxes.
 * Used automatically without WebGL, and offered as a toggle. State is shown as
 * text as well as colour; inferred states have a dashed outline and say so.
 */
export function Schematic({ tall: forceTall }: { tall?: boolean }) {
  const autoTall = useTall();
  const tall = forceTall ?? autoTall;
  const L = useMemo(() => layout(tall ? "tall" : "wide"), [tall]);
  // Select one short key per box: the schematic re-renders when a box's drawing
  // changes, not on every frame of playback.
  const keys = useTwin(
    useShallow((s) => {
      const v = boxViews(currentWorld(s));
      return OBJECT_IDS.map((id) => boxKey(v[id]));
    }),
  );
  const selected = useTwin((s) => s.selected);
  const reducedMotion = useTwin((s) => s.reducedMotion);
  const select = useTwin((s) => s.select);
  // Rebuilt from the current state whenever a key changed (the keys came from that same state).
  const views = useMemo(() => boxViews(currentWorld(useTwin.getState())), [keys]);
  const scroller = useRef<HTMLDivElement>(null);

  // On a phone the selected box (for example a tour stop) may be off screen.
  useEffect(() => {
    if (!tall || !selected) return;
    scroller.current
      ?.querySelector(`[data-id="${selected}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [tall, selected, reducedMotion]);

  return (
    <div className={`schematic ${tall ? "tall" : "wide"}`} ref={scroller} onClick={() => select(null)}>
      <svg
        viewBox={`-4 -4 ${L.width + 8} ${L.height + 8}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Platform schematic"
      >
        {L.districts.map((d) => (
          <g key={d.district.id} className={`district${d.district.platform ? " platform" : ""}`}>
            <rect x={d.x} y={d.y} width={d.w} height={d.h} rx={12} />
            <text x={d.x + 14} y={d.y + 20}>
              {d.district.label}
            </text>
          </g>
        ))}
        {(Object.keys(L.boxes) as ObjectId[]).map((id) => {
          const b = L.boxes[id];
          const { status: st, dots: shown, total } = views[id];
          const name = OBJECTS[id].name;
          const label = `${name}: ${st.text}${st.inferred ? ", inferred" : ""}${total ? `, ${total} job${total === 1 ? "" : "s"} here` : ""}`;
          const activate = () => select(id);
          return (
            <g
              key={id}
              data-id={id}
              className={`sbox tone-${st.tone}${st.inferred ? " inferred" : ""}${selected === id ? " selected" : ""}`}
              transform={`translate(${b.x} ${b.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={selected === id}
              aria-label={label}
              onClick={(e) => {
                e.stopPropagation();
                activate();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
              }}
            >
              <title>{label}</title>
              <rect className="frame" width={b.w} height={b.h} rx={8} />
              <rect className="stripe" width={5} height={b.h - 16} x={0} y={8} rx={2} />
              <text className="name" x={14} y={22}>
                {name}
              </text>
              <text className="state" x={14} y={40}>
                {st.text}
              </text>
              {shown.map((j, i) => (
                <circle key={j.id} className={`dot t-${j.tone}${j.held ? " held" : ""}`} cx={18 + i * 12} cy={54} r={4.2} />
              ))}
              {total > MAX_DOTS && (
                <text className="more" x={18 + MAX_DOTS * 12} y={58}>
                  +{total - MAX_DOTS}
                </text>
              )}
              {st.inferred && (
                <text className="inf" x={b.w - 10} y={58} textAnchor="end">
                  inferred
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="schematic-key muted small">
        Dots are jobs; a hollow dot is held by the worker. Dashed boxes are inferred, not observed.
      </p>
    </div>
  );
}
