export type RuntimeHealthShape = {
  state?: string;
  stale?: boolean;
  authorityReady?: boolean;
  lastError?: unknown;
  symbols?: string[];
  evidence?: Record<string, { fresh?: boolean; ancillaryFresh?: boolean; entryReady?: boolean }>;
  realtimeReadiness?: { capacity?: number; actionableMarkets?: number; protectedMarketsReady?: boolean };
};

export function runtimeReady(runtime: RuntimeHealthShape | null, transportFresh = true) {
  if (!runtime || !transportFresh || runtime.state !== "LIVE" || runtime.stale !== false || runtime.authorityReady !== true) return false;
  const symbols = runtime.symbols ?? [];
  return symbols.length === 10 && new Set(symbols).size === 10
    && runtime.realtimeReadiness?.capacity === 10
    && (runtime.realtimeReadiness.actionableMarkets ?? 0) > 0
    && runtime.realtimeReadiness.protectedMarketsReady === true;
}
