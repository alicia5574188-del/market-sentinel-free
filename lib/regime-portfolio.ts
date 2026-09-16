import { selectSafeLeverage, type Side } from "./liquidity-core.ts";
import type { GateCandle } from "./gate-market.ts";
import type { ArenaQuote, ArenaTrade, ArenaTradeContext, StrategyFamily } from "./strategy-arena.ts";

export const REGIME_PORTFOLIO_VERSION = 1;
export const REGIME_ROUTE_AUDIT_VERSION = 1 as const;
export const REGIME_ACCOUNT_INITIAL_EQUITY = 1_000;
export const REGIME_HOURLY_REQUIRED_CANDLES = 721;
export const REGIME_FRICTION_RATE = 0.0014;
export const REGIME_ENTRY_SLIPPAGE_RATE = 0.00025;
export const REGIME_UNIVERSE = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT",
  "ADA_USDT", "LINK_USDT", "LTC_USDT", "AVAX_USDT", "BCH_USDT"] as const;
export const REGIME_SATELLITE_UNIVERSE = ["SUI_USDT", "UNI_USDT"] as const;
export const REGIME_EXECUTION_UNIVERSE = [...REGIME_UNIVERSE, ...REGIME_SATELLITE_UNIVERSE] as const;
export const REGIME_SATELLITE_TRADE_RISK_RATE = .005;
export const REGIME_SATELLITE_ACCOUNT_RISK_CAP = .02;
export const REGIME_SATELLITE_DIRECTION_RISK_CAP = .015;
const REGIME_CORE_SET = new Set<string>(REGIME_UNIVERSE);
const REGIME_SATELLITE_SET = new Set<string>(REGIME_SATELLITE_UNIVERSE);

export type RegimeSystemId = "SHOCK_TRANSITION" | "COMPRESSION" | "DIRECTIONAL_TREND"
  | "NON_TREND_EXPANSION" | "BALANCED_ROTATION";

export const REGIME_SYSTEMS: RegimeSystemId[] = ["SHOCK_TRANSITION", "COMPRESSION", "DIRECTIONAL_TREND",
  "NON_TREND_EXPANSION", "BALANCED_ROTATION"];

type ExitModel = "TARGET" | "TRAIL";
export type RegimeStrategy = {
  id: string; name: string; system: RegimeSystemId; tactic: string; family: StrategyFamily;
  stopFloor: number; stopAtr: number; rewardRisk?: number; exitModel: ExitModel; trailScale?: number;
  maxHoldHours: number; params: Record<string, number>;
};

const strategy = (system: RegimeSystemId, id: string, name: string, tactic: string, family: StrategyFamily,
  stopFloor: number, stopAtr: number, rewardRisk: number | undefined, maxHoldHours: number,
  params: Record<string, number>, exitModel: ExitModel = "TARGET", trailScale?: number): RegimeStrategy =>
  ({ system, id, name, tactic, family, stopFloor, stopAtr, rewardRisk, maxHoldHours, params, exitModel, trailScale });

export const REGIME_STRATEGIES: RegimeStrategy[] = [
  strategy("SHOCK_TRANSITION", "shock_transition-aligned_downshock_reversal-14", "共振下跌反转", "ALIGNED_DOWNSHOCK_REVERSAL", "REVERSAL", .06, 6, 1.5, 72, { symbol24: .08, rebound6: .008 }),
  strategy("SHOCK_TRANSITION", "shock_transition-counter_downshock_survivor-15", "逆势抗跌存活", "COUNTER_DOWNSHOCK_SURVIVOR", "REVERSAL", .06, 6, 2.2, 96, { relative24: .05, rebound6: .004 }),
  strategy("COMPRESSION", "compression-false_release-4", "压缩假释放", "FALSE_RELEASE", "RANGE", .03, 5, 1.5, 48, { volume: 1.1, reclaim: .005 }),
  strategy("COMPRESSION", "compression-quiet_pullback_resume-21", "静默回撤恢复", "QUIET_PULLBACK_RESUME", "RANGE", .03, 5, 2.2, 96, { relative7: .05, pullbackMin: .003, pullbackMax: .01, resume6: .006 }),
  strategy("DIRECTIONAL_TREND", "directional_trend-bear-market_rebound-12", "空头市场反弹", "BEAR_MARKET_REBOUND", "TREND", .03, 5, 1.5, 72, { drop24: .05, rebound6: .008 }),
  strategy("DIRECTIONAL_TREND", "directional_trend-bull-relative_momentum-7", "多头相对动量", "BULL_RELATIVE_MOMENTUM", "TREND", .06, 6, undefined, 168, { relative7: .03, confirm24: .005 }, "TRAIL", .8),
  strategy("DIRECTIONAL_TREND", "directional_trend-bear-breakdown_trail-2", "空头破位跟踪", "BEAR_BREAKDOWN_TRAIL", "TREND", .10, 8, undefined, 720, { symbol30: .08, breadth: .30 }, "TRAIL", .6),
  strategy("DIRECTIONAL_TREND", "directional_trend-bear-defensive_relative-2", "空头防守相对强弱", "BEAR_DEFENSIVE_RELATIVE", "TREND", .05, 5, 1.5, 72, { relative7: .03, confirm6: 0 }),
  strategy("NON_TREND_EXPANSION", "non_trend_expansion-refined_breadth_continuation-10", "扩散延续", "REFINED_BREADTH_CONTINUATION", "FAST", .035, 5, 2, 72, { symbol24: .055, impulse6: .003 }),
  strategy("NON_TREND_EXPANSION", "non_trend_expansion-expansion_defender-14", "扩张防守", "EXPANSION_DEFENDER", "REVERSAL", .05, 5, 1.5, 72, { relative24: .04, resume6: .004 }),
  strategy("BALANCED_ROTATION", "balanced_rotation-relative_pullback_resume-4", "相对回撤恢复", "RELATIVE_PULLBACK_RESUME", "RANGE", .03, 5, 1.5, 96, { relative7: .04, pullbackMin: .003, pullbackMax: .01, resume6: .006 }),
  strategy("BALANCED_ROTATION", "balanced_rotation-short_horizon_reversal-8", "短周期反转", "SHORT_HORIZON_REVERSAL", "REVERSAL", .03, 5, 1.5, 72, { relative24: .05, reversal6: .003 }),
];

export const REGIME_SYSTEM_META: Record<RegimeSystemId, { name: string; description: string }> = {
  SHOCK_TRANSITION: { name: "冲击转折系统", description: "覆盖市场共振急涨急跌与方向切换" },
  COMPRESSION: { name: "波动压缩系统", description: "覆盖低波动蓄势、假突破与恢复" },
  DIRECTIONAL_TREND: { name: "方向趋势系统", description: "覆盖中长期多空趋势、破位与反弹" },
  NON_TREND_EXPANSION: { name: "非趋势扩张系统", description: "覆盖尚未形成长期趋势的波动扩散" },
  BALANCED_ROTATION: { name: "平衡轮动系统", description: "覆盖其余平衡、轮动和相对强弱行情" },
};

export type RegimeAccountState = {
  id: RegimeSystemId; startedAt: number; equity: number; resolved: number; wins: number; grossPnl: number; costs: number;
  open: Record<string, ArenaTrade>; recent: ArenaTrade[]; archived: ArenaTrade[];
  cooldowns: Record<string, number>; admissionRejects: Record<string, number>;
};

export type RegimeContext = { at: number; regime: RegimeSystemId; median24: number; median7: number; median30: number;
  breadth24: number; breadth7: number; breadth30: number; compression: number; markets: number };

export type RegimePortfolioState = {
  version: 1; auditVersion?: 1; startedAt: number; lastEvaluatedHour: number | null; currentContext: RegimeContext | null;
  warmMarkets: number; accounts: Record<RegimeSystemId, RegimeAccountState>; routeChecks: RegimeRouteCheck[];
};

export type RegimeRouteCheck = { id: string; eventId: string; strategyId: string; strategyName: string; symbol: string;
  observedAt: number; status: "FORMING" | "BLOCKED" | "OPEN"; blocker: string | null; side: Side | null;
  environment: RegimeSystemId; score: number; reason: string; engineId: RegimeSystemId; engineName: string;
  entryPrice: number | null; stopPrice: number | null; targetPrice: number | null };

export type RegimeContractMeta = { quantoMultiplier: number; maintenanceRate: number; leverageMax: number; fundingRate?: number; volume24hUsd?: number };

const account = (id: RegimeSystemId, now: number): RegimeAccountState => ({ id, startedAt: now,
  equity: REGIME_ACCOUNT_INITIAL_EQUITY, resolved: 0, wins: 0, grossPnl: 0, costs: 0, open: {}, recent: [], archived: [],
  cooldowns: {}, admissionRejects: {} });

export function initialRegimePortfolio(now = Date.now()): RegimePortfolioState {
  return { version: REGIME_PORTFOLIO_VERSION, auditVersion: REGIME_ROUTE_AUDIT_VERSION,
    startedAt: now, lastEvaluatedHour: null, currentContext: null,
    warmMarkets: 0, accounts: Object.fromEntries(REGIME_SYSTEMS.map((id) => [id, account(id, now)])) as Record<RegimeSystemId, RegimeAccountState>,
    routeChecks: [] };
}

export function normalizeRegimePortfolio(value: RegimePortfolioState | null | undefined, now = Date.now()): RegimePortfolioState {
  const fresh = initialRegimePortfolio(now);
  if (!value || value.version !== REGIME_PORTFOLIO_VERSION) return fresh;
  return { ...fresh, ...value, auditVersion: REGIME_ROUTE_AUDIT_VERSION,
    lastEvaluatedHour: value.auditVersion === REGIME_ROUTE_AUDIT_VERSION ? value.lastEvaluatedHour : null,
    accounts: Object.fromEntries(REGIME_SYSTEMS.map((id) => [id, {
    ...fresh.accounts[id], ...(value.accounts?.[id] ?? {}), id,
  }])) as Record<RegimeSystemId, RegimeAccountState>, routeChecks: (value.routeChecks ?? []).map((row) => ({
    ...row, entryPrice: row.entryPrice ?? null, stopPrice: row.stopPrice ?? null, targetPrice: row.targetPrice ?? null,
  })) };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
};
const sign = (value: number) => value > 0 ? 1 : value < 0 ? -1 : 0;
const ret = (rows: GateCandle[], index: number, hours: number) => rows[index].close / rows[index - hours].close - 1;
const rangeRate = (row: GateCandle) => (row.high - row.low) / Math.max(row.close, 1e-12);

export function classifyRegime(context: Omit<RegimeContext, "at" | "regime">): RegimeSystemId {
  const aligned24 = Math.max(context.breadth24, 1 - context.breadth24);
  if (Math.abs(context.median24) >= .04 || (Math.abs(context.median24) >= .02 && aligned24 >= .82)) return "SHOCK_TRANSITION";
  if (context.compression <= .68 && Math.abs(context.median24) < .025) return "COMPRESSION";
  if ((context.median30 >= .08 && context.median7 >= .015 && context.breadth30 >= .60)
    || (context.median30 <= -.08 && context.median7 <= -.015 && context.breadth30 <= .40)) return "DIRECTIONAL_TREND";
  if (Math.abs(context.median24) >= .018 || aligned24 >= .75) return "NON_TREND_EXPANSION";
  return "BALANCED_ROTATION";
}

type Feature = { symbol: string; current: GateCandle; r1: number; r6: number; r24: number; r7d: number; r30d: number;
  atr6: number; compression: number; volumeBurst: number; high24: number; low24: number; high7d: number; low7d: number;
  relative24: number; relative7: number; context: RegimeContext };
type FoundSignal = { direction: 1 | -1; strength: number };
type SignalReadiness = { direction: 1 | -1 | null; score: number; reason: string };
type TradeGeometry = { entryPrice: number; stopPrice: number; targetPrice: number; stopRate: number; targetRate: number };

function synchronizedFeatures(paths: Record<string, GateCandle[]>) {
  const eligible = Object.entries(paths).filter(([, rows]) => rows.length >= REGIME_HOURLY_REQUIRED_CANDLES);
  const contextEligible = eligible.filter(([symbol]) => REGIME_CORE_SET.has(symbol));
  if (contextEligible.length < 8) return null;
  const commonTime = Math.min(...contextEligible.map(([, rows]) => rows.at(-1)!.time));
  const rows: Omit<Feature, "relative24" | "relative7" | "context">[] = [];
  for (const [symbol, path] of eligible) {
    const index = path.findIndex((row) => row.time === commonTime);
    if (index < 720) continue;
    let contiguous = true;
    for (let offset = index - 720; offset < index; offset += 1) if (path[offset + 1].time !== path[offset].time + 3_600) { contiguous = false; break; }
    if (!contiguous) continue;
    const current = path[index]; const prior24 = path.slice(index - 24, index); const prior7 = path.slice(index - 168, index);
    const currentRanges = path.slice(index - 5, index + 1).map(rangeRate);
    const baselineRanges = path.slice(index - 168, index - 6).map(rangeRate);
    const recentVolume = sum(path.slice(index - 5, index + 1).map((row) => row.volume)) / 6;
    const baselineVolume = sum(path.slice(index - 48, index - 6).map((row) => row.volume)) / 42;
    rows.push({ symbol, current, r1: ret(path, index, 1), r6: ret(path, index, 6), r24: ret(path, index, 24),
      r7d: ret(path, index, 168), r30d: ret(path, index, 720), atr6: median(currentRanges),
      compression: median(currentRanges) / Math.max(median(baselineRanges), 1e-9),
      volumeBurst: recentVolume / Math.max(baselineVolume, 1e-9), high24: Math.max(...prior24.map((row) => row.high)),
      low24: Math.min(...prior24.map((row) => row.low)), high7d: Math.max(...prior7.map((row) => row.high)),
      low7d: Math.min(...prior7.map((row) => row.low)) });
  }
  const contextRows = rows.filter((row) => REGIME_CORE_SET.has(row.symbol));
  if (contextRows.length < 8) return null;
  const base = { median24: median(contextRows.map((row) => row.r24)), median7: median(contextRows.map((row) => row.r7d)),
    median30: median(contextRows.map((row) => row.r30d)), breadth24: contextRows.filter((row) => row.r24 > 0).length / contextRows.length,
    breadth7: contextRows.filter((row) => row.r7d > 0).length / contextRows.length,
    breadth30: contextRows.filter((row) => row.r30d > 0).length / contextRows.length,
    compression: median(contextRows.map((row) => row.compression)), markets: contextRows.length };
  const context: RegimeContext = { ...base, at: commonTime * 1_000, regime: classifyRegime(base) };
  return { context, features: rows.map((row) => ({ ...row, relative24: row.r24 - context.median24,
    relative7: row.r7d - context.median7, context })) as Feature[] };
}

function signal(config: RegimeStrategy, f: Feature): FoundSignal | null {
  const p = config.params;
  if (config.tactic === "ALIGNED_DOWNSHOCK_REVERSAL") {
    if (f.context.median24 >= 0 || f.context.median30 >= 0 || f.r24 > -p.symbol24 || f.r6 < p.rebound6) return null;
    return { direction: 1, strength: -f.r24 + f.r6 };
  }
  if (config.tactic === "COUNTER_DOWNSHOCK_SURVIVOR") {
    if (f.context.median24 >= 0 || f.context.median30 <= 0 || f.relative24 < p.relative24 || f.r6 < p.rebound6) return null;
    return { direction: 1, strength: f.relative24 + f.r6 };
  }
  if (config.tactic === "FALSE_RELEASE") {
    if (f.volumeBurst < p.volume) return null;
    const highFail = f.current.high > f.high24 && f.current.close < f.high24 * (1 - p.reclaim);
    const lowFail = f.current.low < f.low24 && f.current.close > f.low24 * (1 + p.reclaim);
    if (highFail === lowFail) return null;
    return { direction: highFail ? -1 : 1, strength: f.volumeBurst + Math.abs(f.r1) };
  }
  if (config.tactic === "QUIET_PULLBACK_RESUME" || config.tactic === "RELATIVE_PULLBACK_RESUME") {
    const direction = sign(f.relative7) as 1 | -1; const pullback = direction * f.r24;
    if (!direction || Math.abs(f.relative7) < p.relative7 || pullback > -p.pullbackMin || pullback < -p.pullbackMax
      || direction * f.r6 < p.resume6) return null;
    return { direction, strength: Math.abs(f.relative7) + Math.abs(f.r24) + direction * f.r6 };
  }
  if (config.tactic === "BEAR_MARKET_REBOUND") {
    if (f.context.median30 >= 0 || f.r24 > -p.drop24 || f.r6 < p.rebound6) return null;
    return { direction: 1, strength: -f.r24 + f.r6 };
  }
  if (config.tactic === "BULL_RELATIVE_MOMENTUM") {
    const direction = sign(f.relative7) as 1 | -1;
    if (f.context.median30 <= 0 || !direction || Math.abs(f.relative7) < p.relative7
      || direction * f.relative24 < p.confirm24) return null;
    return { direction, strength: Math.abs(f.relative7) + direction * f.relative24 };
  }
  if (config.tactic === "BEAR_BREAKDOWN_TRAIL") {
    if (f.context.median30 >= 0 || f.r30d > -p.symbol30 || f.context.breadth30 > p.breadth || f.current.close >= f.low7d) return null;
    return { direction: -1, strength: -f.r30d + (1 - f.context.breadth30) * .02 };
  }
  if (config.tactic === "BEAR_DEFENSIVE_RELATIVE") {
    if (f.context.median30 >= 0 || -f.relative7 < p.relative7 || -f.r6 < p.confirm6) return null;
    return { direction: 1, strength: -f.relative7 - f.r6 };
  }
  if (config.tactic === "REFINED_BREADTH_CONTINUATION") {
    const direction = sign(f.context.median24) as 1 | -1; const boundary = direction > 0 ? f.high24 : f.low24;
    if (!direction || sign(f.r24) !== direction || Math.abs(f.r24) < p.symbol24 || direction * f.r6 < p.impulse6
      || direction * (f.current.close / boundary - 1) < 0) return null;
    return { direction, strength: Math.abs(f.r24) + direction * f.r6 };
  }
  if (config.tactic === "EXPANSION_DEFENDER") {
    const marketDirection = sign(f.context.median24); const direction = -marketDirection as 1 | -1;
    if (!marketDirection || direction * f.relative24 < p.relative24 || direction * f.r6 < p.resume6) return null;
    return { direction, strength: direction * f.relative24 + direction * f.r6 };
  }
  if (config.tactic === "SHORT_HORIZON_REVERSAL") {
    const original = sign(f.relative24); const direction = -original as 1 | -1;
    if (!original || Math.abs(f.relative24) < p.relative24 || direction * f.r6 < p.reversal6) return null;
    return { direction, strength: Math.abs(f.relative24) + direction * f.r6 };
  }
  return null;
}

function percent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function readiness(config: RegimeStrategy, f: Feature): SignalReadiness {
  const p = config.params;
  let direction: 1 | -1 | null = null;
  let checks: Array<[boolean, string]> = [];
  if (config.tactic === "ALIGNED_DOWNSHOCK_REVERSAL") {
    direction = 1;
    checks = [[f.context.median24 < 0, `市场24h中位数需<0（当前${percent(f.context.median24)}）`],
      [f.context.median30 < 0, `市场30d中位数需<0（当前${percent(f.context.median30)}）`],
      [f.r24 <= -p.symbol24, `币种24h需≤-${percent(p.symbol24)}（当前${percent(f.r24)}）`],
      [f.r6 >= p.rebound6, `6h反弹需≥${percent(p.rebound6)}（当前${percent(f.r6)}）`]];
  } else if (config.tactic === "COUNTER_DOWNSHOCK_SURVIVOR") {
    direction = 1;
    checks = [[f.context.median24 < 0, `市场24h中位数需<0（当前${percent(f.context.median24)}）`],
      [f.context.median30 > 0, `市场30d中位数需>0（当前${percent(f.context.median30)}）`],
      [f.relative24 >= p.relative24, `24h相对强度需≥${percent(p.relative24)}（当前${percent(f.relative24)}）`],
      [f.r6 >= p.rebound6, `6h反弹需≥${percent(p.rebound6)}（当前${percent(f.r6)}）`]];
  } else if (config.tactic === "FALSE_RELEASE") {
    const highFail = f.current.high > f.high24 && f.current.close < f.high24 * (1 - p.reclaim);
    const lowFail = f.current.low < f.low24 && f.current.close > f.low24 * (1 + p.reclaim);
    direction = highFail ? -1 : lowFail ? 1 : f.current.high > f.high24 ? -1 : f.current.low < f.low24 ? 1 : null;
    checks = [[f.volumeBurst >= p.volume, `6h量能倍数需≥${p.volume.toFixed(2)}（当前${f.volumeBurst.toFixed(2)}）`],
      [highFail !== lowFail, `需出现且仅出现一侧24h假突破回收（当前${highFail ? "上沿回收" : lowFail ? "下沿回收" : "未回收"}）`]];
  } else if (config.tactic === "QUIET_PULLBACK_RESUME" || config.tactic === "RELATIVE_PULLBACK_RESUME") {
    const relativeDirection = sign(f.relative7);
    direction = relativeDirection === 0 ? null : relativeDirection;
    const pullback = (direction ?? 0) * f.r24;
    checks = [[direction != null, `7d相对方向需明确（当前${percent(f.relative7)}）`],
      [Math.abs(f.relative7) >= p.relative7, `7d相对强度绝对值需≥${percent(p.relative7)}（当前${percent(Math.abs(f.relative7))}）`],
      [pullback <= -p.pullbackMin, `24h回撤需≥${percent(p.pullbackMin)}（当前${percent(-pullback)}）`],
      [pullback >= -p.pullbackMax, `24h回撤需≤${percent(p.pullbackMax)}（当前${percent(-pullback)}）`],
      [(direction ?? 0) * f.r6 >= p.resume6, `6h恢复需≥${percent(p.resume6)}（当前${percent((direction ?? 0) * f.r6)}）`]];
  } else if (config.tactic === "BEAR_MARKET_REBOUND") {
    direction = 1;
    checks = [[f.context.median30 < 0, `市场30d中位数需<0（当前${percent(f.context.median30)}）`],
      [f.r24 <= -p.drop24, `币种24h需≤-${percent(p.drop24)}（当前${percent(f.r24)}）`],
      [f.r6 >= p.rebound6, `6h反弹需≥${percent(p.rebound6)}（当前${percent(f.r6)}）`]];
  } else if (config.tactic === "BULL_RELATIVE_MOMENTUM") {
    const relativeDirection = sign(f.relative7);
    direction = relativeDirection === 0 ? null : relativeDirection;
    checks = [[f.context.median30 > 0, `市场30d中位数需>0（当前${percent(f.context.median30)}）`],
      [direction != null, `7d相对方向需明确（当前${percent(f.relative7)}）`],
      [Math.abs(f.relative7) >= p.relative7, `7d相对强度绝对值需≥${percent(p.relative7)}（当前${percent(Math.abs(f.relative7))}）`],
      [(direction ?? 0) * f.relative24 >= p.confirm24, `24h同向确认需≥${percent(p.confirm24)}（当前${percent((direction ?? 0) * f.relative24)}）`]];
  } else if (config.tactic === "BEAR_BREAKDOWN_TRAIL") {
    direction = -1;
    checks = [[f.context.median30 < 0, `市场30d中位数需<0（当前${percent(f.context.median30)}）`],
      [f.r30d <= -p.symbol30, `币种30d需≤-${percent(p.symbol30)}（当前${percent(f.r30d)}）`],
      [f.context.breadth30 <= p.breadth, `30d上涨广度需≤${percent(p.breadth)}（当前${percent(f.context.breadth30)}）`],
      [f.current.close < f.low7d, `收盘需跌破7d低点（当前${f.current.close.toFixed(5)} / ${f.low7d.toFixed(5)}）`]];
  } else if (config.tactic === "BEAR_DEFENSIVE_RELATIVE") {
    direction = 1;
    checks = [[f.context.median30 < 0, `市场30d中位数需<0（当前${percent(f.context.median30)}）`],
      [-f.relative7 >= p.relative7, `7d防守相对强度需≥${percent(p.relative7)}（当前${percent(-f.relative7)}）`],
      [-f.r6 >= p.confirm6, `6h确认需≥${percent(p.confirm6)}（当前${percent(-f.r6)}）`]];
  } else if (config.tactic === "REFINED_BREADTH_CONTINUATION") {
    const marketDirection = sign(f.context.median24);
    direction = marketDirection === 0 ? null : marketDirection;
    const boundary = direction === 1 ? f.high24 : f.low24;
    checks = [[direction != null, `市场24h方向需明确（当前${percent(f.context.median24)}）`],
      [direction != null && sign(f.r24) === direction, `币种24h需与市场同向（当前${percent(f.r24)}）`],
      [Math.abs(f.r24) >= p.symbol24, `币种24h幅度需≥${percent(p.symbol24)}（当前${percent(Math.abs(f.r24))}）`],
      [(direction ?? 0) * f.r6 >= p.impulse6, `6h同向脉冲需≥${percent(p.impulse6)}（当前${percent((direction ?? 0) * f.r6)}）`],
      [direction != null && direction * (f.current.close / boundary - 1) >= 0, `收盘需越过24h边界（当前${f.current.close.toFixed(5)} / ${boundary.toFixed(5)}）`]];
  } else if (config.tactic === "EXPANSION_DEFENDER") {
    const marketDirection = sign(f.context.median24);
    direction = marketDirection ? -marketDirection as 1 | -1 : null;
    checks = [[marketDirection !== 0, `市场24h方向需明确（当前${percent(f.context.median24)}）`],
      [(direction ?? 0) * f.relative24 >= p.relative24, `逆市场24h相对强度需≥${percent(p.relative24)}（当前${percent((direction ?? 0) * f.relative24)}）`],
      [(direction ?? 0) * f.r6 >= p.resume6, `6h恢复需≥${percent(p.resume6)}（当前${percent((direction ?? 0) * f.r6)}）`]];
  } else if (config.tactic === "SHORT_HORIZON_REVERSAL") {
    const original = sign(f.relative24);
    direction = original ? -original as 1 | -1 : null;
    checks = [[original !== 0, `24h相对方向需明确（当前${percent(f.relative24)}）`],
      [Math.abs(f.relative24) >= p.relative24, `24h相对偏离需≥${percent(p.relative24)}（当前${percent(Math.abs(f.relative24))}）`],
      [(direction ?? 0) * f.r6 >= p.reversal6, `6h反转需≥${percent(p.reversal6)}（当前${percent((direction ?? 0) * f.r6)}）`]];
  }
  const passed = checks.filter(([ok]) => ok).length;
  const missing = checks.filter(([ok]) => !ok).map(([, label]) => label);
  return { direction, score: checks.length ? Math.round(passed / checks.length * 100) : 0,
    reason: `满足 ${passed}/${checks.length} 项冻结条件${missing.length ? `；待满足：${missing.join("；")}` : ""}` };
}

function tradeGeometry(config: RegimeStrategy, feature: Feature, found: FoundSignal, marketPrice: number): TradeGeometry {
  const entryPrice = marketPrice * (1 + found.direction * REGIME_ENTRY_SLIPPAGE_RATE);
  const stopRate = Math.min(.20, Math.max(config.stopFloor, config.stopAtr * feature.atr6));
  const stopPrice = entryPrice * (1 - found.direction * stopRate);
  const targetRate = config.exitModel === "TRAIL" ? Math.min(.8, Math.max(stopRate * 10, .5))
    : Math.max(stopRate * (config.rewardRisk ?? 1.5), REGIME_FRICTION_RATE * 2.2);
  return { entryPrice, stopPrice, targetPrice: entryPrice * (1 + found.direction * targetRate), stopRate, targetRate };
}

function quotePrice(quote: ArenaQuote | undefined, side: Side, now: number) {
  if (!quote || quote.fresh === false || quote.observedAt == null || now - quote.observedAt > 8_000) return null;
  const value = side === "LONG" ? quote.bestAsk : quote.bestBid;
  return value && value > 0 ? value : null;
}

const openRisk = (account: RegimeAccountState, side?: Side) => Object.values(account.open)
  .filter((trade) => !side || trade.side === side).reduce((total, trade) => total + trade.plannedRisk, 0);

function block(account: RegimeAccountState, code: string) {
  account.admissionRejects[code] = (account.admissionRejects[code] ?? 0) + 1;
  return code;
}

function makeTrade(config: RegimeStrategy, feature: Feature, found: FoundSignal, account: RegimeAccountState,
  quote: ArenaQuote, meta: RegimeContractMeta, now: number): { trade: ArenaTrade | null; blocker: string | null; geometry: TradeGeometry | null } {
  const side: Side = found.direction > 0 ? "LONG" : "SHORT";
  const marketPrice = quotePrice(quote, side, now);
  if (!marketPrice) return { trade: null, blocker: block(account, "STALE_QUOTE"), geometry: null };
  const geometry = tradeGeometry(config, feature, found, marketPrice);
  if (account.open[feature.symbol]) return { trade: null, blocker: block(account, "SYMBOL_OCCUPIED"), geometry };
  if ((account.cooldowns[`${config.id}:${feature.symbol}`] ?? 0) > now) return { trade: null, blocker: block(account, "COOLDOWN"), geometry };
  const spread = quote.bestBid && quote.bestAsk ? (quote.bestAsk - quote.bestBid) / Math.max(marketPrice, 1e-9) : Infinity;
  if (spread > .0012) return { trade: null, blocker: block(account, "SPREAD"), geometry };
  const multiplier = Math.max(meta.quantoMultiplier, 1e-12);
  const { entryPrice, stopPrice, targetPrice, stopRate, targetRate } = geometry;
  const satellite = REGIME_SATELLITE_SET.has(feature.symbol);
  const tradeRiskRate = satellite ? REGIME_SATELLITE_TRADE_RISK_RATE : .015;
  const notionalMultiple = Math.min(satellite ? .20 : .5,
    tradeRiskRate / Math.max(stopRate + REGIME_FRICTION_RATE, 1e-9));
  if (notionalMultiple < .05) return { trade: null, blocker: block(account, "MIN_NOTIONAL"), geometry };
  const contractNotional = entryPrice * multiplier;
  const contracts = Math.floor(account.equity * notionalMultiple / contractNotional);
  if (contracts < 1) return { trade: null, blocker: block(account, "MIN_CONTRACT"), geometry };
  const notional = contracts * contractNotional;
  const plannedRisk = notional * (stopRate + REGIME_FRICTION_RATE);
  if (satellite) {
    const satelliteOpen = Object.values(account.open).filter((row) => REGIME_SATELLITE_SET.has(row.symbol));
    const satelliteRisk = satelliteOpen.reduce((total, row) => total + row.plannedRisk, 0);
    const satelliteSideRisk = satelliteOpen.filter((row) => row.side === side)
      .reduce((total, row) => total + row.plannedRisk, 0);
    if (satelliteRisk + plannedRisk > account.equity * REGIME_SATELLITE_ACCOUNT_RISK_CAP + 1e-8
      || satelliteSideRisk + plannedRisk > account.equity * REGIME_SATELLITE_DIRECTION_RISK_CAP + 1e-8) {
      return { trade: null, blocker: block(account, "SATELLITE_RISK_CAP"), geometry };
    }
  }
  if (openRisk(account) + plannedRisk > account.equity * .10 + 1e-8
    || openRisk(account, side) + plannedRisk > account.equity * .065 + 1e-8) return { trade: null, blocker: block(account, "RISK_CAP"), geometry };
  const leverage = selectSafeLeverage({ notional, equity: account.equity, entry: entryPrice, invalidation: stopPrice,
    maintenanceRate: meta.maintenanceRate, leverageMax: meta.leverageMax });
  const context: ArenaTradeContext = { channel: config.system === "COMPRESSION" ? "COMPRESSION" : config.system === "BALANCED_ROTATION" ? "RANGE"
    : config.system === "DIRECTIONAL_TREND" ? "TREND" : "ANOMALY", regime: config.system === "COMPRESSION" ? "COMPRESSION"
      : config.system === "BALANCED_ROTATION" ? "RANGE" : config.system === "DIRECTIONAL_TREND" ? "TREND" : "EXPANSION",
    anomalyKind: null, entryStyle: "CONFIRM", exitProfile: config.exitModel === "TRAIL" ? "STRUCTURE" : "FAST",
    candidateScore: Math.round(found.strength * 1_000), trendRate: feature.r30d, trendEfficiency: 0,
    volatilityRatio: feature.compression, rangePosition: 0, openInterestChangeRate: 0,
    volume24hUsd: meta.volume24hUsd ?? 0, fundingRate: meta.fundingRate ?? 0, alignedFlow: 0, confirmation: 1,
    fakeoutRisk: 0, rangeId: `${config.system}:${feature.context.at}`, modeledCostRate: REGIME_FRICTION_RATE,
    spreadRate: spread, bidDepthUsd: 0, askDepthUsd: 0, structureSource: "CANDLE_5M", grossRewardRate: targetRate,
    structuralStopRate: stopRate, netRewardRisk: (targetRate - REGIME_FRICTION_RATE) / (stopRate + REGIME_FRICTION_RATE),
    costShare: REGIME_FRICTION_RATE / Math.max(targetRate, 1e-9), empiricalExpectedReturnRate: 0,
    empiricalProfitFactor: 0, empiricalEvents: 0, entryTrigger: entryPrice, feeSlippageRate: REGIME_FRICTION_RATE,
    maxHoldMs: config.maxHoldHours * 3_600_000, noProgressMs: config.maxHoldHours * 3_600_000,
    profitArmIsNotExit: config.exitModel === "TRAIL" };
  const eventId = `${config.system}:${feature.context.at}:${feature.symbol}:${config.id}`;
  return { blocker: null, geometry, trade: { id: `REGIME:${eventId}`, strategyId: config.id, strategyName: config.name,
    family: config.family, lane: "PORTFOLIO", eventId, symbol: feature.symbol, side, status: "OPEN", openedAt: now,
    closedAt: null, entryPrice, stopPrice, targetPrice, exitPrice: null, outcome: null, grossReturnRate: null,
    netReturnRate: null, netPnl: null, notional, maxFavorableRate: 0, maxAdverseRate: 0, lastPrice: entryPrice,
    selectedForPortfolio: true, reason: `${REGIME_SYSTEM_META[config.system].name}直接信号；${config.name}`,
    context, admissionTier: "NORMAL", plannedRisk, contracts, quantoMultiplier: multiplier,
    leverage: leverage.leverage, margin: leverage.margin, accountEquityAtOpen: account.equity,
    activeStopPrice: stopPrice, profitArmedAt: null, orientation: "NORMAL" } };
}

function closeTrade(account: RegimeAccountState, trade: ArenaTrade, price: number, now: number,
  outcome: NonNullable<ArenaTrade["outcome"]>) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const grossReturnRate = direction * (price - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
  const netReturnRate = grossReturnRate - REGIME_FRICTION_RATE;
  const netPnl = trade.notional * netReturnRate;
  const closed = { ...trade, status: "CLOSED" as const, closedAt: now, exitPrice: price, outcome,
    grossReturnRate, netReturnRate, netPnl, lastPrice: price };
  delete account.open[trade.symbol]; account.equity = Math.max(.01, account.equity + netPnl);
  account.resolved += 1; account.wins += Number(netPnl > 0); account.grossPnl += trade.notional * grossReturnRate;
  account.costs += trade.notional * REGIME_FRICTION_RATE;
  account.cooldowns[`${trade.strategyId}:${trade.symbol}`] = now + 24 * 3_600_000;
  account.recent = [closed, ...account.recent].slice(0, 200);
}

export function advanceRegimePortfolio(input: { state: RegimePortfolioState; quotes: Record<string, ArenaQuote>; now: number }) {
  const state = normalizeRegimePortfolio(input.state, input.now);
  for (const account of Object.values(state.accounts)) for (const trade of Object.values(account.open)) {
    const quote = input.quotes[trade.symbol]; const price = quotePrice(quote, trade.side === "LONG" ? "SHORT" : "LONG", input.now);
    if (!price) continue;
    const direction = trade.side === "LONG" ? 1 : -1;
    const move = direction * (price - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
    trade.lastPrice = price; trade.maxFavorableRate = Math.max(trade.maxFavorableRate, move);
    trade.maxAdverseRate = Math.min(trade.maxAdverseRate, move);
    const stop = trade.activeStopPrice ?? trade.stopPrice;
    const stopped = trade.side === "LONG" ? price <= stop : price >= stop;
    const targeted = trade.side === "LONG" ? price >= trade.targetPrice : price <= trade.targetPrice;
    const timedOut = input.now - trade.openedAt >= (trade.context.maxHoldMs ?? 72 * 3_600_000);
    if (stopped) { closeTrade(account, trade, stop, input.now, trade.profitArmedAt ? "RUNNER_EXIT" : "STOP"); continue; }
    if (trade.context.profitArmIsNotExit === false && targeted) { closeTrade(account, trade, trade.targetPrice, input.now, "TARGET"); continue; }
    const completedCandle = quote.completedMinuteAt != null && quote.completedMinuteAt !== trade.lastSoftEvidenceAt;
    if (trade.context.profitArmIsNotExit === true && completedCandle) {
      trade.lastSoftEvidenceAt = quote.completedMinuteAt!;
      const config = REGIME_STRATEGIES.find((row) => row.id === trade.strategyId)!;
      const stopRate = trade.context.structuralStopRate;
      const extreme = trade.side === "LONG" ? trade.entryPrice * (1 + trade.maxFavorableRate) : trade.entryPrice * (1 - trade.maxFavorableRate);
      const candidate = extreme * (1 - direction * stopRate * (config.trailScale ?? .8));
      trade.activeStopPrice = trade.side === "LONG" ? Math.max(stop, candidate) : Math.min(stop, candidate);
      if (trade.maxFavorableRate > 0) trade.profitArmedAt ??= input.now;
    }
    if (timedOut) closeTrade(account, trade, price, input.now, "EDGE_DECAY");
  }
  return state;
}

export function evaluateRegimePortfolio(input: { state: RegimePortfolioState; hourly: Record<string, GateCandle[]>;
  quotes: Record<string, ArenaQuote>; contracts: Record<string, RegimeContractMeta>; now: number; allowNewEntries?: boolean }) {
  const state = advanceRegimePortfolio({ state: input.state, quotes: input.quotes, now: input.now });
  const synchronized = synchronizedFeatures(input.hourly);
  state.warmMarkets = REGIME_UNIVERSE.filter((symbol) => (input.hourly[symbol]?.length ?? 0) >= REGIME_HOURLY_REQUIRED_CANDLES).length;
  if (!synchronized || state.lastEvaluatedHour === synchronized.context.at) return state;
  state.currentContext = synchronized.context;
  if (input.allowNewEntries === false) {
    state.lastEvaluatedHour = synchronized.context.at;
    state.routeChecks = [];
    return state;
  }
  const accountState = state.accounts[synchronized.context.regime];
  const strategies = REGIME_STRATEGIES.filter((row) => row.system === synchronized.context.regime);
  const candidates = synchronized.features.flatMap((feature) => strategies.flatMap((config) => {
    const found = signal(config, feature); return found ? [{ feature, config, found }] : [];
  })).sort((left, right) => Number(REGIME_SATELLITE_SET.has(left.feature.symbol))
    - Number(REGIME_SATELLITE_SET.has(right.feature.symbol))
    || right.found.strength - left.found.strength || left.config.id.localeCompare(right.config.id));
  const forming = synchronized.features.flatMap((feature) => strategies.flatMap((config) => {
    if (signal(config, feature)) return [];
    return [{ feature, config, readiness: readiness(config, feature) }];
  })).sort((left, right) => right.readiness.score - left.readiness.score || left.config.id.localeCompare(right.config.id));
  const checks: RegimeRouteCheck[] = [];
  let transientBlock = false;
  for (const candidate of candidates) {
    const meta = input.contracts[candidate.feature.symbol]; const quote = input.quotes[candidate.feature.symbol];
    const side: Side = candidate.found.direction > 0 ? "LONG" : "SHORT";
    const fallbackPrice = quote ? quotePrice(quote, side, input.now) : null;
    const result = meta && quote ? makeTrade(candidate.config, candidate.feature, candidate.found, accountState, quote, meta, input.now)
      : { trade: null, blocker: block(accountState, !meta ? "CONTRACT" : "STALE_QUOTE"),
        geometry: fallbackPrice ? tradeGeometry(candidate.config, candidate.feature, candidate.found, fallbackPrice) : null };
    if (result.trade) accountState.open[result.trade.symbol] = result.trade;
    if (result.blocker === "STALE_QUOTE" || result.blocker === "CONTRACT") transientBlock = true;
    const name = REGIME_SYSTEM_META[candidate.config.system].name;
    checks.push({ id: `${candidate.feature.context.at}:${candidate.config.id}:${candidate.feature.symbol}`,
      eventId: `${candidate.config.system}:${candidate.feature.context.at}`, strategyId: candidate.config.id,
      strategyName: candidate.config.name, symbol: candidate.feature.symbol, observedAt: input.now,
      status: result.trade ? "OPEN" : "BLOCKED", blocker: result.blocker, side, environment: candidate.config.system,
      score: Math.round(candidate.found.strength * 1_000), reason: `${name}已识别${candidate.config.name}信号`,
      engineId: candidate.config.system, engineName: name, entryPrice: result.geometry?.entryPrice ?? null,
      stopPrice: result.geometry?.stopPrice ?? null, targetPrice: result.geometry?.targetPrice ?? null });
  }
  if (!transientBlock) state.lastEvaluatedHour = synchronized.context.at;
  const formingChecks: RegimeRouteCheck[] = forming.slice(0, 10).map(({ feature, config, readiness: row }) => ({
    id: `${feature.context.at}:${config.id}:${feature.symbol}`, eventId: `${config.system}:${feature.context.at}`,
    strategyId: config.id, strategyName: config.name, symbol: feature.symbol, observedAt: input.now, status: "FORMING",
    blocker: null, side: row.direction == null ? null : row.direction > 0 ? "LONG" : "SHORT", environment: config.system,
    score: row.score, reason: row.reason, engineId: config.system, engineName: REGIME_SYSTEM_META[config.system].name,
    entryPrice: null, stopPrice: null, targetPrice: null,
  }));
  const historical = state.routeChecks.filter((row) => row.status !== "FORMING" && input.now - row.observedAt < 24 * 3_600_000);
  state.routeChecks = [...new Map([...checks, ...formingChecks, ...historical].map((row) => [row.id, row])).values()].slice(0, 200);
  return state;
}

export function resetRegimePortfolio(input: { state: RegimePortfolioState; quotes: Record<string, ArenaQuote>; now: number }) {
  const state = normalizeRegimePortfolio(input.state, input.now);
  for (const accountState of Object.values(state.accounts)) {
    for (const trade of Object.values(accountState.open)) {
      const quote = input.quotes[trade.symbol]; const price = quotePrice(quote, trade.side === "LONG" ? "SHORT" : "LONG", input.now);
      if (!price) throw new Error(`${trade.symbol} 行情不新鲜，不能重置五系统模拟账户`);
      closeTrade(accountState, trade, price, input.now, "RESET");
    }
    accountState.archived = [...accountState.archived, ...accountState.recent].slice(-200);
  }
  const fresh = initialRegimePortfolio(input.now);
  for (const id of REGIME_SYSTEMS) fresh.accounts[id].archived = state.accounts[id].archived;
  return fresh;
}

export function regimePortfolioSummary(state: RegimePortfolioState) {
  const normalized = normalizeRegimePortfolio(state);
  return { version: normalized.version, startedAt: normalized.startedAt, currentContext: normalized.currentContext,
    warmMarkets: normalized.warmMarkets, lastEvaluatedHour: normalized.lastEvaluatedHour,
    systems: REGIME_SYSTEMS.map((id) => ({ id, name: REGIME_SYSTEM_META[id].name,
      description: REGIME_SYSTEM_META[id].description, initialEquity: REGIME_ACCOUNT_INITIAL_EQUITY,
      portfolioEquity: normalized.accounts[id].equity, portfolioOpen: Object.values(normalized.accounts[id].open),
      portfolioResolved: normalized.accounts[id].resolved, portfolioWins: normalized.accounts[id].wins,
      portfolioGrossPnl: normalized.accounts[id].grossPnl, portfolioCosts: normalized.accounts[id].costs,
      recentPortfolio: normalized.accounts[id].recent, archivedPortfolioTrades: normalized.accounts[id].archived,
      strategies: REGIME_STRATEGIES.filter((row) => row.system === id).map((row) => ({ ...row, lane: "ACTIVE", enabled: true })) })),
    currentRouteChecks: normalized.routeChecks, rules: { outcomeBasedPromotion: false, shadowExecution: false,
      perSystemInitialEquity: REGIME_ACCOUNT_INITIAL_EQUITY, mutuallyExclusiveRegimes: true, exhaustiveRegimeCoverage: true,
      singleTradeRiskRate: .015, portfolioRiskCap: .10, correlatedRiskCap: .065, orderCopyRate: 1,
      coreUniverse: [...REGIME_UNIVERSE], satelliteUniverse: [...REGIME_SATELLITE_UNIVERSE],
      satelliteTradeRiskRate: REGIME_SATELLITE_TRADE_RISK_RATE,
      satelliteAccountRiskCap: REGIME_SATELLITE_ACCOUNT_RISK_CAP,
      satelliteCorrelatedRiskCap: REGIME_SATELLITE_DIRECTION_RISK_CAP } };
}
