/**
 * Timings copied from the platform's configuration (read-only reference repo).
 * Source files are named so the values can be re-checked when the platform changes.
 */
export const CONFIG = {
  /** k8s/keda/scaledobject.yaml: pollingInterval */
  kedaPollSeconds: 15,
  /** k8s/keda/scaledobject.yaml: cooldownPeriod */
  kedaCooldownSeconds: 120,
  /** k8s/autoscaler/cluster-autoscaler.yaml: --scale-down-unneeded-time */
  caScaleDownSeconds: 120,
  /** services/control_plane/idle_watchdog.py: idle_threshold_seconds */
  watchdogIdleSeconds: 1800,
  /** terraform/modules/sqs/main.tf: maxReceiveCount */
  maxReceiveCount: 3,
  /** services/ai_worker/worker.py: relevance_threshold default */
  layaRelevanceThreshold: 0.35,
  /** services/ai_worker/worker.py: verification pass threshold */
  layaVerifyThreshold: 0.4,
  /** docs/architecture/01-master-architecture.md: GPU cold start range */
  coldStartSeconds: [90, 150] as const,
  /** EventBridge rule personal-ai-control-plane-prewarm */
  prewarmUtc: "06:55",
} as const;

/**
 * Placeholder durations for sample traces only. Replace with medians from real
 * recorded runs once telemetry exists (Phase C).
 */
export const SAMPLE = {
  cpBootSeconds: 55,
  podsReadySeconds: 40,
  kedaDetectSeconds: 9,
  caReactSeconds: 8,
  gpuLaunchSeconds: 28,
  ebsAttachSeconds: 14,
  nodeJoinSeconds: 22,
  modelLoadSeconds: 48,
  generationSeconds: 11,
  gpuTerminateSeconds: 35,
  cpStopSeconds: 25,
} as const;

/** Illustrative hourly rates used only to label sample costs. Not billed figures. */
export const SAMPLE_RATES_USD_PER_HOUR = {
  gpu: 1.0,
  controlPlane: 0.04,
} as const;
