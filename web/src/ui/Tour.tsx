import { useEffect, useRef } from "react";
import { caption } from "../content/captions";
import { TOUR } from "../content/tour";
import { useDashboard } from "../store";

/** Guided tour panel. Takes the replay bar's place while a tour runs. */
export function Tour() {
  const index = useDashboard((s) => s.tour);
  const playing = useDashboard((s) => s.playing);
  const last = useDashboard((s) => s.history[s.history.length - 1]);
  const { tourGo, endTour } = useDashboard.getState();
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (index === 0) nextRef.current?.focus();
  }, [index]);

  if (index === null) return null;
  const stop = TOUR[index];
  const isLast = index === TOUR.length - 1;

  return (
    <section className="panel tour" aria-label="Guided tour">
      <div className="tour-head">
        <span className="eyebrow">
          <span className="sample">Sample</span> Guided tour · stop {index + 1} of {TOUR.length}
        </span>
        <button className="icon" onClick={endTour} aria-label="End tour">
          ×
        </button>
      </div>
      <div aria-live="polite">
        <h2>{stop.title}</h2>
        <p>{stop.caption}</p>
      </div>
      <p className="muted small tour-event">
        {playing ? "Playing… " : "On the desk: "}
        {last ? caption(last) : ""}
      </p>
      <div className="tour-progress" aria-hidden="true">
        {TOUR.map((_, i) => (
          <span key={i} className={i === index ? "on" : i < index ? "done" : ""} />
        ))}
      </div>
      <div className="tour-nav">
        <button className="ghost" onClick={() => tourGo(index - 1)} disabled={index === 0}>
          ← Back
        </button>
        {isLast ? (
          <button ref={nextRef} className="primary-btn" onClick={endTour}>
            Finish
          </button>
        ) : (
          <button ref={nextRef} className="primary-btn" onClick={() => tourGo(index + 1)}>
            Next: {TOUR[index + 1].title} →
          </button>
        )}
      </div>
    </section>
  );
}
