import type { Side } from "./liquidity-core.ts";
import { arenaSummary as currentArenaSummary, type ArenaTrade, type StrategyArenaState } from "./strategy-arena.ts";
import { arenaSummary as previousArenaSummary, type ArenaTrade as PreviousArenaTrade,
  type StrategyArenaState as PreviousStrategyArenaState } from "./previous-strategy-arena.ts";

export const DUAL_PAPER_VERSION = 1;
export const ENGINE_INITIAL_EQUITY = 1_000;
export const CANONICAL_PAPER_INITIAL_EQUITY = 1_000;
export const ENGINE_CANONICAL_WEIGHT = 0.5;

export type StrategyEngineId = "CURRENT_V5" | "PREVIOUS_V4";
export type EngineTaggedTrade = ArenaTrade & {
  engineId: StrategyEngineId;
  engineName: string;
  engineTradeId: string;
};

export type DualPaperAccounts = {
  current: StrategyArenaState;
  previous: PreviousStrategyArenaState;
};

const ENGINE_META: Record<StrategyEngineId, { name: string; strategyVersion: string }> = {
  CURRENT_V5: { name: "当前上线版 V5", strategyVersion: "V5" },
  PREVIOUS_V4: { name: "上一版 V4", strategyVersion: "V4" },
};

function taggedTrade(engineId: StrategyEngineId, value: ArenaTrade | PreviousArenaTrade, accountScale = 1): EngineTaggedTrade {
  const trade = value as ArenaTrade;
  return { ...trade, id: `${engineId}:${trade.id}`, eventId: `${engineId}:${trade.eventId}`,
    notional: trade.notional * accountScale, plannedRisk: trade.plannedRisk * accountScale,
    contracts: trade.contracts * accountScale, margin: trade.margin * accountScale,
    netPnl: trade.netPnl == null ? null : trade.netPnl * accountScale,
    accountEquityAtOpen: accountScale === 1 ? trade.accountEquityAtOpen : CANONICAL_PAPER_INITIAL_EQUITY,
    engineId, engineName: ENGINE_META[engineId].name, engineTradeId: trade.id };
}

function taggedTrades(engineId: StrategyEngineId, values: Array<ArenaTrade | PreviousArenaTrade>, accountScale = 1) {
  return values.map((trade) => taggedTrade(engineId, trade, accountScale));
}

export function canonicalPaperOpen(accounts: DualPaperAccounts) {
  return [
    ...taggedTrades("CURRENT_V5", Object.values(accounts.current.portfolioOpen), ENGINE_CANONICAL_WEIGHT),
    ...taggedTrades("PREVIOUS_V4", Object.values(accounts.previous.portfolioOpen), ENGINE_CANONICAL_WEIGHT),
  ].sort((left, right) => right.openedAt - left.openedAt);
}

export function canonicalPaperEquity(accounts: DualPaperAccounts) {
  return CANONICAL_PAPER_INITIAL_EQUITY
    + (accounts.current.portfolioEquity - ENGINE_INITIAL_EQUITY) * ENGINE_CANONICAL_WEIGHT
    + (accounts.previous.portfolioEquity - ENGINE_INITIAL_EQUITY) * ENGINE_CANONICAL_WEIGHT;
}

function taggedRows<T extends { id: string }>(engineId: StrategyEngineId, values: T[]) {
  return values.map((value) => ({ ...value, id: `${engineId}:${value.id}`, engineId,
    engineName: ENGINE_META[engineId].name }));
}

export function canonicalPaperSummary(accounts: DualPaperAccounts) {
  const current = currentArenaSummary(accounts.current);
  const previous = previousArenaSummary(accounts.previous);
  const engineSummaries = [
    { id: "CURRENT_V5" as const, name: ENGINE_META.CURRENT_V5.name, strategyVersion: "V5", initialEquity: ENGINE_INITIAL_EQUITY,
      ...current },
    { id: "PREVIOUS_V4" as const, name: ENGINE_META.PREVIOUS_V4.name, strategyVersion: "V4", initialEquity: ENGINE_INITIAL_EQUITY,
      ...previous },
  ];
  return {
    ...current,
    version: current.version,
    dualPaperVersion: DUAL_PAPER_VERSION,
    systemName: "双引擎独立账户",
    initialEquity: CANONICAL_PAPER_INITIAL_EQUITY,
    portfolioEquity: canonicalPaperEquity(accounts),
    portfolioResolved: current.portfolioResolved + previous.portfolioResolved,
    portfolioWins: current.portfolioWins + previous.portfolioWins,
    portfolioGrossPnl: (current.portfolioGrossPnl + previous.portfolioGrossPnl) * ENGINE_CANONICAL_WEIGHT,
    portfolioCosts: (current.portfolioCosts + previous.portfolioCosts) * ENGINE_CANONICAL_WEIGHT,
    portfolioOpen: canonicalPaperOpen(accounts),
    recentPortfolio: [
      ...taggedTrades("CURRENT_V5", current.recentPortfolio, ENGINE_CANONICAL_WEIGHT),
      ...taggedTrades("PREVIOUS_V4", previous.recentPortfolio, ENGINE_CANONICAL_WEIGHT),
    ].sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt)).slice(0, 200),
    archivedPortfolioTrades: [
      ...taggedTrades("CURRENT_V5", current.archivedPortfolioTrades, ENGINE_CANONICAL_WEIGHT),
      ...taggedTrades("PREVIOUS_V4", previous.archivedPortfolioTrades, ENGINE_CANONICAL_WEIGHT),
    ].sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt)).slice(0, 200),
    openShadow: [
      ...taggedTrades("CURRENT_V5", current.openShadow),
      ...taggedTrades("PREVIOUS_V4", previous.openShadow),
    ].sort((left, right) => right.openedAt - left.openedAt),
    recentShadow: [
      ...taggedTrades("CURRENT_V5", current.recentShadow),
      ...taggedTrades("PREVIOUS_V4", previous.recentShadow),
    ].sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt)).slice(0, 200),
    strategies: [
      ...taggedRows("CURRENT_V5", current.strategies),
      ...taggedRows("PREVIOUS_V4", previous.strategies),
    ],
    playbooks: [
      ...taggedRows("CURRENT_V5", current.playbooks),
      ...taggedRows("PREVIOUS_V4", previous.playbooks),
    ],
    transitions: [
      ...taggedRows("CURRENT_V5", current.transitions),
      ...taggedRows("PREVIOUS_V4", previous.transitions),
    ].sort((left, right) => right.at - left.at).slice(0, 200),
    observationShadow: [
      ...taggedRows("CURRENT_V5", current.observationShadow),
      ...taggedRows("PREVIOUS_V4", previous.observationShadow),
    ].sort((left, right) => right.observedAt - left.observedAt).slice(0, 200),
    blockedCandidates: [
      ...taggedRows("CURRENT_V5", current.blockedCandidates),
      ...taggedRows("PREVIOUS_V4", previous.blockedCandidates),
    ].sort((left, right) => right.blockedAt - left.blockedAt).slice(0, 200),
    currentRouteChecks: [
      ...taggedRows("CURRENT_V5", current.currentRouteChecks),
      ...taggedRows("PREVIOUS_V4", previous.currentRouteChecks),
    ].sort((left, right) => right.observedAt - left.observedAt).slice(0, 60),
    shadowCount: current.shadowCount + previous.shadowCount,
    activeCount: current.activeCount + previous.activeCount,
    reverseActiveCount: current.reverseActiveCount + previous.reverseActiveCount,
    sleepingCount: current.sleepingCount + previous.sleepingCount,
    catalogSize: current.catalogSize + previous.catalogSize,
    playbookCount: current.playbookCount + previous.playbookCount,
    paperCount: current.paperCount + previous.paperCount,
    verifiedCount: current.verifiedCount + previous.verifiedCount,
    engines: engineSummaries,
    rules: { ...current.rules, dualIndependentEngines: true, engineInitialEquity: ENGINE_INITIAL_EQUITY,
      canonicalInitialEquity: CANONICAL_PAPER_INITIAL_EQUITY, sameSymbolCrossEngineAllowed: true,
      engineCanonicalWeight: ENGINE_CANONICAL_WEIGHT, liveSource: "CANONICAL_PAPER_NET" },
  };
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

function protectiveStop(side: Side, trades: EngineTaggedTrade[]) {
  const stops = trades.map((trade) => trade.activeStopPrice ?? trade.stopPrice);
  return side === "LONG" ? Math.max(...stops) : Math.min(...stops);
}

function structuralStop(side: Side, trades: EngineTaggedTrade[]) {
  const stops = trades.map((trade) => trade.stopPrice);
  return side === "LONG" ? Math.max(...stops) : Math.min(...stops);
}

function closestTarget(side: Side, trades: EngineTaggedTrade[]) {
  const targets = trades.map((trade) => trade.targetPrice);
  return side === "LONG" ? Math.min(...targets) : Math.max(...targets);
}

/**
 * Gate runs in single-position mode. The canonical PAPER account keeps every
 * logical leg, while LIVE receives one deterministic net position per symbol.
 * A changed constituent set changes the synthetic id, making the existing
 * reconciliation close and reopen the new net instead of silently retaining
 * stale size or direction.
 */
export function canonicalLivePortfolio(accounts: DualPaperAccounts) {
  const canonicalEquity = canonicalPaperEquity(accounts);
  const bySymbol = Object.groupBy(canonicalPaperOpen(accounts), (trade) => trade.symbol);
  const output: Record<string, ArenaTrade> = {};
  for (const [symbol, all] of Object.entries(bySymbol)) {
    const trades = all ?? [];
    const signedContracts = trades.reduce((total, trade) => total + (trade.side === "LONG" ? trade.contracts : -trade.contracts), 0);
    if (Math.abs(signedContracts) < 1) continue;
    const side: Side = signedContracts > 0 ? "LONG" : "SHORT";
    const contributors = trades.filter((trade) => trade.side === side);
    if (!contributors.length) continue;
    const anchor = [...contributors].sort((left, right) => right.openedAt - left.openedAt)[0];
    const contracts = Math.abs(signedContracts);
    const entryPrice = contributors.reduce((total, trade) => total + trade.entryPrice * trade.contracts, 0)
      / Math.max(1, contributors.reduce((total, trade) => total + trade.contracts, 0));
    const stopPrice = structuralStop(side, contributors);
    const activeStopPrice = protectiveStop(side, contributors);
    const targetPrice = closestTarget(side, contributors);
    const quantoMultiplier = anchor.quantoMultiplier;
    const notional = contracts * entryPrice * quantoMultiplier;
    const modeledCostRate = Math.max(...contributors.map((trade) => trade.context.modeledCostRate));
    const plannedRisk = notional * (Math.abs(entryPrice - stopPrice) / Math.max(entryPrice, 1e-9) + modeledCostRate);
    const constituentKey = trades.map((trade) => trade.id).sort().join("|");
    const leverage = Math.max(1, Math.min(...contributors.map((trade) => trade.leverage)));
    const syntheticId = trades.length === 1 && trades[0].engineId === "CURRENT_V5"
      ? trades[0].engineTradeId
      : `CANONICAL:${symbol}:${side}:${stableHash(constituentKey)}`;
    output[symbol] = {
      ...anchor,
      id: syntheticId,
      eventId: `CANONICAL:${stableHash(constituentKey)}`,
      strategyId: "dual_engine_net",
      strategyName: "双引擎净额",
      side,
      openedAt: Math.max(...trades.map((trade) => trade.openedAt)),
      entryPrice,
      stopPrice,
      activeStopPrice,
      targetPrice,
      notional,
      plannedRisk,
      contracts,
      leverage,
      margin: notional / leverage,
      accountEquityAtOpen: canonicalEquity,
      reason: `唯一PAPER净额；逻辑腿 ${trades.length} 笔（当前版 ${trades.filter((trade) => trade.engineId === "CURRENT_V5").length}，上一版 ${trades.filter((trade) => trade.engineId === "PREVIOUS_V4").length}）`,
      context: { ...anchor.context, modeledCostRate, structuralStopRate: Math.abs(entryPrice - stopPrice) / Math.max(entryPrice, 1e-9) },
    };
  }
  return output;
}
