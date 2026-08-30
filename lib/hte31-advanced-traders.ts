import { classifyHte31AssetRegime, classifyHte31MarketRegime } from "./hte31-regime.ts";
import type {
  Hte31Candle,
  Hte31EntryCheck,
  Hte31EntryPlan,
  Hte31Input,
  Hte31Signal,
  Hte31SignalMetric,
  Hte31TradeSide,
} from "./hte31-types.ts";

export type AdvancedTraderId = "exhaustion_reversal" | "higher_timeframe_swing";

const FIVE_MINUTES = 300_000;

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function candleMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

function completed(input: Hte31Input) {
  return input.candles5m
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .filter((candle) => candleMs(candle.time) + FIVE_MINUTES <= input.observedAt)
    .sort((a, b) => a.time - b.time);
}

function atr(rows: Hte31Candle[], period = 14) {
  if (rows.length <= period) return null;
  const ranges = rows.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - rows[index].close),
    Math.abs(candle.low - rows[index].close),
  ));
  return mean(ranges.slice(-period));
}

function ema(values: number[], period: number) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) result = values[index] * alpha + result * (1 - alpha);
  return result;
}

function signed(value: number | null | undefined, side: Hte31TradeSide) {
  return (value ?? 0) * (side === "LONG" ? 1 : -1);
}

function opposite(side: Hte31TradeSide): Hte31TradeSide {
  return side === "LONG" ? "SHORT" : "LONG";
}

function swingStop(rows: Hte31Candle[], side: Hte31TradeSide, currentAtr: number | null, lookback = 10, padding = 0.18) {
  if (!rows.length || currentAtr == null) return 0;
  const window = rows.slice(-lookback);
  return side === "LONG"
    ? Math.min(...window.map((row) => row.low)) - currentAtr * padding
    : Math.max(...window.map((row) => row.high)) + currentAtr * padding;
}

function hardBlockers(input: Hte31Input) {
  const blockers: string[] = [];
  if (input.dataQuality < 0.68) blockers.push("DATA_UNSAFE");
  if (input.volumeUsd < 12_000_000) blockers.push("LIQUIDITY_TOO_LOW");
  if (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.0015) blockers.push("LEVERAGE_EXTREME");
  if ((input.macroEventRisk ?? 0) >= 0.98) blockers.push("EMERGENCY_EVENT_RISK");
  return blockers;
}

function buildPlan(input: Hte31Input, side: Hte31TradeSide, stop: number, rr: number, minutes: number, checks: Hte31EntryCheck[]): Hte31EntryPlan | null {
  const rows = completed(input);
  const currentAtr = atr(rows);
  const entry = input.futuresPrice;
  if (currentAtr == null || entry <= 0 || stop <= 0) return null;
  const risk = Math.abs(entry - stop);
  const riskPct = risk / entry * 100;
  if (!(risk > 0) || riskPct > 5) return null;
  const direction = side === "LONG" ? 1 : -1;
  const tp1 = entry + direction * risk;
  const tp2 = entry + direction * risk * rr;
  const hard: Hte31EntryCheck[] = [
    { key: "hte-data", label: "数据安全", passed: input.dataQuality >= 0.68, required: true, detail: `${Math.round(input.dataQuality * 100)}%` },
    { key: "hte-liquidity", label: "流动性安全", passed: input.volumeUsd >= 12_000_000, required: true, detail: `${(input.volumeUsd / 1e6).toFixed(1)}M` },
    { key: "hte-funding", label: "杠杆拥挤未失控", passed: input.fundingRate == null || Math.abs(input.fundingRate) < 0.0015, required: true, detail: `${((input.fundingRate ?? 0) * 100).toFixed(4)}%` },
    { key: "hte-event", label: "事件安全", passed: (input.macroEventRisk ?? 0) < 0.98, required: true, detail: `${Math.round((input.macroEventRisk ?? 0) * 100)}` },
    { key: "hte-stop", label: "结构止损距离", passed: riskPct <= 5, required: true, detail: `${riskPct.toFixed(2)}%` },
    ...checks,
  ];
  return {
    ready: hard.every((check) => !check.required || check.passed),
    side,
    entryPrice: entry,
    entryZone: [entry - currentAtr * 0.12, entry + currentAtr * 0.12],
    stopLossPrice: stop,
    takeProfit1Price: tp1,
    takeProfit2Price: tp2,
    riskPerUnit: risk,
    plannedRiskPct: riskPct,
    riskReward: rr,
    maxHoldingMinutes: minutes,
    checks: hard,
    exitRules: [
      { code: "stop_loss", label: "结构止损", condition: `${side === "LONG" ? "价格 ≤" : "价格 ≥"} ${stop}` },
      { code: "breakeven", label: "第一目标保护", condition: `达到 ${tp1} 后从下一观察周期起保护到入场价` },
      { code: "take_profit", label: "第二目标", condition: `达到 ${tp2} 完成退出` },
      { code: "structure_reversal", label: "结构前提失效", condition: "触发该交易员定义的反向结构" },
      { code: "macro_risk", label: "紧急风险退出", condition: "全局风险进入 RED / 紧急事件" },
      { code: "timeout", label: "时间止损", condition: `${minutes} 分钟仍未兑现预期行为则退出` },
    ],
  };
}

function metrics(input: Hte31Input, trader: AdvancedTraderId, details: { structure: number; crowding: number; timing: number }): Hte31SignalMetric[] {
  return [
    { key: "advanced-trader", label: "主交易员", score: 1, detail: trader === "exhaustion_reversal" ? "HT4 Exhaustion / Anti-Crowd" : "HT5 Higher-Timeframe Swing", available: true, category: "cross" },
    { key: "tf-15m", label: "15m 结构", score: input.timeframeTrend15m ?? 0, detail: `${((input.timeframeTrend15m ?? 0) * 100).toFixed(0)}`, available: input.timeframeTrend15m != null, category: "price" },
    { key: "tf-1h", label: "1h 结构", score: input.timeframeTrend1h ?? 0, detail: `${((input.timeframeTrend1h ?? 0) * 100).toFixed(0)}`, available: input.timeframeTrend1h != null, category: "price" },
    { key: "tf-4h", label: "4h 结构", score: input.timeframeTrend4h ?? 0, detail: `${((input.timeframeTrend4h ?? 0) * 100).toFixed(0)}`, available: input.timeframeTrend4h != null, category: "price" },
    { key: "structure-quality", label: "大结构质量", score: details.structure, detail: `${Math.round(details.structure * 100)}%`, available: true, category: "cross" },
    { key: "crowding", label: "拥挤/衰竭", score: details.crowding, detail: `${Math.round(details.crowding * 100)}%`, available: true, category: "derivatives" },
    { key: "timing", label: "短线触发质量", score: details.timing, detail: `${Math.round(details.timing * 100)}%`, available: true, category: "momentum" },
  ];
}

function makeSignal(input: Hte31Input, config: {
  trader: AdvancedTraderId;
  strategyId: "trend_exhaustion_reversal" | "higher_timeframe_swing";
  side: Hte31TradeSide;
  setupActive: boolean;
  setupScore: number;
  evidenceScore: number;
  thesis: string;
  expectedBehavior: string;
  stop: number;
  rr: number;
  minutes: number;
  checks: Hte31EntryCheck[];
  structureQuality: number;
  crowdingQuality: number;
  timingQuality: number;
}): Hte31Signal {
  const regime = classifyHte31MarketRegime(input);
  const assetRegime = classifyHte31AssetRegime(input);
  const blockers = hardBlockers(input);
  const entryPlan = buildPlan(input, config.side, config.stop, config.rr, config.minutes, config.checks);
  const ready = config.setupActive && blockers.length === 0 && Boolean(entryPlan?.ready);
  const direction = config.side === "LONG" ? 1 : -1;
  const failedRequired = entryPlan?.checks.filter((check) => check.required && !check.passed).map((check) => `${check.label}未通过`) ?? [];
  return {
    strategyId: config.strategyId,
    label: config.trader === "exhaustion_reversal" ? "HT4 Exhaustion 反拥挤衰竭" : "HT5 Swing 大周期结构",
    shadowOnly: true,
    state: blockers.length ? "blocked" : ready ? "ready" : "watching",
    side: blockers.length ? "WAIT" : config.side,
    score: Number((direction * clamp(config.setupScore * 0.6 + config.evidenceScore * 0.4) / 100).toFixed(4)),
    confidence: Math.round(clamp(46 + config.setupScore * 0.3 + config.evidenceScore * 0.18 + input.dataQuality * 10)),
    regime,
    thesis: `${config.thesis} 预期行为：${config.expectedBehavior}`,
    reasons: config.checks.filter((check) => check.passed).map((check) => check.label),
    blockers: [...new Set([...blockers, ...failedRequired])],
    entryPlan,
    metrics: metrics(input, config.trader, { structure: config.structureQuality, crowding: config.crowdingQuality, timing: config.timingQuality }),
    strategyMeta: {
      playbookId: config.trader === "exhaustion_reversal" ? "HT4_EXHAUSTION_ANTI_CROWD" : "HT5_HIGHER_TIMEFRAME_SWING",
      assetRegime,
      setupScore: Math.round(clamp(config.setupScore)),
      evidenceScore: Math.round(clamp(config.evidenceScore)),
      triggerActive: config.setupActive,
      hardGatePassed: blockers.length === 0 && Boolean(entryPlan?.ready),
      candidateSide: config.side,
      supportingPlaybooks: [],
      strategyConflict: 0,
    },
  };
}

function exhaustion(input: Hte31Input, rows: Hte31Candle[]): Hte31Signal {
  const currentAtr = atr(rows);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const ema20 = ema(rows.slice(-50).map((row) => row.close), 20);
  const shortTrend = input.timeframeTrend15m ?? input.multiTimeframeTrend ?? 0;
  const crowdedSide: Hte31TradeSide = shortTrend >= 0 ? "LONG" : "SHORT";
  const side = opposite(crowdedSide);
  const direction = crowdedSide === "LONG" ? 1 : -1;
  const stretchAtr = latest && ema20 != null && currentAtr
    ? direction * (latest.close - ema20) / Math.max(currentAtr, Number.EPSILON)
    : 0;
  const shortTrendMature = Math.abs(shortTrend) >= 0.45;
  const stretched = stretchAtr >= 0.72;
  const fundingCrowded = input.fundingRate != null && signed(input.fundingRate, crowdedSide) >= 0.00008;
  const oiCrowded = (input.openInterestChangePct ?? 0) >= 0.8;
  const flowWeak = input.spotCvdRatio != null && signed(input.spotCvdRatio, crowdedSide) <= 0.006;
  const bookWeak = input.orderBookImbalance != null && signed(input.orderBookImbalance, crowdedSide) <= 0.018;
  const oneHour = input.timeframeTrend1h ?? 0;
  const fourHour = input.timeframeTrend4h ?? 0;
  const higherConflict = signed(fourHour, crowdedSide) <= -0.18 || (signed(fourHour, crowdedSide) <= 0.08 && signed(oneHour, crowdedSide) <= 0.12);
  const highIv = (input.optionsIvPercentile ?? 0) >= 0.72;
  const body = latest ? Math.abs(latest.close - latest.open) : 0;
  const upperWick = latest ? latest.high - Math.max(latest.open, latest.close) : 0;
  const lowerWick = latest ? Math.min(latest.open, latest.close) - latest.low : 0;
  const failedContinuation = Boolean(latest && previous && currentAtr && (crowdedSide === "LONG"
    ? latest.close < latest.open && latest.close < previous.close && upperWick >= Math.max(body * 0.65, currentAtr * 0.10)
    : latest.close > latest.open && latest.close > previous.close && lowerWick >= Math.max(body * 0.65, currentAtr * 0.10)));
  const microReversal = Boolean(latest && previous && (side === "SHORT"
    ? latest.close < previous.close && latest.close <= (previous.high + previous.low) / 2
    : latest.close > previous.close && latest.close >= (previous.high + previous.low) / 2));
  const counterVotes = [fundingCrowded, oiCrowded, flowWeak, bookWeak, higherConflict, highIv].filter(Boolean).length;
  const crowdingConfirmed = counterVotes >= 3;
  const setupActive = shortTrendMature && stretched && crowdingConfirmed && failedContinuation && microReversal;
  const structureQuality = clamp((Math.abs(fourHour) * 0.55 + Math.abs(oneHour) * 0.45), 0, 1);
  const crowdingQuality = clamp(counterVotes / 6, 0, 1);
  const timingQuality = failedContinuation && microReversal ? 1 : failedContinuation || microReversal ? 0.5 : 0;
  return makeSignal(input, {
    trader: "exhaustion_reversal",
    strategyId: "trend_exhaustion_reversal",
    side,
    setupActive,
    setupScore: (shortTrendMature ? 20 : 0) + (stretched ? 22 : 0) + (crowdingConfirmed ? 28 : counterVotes * 6) + (failedContinuation ? 18 : 0) + (microReversal ? 12 : 0),
    evidenceScore: 34 + counterVotes * 9 + (higherConflict ? 12 : 0) + (failedContinuation ? 10 : 0),
    thesis: "Exhaustion 不因为市场上涨就盲目做空、下跌就盲目做多；只在短周期共识已经拥挤或过度延伸，并出现继续推进失败后站到共识反面。",
    expectedBehavior: "反向确认后应快速离开拥挤极值；若原趋势重新扩张并突破衰竭极值，立即承认反转判断失败。",
    stop: swingStop(rows, side, currentAtr, 8, 0.20),
    rr: 2.6,
    minutes: 300,
    structureQuality,
    crowdingQuality,
    timingQuality,
    checks: [
      { key: "exhaustion-mature", label: "短周期趋势已经成熟", passed: shortTrendMature, required: true, detail: `15m ${shortTrend.toFixed(2)}` },
      { key: "exhaustion-stretch", label: "价格已经明显远离短期均值", passed: stretched, required: true, detail: `${stretchAtr.toFixed(2)} ATR` },
      { key: "exhaustion-crowding", label: "至少三类拥挤/背离证据", passed: crowdingConfirmed, required: true, detail: `${counterVotes}/6 · Funding/OI/Flow/Book/HTF/IV` },
      { key: "exhaustion-failure", label: "原方向继续推进失败", passed: failedContinuation, required: true, detail: crowdedSide === "LONG" ? "冲高后转弱" : "杀跌后转强" },
      { key: "exhaustion-reversal", label: "5m 已出现反向确认", passed: microReversal, required: true, detail: side === "LONG" ? "反向恢复向上" : "反向恢复向下" },
    ],
  });
}

function higherTimeframeSwing(input: Hte31Input, rows: Hte31Candle[]): Hte31Signal {
  const currentAtr = atr(rows);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const ema20 = ema(rows.slice(-50).map((row) => row.close), 20);
  const t15 = input.timeframeTrend15m ?? input.multiTimeframeTrend ?? 0;
  const t1h = input.timeframeTrend1h ?? input.multiTimeframeTrend ?? 0;
  const t4h = input.timeframeTrend4h ?? input.multiTimeframeTrend ?? 0;
  const side: Hte31TradeSide = t4h >= 0 ? "LONG" : "SHORT";
  const higherDirection = Math.abs(t4h) >= 0.32;
  const oneHourAligned = signed(t1h, side) >= 0.08;
  const tacticalConflict = signed(t15, side) <= 0.18;
  const nearMean = Boolean(latest && ema20 != null && currentAtr && Math.abs(latest.close - ema20) <= currentAtr * 1.15);
  const resumed = Boolean(latest && previous && currentAtr && (side === "LONG"
    ? latest.close > latest.open && latest.close > previous.close && latest.close >= previous.high - currentAtr * 0.08
    : latest.close < latest.open && latest.close < previous.close && latest.close <= previous.low + currentAtr * 0.08));
  const flowOk = input.spotCvdRatio == null || signed(input.spotCvdRatio, side) >= -0.006;
  const bookOk = input.orderBookImbalance == null || signed(input.orderBookImbalance, side) >= -0.08;
  const benchmarkOk = input.benchmarkMomentum == null || signed(input.benchmarkMomentum, side) >= -0.8;
  const breadth = side === "LONG" ? input.marketAdvancingRatio : input.marketDecliningRatio;
  const breadthOk = breadth == null || breadth >= 0.40;
  const setupActive = higherDirection && oneHourAligned && tacticalConflict && nearMean && resumed && flowOk && bookOk && benchmarkOk && breadthOk;
  const structureQuality = clamp(Math.abs(t4h) * 0.62 + Math.max(0, signed(t1h, side)) * 0.38, 0, 1);
  const timingQuality = clamp((tacticalConflict ? 0.35 : 0) + (nearMean ? 0.30 : 0) + (resumed ? 0.35 : 0), 0, 1);
  const crowdingQuality = clamp(Math.max(0, -signed(t15, side)), 0, 1);
  return makeSignal(input, {
    trader: "higher_timeframe_swing",
    strategyId: "higher_timeframe_swing",
    side,
    setupActive,
    setupScore: (higherDirection ? 26 : 0) + (oneHourAligned ? 20 : 0) + (tacticalConflict ? 18 : 0) + (nearMean ? 14 : 0) + (resumed ? 22 : 0),
    evidenceScore: 44 + (flowOk ? 10 : -18) + (bookOk ? 8 : -15) + (benchmarkOk ? 8 : -12) + (breadthOk ? 8 : -12),
    thesis: "Swing 让 1h/4h 决定未来数小时的主要站队方向，15m/5m 只负责等待逆向回撤结束并提供更便宜的入场，而不是用短线噪声覆盖大结构。",
    expectedBehavior: "短线回撤结束后应重新服从 1h/4h 主结构；若 1h 也持续反向或局部结构破坏，则大周期交易前提失效。",
    stop: swingStop(rows, side, currentAtr, 12, 0.22),
    rr: 3.0,
    minutes: 480,
    structureQuality,
    crowdingQuality,
    timingQuality,
    checks: [
      { key: "swing-4h", label: "4h 主结构清晰", passed: higherDirection, required: true, detail: `4h ${t4h.toFixed(2)}` },
      { key: "swing-1h", label: "1h 与大结构一致", passed: oneHourAligned, required: true, detail: `1h ${t1h.toFixed(2)}` },
      { key: "swing-pullback", label: "15m 正处于大趋势逆向回撤", passed: tacticalConflict, required: true, detail: `15m ${t15.toFixed(2)}` },
      { key: "swing-mean", label: "5m 回到可控均值区域", passed: nearMean, required: true, detail: ema20 == null ? "EMA20 --" : `EMA20 ${ema20.toFixed(6)}` },
      { key: "swing-resume", label: "5m 已重新服从大周期", passed: resumed, required: true, detail: side === "LONG" ? "恢复向上" : "恢复向下" },
      { key: "swing-flow", label: "现货与订单簿没有强烈反向压制", passed: flowOk && bookOk, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)} / Book ${signed(input.orderBookImbalance, side).toFixed(3)}` },
      { key: "swing-market", label: "基准与市场广度不逆风", passed: benchmarkOk && breadthOk, required: true, detail: `Benchmark ${signed(input.benchmarkMomentum, side).toFixed(2)} / Breadth ${breadth == null ? "--" : breadth.toFixed(2)}` },
    ],
  });
}

/**
 * Two additional independent traders. They do not vote with HT1-HT3 and do not
 * invert an existing signal mechanically: both require their own structural
 * setup and confirmation before becoming READY.
 */
export function evaluateAdvancedHumanTraders(input: Hte31Input): Hte31Signal[] {
  const rows = completed(input);
  if (rows.length < 34) return [];
  return [exhaustion(input, rows), higherTimeframeSwing(input, rows)];
}
