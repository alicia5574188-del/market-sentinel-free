import type { Candle, SignalMetric } from "./signal-engine.ts";
import type { EntryCheck, EntryPlan, ExitRule, TradeSide } from "./trade-lifecycle.ts";

export type ShadowStrategyId = "trend_pullback" | "volatility_breakout" | "range_reversion" | "relative_strength";
export type ShadowStrategyState = "ready" | "watching" | "blocked";
export type MarketRegimeKind = "trend" | "range" | "compression" | "mixed" | "stress";

export type ShadowStrategyInput = {
  symbol: string;
  observedAt: number;
  futuresPrice: number;
  volumeUsd: number;
  changePercentage: number | null;
  fundingRate: number | null;
  openInterestChangePct: number | null;
  spotCvdRatio: number | null;
  orderBookImbalance: number | null;
  liquidationImbalance: number | null;
  multiTimeframeTrend: number | null;
  benchmarkMomentum: number | null;
  macroEventRisk: number | null;
  dataQuality: number;
  candles5m: Candle[];
};

export type MarketRegime = {
  kind: MarketRegimeKind;
  trendScore: number;
  atrPct: number | null;
  compressionRatio: number | null;
  rangeWidthPct: number | null;
  relativeStrength24h: number | null;
  reason: string;
};

export type ShadowStrategySignal = {
  strategyId: ShadowStrategyId;
  label: string;
  shadowOnly: true;
  state: ShadowStrategyState;
  side: TradeSide | "WAIT";
  score: number;
  confidence: number;
  regime: MarketRegime;
  thesis: string;
  reasons: string[];
  blockers: string[];
  entryPlan: EntryPlan | null;
  metrics: SignalMetric[];
};

const FIVE_MINUTES = 5 * 60_000;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ema(values: number[], period: number) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) result = values[index] * alpha + result * (1 - alpha);
  return result;
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  const window = changes.slice(-period);
  const gains = mean(window.map((change) => Math.max(0, change)));
  const losses = mean(window.map((change) => Math.max(0, -change)));
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function atr(candles: Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close),
  ));
  return mean(ranges.slice(-period));
}

function candleMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

function completed5m(input: ShadowStrategyInput) {
  return input.candles5m
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .filter((candle) => candleMs(candle.time) + FIVE_MINUTES <= input.observedAt)
    .sort((a, b) => a.time - b.time);
}

function volumeRatio(candles: Candle[]) {
  if (candles.length < 22) return null;
  const reference = candles.slice(-21, -1).map((candle) => candle.volume);
  return candles.at(-1)!.volume / Math.max(mean(reference), Number.EPSILON);
}

function rollingAtrRatio(candles: Candle[]) {
  if (candles.length < 42) return null;
  const recent = atr(candles.slice(-20), 10);
  const older = atr(candles.slice(-42, -12), 14);
  if (recent == null || older == null || older <= 0) return null;
  return recent / older;
}

function rangeWidthPct(candles: Candle[], lookback = 24) {
  const window = candles.slice(-lookback);
  const last = window.at(-1)?.close ?? 0;
  if (window.length < 12 || last <= 0) return null;
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  return (high - low) / last * 100;
}

export function classifyShadowRegime(input: ShadowStrategyInput): MarketRegime {
  const candles = completed5m(input);
  const atr5 = atr(candles);
  const atrPct = atr5 != null && input.futuresPrice > 0 ? atr5 / input.futuresPrice * 100 : null;
  const compressionRatio = rollingAtrRatio(candles);
  const width = rangeWidthPct(candles);
  const trend = clamp(input.multiTimeframeTrend ?? 0, -1, 1);
  const relativeStrength24h = input.changePercentage == null || input.benchmarkMomentum == null ? null : input.changePercentage - input.benchmarkMomentum;
  const stress = input.dataQuality < 0.68 || (input.macroEventRisk ?? 0) >= 0.85 || (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.001);
  let kind: MarketRegimeKind;
  let reason: string;
  if (stress) {
    kind = "stress";
    reason = "关键数据、宏观事件或资金费率进入安全拦截状态";
  } else if (compressionRatio != null && compressionRatio <= 0.72 && (width ?? 99) <= 3.2) {
    kind = "compression";
    reason = `短周期 ATR 压缩到较早窗口的 ${(compressionRatio * 100).toFixed(0)}%`;
  } else if (Math.abs(trend) >= 0.42) {
    kind = "trend";
    reason = `15m/1h/4h 聚合趋势强度 ${(Math.abs(trend) * 100).toFixed(0)}`;
  } else if (Math.abs(trend) <= 0.22 && (width ?? 99) <= 5.5) {
    kind = "range";
    reason = `高周期趋势较弱，近端区间宽度 ${width == null ? "--" : `${width.toFixed(2)}%`}`;
  } else {
    kind = "mixed";
    reason = "趋势、震荡与波动特征尚未形成单一主导状态";
  }
  return {
    kind,
    trendScore: Number(trend.toFixed(4)),
    atrPct: atrPct == null ? null : Number(atrPct.toFixed(4)),
    compressionRatio: compressionRatio == null ? null : Number(compressionRatio.toFixed(4)),
    rangeWidthPct: width == null ? null : Number(width.toFixed(4)),
    relativeStrength24h: relativeStrength24h == null ? null : Number(relativeStrength24h.toFixed(4)),
    reason,
  };
}

function baseBlockers(input: ShadowStrategyInput, minimumQuality = 0.70) {
  const blockers: string[] = [];
  if (input.dataQuality < minimumQuality) blockers.push(`数据质量 ${Math.round(input.dataQuality * 100)}% 低于 ${Math.round(minimumQuality * 100)}%`);
  if ((input.macroEventRisk ?? 0) >= 0.85) blockers.push("高影响宏观事件窗口");
  if (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.001) blockers.push("资金费率过度拥挤");
  return blockers;
}

function commonMetrics(input: ShadowStrategyInput, score: number, regime: MarketRegime): SignalMetric[] {
  const direction = score === 0 ? 1 : Math.sign(score);
  return [
    { key: "multi-timeframe", label: "多周期结构", score: regime.trendScore, detail: `15m/1h/4h 聚合 ${(regime.trendScore * 100).toFixed(0)}`, available: input.multiTimeframeTrend != null, category: "price" },
    { key: "spot-flow", label: "现货主动流", score: input.spotCvdRatio == null ? 0 : clamp(input.spotCvdRatio * 2.2, -1, 1), detail: input.spotCvdRatio == null ? "Spot CVD 不可用" : `Spot CVD ${(input.spotCvdRatio * 100).toFixed(1)}%`, available: input.spotCvdRatio != null, category: "spot" },
    { key: "order-book", label: "订单簿", score: input.orderBookImbalance == null ? 0 : clamp(input.orderBookImbalance * 1.8, -1, 1), detail: input.orderBookImbalance == null ? "订单簿不可用" : `深度不平衡 ${(input.orderBookImbalance * 100).toFixed(1)}%`, available: input.orderBookImbalance != null, category: "microstructure" },
    { key: "derivatives", label: "OI / 资金费率", score: input.openInterestChangePct == null ? 0 : direction * clamp(input.openInterestChangePct / 4, -1, 1), detail: `OI ${input.openInterestChangePct == null ? "--" : `${input.openInterestChangePct.toFixed(2)}%`}；资金费率 ${input.fundingRate == null ? "--" : `${(input.fundingRate * 100).toFixed(4)}%`}`, available: input.openInterestChangePct != null || input.fundingRate != null, category: "derivatives" },
  ];
}

function defaultExitRules(side: TradeSide, stop: number, tp1: number, tp2: number, timeout: number): ExitRule[] {
  return [
    { code: "stop_loss", label: "结构止损", condition: `${side === "LONG" ? "价格 ≤" : "价格 ≥"} ${stop}` },
    { code: "breakeven", label: "第一目标保护", condition: `到达 ${tp1} 后止损移动到入场价` },
    { code: "take_profit", label: "第二目标", condition: `到达 ${tp2} 完成退出` },
    { code: "structure_reversal", label: "策略结构反转", condition: "该策略方向分显著反向" },
    { code: "flow_reversal", label: "资金流反转", condition: "Spot CVD 与独立结构源连续反向" },
    { code: "macro_risk", label: "事件风险退出", condition: "宏观风险达到 85/100" },
    { code: "timeout", label: "时间止损", condition: `${timeout} 分钟未完成第二目标则退出` },
  ];
}

function buildPlan(input: ShadowStrategyInput, options: { side: TradeSide; stopLossPrice: number; tp1R?: number; tp2R?: number; maxHoldingMinutes: number; checks: EntryCheck[]; entryZoneAtr?: number }): EntryPlan | null {
  const candles = completed5m(input);
  const currentAtr = atr(candles);
  const entry = input.futuresPrice;
  if (currentAtr == null || entry <= 0 || options.stopLossPrice <= 0) return null;
  const risk = Math.abs(entry - options.stopLossPrice);
  const plannedRiskPct = risk / entry * 100;
  if (!Number.isFinite(risk) || risk <= 0 || plannedRiskPct > 6) return null;
  const direction = options.side === "LONG" ? 1 : -1;
  const tp1R = options.tp1R ?? 1;
  const tp2R = options.tp2R ?? 2;
  const tp1 = entry + direction * risk * tp1R;
  const tp2 = entry + direction * risk * tp2R;
  const zone = currentAtr * (options.entryZoneAtr ?? 0.18);
  const checks = [...options.checks, { key: "risk-distance", label: "结构止损距离", passed: plannedRiskPct <= 6, required: true, detail: `${plannedRiskPct.toFixed(2)}% / 上限 6.00%` }];
  return {
    ready: checks.every((check) => !check.required || check.passed),
    side: options.side,
    entryPrice: entry,
    entryZone: [entry - zone, entry + zone],
    stopLossPrice: options.stopLossPrice,
    takeProfit1Price: tp1,
    takeProfit2Price: tp2,
    riskPerUnit: risk,
    plannedRiskPct,
    riskReward: tp2R,
    maxHoldingMinutes: options.maxHoldingMinutes,
    checks,
    exitRules: defaultExitRules(options.side, options.stopLossPrice, tp1, tp2, options.maxHoldingMinutes),
  };
}

function state(plan: EntryPlan | null, blockers: string[]): ShadowStrategyState {
  if (blockers.length) return "blocked";
  return plan?.ready ? "ready" : "watching";
}

function confidence(score: number, quality: number, cap = 88) {
  return Math.round(clamp(50 + Math.abs(score) * 32 + (quality - 0.65) * 24, 40, cap));
}

function trendPullback(input: ShadowStrategyInput, regime: MarketRegime): ShadowStrategySignal {
  const candles = completed5m(input);
  const closes = candles.map((candle) => candle.close);
  const fast = ema(closes.slice(-40), 9);
  const slow = ema(closes.slice(-50), 21);
  const currentAtr = atr(candles);
  const latest = candles.at(-1) ?? null;
  const previous = candles.at(-2) ?? null;
  const rsi14 = rsi(closes);
  const volRatio = volumeRatio(candles);
  const direction = regime.trendScore >= 0 ? 1 : -1;
  const side: TradeSide = direction > 0 ? "LONG" : "SHORT";
  const nearFast = currentAtr != null && fast != null ? Math.abs(input.futuresPrice - fast) / currentAtr <= 0.85 : false;
  const resumed = latest != null && previous != null && fast != null && slow != null && (side === "LONG" ? fast > slow && latest.close > latest.open && latest.close >= fast && latest.close > previous.close : fast < slow && latest.close < latest.open && latest.close <= fast && latest.close < previous.close);
  const rsiHealthy = rsi14 != null && (side === "LONG" ? rsi14 >= 46 && rsi14 <= 68 : rsi14 >= 32 && rsi14 <= 54);
  const flowAligned = input.spotCvdRatio != null && input.spotCvdRatio * direction >= 0.01;
  const trendStrong = Math.abs(regime.trendScore) >= 0.35;
  const volumeOkay = volRatio != null && volRatio >= 0.72;
  const checks: EntryCheck[] = [
    { key: "regime", label: "高周期趋势", passed: trendStrong && regime.kind !== "range", required: true, detail: `${regime.kind} · 趋势 ${regime.trendScore.toFixed(2)}` },
    { key: "pullback-location", label: "回踩位置", passed: nearFast, required: true, detail: nearFast ? "回到 EMA9 附近" : "离均线过远，不追价" },
    { key: "resume", label: "完整 5m 恢复", passed: resumed, required: true, detail: resumed ? "完整 K 线重新顺趋势" : "等待重新顺趋势收盘" },
    { key: "rsi", label: "动量不过热", passed: rsiHealthy, required: true, detail: `RSI14 ${rsi14 == null ? "--" : rsi14.toFixed(1)}` },
    { key: "spot-flow", label: "Spot CVD 同向", passed: flowAligned, required: true, detail: input.spotCvdRatio == null ? "缺失" : `${(input.spotCvdRatio * 100).toFixed(1)}%` },
    { key: "volume", label: "量能不衰竭", passed: volumeOkay, required: true, detail: volRatio == null ? "--" : `${volRatio.toFixed(2)}×` },
  ];
  const swing = candles.slice(-8);
  const stop = swing.length && currentAtr != null ? (side === "LONG" ? Math.min(...swing.map((candle) => candle.low)) - currentAtr * 0.10 : Math.max(...swing.map((candle) => candle.high)) + currentAtr * 0.10) : 0;
  const blockers = baseBlockers(input, 0.72);
  const plan = buildPlan(input, { side, stopLossPrice: stop, tp2R: 2.2, maxHoldingMinutes: 180, checks });
  const score = direction * clamp(Math.abs(regime.trendScore) * 0.52 + Math.max(0, (input.spotCvdRatio ?? 0) * direction) * 1.4 + (resumed ? 0.20 : 0) + (nearFast ? 0.10 : 0), 0, 1);
  const currentState = state(plan, blockers);
  return { strategyId: "trend_pullback", label: "趋势回踩", shadowOnly: true, state: currentState, side: blockers.length ? "WAIT" : side, score: Number(score.toFixed(4)), confidence: confidence(score, input.dataQuality), regime, thesis: currentState === "ready" ? "高周期趋势未破坏，短周期回踩后重新恢复，不在扩张末端追价。" : "等待趋势、回踩位置、短周期恢复和现货流同时成立。", reasons: checks.filter((check) => check.passed).map((check) => check.label), blockers: [...blockers, ...checks.filter((check) => check.required && !check.passed).map((check) => `${check.label}未通过`)], entryPlan: plan, metrics: commonMetrics(input, score, regime) };
}

function volatilityBreakout(input: ShadowStrategyInput, regime: MarketRegime): ShadowStrategySignal {
  const candles = completed5m(input);
  const latest = candles.at(-1) ?? null;
  const currentAtr = atr(candles);
  const prior = candles.slice(-22, -1);
  const priorHigh = prior.length ? Math.max(...prior.map((candle) => candle.high)) : null;
  const priorLow = prior.length ? Math.min(...prior.map((candle) => candle.low)) : null;
  const volRatio = volumeRatio(candles);
  const breakoutLong = latest != null && priorHigh != null && currentAtr != null && latest.close >= priorHigh + currentAtr * 0.03;
  const breakoutShort = latest != null && priorLow != null && currentAtr != null && latest.close <= priorLow - currentAtr * 0.03;
  const side: TradeSide = breakoutShort && !breakoutLong ? "SHORT" : "LONG";
  const direction = side === "LONG" ? 1 : -1;
  const breakout = side === "LONG" ? breakoutLong : breakoutShort;
  const flowAligned = input.spotCvdRatio != null && input.spotCvdRatio * direction >= 0.015;
  const volumeExpanded = volRatio != null && volRatio >= 1.20;
  const oiSupports = input.openInterestChangePct == null || input.openInterestChangePct >= 0.4;
  const trendNotOpposed = input.multiTimeframeTrend == null || input.multiTimeframeTrend * direction >= -0.18;
  const compression = regime.kind === "compression" || (regime.compressionRatio != null && regime.compressionRatio <= 0.82);
  const checks: EntryCheck[] = [
    { key: "compression", label: "突破前波动收缩", passed: compression, required: true, detail: regime.compressionRatio == null ? "数据不足" : `ATR 比率 ${regime.compressionRatio.toFixed(2)}` },
    { key: "closed-breakout", label: "完整 5m 收盘突破", passed: breakout, required: true, detail: `前高 ${priorHigh ?? "--"} / 前低 ${priorLow ?? "--"}` },
    { key: "volume", label: "突破量能", passed: volumeExpanded, required: true, detail: volRatio == null ? "--" : `${volRatio.toFixed(2)}× / 要求 1.20×` },
    { key: "spot-flow", label: "Spot CVD 跟随", passed: flowAligned, required: true, detail: input.spotCvdRatio == null ? "缺失" : `${(input.spotCvdRatio * 100).toFixed(1)}%` },
    { key: "oi", label: "OI 不萎缩", passed: oiSupports, required: true, detail: input.openInterestChangePct == null ? "缺失，按中性" : `${input.openInterestChangePct.toFixed(2)}%` },
    { key: "higher-timeframe", label: "高周期不强烈反向", passed: trendNotOpposed, required: true, detail: input.multiTimeframeTrend == null ? "--" : `${(input.multiTimeframeTrend * direction).toFixed(2)}` },
  ];
  const stopBase = side === "LONG" ? priorHigh : priorLow;
  const stop = stopBase != null && currentAtr != null ? stopBase - direction * currentAtr * 0.55 : 0;
  const blockers = baseBlockers(input, 0.72);
  const plan = buildPlan(input, { side, stopLossPrice: stop, tp2R: 2.4, maxHoldingMinutes: 120, checks, entryZoneAtr: 0.12 });
  const score = direction * clamp((breakout ? 0.38 : 0) + Math.max(0, (volRatio ?? 0) - 1) * 0.30 + Math.max(0, (input.spotCvdRatio ?? 0) * direction) * 1.4 + (compression ? 0.18 : 0), 0, 1);
  const currentState = state(plan, blockers);
  return { strategyId: "volatility_breakout", label: "波动收缩突破", shadowOnly: true, state: currentState, side: blockers.length || (!breakoutLong && !breakoutShort) ? "WAIT" : side, score: Number(score.toFixed(4)), confidence: confidence(score, input.dataQuality), regime, thesis: currentState === "ready" ? "波动先收缩，再由完整 K 线放量突破，并由现货流和 OI 确认。" : "普通大阳/大阴线不追，只等压缩后的有效突破。", reasons: checks.filter((check) => check.passed).map((check) => check.label), blockers: [...blockers, ...checks.filter((check) => check.required && !check.passed).map((check) => `${check.label}未通过`)], entryPlan: plan, metrics: commonMetrics(input, score, regime) };
}

function rangeReversion(input: ShadowStrategyInput, regime: MarketRegime): ShadowStrategySignal {
  const candles = completed5m(input);
  const window = candles.slice(-30);
  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1) ?? null;
  const currentAtr = atr(candles);
  const rsi14 = rsi(closes);
  const high = window.length ? Math.max(...window.map((candle) => candle.high)) : null;
  const low = window.length ? Math.min(...window.map((candle) => candle.low)) : null;
  const span = high != null && low != null ? high - low : 0;
  const position = latest != null && low != null && span > 0 ? (latest.close - low) / span : 0.5;
  const longSetup = position <= 0.18 && rsi14 != null && rsi14 <= 39;
  const shortSetup = position >= 0.82 && rsi14 != null && rsi14 >= 61;
  const side: TradeSide = shortSetup && !longSetup ? "SHORT" : "LONG";
  const direction = side === "LONG" ? 1 : -1;
  const flowDivergence = input.spotCvdRatio != null && input.spotCvdRatio * direction >= -0.005;
  const bookAbsorption = input.orderBookImbalance != null && input.orderBookImbalance * direction >= 0.02;
  const microstructureSupport = flowDivergence || bookAbsorption;
  const noBreakoutVolume = (volumeRatio(candles) ?? 1) <= 1.55;
  const regimeOkay = regime.kind === "range" || (Math.abs(regime.trendScore) <= 0.20 && regime.kind !== "stress");
  const setup = longSetup || shortSetup;
  const checks: EntryCheck[] = [
    { key: "regime", label: "震荡市场", passed: regimeOkay, required: true, detail: `${regime.kind} · 趋势 ${regime.trendScore.toFixed(2)}` },
    { key: "range-edge", label: "接近区间边缘", passed: setup, required: true, detail: `区间位置 ${(position * 100).toFixed(0)}% · RSI ${rsi14 == null ? "--" : rsi14.toFixed(1)}` },
    { key: "microstructure", label: "流量背离/吸收", passed: microstructureSupport, required: true, detail: `CVD ${input.spotCvdRatio == null ? "--" : (input.spotCvdRatio * 100).toFixed(1)}% · 订单簿 ${input.orderBookImbalance == null ? "--" : (input.orderBookImbalance * 100).toFixed(1)}%` },
    { key: "no-breakout", label: "未进入放量突破", passed: noBreakoutVolume, required: true, detail: `量能 ${(volumeRatio(candles) ?? 0).toFixed(2)}×` },
  ];
  const stop = currentAtr != null && high != null && low != null ? (side === "LONG" ? low - currentAtr * 0.18 : high + currentAtr * 0.18) : 0;
  const blockers = baseBlockers(input, 0.70);
  const plan = buildPlan(input, { side, stopLossPrice: stop, tp1R: 0.9, tp2R: 1.65, maxHoldingMinutes: 90, checks, entryZoneAtr: 0.14 });
  const edgeDistance = side === "LONG" ? 1 - clamp(position / 0.5, 0, 1) : 1 - clamp((1 - position) / 0.5, 0, 1);
  const score = direction * clamp(edgeDistance * 0.45 + (microstructureSupport ? 0.25 : 0) + (rsi14 == null ? 0 : Math.abs(rsi14 - 50) / 50 * 0.25), 0, 1);
  const currentState = state(plan, blockers);
  return { strategyId: "range_reversion", label: "震荡均值回归", shadowOnly: true, state: currentState, side: blockers.length || !setup ? "WAIT" : side, score: Number(score.toFixed(4)), confidence: confidence(score, input.dataQuality, 84), regime, thesis: currentState === "ready" ? "只在低趋势区间边缘反向交易，并要求现货流或订单簿出现吸收/背离。" : "一旦趋势显著就退出候选，不用均值回归硬扛趋势。", reasons: checks.filter((check) => check.passed).map((check) => check.label), blockers: [...blockers, ...checks.filter((check) => check.required && !check.passed).map((check) => `${check.label}未通过`)], entryPlan: plan, metrics: commonMetrics(input, score, regime) };
}

function relativeStrength(input: ShadowStrategyInput, regime: MarketRegime): ShadowStrategySignal {
  const candles = completed5m(input);
  const currentAtr = atr(candles);
  const relative = regime.relativeStrength24h;
  const side: TradeSide = (relative ?? 0) < 0 ? "SHORT" : "LONG";
  const direction = side === "LONG" ? 1 : -1;
  const relativeStrong = relative != null && Math.abs(relative) >= 1.8;
  const trendAligned = input.multiTimeframeTrend != null && input.multiTimeframeTrend * direction >= 0.24;
  const flowAligned = input.spotCvdRatio != null && input.spotCvdRatio * direction >= 0.012;
  const liquidEnough = input.volumeUsd >= 25_000_000;
  const dayNotExhausted = input.changePercentage == null || Math.abs(input.changePercentage) <= 12;
  const checks: EntryCheck[] = [
    { key: "relative-edge", label: "相对 BTC/ETH 强弱", passed: relativeStrong, required: true, detail: relative == null ? "基准缺失" : `${relative >= 0 ? "+" : ""}${relative.toFixed(2)}%` },
    { key: "trend", label: "自身趋势确认", passed: trendAligned, required: true, detail: input.multiTimeframeTrend == null ? "缺失" : `${(input.multiTimeframeTrend * direction).toFixed(2)}` },
    { key: "spot-flow", label: "Spot CVD 同向", passed: flowAligned, required: true, detail: input.spotCvdRatio == null ? "缺失" : `${(input.spotCvdRatio * 100).toFixed(1)}%` },
    { key: "liquidity", label: "流动性", passed: liquidEnough, required: true, detail: `${(input.volumeUsd / 1_000_000).toFixed(1)}M USDT/24h` },
    { key: "anti-exhaustion", label: "日内不过度延伸", passed: dayNotExhausted, required: true, detail: input.changePercentage == null ? "--" : `${input.changePercentage.toFixed(2)}%` },
  ];
  const swing = candles.slice(-10);
  const stop = swing.length && currentAtr != null ? (side === "LONG" ? Math.min(...swing.map((candle) => candle.low)) - currentAtr * 0.08 : Math.max(...swing.map((candle) => candle.high)) + currentAtr * 0.08) : 0;
  const blockers = baseBlockers(input, 0.74);
  const plan = buildPlan(input, { side, stopLossPrice: stop, tp2R: 2.0, maxHoldingMinutes: 240, checks });
  const score = direction * clamp((relative == null ? 0 : Math.abs(relative) / 6) * 0.50 + Math.max(0, (input.multiTimeframeTrend ?? 0) * direction) * 0.28 + Math.max(0, (input.spotCvdRatio ?? 0) * direction) * 1.2, 0, 1);
  const currentState = state(plan, blockers);
  return { strategyId: "relative_strength", label: "相对强弱（实验）", shadowOnly: true, state: currentState, side: blockers.length || !relativeStrong ? "WAIT" : side, score: Number(score.toFixed(4)), confidence: confidence(score, input.dataQuality, 76), regime, thesis: currentState === "ready" ? "只做相对 BTC/ETH 明显更强或更弱、且自身趋势与现货流同步的高流动性标的。" : "该因子在加密市场研究结论更分歧，因此置信度上限更低、晋级样本要求更高。", reasons: checks.filter((check) => check.passed).map((check) => check.label), blockers: [...blockers, ...checks.filter((check) => check.required && !check.passed).map((check) => `${check.label}未通过`)], entryPlan: plan, metrics: commonMetrics(input, score, regime) };
}

export function evaluateShadowStrategies(input: ShadowStrategyInput): ShadowStrategySignal[] {
  const regime = classifyShadowRegime(input);
  return [trendPullback(input, regime), volatilityBreakout(input, regime), rangeReversion(input, regime), relativeStrength(input, regime)];
}
