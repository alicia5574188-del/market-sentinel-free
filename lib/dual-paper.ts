import type { Side } from "./liquidity-core.ts";
import { arenaSummary as currentArenaSummary, type ArenaTrade, type StrategyArenaState } from "./strategy-arena.ts";
import { arenaSummary as previousArenaSummary, type ArenaTrade as PreviousArenaTrade,
  type StrategyArenaState as PreviousStrategyArenaState } from "./previous-strategy-arena.ts";
import { REGIME_ACCOUNT_INITIAL_EQUITY, REGIME_SYSTEM_META, REGIME_SYSTEMS, regimePortfolioSummary,
  type RegimePortfolioState, type RegimeSystemId } from "./regime-portfolio.ts";

export const DUAL_PAPER_VERSION = 3;
export const ENGINE_INITIAL_EQUITY = 1_000;
export const CANONICAL_PAPER_REFERENCE_EQUITY = 1_000;
export const ENGINE_ORDER_COPY_RATE = 1;

export type StrategyEngineId = RegimeSystemId | "CURRENT_V5" | "PREVIOUS_V4";
export type EngineTaggedTrade = ArenaTrade & {
  engineId: StrategyEngineId;
  engineName: string;
  engineTradeId: string;
};

export type DualPaperAccounts = {
  current: StrategyArenaState;
  previous: PreviousStrategyArenaState;
  regime: RegimePortfolioState;
};

const ENGINE_META: Record<StrategyEngineId, { name: string; strategyVersion: string }> = {
  CURRENT_V5: { name: "当前上线版 V5", strategyVersion: "V5" },
  PREVIOUS_V4: { name: "上一版 V4", strategyVersion: "V4" },
  ...Object.fromEntries(REGIME_SYSTEMS.map((id) => [id, { name: REGIME_SYSTEM_META[id].name,
    strategyVersion: "REGIME-1" }])) as Record<RegimeSystemId, { name: string; strategyVersion: string }>,
};

function taggedTrade(engineId: StrategyEngineId, value: ArenaTrade | PreviousArenaTrade, copyRate = 1): EngineTaggedTrade {
  const trade = value as ArenaTrade;
  return { ...trade, id: `${engineId}:${trade.id}`, eventId: `${engineId}:${trade.eventId}`,
    notional: trade.notional * copyRate, plannedRisk: trade.plannedRisk * copyRate,
    contracts: trade.contracts * copyRate, margin: trade.margin * copyRate,
    netPnl: trade.netPnl == null ? null : trade.netPnl * copyRate,
    accountEquityAtOpen: copyRate === 1 ? trade.accountEquityAtOpen : CANONICAL_PAPER_REFERENCE_EQUITY,
    engineId, engineName: ENGINE_META[engineId].name, engineTradeId: trade.id };
}

function taggedTrades(engineId: StrategyEngineId, values: Array<ArenaTrade | PreviousArenaTrade>, copyRate = 1) {
  return values.map((trade) => taggedTrade(engineId, trade, copyRate));
}

export function canonicalPaperOpen(accounts: DualPaperAccounts) {
  return [
    ...REGIME_SYSTEMS.flatMap((id) => taggedTrades(id, Object.values(accounts.regime.accounts[id].open), ENGINE_ORDER_COPY_RATE)),
    ...taggedTrades("CURRENT_V5", Object.values(accounts.current.portfolioOpen), ENGINE_ORDER_COPY_RATE),
    ...taggedTrades("PREVIOUS_V4", Object.values(accounts.previous.portfolioOpen), ENGINE_ORDER_COPY_RATE),
  ].sort((left, right) => right.openedAt - left.openedAt);
}

export function canonicalPaperEquity(accounts: DualPaperAccounts) {
  return CANONICAL_PAPER_REFERENCE_EQUITY
    + REGIME_SYSTEMS.reduce((total, id) => total + accounts.regime.accounts[id].equity - REGIME_ACCOUNT_INITIAL_EQUITY, 0)
    + (accounts.current.portfolioEquity - ENGINE_INITIAL_EQUITY) * ENGINE_ORDER_COPY_RATE
    + (accounts.previous.portfolioEquity - ENGINE_INITIAL_EQUITY) * ENGINE_ORDER_COPY_RATE;
}

export function canonicalPaperSummary(accounts: DualPaperAccounts) {
  const current = currentArenaSummary(accounts.current);
  const previous = previousArenaSummary(accounts.previous);
  const regime = regimePortfolioSummary(accounts.regime);
  const engineSummaries = regime.systems.map((system) => ({ ...system, strategyVersion: "REGIME-1",
    offlineValidation: {} }));
  const regimeRecent = regime.systems.flatMap((system) => taggedTrades(system.id, system.recentPortfolio));
  const regimeArchived = regime.systems.flatMap((system) => taggedTrades(system.id, system.archivedPortfolioTrades));
  return {
    ...current,
    version: regime.version,
    dualPaperVersion: DUAL_PAPER_VERSION,
    systemName: "五行情独立账户组合",
    currentContext: regime.currentContext,
    warmMarkets: regime.warmMarkets,
    lastEvaluatedHour: regime.lastEvaluatedHour,
    initialEquity: CANONICAL_PAPER_REFERENCE_EQUITY,
    portfolioEquity: canonicalPaperEquity(accounts),
    portfolioResolved: current.portfolioResolved + previous.portfolioResolved + regime.systems.reduce((sum, row) => sum + row.portfolioResolved, 0),
    portfolioWins: current.portfolioWins + previous.portfolioWins + regime.systems.reduce((sum, row) => sum + row.portfolioWins, 0),
    portfolioGrossPnl: (current.portfolioGrossPnl + previous.portfolioGrossPnl) * ENGINE_ORDER_COPY_RATE
      + regime.systems.reduce((sum, row) => sum + row.portfolioGrossPnl, 0),
    portfolioCosts: (current.portfolioCosts + previous.portfolioCosts) * ENGINE_ORDER_COPY_RATE
      + regime.systems.reduce((sum, row) => sum + row.portfolioCosts, 0),
    portfolioOpen: canonicalPaperOpen(accounts),
    recentPortfolio: [
      ...regimeRecent,
      ...taggedTrades("CURRENT_V5", current.recentPortfolio, ENGINE_ORDER_COPY_RATE),
      ...taggedTrades("PREVIOUS_V4", previous.recentPortfolio, ENGINE_ORDER_COPY_RATE),
    ].sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt)).slice(0, 200),
    archivedPortfolioTrades: [
      ...regimeArchived,
      ...taggedTrades("CURRENT_V5", current.archivedPortfolioTrades, ENGINE_ORDER_COPY_RATE),
      ...taggedTrades("PREVIOUS_V4", previous.archivedPortfolioTrades, ENGINE_ORDER_COPY_RATE),
    ].sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt)).slice(0, 200),
    openShadow: [], recentShadow: [], observationShadow: [], blockedCandidates: [],
    strategies: regime.systems.flatMap((system) => system.strategies.map((row) => ({ ...row, engineId: system.id,
      engineName: system.name }))),
    playbooks: [], transitions: [], currentRouteChecks: regime.currentRouteChecks,
    shadowCount: 0,
    activeCount: regime.systems.reduce((sum, row) => sum + row.strategies.length, 0),
    reverseActiveCount: 0,
    sleepingCount: 0,
    catalogSize: regime.systems.reduce((sum, row) => sum + row.strategies.length, 0),
    playbookCount: regime.systems.reduce((sum, row) => sum + row.strategies.length, 0),
    paperCount: regime.systems.reduce((sum, row) => sum + row.strategies.length, 0),
    verifiedCount: regime.systems.reduce((sum, row) => sum + row.strategies.length, 0),
    engines: engineSummaries,
    retiredEngines: [
      { id: "CURRENT_V5" as const, name: ENGINE_META.CURRENT_V5.name, portfolioEquity: current.portfolioEquity,
        portfolioOpen: current.portfolioOpen, portfolioResolved: current.portfolioResolved },
      { id: "PREVIOUS_V4" as const, name: ENGINE_META.PREVIOUS_V4.name, portfolioEquity: previous.portfolioEquity,
        portfolioOpen: previous.portfolioOpen, portfolioResolved: previous.portfolioResolved },
    ],
    rules: { ...current.rules, ...regime.rules, dualIndependentEngines: false, independentSystemCount: REGIME_SYSTEMS.length,
      engineInitialEquity: ENGINE_INITIAL_EQUITY,
      canonicalReferenceEquity: CANONICAL_PAPER_REFERENCE_EQUITY, sameSymbolCrossEngineAllowed: true,
      engineOrderCopyRate: ENGINE_ORDER_COPY_RATE, canonicalCapitalAgnostic: true,
      liveSource: "CANONICAL_PAPER_NET", legacyEnginesOpenDrainOnly: true },
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
 * The canonical PAPER execution mirror copies every engine order at 100% and
 * keeps every logical leg without applying its own capital or risk gate. Gate
 * runs in single-position mode, so LIVE receives one deterministic net position per symbol.
 * A changed constituent set changes the synthetic id, making the existing
 * reconciliation close and reopen the new net instead of silently retaining
 * stale size or direction.
 */
export function canonicalLivePortfolio(accounts: DualPaperAccounts) {
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
      strategyId: "regime_system_net",
      strategyName: "五行情系统净额",
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
      accountEquityAtOpen: CANONICAL_PAPER_REFERENCE_EQUITY,
      reason: `唯一PAPER净额；逻辑腿 ${trades.length} 笔，全部按各系统原始张数100%复制`,
      context: { ...anchor.context, modeledCostRate, structuralStopRate: Math.abs(entryPrice - stopPrice) / Math.max(entryPrice, 1e-9) },
    };
  }
  return output;
}
