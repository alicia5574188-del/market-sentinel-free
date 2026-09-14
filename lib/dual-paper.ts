import type { Side } from "./liquidity-core.ts";
import { arenaSummary as currentArenaSummary, type ArenaTrade, type StrategyArenaState } from "./strategy-arena.ts";
import { arenaSummary as previousArenaSummary, type ArenaTrade as PreviousArenaTrade,
  type StrategyArenaState as PreviousStrategyArenaState } from "./previous-strategy-arena.ts";
import { REGIME_SYSTEM_META, REGIME_SYSTEMS, regimePortfolioSummary,
  type RegimePortfolioState, type RegimeSystemId } from "./regime-portfolio.ts";

export const DUAL_PAPER_VERSION = 4;
export const ENGINE_INITIAL_EQUITY = 1_000;
export const CANONICAL_PAPER_REFERENCE_EQUITY = 10_000;
export const CANONICAL_PAPER_STATE_VERSION = 1;
const CANONICAL_HISTORY_LIMIT = 200;

export type StrategyEngineId = RegimeSystemId | "CURRENT_V5" | "PREVIOUS_V4";
export type EngineTaggedTrade = ArenaTrade & {
  engineId: StrategyEngineId;
  engineName: string;
  engineTradeId: string;
};

export type CanonicalPaperCopy = {
  id: string;
  engineId: StrategyEngineId;
  engineTradeId: string;
  scale: number;
  accountEquityAtOpen: number;
  copiedAt: number;
  trade: EngineTaggedTrade;
};

export type CanonicalPaperState = {
  version: typeof CANONICAL_PAPER_STATE_VERSION;
  startedAt: number;
  equity: number;
  resolved: number;
  wins: number;
  grossPnl: number;
  costs: number;
  open: Record<string, CanonicalPaperCopy>;
  recent: EngineTaggedTrade[];
  archived: EngineTaggedTrade[];
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

function taggedTrade(engineId: StrategyEngineId, value: ArenaTrade | PreviousArenaTrade): EngineTaggedTrade {
  const trade = value as ArenaTrade;
  return { ...trade, id: `${engineId}:${trade.id}`, eventId: `${engineId}:${trade.eventId}`,
    engineId, engineName: ENGINE_META[engineId].name, engineTradeId: trade.id };
}

function taggedTrades(engineId: StrategyEngineId, values: Array<ArenaTrade | PreviousArenaTrade>) {
  return values.map((trade) => taggedTrade(engineId, trade));
}

function sourceOpen(accounts: DualPaperAccounts) {
  return [
    ...REGIME_SYSTEMS.flatMap((id) => taggedTrades(id, Object.values(accounts.regime.accounts[id].open))),
    ...taggedTrades("CURRENT_V5", Object.values(accounts.current.portfolioOpen)),
    ...taggedTrades("PREVIOUS_V4", Object.values(accounts.previous.portfolioOpen)),
  ].sort((left, right) => left.openedAt - right.openedAt || left.id.localeCompare(right.id));
}

function sourceClosed(accounts: DualPaperAccounts) {
  return [
    ...REGIME_SYSTEMS.flatMap((id) => taggedTrades(id, [
      ...accounts.regime.accounts[id].recent, ...accounts.regime.accounts[id].archived,
    ])),
    ...taggedTrades("CURRENT_V5", [...accounts.current.recentPortfolio, ...accounts.current.archivedPortfolioTrades]),
    ...taggedTrades("PREVIOUS_V4", [...accounts.previous.recentPortfolio, ...accounts.previous.archivedPortfolioTrades]),
  ];
}

function scaledTrade(source: EngineTaggedTrade, scale: number, accountEquityAtOpen: number): EngineTaggedTrade {
  return {
    ...source,
    notional: source.notional * scale,
    plannedRisk: source.plannedRisk * scale,
    contracts: source.contracts * scale,
    margin: source.margin * scale,
    netPnl: source.netPnl == null ? null : source.netPnl * scale,
    accountEquityAtOpen,
  };
}

export function initialCanonicalPaperState(now = Date.now()): CanonicalPaperState {
  return { version: CANONICAL_PAPER_STATE_VERSION, startedAt: now, equity: CANONICAL_PAPER_REFERENCE_EQUITY,
    resolved: 0, wins: 0, grossPnl: 0, costs: 0, open: {}, recent: [], archived: [] };
}

export function normalizeCanonicalPaperState(value: CanonicalPaperState | null | undefined, now = Date.now()) {
  if (!value || value.version !== CANONICAL_PAPER_STATE_VERSION || !(value.equity > 0)) return initialCanonicalPaperState(now);
  return {
    ...value,
    open: Object.fromEntries(Object.entries(value.open ?? {}).filter(([, copy]) => copy?.trade && copy.scale > 0)),
    recent: (value.recent ?? []).slice(0, CANONICAL_HISTORY_LIMIT),
    archived: (value.archived ?? []).slice(0, CANONICAL_HISTORY_LIMIT),
  };
}

/**
 * Every source account decides and sizes from its own isolated equity. The
 * canonical account copies the source's notional/equity fraction against one
 * canonical-equity snapshot. That scale is frozen for the whole position, so
 * unrelated PnL cannot resize an already-open order.
 */
export function reconcileCanonicalPaper(input: { state: CanonicalPaperState; accounts: DualPaperAccounts; now: number }) {
  const state = normalizeCanonicalPaperState(structuredClone(input.state), input.now);
  const openSources = new Map(sourceOpen(input.accounts).map((trade) => [trade.id, trade]));
  const closedSources = new Map(sourceClosed(input.accounts).map((trade) => [trade.id, trade]));
  const closedCopies: EngineTaggedTrade[] = [];

  for (const [id, copy] of Object.entries(state.open)) {
    if (openSources.has(id)) continue;
    const closed = closedSources.get(id);
    if (!closed || closed.status !== "CLOSED" || closed.netPnl == null) continue;
    const scaled = scaledTrade(closed, copy.scale, copy.accountEquityAtOpen);
    closedCopies.push(scaled);
    delete state.open[id];
    state.equity = Math.max(0.01, state.equity + scaled.netPnl!);
    state.resolved += 1;
    if (scaled.netPnl! > 0) state.wins += 1;
    const grossPnl = scaled.notional * (scaled.grossReturnRate ?? 0);
    state.grossPnl += grossPnl;
    state.costs += Math.max(0, grossPnl - scaled.netPnl!);
  }

  // All orders first observed in one reconciliation pass use the same account
  // snapshot; iteration order cannot grant a later signal a different balance.
  const equitySnapshot = state.equity;
  for (const source of openSources.values()) {
    if (state.open[source.id]) continue;
    const sourceEquity = Math.max(0.01, source.accountEquityAtOpen);
    const scale = equitySnapshot / sourceEquity;
    const copied = scaledTrade(source, scale, equitySnapshot);
    state.open[source.id] = { id: source.id, engineId: source.engineId, engineTradeId: source.engineTradeId,
      scale, accountEquityAtOpen: equitySnapshot, copiedAt: input.now, trade: copied };
  }

  if (closedCopies.length) {
    const combined = [...closedCopies, ...state.recent]
      .sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt));
    state.recent = combined.slice(0, CANONICAL_HISTORY_LIMIT);
    state.archived = [...combined.slice(CANONICAL_HISTORY_LIMIT), ...state.archived]
      .slice(0, CANONICAL_HISTORY_LIMIT);
  }
  return { state, changed: closedCopies.length > 0 || Object.keys(state.open).length !== Object.keys(input.state.open ?? {}).length };
}

export function canonicalPaperOpen(accounts: DualPaperAccounts, state: CanonicalPaperState) {
  const sources = new Map(sourceOpen(accounts).map((trade) => [trade.id, trade]));
  return Object.values(state.open).map((copy) => {
    const source = sources.get(copy.id);
    return source ? scaledTrade(source, copy.scale, copy.accountEquityAtOpen) : copy.trade;
  }).sort((left, right) => right.openedAt - left.openedAt);
}

export function canonicalPaperSummary(accounts: DualPaperAccounts, state: CanonicalPaperState) {
  const current = currentArenaSummary(accounts.current);
  const previous = previousArenaSummary(accounts.previous);
  const regime = regimePortfolioSummary(accounts.regime);
  const engineSummaries = regime.systems.map((system) => ({ ...system, strategyVersion: "REGIME-1",
    offlineValidation: {} }));
  return {
    ...current,
    version: regime.version,
    dualPaperVersion: DUAL_PAPER_VERSION,
    systemName: "五行情独立账户组合",
    currentContext: regime.currentContext,
    warmMarkets: regime.warmMarkets,
    lastEvaluatedHour: regime.lastEvaluatedHour,
    initialEquity: CANONICAL_PAPER_REFERENCE_EQUITY,
    portfolioEquity: state.equity,
    portfolioResolved: state.resolved,
    portfolioWins: state.wins,
    portfolioGrossPnl: state.grossPnl,
    portfolioCosts: state.costs,
    portfolioOpen: canonicalPaperOpen(accounts, state),
    recentPortfolio: state.recent,
    archivedPortfolioTrades: state.archived,
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
      canonicalCopySizing: "SOURCE_EQUITY_FRACTION", canonicalEntryScaleFrozen: true,
      canonicalAdmissionGate: false, canonicalCapitalAgnostic: false,
      liveSource: "CANONICAL_PAPER_NORMALIZED_NET", legacyEnginesOpenDrainOnly: true },
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
 * PAPER retains every logical leg. Gate single-position mode receives the net
 * of their equity fractions, which the existing LIVE entry path applies to
 * actual Gate equity. Absolute PAPER dollars therefore never leak into LIVE.
 */
export function canonicalLivePortfolio(accounts: DualPaperAccounts, state: CanonicalPaperState) {
  const bySymbol = Object.groupBy(canonicalPaperOpen(accounts, state), (trade) => trade.symbol);
  const output: Record<string, ArenaTrade> = {};
  for (const [symbol, all] of Object.entries(bySymbol)) {
    const trades = all ?? [];
    const signedFraction = trades.reduce((total, trade) => total
      + (trade.side === "LONG" ? 1 : -1) * trade.notional / Math.max(trade.accountEquityAtOpen, 0.01), 0);
    if (Math.abs(signedFraction) < 1e-9) continue;
    const side: Side = signedFraction > 0 ? "LONG" : "SHORT";
    const contributors = trades.filter((trade) => trade.side === side);
    if (!contributors.length) continue;
    const anchor = [...contributors].sort((left, right) => right.openedAt - left.openedAt)[0];
    const fractionWeight = (trade: EngineTaggedTrade) => trade.notional / Math.max(trade.accountEquityAtOpen, 0.01);
    const totalWeight = contributors.reduce((total, trade) => total + fractionWeight(trade), 0);
    const entryPrice = contributors.reduce((total, trade) => total + trade.entryPrice * fractionWeight(trade), 0)
      / Math.max(1e-9, totalWeight);
    const stopPrice = structuralStop(side, contributors);
    const activeStopPrice = protectiveStop(side, contributors);
    const targetPrice = closestTarget(side, contributors);
    const quantoMultiplier = anchor.quantoMultiplier;
    const notional = Math.abs(signedFraction) * CANONICAL_PAPER_REFERENCE_EQUITY;
    const contracts = notional / Math.max(entryPrice * quantoMultiplier, 1e-9);
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
      reason: `唯一PAPER净额；逻辑腿 ${trades.length} 笔，按各自系统开仓权益比例复制`,
      context: { ...anchor.context, modeledCostRate, structuralStopRate: Math.abs(entryPrice - stopPrice) / Math.max(entryPrice, 1e-9) },
    };
  }
  return output;
}
