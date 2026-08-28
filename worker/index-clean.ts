// HTE 3.1 Clean production entry.
//
// The HTTP application shell and LiveTradingCoordinator stay unchanged. The
// simulation MarketScanner and PositionMonitor bindings are replaced by fresh
// Durable Object classes/namespaces so no legacy alarm, job, or simulated
// position state can leak into the clean runtime. Legacy namespaces are renamed
// to inert archive classes: their storage is preserved, but no production
// binding can call them and any surviving alarm is cleared by the archive class.
export { default, LiveTradingCoordinator } from "./index";
export { HTE31MarketScanner, HTE31TradeManager } from "./hte31-workers";
export { RetiredPositionMonitor, RetiredMarketScanner, RetiredMarketScannerV2 } from "./retired-simulation-workers";
