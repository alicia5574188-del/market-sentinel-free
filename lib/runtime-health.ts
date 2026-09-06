export type RuntimeHealthShape = {
  state?: string;
  stale?: boolean;
  authorityReady?: boolean;
  lastError?: unknown;
  symbols?: string[];
  evidence?: Record<string, { fresh?: boolean; ancillaryFresh?: boolean }>;
};

export function runtimeReady(runtime: RuntimeHealthShape | null, transportFresh = true) {
  if (!runtime || !transportFresh || runtime.state !== "LIVE" || runtime.stale !== false || runtime.authorityReady !== true || runtime.lastError != null) return false;
  const symbols = runtime.symbols ?? [];
  return symbols.length === 4 && new Set(symbols).size === 4
    && symbols.every((symbol) => runtime.evidence?.[symbol]?.fresh === true && runtime.evidence[symbol]?.ancillaryFresh === true);
}
