// HTE 3.1 Clean production entry.
//
// Keep every Durable Object class that has ever been deployed exported so
// Cloudflare does not have to delete or reconcile persistent legacy classes in
// the same release that creates the clean runtime. Production bindings point
// only at HTE31MarketScanner / HTE31TradeManager; the legacy classes remain
// unbound and therefore cannot participate in HTE 3.1 scanning or learning.
export { default, PositionMonitor, MarketScanner, LiveTradingCoordinator } from "./index";
export { MarketScanner as MarketScannerV2 } from "./index";
export { HTE31MarketScanner, HTE31TradeManager } from "./hte31-workers";
