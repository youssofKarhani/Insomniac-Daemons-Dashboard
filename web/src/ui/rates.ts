import { useShallow } from "zustand/react/shallow";
import { SAMPLE_RATES_USD_PER_HOUR as SAMPLE } from "../model/timings";
import { useDashboard } from "../store";

export interface Rates {
  gpu: number;
  controlPlane: number;
  /** "list" when taken from the AWS Pricing API via costs.json, "sample" otherwise. */
  basis: "list" | "sample";
  gpuMarket: "on-demand" | "spot";
  nowPerHour: number;
}

/** Hourly rates for estimates: AWS list prices when telemetry provides them, sample rates otherwise. */
export function useRates(): Rates {
  return useDashboard(
    useShallow((s) => {
      const r = s.costs?.rates;
      const market = s.world.gpu.market;
      const gpuList = market === "spot" ? r?.gpu?.spot ?? r?.gpu?.onDemand : r?.gpu?.onDemand;
      const cpList = r?.controlPlane?.onDemand;
      const basis: Rates["basis"] = gpuList != null && cpList != null ? "list" : "sample";
      const gpu = basis === "list" ? gpuList! : SAMPLE.gpu;
      const controlPlane = basis === "list" ? cpList! : SAMPLE.controlPlane;
      const w = s.world;
      const gpuOn = w.gpu.state !== "none" && w.gpu.state !== "launch_failed";
      const nowPerHour = (gpuOn ? gpu : 0) + (w.cp.state !== "stopped" ? controlPlane : 0);
      return { gpu, controlPlane, basis, gpuMarket: market, nowPerHour };
    }),
  );
}
