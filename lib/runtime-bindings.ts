/// <reference types="@cloudflare/workers-types" />

import type { MarketScanner, PositionMonitor } from "../worker";

export type RuntimeBindings = {
  SCAN_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  BACKGROUND_MODE?: string;
  SITE_OWNER_EMAIL?: string;
  OWNER_ACCESS_TOKEN?: string;
  POSITION_MONITOR?: DurableObjectNamespace<PositionMonitor>;
  MARKET_SCANNER?: DurableObjectNamespace<MarketScanner>;
};

const runtime = globalThis as typeof globalThis & { __MARKET_SENTINEL_BINDINGS__?: RuntimeBindings };

export function setRuntimeBindings(bindings: RuntimeBindings) {
  runtime.__MARKET_SENTINEL_BINDINGS__ = bindings;
}

export function getRuntimeBindings(): RuntimeBindings {
  return runtime.__MARKET_SENTINEL_BINDINGS__ ?? {};
}
