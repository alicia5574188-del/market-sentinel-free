// Compatibility export for callers that still use the historical module path.
// The implementation is HTE31-owned and no longer depends on Strategy 2,
// Shadow Strategy, Signal Engine, or the legacy trade lifecycle domain.
export {
  HUMAN_TRADER_LABELS,
  HUMAN_TRADER_PLAYBOOKS,
  evaluateHumanTraderPool,
} from "./hte31-human-trader-engine.ts";
export type { HumanTraderId } from "./hte31-human-trader-engine.ts";
