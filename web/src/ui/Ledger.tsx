import { useShallow } from "zustand/react/shallow";
import type { RunSummary } from "../data/remote";
import { runtimeAt } from "../model/state";
import { CONFIG } from "../model/timings";
import { useTwin } from "../store";
import { duration, usd } from "./format";
import { useRates } from "./rates";

const H = 3_600_000;

/**
 * Cost panel on the desk corner. Billed figures come from Cost Explorer (via
 * costs.json) and are labelled as billed; everything else is an estimate with
 * its assumptions stated.
 */
export function Ledger() {
  const rates = useRates();
  const mode = useTwin((s) => s.mode);
  const v = useTwin(
    useShallow((s) => {
      const w = s.world;
      const rt = runtimeAt(w, w.t);
      const span = Math.max(0, w.t - s.timeline.srcStart);
      return {
        gpuS: Math.round(rt.gpuMs / 1000),
        cpS: Math.round(rt.cpMs / 1000),
        spanS: Math.round(span / 1000),
      };
    }),
  );
  const billed = useTwin(
    useShallow((s) => {
      const b = s.costs?.billed;
      if (!b || "error" in b) return null;
      const m = b.months[b.months.length - 1];
      return m ?? null;
    }),
  );
  const billedError = useTwin((s) => (s.costs?.billed && "error" in s.costs.billed ? s.costs.billed.error : null));
  const prewarm = useTwin(useShallow((s) => idlePrewarms(s.recorded, billed?.month)));

  const paid = (v.gpuS * 1000 / H) * rates.gpu + (v.cpS * 1000 / H) * rates.controlPlane;
  const alwaysOn = (v.spanS * 1000 / H) * (rates.gpu + rates.controlPlane);
  const saved = alwaysOn > 0 ? Math.max(0, 1 - paid / alwaysOn) : 0;
  const showRun = mode === "replay";
  const credits = billed?.credits ?? 0;
  const prewarmCost = (prewarm.cpSeconds * 1000 / H) * rates.controlPlane;

  return (
    <section className="panel ledger" aria-label="Cost">
      <div className="ledger-row big">
        <span>Compute now</span>
        <b>${rates.nowPerHour.toFixed(2)}/h</b>
      </div>
      {billed && (
        <>
          <div className="ledger-row">
            <span>
              Usage {monthName(billed.month)}
              {billed.partial ? " so far" : ""}
            </span>
            <b>{usd(billed.total)}</b>
          </div>
          {credits !== 0 && (
            <div className="ledger-row">
              <span>Credits applied</span>
              <b>{usd(credits)}</b>
            </div>
          )}
          {billed.components && billed.components.length > 0 && (
            <details className="ledger-detail">
              <summary>By component</summary>
              {billed.components.map((c) => (
                <div className="ledger-row" key={c.name}>
                  <span>{c.name}</span>
                  <b>{usd(c.amount)}</b>
                </div>
              ))}
              {prewarm.count > 0 && (
                <div className="ledger-row">
                  <span>Morning wakes with no GPU work ({prewarm.count}), est.</span>
                  <b>{usd(prewarmCost)}</b>
                </div>
              )}
            </details>
          )}
        </>
      )}
      {showRun && (
        <>
          <div className="ledger-row">
            <span>GPU time this run</span>
            <b>{duration(v.gpuS * 1000)}</b>
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
        </>
      )}
      <p className="muted small">
        {showRun && saved > 0 ? `${Math.round(saved * 100)}% less over ${duration(v.spanS * 1000)}. ` : ""}
        {showRun ? "Always on means GPU and tower running the whole time; disks cost the same either way and are left out. " : ""}
        {rates.basis === "list" ? "Estimates use AWS list prices." : "Estimates use sample rates."}
        {billed ? " Usage from Cost Explorer, before credits, up to a day behind." : ""}
        {billedError ? " Billed costs unavailable." : ""}
      </p>
    </section>
  );
}

/**
 * Recorded runs that started at the morning pre-warm and never used the GPU.
 * An estimate: the tower time is priced at list, and a run with CPU-only jobs
 * in it would also count.
 */
function idlePrewarms(runs: RunSummary[] | null | undefined, month: string | undefined) {
  const [hh, mm] = CONFIG.prewarmUtc.split(":").map(Number);
  let count = 0;
  let cpSeconds = 0;
  for (const r of runs ?? []) {
    const d = new Date(r.start);
    if (month && d.toISOString().slice(0, 7) !== month) continue;
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() - (hh * 60 + mm);
    if (minutes >= -1 && minutes <= 5 && r.gpuSeconds === 0) {
      count += 1;
      cpSeconds += r.controlPlaneSeconds;
    }
  }
  return { count, cpSeconds };
}

function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
}
