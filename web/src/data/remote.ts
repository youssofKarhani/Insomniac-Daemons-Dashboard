import { z } from "zod";
import { TwinEventSchema } from "../model/events";

/**
 * Public telemetry published by the twin's own AWS stack (see infra/).
 * Unset VITE_TWIN_DATA_URL means "no telemetry": the site runs on sample data.
 */
export const DATA_URL: string | null = (import.meta.env.VITE_TWIN_DATA_URL as string | undefined)?.replace(/\/$/, "") || null;

/** live.json older than this is shown as stale rather than as the platform's state. */
export const STALE_AFTER_MS = 3 * 60_000;
export const LIVE_POLL_MS = 10_000;

const RunRef = z.object({ id: z.string(), start: z.number(), end: z.number().nullable().optional(), open: z.boolean() });

export const LiveDoc = z.object({
  schema: z.literal(1),
  generatedAt: z.number(),
  run: RunRef.nullable(),
  events: z.array(TwinEventSchema),
});
export type LiveDoc = z.infer<typeof LiveDoc>;

export const RunSummary = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number().nullable(),
  events: z.number(),
  gpuSeconds: z.number(),
  controlPlaneSeconds: z.number(),
  gpuLaunches: z.number(),
  launchFailures: z.number(),
});
export type RunSummary = z.infer<typeof RunSummary>;

const RunIndex = z.object({ schema: z.literal(1), generatedAt: z.number(), runs: z.array(RunSummary) });
const RunDoc = z.object({ schema: z.literal(1), run: RunSummary, events: z.array(TwinEventSchema) });

const Rate = z.object({ instanceType: z.string(), onDemand: z.number().nullable().optional(), spot: z.number().nullable().optional() });
export const CostsDoc = z.object({
  schema: z.literal(1),
  generatedAt: z.number(),
  billed: z.union([
    z.object({
      currency: z.string(),
      months: z.array(
        z.object({
          month: z.string(),
          /** Usage before credits and refunds. */
          total: z.number(),
          credits: z.number().optional(),
          net: z.number().optional(),
          partial: z.boolean(),
          services: z.array(z.object({ name: z.string(), amount: z.number() })),
          components: z.array(z.object({ name: z.string(), amount: z.number() })).optional(),
        }),
      ),
      days: z.array(z.object({ date: z.string(), total: z.number() })),
    }),
    z.object({ error: z.string() }),
  ]),
  rates: z.object({ gpu: Rate, controlPlane: Rate }).partial().optional(),
});
export type CostsDoc = z.infer<typeof CostsDoc>;

async function getJson<S extends z.ZodTypeAny>(path: string, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
  if (!DATA_URL) throw new Error("Telemetry is not configured");
  const res = await fetch(`${DATA_URL}/${path}`, { signal, cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return schema.parse(await res.json());
}

export const fetchLive = (signal?: AbortSignal) => getJson("live.json", LiveDoc, signal);
/** Before the first run closes there is no index; S3 behind CloudFront reports that as 403. */
export const fetchRunIndex = (signal?: AbortSignal) =>
  getJson("runs/index.json", RunIndex, signal).then(
    (d) => d.runs,
    (err: unknown) => {
      if (err instanceof Error && /HTTP 40[34]$/.test(err.message)) return [];
      throw err;
    },
  );
export const fetchRun = (id: string, signal?: AbortSignal) => {
  if (!/^r-\d{8}-\d{6}$/.test(id)) return Promise.reject(new Error("Invalid run id"));
  return getJson(`runs/${id}.json`, RunDoc, signal);
};
export const fetchCosts = (signal?: AbortSignal) => getJson("costs.json", CostsDoc, signal);
