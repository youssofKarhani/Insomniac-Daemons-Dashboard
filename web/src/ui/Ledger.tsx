import { useShallow } from "zustand/react/shallow";
import { runtimeAt } from "../model/state";
import { SAMPLE_RATES_USD_PER_HOUR as RATE } from "../model/timings";
import { useTwin } from "../store";
import { duration, usd } from "./format";

const H = 3_600_000;

/** Small cost panel on the desk corner. All figures use illustrative sample rates. */
export function Ledger() {
  const v = useTwin(useShallow((s) => {
    const w = s.world;
    const rt = runtimeAt(w, w.t);
    const span = Math.max(0, w.t - s.timeline.srcStart);
    const gpuOn = w.gpu.state !== "none" && w.gpu.state !== "launch_failed";
    const nowRate = (gpuOn ? RATE.gpu : 0) + (w.cp.state !== "stopped" ? RATE.controlPlane : 0);
    const paid = (rt.gpuMs / H) * RATE.gpu + (rt.cpMs / H) * RATE.controlPlane;
    const alwaysOn = (span / H) * (RATE.gpu + RATE.controlPlane);
    // Round so the selector only changes when the display would.
    return {
      nowRate: nowRate.toFixed(2),
      gpuMin: Math.round(rt.gpuMs / 1000),
      span: Math.round(span / 1000),
      paid: paid.toFixed(3),
      alwaysOn: alwaysOn.toFixed(3),
    };
  }));

  const paid = Number(v.paid);
  const alwaysOn = Number(v.alwaysOn);
  const saved = alwaysOn > 0 ? Math.max(0, 1 - paid / alwaysOn) : 0;
  return (
    <section className="panel ledger" aria-label="Cost">
      <div className="ledger-row big">
        <span>Compute now</span>
        <b>${v.nowRate}/h</b>
      </div>
      <div className="ledger-row">
        <span>GPU time this run</span>
        <b>{duration(v.gpuMin * 1000)}</b>
      </div>
      <div className="ledger-row">
        <span>Paid vs always on</span>
        <b>
          {usd(paid)} / {usd(alwaysOn)}
        </b>
      </div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${alwaysOn > 0 ? Math.min(100, (paid / alwaysOn) * 100) : 0}%` }} />
      </div>
      <p className="muted small">
        {saved > 0 ? `${Math.round(saved * 100)}% less over ${duration(v.span * 1000)}. ` : ""}Sample rates, not billed figures.
      </p>
    </section>
  );
}
