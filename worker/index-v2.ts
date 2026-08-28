// Fresh production entry for the MarketScanner V2 namespace.
//
// The application Worker, PositionMonitor and LiveTradingCoordinator keep the
// exact same implementation and storage. Only MARKET_SCANNER is rebound to a
// brand-new Durable Object class export so a poisoned/stale scanner instance
// cannot carry its old alarm/runtime state into the resumable phase machine.
export { default, PositionMonitor, MarketScanner, LiveTradingCoordinator } from "./index";
export { MarketScanner as MarketScannerV2 } from "./index";
