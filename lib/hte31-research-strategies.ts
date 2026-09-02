import { classifyHte31AssetRegime, classifyHte31MarketRegime } from "./hte31-regime.ts";
import type {
  Hte31AssetRegime,
  Hte31Candle,
  Hte31EntryCheck,
  Hte31EntryPlan,
  Hte31Input,
  Hte31MarketRegime,
  Hte31TradeSide,
} from "./hte31-types.ts";
import {
  HTE31_RESEARCH_STRATEGIES,
  type Hte31ResearchStrategyId,
  type Hte31ResearchTraderId,
} from "./hte31-strategy-catalog.ts";

const FIVE_MINUTES = 300_000;

export type Hte31ResearchSignal = {
  traderId: Hte31ResearchTraderId;
  strategyId: Hte31ResearchStrategyId;
  label: string;
  state: "ready" | "watching" | "blocked";
  side: Hte31TradeSide | "WAIT";
  confidence: number;
  thesis: string;
  reasons: string[];
  blockers: string[];
  assetRegime: Hte31AssetRegime;
  regime: Hte31MarketRegime;
  entryPlan: Hte31EntryPlan | null;
};

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function candleMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

function completed(input: Hte31Input) {
  return input.candles5m
    .filter((row) => [row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite))
    .filter((row) => candleMs(row.time) + FIVE_MINUTES <= input.observedAt)
    .sort((a, b) => a.time - b.time);
}

function atr(rows: Hte31Candle[], period = 14) {
  if (rows.length <= period) return null;
  const ranges = rows.slice(1).map((row, index) => Math.max(
    row.high - row.low,
    Math.abs(row.high - rows[index].close),
    Math.abs(row.low - rows[index].close),
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

function volumeRatio(rows: Hte31Candle[], index = rows.length - 1) {
  if (index < 20 || !rows[index]) return 1;
  const baseline = mean(rows.slice(Math.max(0, index - 20), index).map((row) => row.volume));
  return rows[index].volume / Math.max(baseline, Number.EPSILON);
}

function signed(value: number | null | undefined, side: Hte31TradeSide) {
  return (value ?? 0) * (side === "LONG" ? 1 : -1);
}

function direction(side: Hte31TradeSide) {
  return side === "LONG" ? 1 : -1;
}

function hardBlockers(input: Hte31Input) {
  const blockers: string[] = [];
  if (input.dataQuality < 0.68) blockers.push("DATA_UNSAFE");
  if (input.volumeUsd < 12_000_000) blockers.push("LIQUIDITY_TOO_LOW");
  if (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.0015) blockers.push("LEVERAGE_EXTREME");
  if ((input.macroEventRisk ?? 0) >= 0.98) blockers.push("EMERGENCY_EVENT_RISK");
  return blockers;
}

function swingStop(rows: Hte31Candle[], side: Hte31TradeSide, currentAtr: number, lookback: number, padding = 0.18) {
  const window = rows.slice(-lookback);
  if (!window.length) return 0;
  return side === "LONG"
    ? Math.min(...window.map((row) => row.low)) - currentAtr * padding
    : Math.max(...window.map((row) => row.high)) + currentAtr * padding;
}

function buildPlan(
  input: Hte31Input,
  rows: Hte31Candle[],
  side: Hte31TradeSide,
  stop: number,
  rr: number,
  maxHoldingMinutes: number,
  checks: Hte31EntryCheck[],
): Hte31EntryPlan | null {
  const currentAtr = atr(rows);
  const entry = input.futuresPrice;
  if (currentAtr == null || !(entry > 0 && stop > 0)) return null;
  if (side === "LONG" ? stop >= entry : stop <= entry) return null;
  const risk = Math.abs(entry - stop);
  const riskPct = risk / entry * 100;
  if (!(risk > 0) || riskPct > 6) return null;
  const d = direction(side);
  const hardChecks: Hte31EntryCheck[] = [
    { key: "research-data", label: "数据安全", passed: input.dataQuality >= 0.68, required: true, detail: `${Math.round(input.dataQuality * 100)}%` },
    { key: "research-liquidity", label: "流动性安全", passed: input.volumeUsd >= 12_000_000, required: true, detail: `${(input.volumeUsd / 1e6).toFixed(1)}M` },
    { key: "research-funding", label: "杠杆未失控", passed: input.fundingRate == null || Math.abs(input.fundingRate) < 0.0015, required: true, detail: `${((input.fundingRate ?? 0) * 100).toFixed(4)}%` },
    { key: "research-event", label: "事件风险安全", passed: (input.macroEventRisk ?? 0) < 0.98, required: true, detail: `${Math.round((input.macroEventRisk ?? 0) * 100)}` },
    { key: "research-stop", label: "结构止损可执行", passed: riskPct <= 6, required: true, detail: `${riskPct.toFixed(2)}%` },
    ...checks,
  ];
  return {
    ready: hardChecks.every((check) => !check.required || check.passed),
    side,
    entryPrice: entry,
    entryZone: [entry - currentAtr * 0.12, entry + currentAtr * 0.12],
    stopLossPrice: stop,
    takeProfit1Price: entry + d * risk,
    takeProfit2Price: entry + d * risk * rr,
    riskPerUnit: risk,
    plannedRiskPct: riskPct,
    riskReward: rr,
    maxHoldingMinutes,
    checks: hardChecks,
    exitRules: [
      { code: "stop_loss", label: "结构止损", condition: `${side === "LONG" ? "价格 ≤" : "价格 ≥"} ${stop}` },
      { code: "breakeven", label: "第一目标保护", condition: "达到 +1R 后从下一观察周期保护入场价" },
      { code: "take_profit", label: "研究目标", condition: `达到 +${rr.toFixed(1)}R` },
      { code: "structure_reversal", label: "Setup 失效", condition: "用于入场的结构前提被明确破坏" },
      { code: "timeout", label: "时间失效", condition: `${maxHoldingMinutes} 分钟内未兑现预期行为` },
    ],
  };
}

function makeSignal(input: Hte31Input, config: {
  traderId: Hte31ResearchTraderId;
  strategyId: Hte31ResearchStrategyId;
  side: Hte31TradeSide;
  active: boolean;
  confidence: number;
  thesis: string;
  reasons: string[];
  checks: Hte31EntryCheck[];
  stop: number;
  rr: number;
  maxHoldingMinutes: number;
}): Hte31ResearchSignal {
  const rows = completed(input);
  const blockers = hardBlockers(input);
  const plan = buildPlan(input, rows, config.side, config.stop, config.rr, config.maxHoldingMinutes, config.checks);
  const ready = config.active && blockers.length === 0 && Boolean(plan?.ready);
  const catalog = HTE31_RESEARCH_STRATEGIES.find((item) => item.traderId === config.traderId)!;
  return {
    traderId: config.traderId,
    strategyId: config.strategyId,
    label: catalog.label,
    state: blockers.length ? "blocked" : ready ? "ready" : "watching",
    side: blockers.length ? "WAIT" : config.side,
    confidence: Math.round(clamp(config.confidence / 100, 0, 1) * 100),
    thesis: config.thesis,
    reasons: config.reasons,
    blockers: [...blockers, ...config.checks.filter((check) => check.required && !check.passed).map((check) => check.label)],
    assetRegime: classifyHte31AssetRegime(input),
    regime: classifyHte31MarketRegime(input),
    entryPlan: plan,
  };
}

function trendSide(input: Hte31Input, minimum = 0.18): Hte31TradeSide {
  const oneHour = input.timeframeTrend1h ?? input.multiTimeframeTrend ?? 0;
  return oneHour >= minimum ? "LONG" : oneHour <= -minimum ? "SHORT" : (oneHour >= 0 ? "LONG" : "SHORT");
}

function ht1BreakoutAcceptance(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const currentAtr = atr(rows) ?? 0;
  const side = trendSide(input, 0.18);
  const prior = rows.slice(-39, -3);
  const recent = rows.slice(-3);
  const level = side === "LONG" ? Math.max(...prior.map((row) => row.high)) : Math.min(...prior.map((row) => row.low));
  const accepted = recent.filter((row) => side === "LONG" ? row.close > level : row.close < level).length >= 2;
  const displacement = recent.length && currentAtr > 0
    ? direction(side) * (recent.at(-1)!.close - level) / currentAtr
    : 0;
  const oneHour = signed(input.timeframeTrend1h, side);
  const fifteen = signed(input.timeframeTrend15m, side);
  const flowHostile = signed(input.spotCvdRatio, side) < -0.012 && signed(input.orderBookImbalance, side) < -0.03;
  const checks: Hte31EntryCheck[] = [
    { key: "ht1r-structure", label: "1h方向明确", passed: oneHour >= 0.18, required: true, detail: oneHour.toFixed(2) },
    { key: "ht1r-acceptance", label: "结构位外形成接受", passed: accepted && displacement >= 0.08, required: true, detail: `${recent.filter((row) => side === "LONG" ? row.close > level : row.close < level).length}/3 · ${displacement.toFixed(2)}ATR` },
    { key: "ht1r-15m", label: "15m没有明显反向", passed: fifteen >= -0.08, required: true, detail: fifteen.toFixed(2) },
    { key: "ht1r-flow", label: "资金流没有强烈反对", passed: !flowHostile, required: true, detail: flowHostile ? "CVD与盘口同时反向" : "未见双重反向" },
  ];
  const stop = swingStop(rows, side, currentAtr, 8, 0.12);
  return makeSignal(input, {
    traderId: "dennis_trend_r", strategyId: "ht1_breakout_acceptance", side,
    active: oneHour >= 0.18 && accepted && displacement >= 0.08 && fifteen >= -0.08 && !flowHostile,
    confidence: 58 + Math.min(18, oneHour * 35) + Math.min(14, Math.max(0, displacement) * 12) + (flowHostile ? -12 : 8),
    thesis: "有意义的结构位已被突破，关键不是瞬时穿越，而是价格是否在区间外被市场接受。",
    reasons: ["1h趋势", "15m结构接受", "资金流仅作否决"], checks, stop, rr: 2.2, maxHoldingMinutes: 300,
  });
}

function ht2PullbackResume(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const currentAtr = atr(rows) ?? 0;
  const side = trendSide(input, 0.25);
  const d = direction(side);
  const ema20 = ema(rows.slice(-60).map((row) => row.close), 20) ?? input.futuresPrice;
  const latest = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const recent = rows.slice(-5);
  const touchedMean = recent.some((row) => Math.abs(row.low - ema20) <= currentAtr * 0.45 || Math.abs(row.high - ema20) <= currentAtr * 0.45);
  const oneHour = signed(input.timeframeTrend1h, side);
  const fifteen = signed(input.timeframeTrend15m, side);
  const resumed = d * (latest.close - latest.open) > currentAtr * 0.08 && d * (latest.close - previous.close) > 0;
  const intact = side === "LONG"
    ? Math.min(...recent.map((row) => row.low)) > ema20 - currentAtr * 1.15
    : Math.max(...recent.map((row) => row.high)) < ema20 + currentAtr * 1.15;
  const flowHostile = signed(input.spotCvdRatio, side) < -0.012 && signed(input.orderBookImbalance, side) < -0.03;
  const checks: Hte31EntryCheck[] = [
    { key: "ht2r-trend", label: "1h/15m趋势同向", passed: oneHour >= 0.25 && fifteen >= 0.10, required: true, detail: `${oneHour.toFixed(2)} / ${fifteen.toFixed(2)}` },
    { key: "ht2r-pullback", label: "回撤接近均值", passed: touchedMean, required: true, detail: `EMA20 ${ema20.toFixed(6)}` },
    { key: "ht2r-intact", label: "回撤未破坏结构", passed: intact, required: true, detail: intact ? "结构保持" : "回撤过深" },
    { key: "ht2r-resume", label: "价格重新顺势启动", passed: resumed, required: true, detail: resumed ? "恢复K线出现" : "尚未恢复" },
    { key: "ht2r-flow", label: "资金流没有强烈反对", passed: !flowHostile, required: true, detail: flowHostile ? "CVD与盘口同时反向" : "未见双重反向" },
  ];
  return makeSignal(input, {
    traderId: "raschke_pullback_r", strategyId: "ht2_pullback_resume", side,
    active: oneHour >= 0.25 && fifteen >= 0.10 && touchedMean && intact && resumed && !flowHostile,
    confidence: 55 + Math.min(20, oneHour * 38) + Math.min(12, fifteen * 24) + (resumed ? 10 : 0) - (flowHostile ? 15 : 0),
    thesis: "趋势已经存在，回撤没有破坏结构，重新顺势推进就是入场核心；微观数据只负责否决明显异常。",
    reasons: ["趋势", "回撤", "恢复"], checks,
    stop: swingStop(rows, side, currentAtr, 10, 0.15), rr: 2.3, maxHoldingMinutes: 360,
  });
}

function ht3FailedAuction(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const currentAtr = atr(rows) ?? 0;
  const prior = rows.slice(-32, -5);
  const recent = rows.slice(-5);
  const priorHigh = Math.max(...prior.map((row) => row.high));
  const priorLow = Math.min(...prior.map((row) => row.low));
  let sweepIndex = -1;
  let sweptSide: "HIGH" | "LOW" = "HIGH";
  let excursion = 0;
  recent.forEach((row, index) => {
    const highExcursion = currentAtr > 0 ? (row.high - priorHigh) / currentAtr : 0;
    const lowExcursion = currentAtr > 0 ? (priorLow - row.low) / currentAtr : 0;
    if (highExcursion > excursion && highExcursion >= 0.08) { sweepIndex = index; sweptSide = "HIGH"; excursion = highExcursion; }
    if (lowExcursion > excursion && lowExcursion >= 0.08) { sweepIndex = index; sweptSide = "LOW"; excursion = lowExcursion; }
  });
  const side: Hte31TradeSide = sweptSide === "HIGH" ? "SHORT" : "LONG";
  const sweep = sweepIndex >= 0 ? recent[sweepIndex] : recent[0];
  const latest = recent.at(-1)!;
  const level = sweptSide === "HIGH" ? priorHigh : priorLow;
  const reclaimed = sweptSide === "HIGH" ? latest.close < priorHigh : latest.close > priorLow;
  const outsideCloses = recent.slice(Math.max(0, sweepIndex)).filter((row) => sweptSide === "HIGH" ? row.close > priorHigh : row.close < priorLow).length;
  const failedAcceptance = sweepIndex >= 0 && outsideCloses <= 1;
  const breakoutImpulse = currentAtr > 0 ? Math.abs(sweep.close - (recent[Math.max(0, sweepIndex - 1)]?.close ?? level)) / currentAtr : 0;
  const reclaimImpulse = currentAtr > 0 ? Math.abs(latest.close - sweep.close) / currentAtr : 0;
  const reversalStrongEnough = reclaimImpulse >= Math.max(0.30, breakoutImpulse * 0.75);
  const directional = side === "SHORT" ? latest.close < latest.open : latest.close > latest.open;
  const sweepVolume = volumeRatio(rows, rows.length - recent.length + Math.max(0, sweepIndex));
  const checks: Hte31EntryCheck[] = [
    { key: "ht3r-sweep", label: "关键位出现真实突破尝试", passed: sweepIndex >= 0, required: true, detail: `${excursion.toFixed(2)}ATR` },
    { key: "ht3r-acceptance", label: "区间外没有形成持续接受", passed: failedAcceptance, required: true, detail: `区间外收盘 ${outsideCloses}` },
    { key: "ht3r-reclaim", label: "价格重新夺回旧区间", passed: reclaimed, required: true, detail: `关键位 ${level.toFixed(6)}` },
    { key: "ht3r-force", label: "反向夺回力度足够", passed: reversalStrongEnough && directional, required: true, detail: `突破 ${breakoutImpulse.toFixed(2)}ATR / 夺回 ${reclaimImpulse.toFixed(2)}ATR` },
    { key: "ht3r-volume", label: "突破阶段量能已记录", passed: true, required: false, detail: `${sweepVolume.toFixed(2)}x；量能用于解释而非单独定性` },
  ];
  const stop = sweptSide === "HIGH" ? Math.max(...recent.map((row) => row.high)) + currentAtr * 0.12 : Math.min(...recent.map((row) => row.low)) - currentAtr * 0.12;
  return makeSignal(input, {
    traderId: "turtle_soup_r", strategyId: "ht3_failed_auction", side,
    active: sweepIndex >= 0 && failedAcceptance && reclaimed && reversalStrongEnough && directional,
    confidence: 52 + Math.min(16, excursion * 18) + (failedAcceptance ? 10 : 0) + (reclaimed ? 10 : 0) + Math.min(14, reclaimImpulse * 10),
    thesis: "假突破不是刺破旧高低点，而是一场突破拍卖没有得到接受，随后反方用足够力度重新夺回结构。",
    reasons: ["突破尝试", "接受失败", "反向夺回"], checks, stop, rr: 2.0, maxHoldingMinutes: 300,
  });
}

function ht5SwingResume(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const currentAtr = atr(rows) ?? 0;
  const four = input.timeframeTrend4h ?? 0;
  const one = input.timeframeTrend1h ?? 0;
  const side: Hte31TradeSide = four >= 0 ? "LONG" : "SHORT";
  const d = direction(side);
  const fourSigned = signed(four, side);
  const oneSigned = signed(one, side);
  const fifteenSigned = signed(input.timeframeTrend15m, side);
  const latest = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const ema50 = ema(rows.slice(-120).map((row) => row.close), 50) ?? latest.close;
  const recent = rows.slice(-12);
  const pullback = recent.some((row) => Math.abs(row.close - ema50) <= currentAtr * 0.9);
  const resume = d * (latest.close - previous.close) > currentAtr * 0.06 && d * (latest.close - latest.open) > 0;
  const checks: Hte31EntryCheck[] = [
    { key: "ht5r-4h", label: "4h主结构明确", passed: fourSigned >= 0.30, required: true, detail: fourSigned.toFixed(2) },
    { key: "ht5r-1h", label: "1h与4h同向", passed: oneSigned >= 0.20, required: true, detail: oneSigned.toFixed(2) },
    { key: "ht5r-pullback", label: "大结构中的回撤已发生", passed: pullback, required: true, detail: `5m仅用于成交，EMA50 ${ema50.toFixed(6)}` },
    { key: "ht5r-15m", label: "15m开始恢复", passed: fifteenSigned >= -0.02 && resume, required: true, detail: `${fifteenSigned.toFixed(2)} / ${resume ? "恢复" : "未恢复"}` },
  ];
  return makeSignal(input, {
    traderId: "higher_timeframe_swing_r", strategyId: "ht5_swing_resume", side,
    active: fourSigned >= 0.30 && oneSigned >= 0.20 && pullback && fifteenSigned >= -0.02 && resume,
    confidence: 54 + Math.min(18, fourSigned * 34) + Math.min(16, oneSigned * 30) + (resume ? 10 : 0),
    thesis: "4h/1h决定方向与持有逻辑，15m确认恢复；5m只负责执行，不拥有推翻大周期的权力。",
    reasons: ["4h结构", "1h同向", "15m恢复"], checks,
    stop: swingStop(rows, side, currentAtr, 18, 0.20), rr: 3.0, maxHoldingMinutes: 720,
  });
}

function ht6RangeRotation(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const regime = classifyHte31MarketRegime(input);
  const currentAtr = atr(rows) ?? 0;
  const window = rows.slice(-24);
  const high = Math.max(...window.map((row) => row.high));
  const low = Math.min(...window.map((row) => row.low));
  const width = Math.max(high - low, Number.EPSILON);
  const latest = window.at(-1)!;
  const location = (latest.close - low) / width;
  const side: Hte31TradeSide = location <= 0.25 ? "LONG" : "SHORT";
  const nearEdge = side === "LONG" ? location <= 0.25 : location >= 0.75;
  const rejection = side === "LONG"
    ? latest.close > latest.open && latest.low <= low + width * 0.18
    : latest.close < latest.open && latest.high >= high - width * 0.18;
  const oneHourQuiet = Math.abs(input.timeframeTrend1h ?? 0) <= 0.30;
  const rangeLike = regime.kind === "range" || (regime.kind === "mixed" && oneHourQuiet);
  const checks: Hte31EntryCheck[] = [
    { key: "ht6-range", label: "市场处于平衡/区间", passed: rangeLike, required: true, detail: regime.kind },
    { key: "ht6-edge", label: "只在区间边缘交易", passed: nearEdge, required: true, detail: `${Math.round(location * 100)}%` },
    { key: "ht6-reject", label: "边缘出现向内拒绝", passed: rejection, required: true, detail: rejection ? "已拒绝" : "尚未拒绝" },
  ];
  const stop = side === "LONG" ? low - currentAtr * 0.18 : high + currentAtr * 0.18;
  return makeSignal(input, {
    traderId: "range_rotation", strategyId: "ht6_range_rotation", side,
    active: rangeLike && nearEdge && rejection,
    confidence: 56 + (regime.kind === "range" ? 12 : 5) + (nearEdge ? 12 : 0) + (rejection ? 12 : 0),
    thesis: "区间中部没有优势，只在边缘被拒绝时做向平衡区回归的交易。",
    reasons: ["区间", "边缘", "拒绝"], checks, stop, rr: 1.8, maxHoldingMinutes: 240,
  });
}

function ht7CompressionRelease(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const regime = classifyHte31MarketRegime(input);
  const currentAtr = atr(rows) ?? 0;
  const prior = rows.slice(-22, -1);
  const latest = rows.at(-1)!;
  const high = Math.max(...prior.map((row) => row.high));
  const low = Math.min(...prior.map((row) => row.low));
  const longBreak = latest.close > high;
  const shortBreak = latest.close < low;
  const side: Hte31TradeSide = longBreak ? "LONG" : shortBreak ? "SHORT" : ((input.timeframeTrend15m ?? 0) >= 0 ? "LONG" : "SHORT");
  const breakout = longBreak || shortBreak;
  const vol = volumeRatio(rows);
  const compression = regime.kind === "compression" || (regime.compressionRatio != null && regime.compressionRatio <= 0.82);
  const fifteenNotOpposed = signed(input.timeframeTrend15m, side) >= -0.10;
  const checks: Hte31EntryCheck[] = [
    { key: "ht7-compression", label: "波动先压缩", passed: compression, required: true, detail: regime.compressionRatio == null ? regime.kind : regime.compressionRatio.toFixed(2) },
    { key: "ht7-break", label: "价格离开压缩区", passed: breakout, required: true, detail: breakout ? "已离开" : "仍在区间" },
    { key: "ht7-volume", label: "释放阶段量能扩张", passed: vol >= 1.12, required: true, detail: `${vol.toFixed(2)}x` },
    { key: "ht7-15m", label: "15m不反对突破方向", passed: fifteenNotOpposed, required: true, detail: signed(input.timeframeTrend15m, side).toFixed(2) },
  ];
  return makeSignal(input, {
    traderId: "compression_release", strategyId: "ht7_compression_release", side,
    active: compression && breakout && vol >= 1.12 && fifteenNotOpposed,
    confidence: 54 + (compression ? 14 : 0) + (breakout ? 14 : 0) + Math.min(14, Math.max(0, vol - 1) * 30),
    thesis: "先确认波动收缩，再交易价格被市场接受的释放方向；没有压缩就不把普通突破冒充成释放。",
    reasons: ["压缩", "离开区间", "量能释放"], checks,
    stop: side === "LONG" ? low - currentAtr * 0.12 : high + currentAtr * 0.12, rr: 2.4, maxHoldingMinutes: 300,
  });
}

function ht8RelativeStrength(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const currentAtr = atr(rows) ?? 0;
  const rank = input.crossSectionRank ?? 0.5;
  const side: Hte31TradeSide = rank >= 0.5 ? "LONG" : "SHORT";
  const extreme = side === "LONG" ? rank >= 0.78 : rank <= 0.22;
  const oneHour = signed(input.timeframeTrend1h, side);
  const latest = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const resumed = direction(side) * (latest.close - previous.close) > currentAtr * 0.05;
  const marketBreadthSupport = side === "LONG"
    ? (input.marketAdvancingRatio ?? 0.5) >= 0.42
    : (input.marketDecliningRatio ?? 0.5) >= 0.42;
  const checks: Hte31EntryCheck[] = [
    { key: "ht8-rank", label: "横截面强弱足够突出", passed: extreme, required: true, detail: `${Math.round(rank * 100)}分位` },
    { key: "ht8-trend", label: "1h结构支持强弱方向", passed: oneHour >= 0.18, required: true, detail: oneHour.toFixed(2) },
    { key: "ht8-resume", label: "短线重新沿强弱方向启动", passed: resumed, required: true, detail: resumed ? "已恢复" : "等待恢复" },
    { key: "ht8-breadth", label: "市场广度没有极端逆风", passed: marketBreadthSupport, required: true, detail: side === "LONG" ? `${Math.round((input.marketAdvancingRatio ?? 0) * 100)}%上涨` : `${Math.round((input.marketDecliningRatio ?? 0) * 100)}%下跌` },
  ];
  return makeSignal(input, {
    traderId: "relative_strength", strategyId: "ht8_relative_strength", side,
    active: extreme && oneHour >= 0.18 && resumed && marketBreadthSupport,
    confidence: 54 + Math.min(18, Math.abs(rank - 0.5) * 50) + Math.min(16, oneHour * 30) + (resumed ? 8 : 0),
    thesis: "市场轮动中优先跟随真正领先/落后的币种，等待短线恢复而不是追逐普通涨跌幅。",
    reasons: ["横截面强弱", "1h结构", "恢复"], checks,
    stop: swingStop(rows, side, currentAtr, 10, 0.15), rr: 2.2, maxHoldingMinutes: 360,
  });
}

function ht9ShallowPullback(input: Hte31Input, rows: Hte31Candle[]): Hte31ResearchSignal {
  const currentAtr = atr(rows) ?? 0;
  const side = trendSide(input, 0.32);
  const d = direction(side);
  const oneHour = signed(input.timeframeTrend1h, side);
  const fifteen = signed(input.timeframeTrend15m, side);
  const impulseStart = rows.at(-13)?.close ?? input.futuresPrice;
  const latest = rows.at(-1)!;
  const impulse = currentAtr > 0 ? d * (latest.close - impulseStart) / currentAtr : 0;
  const pause = rows.slice(-5);
  const pauseHigh = Math.max(...pause.map((row) => row.high));
  const pauseLow = Math.min(...pause.map((row) => row.low));
  const pauseWidth = currentAtr > 0 ? (pauseHigh - pauseLow) / currentAtr : 99;
  const priorFour = pause.slice(0, -1);
  const microBreak = side === "LONG"
    ? latest.close > Math.max(...priorFour.map((row) => row.high))
    : latest.close < Math.min(...priorFour.map((row) => row.low));
  const shallow = pauseWidth <= 1.25 && impulse >= 0.70;
  const checks: Hte31EntryCheck[] = [
    { key: "ht9-trend", label: "1h/15m强趋势同向", passed: oneHour >= 0.32 && fifteen >= 0.20, required: true, detail: `${oneHour.toFixed(2)} / ${fifteen.toFixed(2)}` },
    { key: "ht9-impulse", label: "已经存在有效推进", passed: impulse >= 0.70, required: true, detail: `${impulse.toFixed(2)}ATR` },
    { key: "ht9-shallow", label: "整理保持浅而紧", passed: shallow, required: true, detail: `${pauseWidth.toFixed(2)}ATR` },
    { key: "ht9-resume", label: "突破短线整理继续推进", passed: microBreak, required: true, detail: microBreak ? "续航触发" : "仍在整理" },
  ];
  return makeSignal(input, {
    traderId: "shallow_pullback", strategyId: "ht9_shallow_pullback", side,
    active: oneHour >= 0.32 && fifteen >= 0.20 && impulse >= 0.70 && shallow && microBreak,
    confidence: 56 + Math.min(16, oneHour * 30) + Math.min(12, fifteen * 24) + Math.min(12, impulse * 8) + (microBreak ? 8 : 0),
    thesis: "趋势已经启动但不给深回踩时，不强迫价格回到均值；只交易浅整理后重新续航。",
    reasons: ["强趋势", "浅整理", "续航"], checks,
    stop: swingStop(rows, side, currentAtr, 8, 0.14), rr: 2.4, maxHoldingMinutes: 300,
  });
}

export function evaluateHte31ResearchStrategies(input: Hte31Input): Hte31ResearchSignal[] {
  const rows = completed(input);
  if (rows.length < 45) return [];
  return [
    ht1BreakoutAcceptance(input, rows),
    ht2PullbackResume(input, rows),
    ht3FailedAuction(input, rows),
    ht5SwingResume(input, rows),
    ht6RangeRotation(input, rows),
    ht7CompressionRelease(input, rows),
    ht8RelativeStrength(input, rows),
    ht9ShallowPullback(input, rows),
  ];
}
