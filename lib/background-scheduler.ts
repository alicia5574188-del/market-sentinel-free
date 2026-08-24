import { getRuntimeBindings } from "./runtime-bindings";

export type SchedulerWorkerStatus = {
  state: "starting" | "live" | "paused" | "degraded" | "error";
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  refreshed?: number;
  analyzed?: number;
  symbols?: string[];
};

export type BackgroundSchedulerStatus = {
  mode: "foreground-only" | "cloudflare-free";
  active: boolean;
  observedAt: number;
  positionCadenceSeconds: number | null;
  scanCadenceSeconds: number | null;
  deepBatchSize: number | null;
  position: SchedulerWorkerStatus | null;
  scanner: SchedulerWorkerStatus | null;
  error?: string;
};

export async function ensureBackgroundSchedulers(): Promise<BackgroundSchedulerStatus> {
  const bindings = getRuntimeBindings();
  if (bindings.BACKGROUND_MODE !== "cloudflare-free" || !bindings.POSITION_MONITOR || !bindings.MARKET_SCANNER) {
    return {
      mode: "foreground-only",
      active: false,
      observedAt: Date.now(),
      positionCadenceSeconds: null,
      scanCadenceSeconds: null,
      deepBatchSize: null,
      position: null,
      scanner: null,
    };
  }

  try {
    const positionStub = bindings.POSITION_MONITOR.getByName("position-monitor");
    const scannerStub = bindings.MARKET_SCANNER.getByName("market-scanner");
    await Promise.all([
      positionStub.ensure(),
      scannerStub.ensure(),
    ]);
    const [position, scanner] = await Promise.all([
      positionStub.status(),
      scannerStub.status(),
    ]);
    return {
      mode: "cloudflare-free",
      active: true,
      observedAt: Date.now(),
      positionCadenceSeconds: 10,
      scanCadenceSeconds: 60,
      deepBatchSize: 3,
      position,
      scanner,
    };
  } catch (error) {
    return {
      mode: "cloudflare-free",
      active: false,
      observedAt: Date.now(),
      positionCadenceSeconds: 10,
      scanCadenceSeconds: 60,
      deepBatchSize: 3,
      position: null,
      scanner: null,
      error: error instanceof Error ? error.message : "background scheduler unavailable",
    };
  }
}
