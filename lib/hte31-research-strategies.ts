import { classifyHte31AssetRegime, classifyHte31MarketRegime } from "./hte31-regime.ts";
import { hte31TraderDefinition, type Hte31ResearchTraderId } from "./hte31-strategy-catalog.ts";
import type {
  Hte31AssetRegime,
  Hte31Candle,
  Hte31EntryCheck,
  Hte31EntryPlan,
  Hte31Input,
  Hte31MarketRegime,
  Hte31Signal,
  Hte31SignalMetric,
  Hte31StrategyId,
  Hte31TradeSide,
} from "./hte31-types.ts";

const FIVE_MINUTES = 300_000;

function clamp(value: number, minimum = 0, maximum = 100) {
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
  let value = values[0];
  for (let index = 1; index < values.length; index += 1) value = values[index] * alpha + value * (1 - alpha);
  return value;
}

function sideDirection(side: Hte31TradeSide) {
  return side === "LONG" ? 1 : -1;
}

function signed(value: number | null | undefined, side: Hte31TradeSide) {
  return (value ?? 0) * sideDirection(side);
}

function opposite(side: Hte31TradeSide): Hte31TradeSide {
  return side === "LONG" ? "SHORT" : "LONG";
}

function directionFrom(value: number): Hte31TradeSide {
  return value >= 0 ? "LONG" : "SHORT";
}

function higherTimeframeScore(input: Hte31Input) {
  const t15 = input.timeframeTrend15m ?? input.multiTimeframeTrend ?? 0;
  const t1h = input.timeframeTrend1h ?? input.multiTimeframeTrend ?? 0;
  const t4h = input.timeframeTrend4h ?? input.multiTimeframeTrend ?? 0;
  return t15 * 0.20 + t1h * 0.35 + t4h * 0.45;
}

function barVolumeRatio(rows: Hte31Candle[], bar: Hte31Candle | undefined, endOffset = 2) {
  if (!bar || rows.length < 24) return 0;
  const baseline = mean(rows.slice(-28, -endOffset).map((row) => row.volume));
  return bar.volume / Math.max(baseline, Number.EPSILON);
}

function currentVolumeRatio(rows: Hte31Candle[]) {
  return barVolumeRatio(rows, rows.at(-1), 1);
}

function swingStop(rows: Hte31Candle[], side: Hte31TradeSide, currentAtr: number | null, lookback = 10, padding = 0.18) {
  if (!rows.length || currentAtr == null || currentAtr <= 0) return 0;
  const window = rows.slice(-lookback);
  return side === "LONG"
    ? Math.min(...window.map((row) => row.low)) - currentAtr * padding
    : Math.max(...window.map((row) => row.high)) + currentAtr * padding;
}

function hardChecks(input: Hte31Input, riskPct: number): Hte31EntryCheck[] {
  return [
    { key: "hte-data", label: "数据安全", passed: input.dataQuality >= 0.68, required: true, detail: `${Math.round(input.dataQuality * 100)}%` },
    { key: "hte-liquidity", label: "流动性安全", passed: input.volumeUsd >= 12_000_000, required: true, detail: `${(input.volumeUsd / 1e6).toFixed(1)}M` },
    { key: "hte-funding", label: "杠杆拥挤未失控", passed: input.fundingRate == null || Math.abs(input.fundingRate) < 0.0015, required: true, detail: `${((input.fundingRate ?? 0) * 100).toFixed(4)}%` },
    { key: "hte-event", label: "事件安全", passed: (input.macroEventRisk ?? 0) < 0.98, required: true, detail: `${Math.round((input.macroEventRisk ?? 0) * 100)}` },
    { key: "hte-stop", label: "结构止损距离", passed: riskPct > 0 && riskPct <= 5, required: true, detail: `${riskPct.toFixed(2)}%` },
  ];
}

function buildPlan(input: Hte31Input, side: Hte31TradeSide, stop: number, rr: number, minutes: number, checks: Hte31EntryCheck[]): Hte31EntryPlan | null {
  const rows = completed(input);
  const currentAtr = atr(rows);
  const entry = input.futuresPrice;
  if (currentAtr == null || !(entry > 0 && stop > 0)) return null;
  const risk = Math.abs(entry - stop);
  const riskPct = risk / entry * 100;
  if (!(risk > 0) || riskPct > 5) return null;
  const direction = sideDirection(side);
  const tp1 = entry + direction * risk;
  const tp2 = entry + direction * risk * rr;
  const allChecks = [
    ...hardChecks(input, riskPct),
    { key: "hte-research-lane", label: "独立研究通道", passed: true, required: true, detail: "不占控制账户仓位、不进入 Gate 实盘" },
    ...checks,
  ];
  return {
    ready: allChecks.every((check) => !check.required || check.passed),
    side,
    entryPrice: entry,
    entryZone: [entry - currentAtr * 0.15, entry + currentAtr * 0.15],
    stopLossPrice: stop,
    takeProfit1Price: tp1,
    takeProfit2Price: tp2,
    riskPerUnit: risk,
    plannedRiskPct: riskPct,
    riskReward: rr,
    maxHoldingMinutes: minutes,
    checks: allChecks,
    exitRules: [
      { code: "stop_loss", label: "结构止损", condition: `${side === "LONG" ? "价格 ≤" : "价格 ≥"} ${stop}` },
      { code: "breakeven", label: "第一目标保护", condition: `达到 ${tp1} 后从下一观察周期起保护到入场价` },
      { code: "take_profit", label: "第二目标", condition: `达到 ${tp2} 完成退出` },
      { code: "structure_reversal", label: "市场故事失效", condition: "该策略定义的延续、失败、轮动或扩张前提不再成立" },
      { code: "macro_risk", label: "紧急风险退出", condition: "全局风险进入紧急状态" },
      { code: "timeout", label: "时间止损", condition: `${minutes} 分钟仍未兑现预期行为则退出` },
    ],
  };
}

type ResearchConfig = {
  traderId: Hte31ResearchTraderId;
  strategyId: Hte31StrategyId;
  playbookId: string;
  baselineId?: string;
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
};

function makeSignal(input: Hte31Input, regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime, config: ResearchConfig): Hte31Signal {
  const definition = hte31TraderDefinition(config.traderId);
  const entryPlan = buildPlan(input, config.side, config.stop, config.rr, config.minutes, config.checks);
  const failedRequired = entryPlan?.checks.filter((check) => check.required && !check.passed).map((check) => `${check.label}未通过`) ?? [];
  const blocked = input.dataQuality < 0.68 || input.volumeUsd < 12_000_000 || (input.macroEventRisk ?? 0) >= 0.98;
  const ready = config.setupActive && Boolean(entryPlan?.ready) && !blocked;
  const score = sideDirection(config.side) * clamp(config.setupScore * 0.58 + config.evidenceScore * 0.42) / 100;
  const metrics: Hte31SignalMetric[] = [
    { key: "research-trader", label: "研究交易员", score: 1, detail: `${definition.code} ${definition.name}`, available: true, category: "cross" },
    { key: "research-lane", label: "执行通道", score: 0, detail: "并发影子持仓；不争夺控制仓位", available: true, category: "cross" },
    { key: "asset-regime", label: "单币环境", score: Math.abs(regime.trendScore), detail: assetRegime, available: true, category: "cross" },
    { key: "timeframe-context", label: "周期结构", score: higherTimeframeScore(input), detail: `${Math.round(higherTimeframeScore(input) * 100)}`, available: true, category: "price" },
    { key: "spot-flow", label: "现货主动流", score: input.spotCvdRatio ?? 0, detail: input.spotCvdRatio == null ? "--" : `${(input.spotCvdRatio * 100).toFixed(1)}%`, available: input.spotCvdRatio != null, category: "spot" },
  ];
  return {
    strategyId: config.strategyId,
    label: `${definition.code} ${definition.name} ${definition.setup}`,
    shadowOnly: true,
    state: blocked ? "blocked" : ready ? "ready" : "watching",
    side: blocked ? "WAIT" : config.side,
    score: Number(score.toFixed(4)),
    confidence: Math.round(clamp(44 + config.setupScore * 0.30 + config.evidenceScore * 0.18 + input.dataQuality * 10)),
    regime,
    thesis: `${config.thesis} 预期行为：${config.expectedBehavior}`,
    reasons: config.checks.filter((check) => check.passed).map((check) => check.label),
    blockers: [...new Set(failedRequired)],
    entryPlan,
    metrics,
    strategyMeta: {
      playbookId: config.playbookId,
      assetRegime,
      setupScore: Math.round(clamp(config.setupScore)),
      evidenceScore: Math.round(clamp(config.evidenceScore)),
      triggerActive: config.setupActive,
      hardGatePassed: Boolean(entryPlan?.ready) && !blocked,
      candidateSide: config.side,
      executionLane: "research",
      baselineId: config.baselineId,
      storyFamily: definition.storyFamily,
      supportingPlaybooks: [],
      strategyConflict: 0,
    },
  };
}

function acceptedBreakout(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const context = higherTimeframeScore(input);
  const side = directionFrom(context || (input.multiTimeframeTrend ?? 0));
  const prior = rows.slice(-30, -4);
  const recent = rows.slice(-4);
  const priorHigh = prior.length ? Math.max(...prior.map((row) => row.high)) : 0;
  const priorLow = prior.length ? Math.min(...prior.map((row) => row.low)) : 0;
  const boundary = side === "LONG" ? priorHigh : priorLow;
  const breakoutIndex = currentAtr == null ? -1 : recent.findIndex((row) => side === "LONG"
    ? row.close > priorHigh + currentAtr * 0.03
    : row.close < priorLow - currentAtr * 0.03);
  const breakoutBar = breakoutIndex >= 0 ? recent[breakoutIndex] : undefined;
  const accepted = Boolean(currentAtr && breakoutIndex >= 0 && recent.slice(breakoutIndex).every((row) => side === "LONG"
    ? row.close >= priorHigh - currentAtr * 0.08
    : row.close <= priorLow + currentAtr * 0.08));
  const bodyAtr = breakoutBar && currentAtr ? Math.abs(breakoutBar.close - breakoutBar.open) / currentAtr : 0;
  const rangeAtr = breakoutBar && currentAtr ? (breakoutBar.high - breakoutBar.low) / currentAtr : 0;
  const breakoutVolume = barVolumeRatio(rows, breakoutBar, Math.max(1, 4 - Math.max(0, breakoutIndex)));
  const forceConfirmed = rangeAtr >= 0.72 && bodyAtr >= 0.22 && (breakoutVolume >= 1.05 || bodyAtr >= 0.42);
  const trendConfirmed = Math.abs(context) >= 0.24 && signed(input.timeframeTrend4h, side) >= -0.08;
  const flowConfirmed = signed(input.spotCvdRatio, side) >= -0.005 && signed(input.orderBookImbalance, side) >= -0.07;
  const routerFit = ["trend_up", "trend_down", "expansion_up", "expansion_down", "compression", "transition"].includes(assetRegime);
  const setupActive = prior.length >= 20 && breakoutIndex >= 0 && accepted && forceConfirmed && trendConfirmed && flowConfirmed && routerFit;
  const boundaryStop = currentAtr == null ? 0 : boundary - sideDirection(side) * currentAtr * 0.22;
  const localStop = swingStop(rows, side, currentAtr, 8, 0.12);
  const stop = side === "LONG" ? Math.min(boundaryStop, localStop) : Math.max(boundaryStop, localStop);
  return makeSignal(input, regime, assetRegime, {
    traderId: "dennis_trend_v2", strategyId: "trend_breakout_challenger", playbookId: "HT1R_ACCEPTED_BREAKOUT", baselineId: "HT1_DENNIS_TREND", side,
    setupActive,
    setupScore: (breakoutIndex >= 0 ? 30 : 0) + (accepted ? 24 : 0) + (forceConfirmed ? 24 : 0) + (trendConfirmed ? 14 : 0) + (routerFit ? 8 : 0),
    evidenceScore: 42 + (flowConfirmed ? 18 : -22) + Math.min(20, breakoutVolume * 9) + Math.min(14, bodyAtr * 18),
    thesis: "HT1 挑战版不只认最后一根刚突破；它也接受突破后数根K线仍站在旧区间外、或完成第一次回踩接受的趋势。",
    expectedBehavior: "旧边界应继续成为支撑/压力；一旦放量突破被迅速完全收回，立即把故事改判为失败而非继续追单。",
    stop, rr: 2.4, minutes: 240,
    checks: [
      { key: "ht1r-context", label: "高周期方向不反对", passed: trendConfirmed, required: true, detail: `周期分 ${context.toFixed(2)}` },
      { key: "ht1r-breakout", label: "最近四根出现真实突破", passed: breakoutIndex >= 0, required: true, detail: `边界 ${boundary.toFixed(6)}` },
      { key: "ht1r-acceptance", label: "突破后仍被市场接受", passed: accepted, required: true, detail: accepted ? "收盘保持在旧区间外" : "已经重新跌回/涨回旧区间" },
      { key: "ht1r-force", label: "量能或实体支持突破力度", passed: forceConfirmed, required: true, detail: `${breakoutVolume.toFixed(2)}x / ${bodyAtr.toFixed(2)} ATR` },
      { key: "ht1r-flow", label: "现货流与订单簿未反向压制", passed: flowConfirmed, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)}` },
      { key: "ht1r-router", label: "环境允许趋势突破", passed: routerFit, required: true, detail: assetRegime },
    ],
  });
}

function adaptivePullback(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const context = higherTimeframeScore(input);
  const side = directionFrom(context || (input.multiTimeframeTrend ?? 0));
  const impulseRows = rows.slice(-22, -5);
  const pullbackRows = rows.slice(-6);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const impulseMove = currentAtr && impulseRows.length >= 10
    ? sideDirection(side) * (impulseRows.at(-1)!.close - impulseRows[0].open) / currentAtr
    : 0;
  const impulseExtreme = side === "LONG"
    ? Math.max(...impulseRows.map((row) => row.high))
    : Math.min(...impulseRows.map((row) => row.low));
  const pullbackExtreme = side === "LONG"
    ? Math.min(...pullbackRows.map((row) => row.low))
    : Math.max(...pullbackRows.map((row) => row.high));
  const pullbackDepthAtr = currentAtr ? sideDirection(side) * (impulseExtreme - pullbackExtreme) / currentAtr : 99;
  const ema20 = ema(rows.slice(-60).map((row) => row.close), 20);
  const meanReach = Boolean(currentAtr && latest && ema20 != null && Math.abs(latest.close - ema20) <= currentAtr * 1.35);
  const depthAccepted = pullbackDepthAtr >= 0.12 && pullbackDepthAtr <= 1.25;
  const controlled = Boolean(currentAtr && pullbackRows.slice(0, -1).every((row) => {
    const adverseBody = side === "LONG" ? row.open - row.close : row.close - row.open;
    return adverseBody <= currentAtr * 0.78;
  }));
  const resumeBody = latest && currentAtr ? Math.abs(latest.close - latest.open) / currentAtr : 0;
  const resumed = Boolean(latest && previous && resumeBody >= 0.12 && (side === "LONG"
    ? latest.close > latest.open && latest.close > previous.close
    : latest.close < latest.open && latest.close < previous.close));
  const trendConfirmed = Math.abs(context) >= 0.26 && signed(input.timeframeTrend4h, side) >= 0;
  const flowConfirmed = signed(input.spotCvdRatio, side) >= -0.0055 && signed(input.orderBookImbalance, side) >= -0.075;
  const routerFit = ["trend_up", "trend_down", "expansion_up", "expansion_down", "transition"].includes(assetRegime);
  const setupActive = impulseMove >= 1.25 && (depthAccepted || meanReach) && controlled && resumed && trendConfirmed && flowConfirmed && routerFit;
  return makeSignal(input, regime, assetRegime, {
    traderId: "raschke_pullback_v2", strategyId: "trend_pullback_challenger", playbookId: "HT2R_ADAPTIVE_PULLBACK", baselineId: "HT2_RASCHKE_PULLBACK", side,
    setupActive,
    setupScore: (impulseMove >= 1.25 ? 26 : 0) + (depthAccepted ? 22 : 0) + (meanReach ? 12 : 0) + (controlled ? 16 : 0) + (resumed ? 18 : 0) + (trendConfirmed ? 12 : 0),
    evidenceScore: 46 + (flowConfirmed ? 18 : -22) + Math.min(18, impulseMove * 8) + Math.min(10, resumeBody * 18),
    thesis: "HT2 挑战版把回踩理解为趋势推进后的价格让步，而不是必须精确触碰 EMA20；浅回踩和正常回踩分开记录。",
    expectedBehavior: "恢复K线后应再次扩张；若回踩演变成反向冲击或4h方向被破坏，则不再把它解释成便宜入场。",
    stop: swingStop(rows, side, currentAtr, 10, 0.16), rr: 2.2, minutes: 210,
    checks: [
      { key: "ht2r-context", label: "1h/4h 趋势方向成立", passed: trendConfirmed, required: true, detail: `周期分 ${context.toFixed(2)}` },
      { key: "ht2r-impulse", label: "回踩前已有推进段", passed: impulseMove >= 1.25, required: true, detail: `${impulseMove.toFixed(2)} ATR` },
      { key: "ht2r-depth", label: "深浅回踩仍在可控范围", passed: depthAccepted || meanReach, required: true, detail: `${pullbackDepthAtr.toFixed(2)} ATR${meanReach ? " · 接近均值" : ""}` },
      { key: "ht2r-control", label: "回踩没有变成反向冲击", passed: controlled, required: true, detail: controlled ? "逆向实体受控" : "出现大幅逆向实体" },
      { key: "ht2r-resume", label: "最新K线重新顺势", passed: resumed, required: true, detail: `${resumeBody.toFixed(2)} ATR` },
      { key: "ht2r-flow", label: "资金流未强烈反向", passed: flowConfirmed, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)}` },
      { key: "ht2r-router", label: "环境允许趋势回踩", passed: routerFit, required: true, detail: assetRegime },
    ],
  });
}

function failedAuction(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const prior = rows.slice(-36, -2);
  const sweep = rows.at(-2);
  const reclaim = rows.at(-1);
  const priorHigh = prior.length ? Math.max(...prior.map((row) => row.high)) : 0;
  const priorLow = prior.length ? Math.min(...prior.map((row) => row.low)) : 0;
  const highExtension = sweep && currentAtr ? (sweep.high - priorHigh) / currentAtr : 0;
  const lowExtension = sweep && currentAtr ? (priorLow - sweep.low) / currentAtr : 0;
  const sweptHigh = highExtension >= 0.08 && highExtension <= 1.10;
  const sweptLow = lowExtension >= 0.08 && lowExtension <= 1.10;
  const breakoutSide: Hte31TradeSide = sweptHigh && highExtension >= lowExtension ? "LONG" : "SHORT";
  const side = opposite(breakoutSide);
  const extension = Math.max(highExtension, lowExtension);
  const reclaimed = Boolean(reclaim && currentAtr && (side === "SHORT"
    ? sweptHigh && reclaim.close < priorHigh - currentAtr * 0.04
    : sweptLow && reclaim.close > priorLow + currentAtr * 0.04));
  const sweepVolume = barVolumeRatio(rows, sweep, 2);
  const sweepRangeAtr = sweep && currentAtr ? (sweep.high - sweep.low) / currentAtr : 0;
  const breakoutForce = sweepVolume >= 1.05 && sweepRangeAtr >= 0.62;
  const reverseBodyAtr = reclaim && currentAtr ? Math.abs(reclaim.close - reclaim.open) / currentAtr : 0;
  const reverseImpulse = Boolean(reclaim && sweep && reverseBodyAtr >= 0.20 && (side === "SHORT"
    ? reclaim.close < reclaim.open && reclaim.close <= (sweep.high + sweep.low) / 2
    : reclaim.close > reclaim.open && reclaim.close >= (sweep.high + sweep.low) / 2));
  const forceRatio = reverseBodyAtr / Math.max(extension, 0.10);
  const flowConfirm = signed(input.spotCvdRatio, side) >= 0.0015;
  const bookConfirm = signed(input.orderBookImbalance, side) >= 0.015;
  const liquidationContext = signed(input.liquidationImbalance, breakoutSide) >= 0.22;
  const votes = [breakoutForce, reverseImpulse, forceRatio >= 0.90, flowConfirm, bookConfirm, liquidationContext].filter(Boolean).length;
  const microConfirmed = votes >= 3 && (reverseImpulse || (flowConfirm && bookConfirm));
  const strongTrendAgainst = signed(input.timeframeTrend4h, side) < -0.42;
  const trendException = !strongTrendAgainst || (forceRatio >= 1.45 && flowConfirm && bookConfirm);
  const routerFit = ["range", "compression", "transition", "leverage_liquidation"].includes(assetRegime) || trendException;
  const setupActive = (sweptHigh || sweptLow) && reclaimed && breakoutForce && microConfirmed && trendException && routerFit;
  return makeSignal(input, regime, assetRegime, {
    traderId: "turtle_soup_v2", strategyId: "failed_breakout_challenger", playbookId: "HT3R_FAILED_AUCTION", baselineId: "HT3_TURTLE_SOUP", side,
    setupActive,
    setupScore: (sweptHigh || sweptLow ? 24 : 0) + (reclaimed ? 24 : 0) + (breakoutForce ? 16 : 0) + (reverseImpulse ? 18 : 0) + Math.min(18, votes * 3),
    evidenceScore: 34 + votes * 9 + Math.min(16, forceRatio * 8) + (trendException ? 8 : -24),
    thesis: "HT3 挑战版把假突破视为一次失败的价格拍卖：不仅要回到区间，还要检查突破量能、延伸力度、反向冲击和微观资金流谁更强。",
    expectedBehavior: "反向力量应继续把价格推离被扫极值；若再次被突破方向接受，就承认这是真突破而不是继续逆势。",
    stop: swingStop(rows, side, currentAtr, 8, 0.20), rr: 2.1, minutes: 120,
    checks: [
      { key: "ht3r-sweep", label: "旧极值被有效扫过", passed: sweptHigh || sweptLow, required: true, detail: `${extension.toFixed(2)} ATR` },
      { key: "ht3r-breakout-force", label: "突破时确有量能与力度", passed: breakoutForce, required: true, detail: `${sweepVolume.toFixed(2)}x / ${sweepRangeAtr.toFixed(2)} ATR` },
      { key: "ht3r-reclaim", label: "收盘重新被区间接受", passed: reclaimed, required: true, detail: reclaimed ? "深度收回" : "仍在区间外" },
      { key: "ht3r-reversal-force", label: "反向力度足以否定突破", passed: microConfirmed, required: true, detail: `${votes}/6 · 力度比 ${forceRatio.toFixed(2)}` },
      { key: "ht3r-trend", label: "不机械对抗强趋势", passed: trendException, required: true, detail: strongTrendAgainst ? "需极强反向证据" : "高周期未强烈反对" },
      { key: "ht3r-router", label: "环境允许失败突破", passed: routerFit, required: true, detail: assetRegime },
    ],
  });
}

function swingContext(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const t4h = input.timeframeTrend4h ?? input.multiTimeframeTrend ?? 0;
  const side = directionFrom(t4h);
  const t1h = signed(input.timeframeTrend1h, side);
  const t15 = signed(input.timeframeTrend15m, side);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const ema20 = ema(rows.slice(-60).map((row) => row.close), 20);
  const base = rows.slice(-6, -1);
  const baseRangeAtr = currentAtr && base.length ? (Math.max(...base.map((row) => row.high)) - Math.min(...base.map((row) => row.low))) / currentAtr : 99;
  const priceNearMean = Boolean(currentAtr && latest && ema20 != null && Math.abs(latest.close - ema20) <= currentAtr * 1.45);
  const tacticalNotExtended = t15 <= 0.58 && baseRangeAtr <= 1.65;
  const resumed = Boolean(currentAtr && latest && previous && Math.abs(latest.close - latest.open) >= currentAtr * 0.13 && (side === "LONG"
    ? latest.close > latest.open && latest.close > previous.close
    : latest.close < latest.open && latest.close < previous.close));
  const structure = Math.abs(t4h) >= 0.28 && t1h >= 0.04;
  const flow = signed(input.spotCvdRatio, side) >= -0.006 && signed(input.orderBookImbalance, side) >= -0.08;
  const breadth = side === "LONG" ? input.marketAdvancingRatio : input.marketDecliningRatio;
  const marketSupport = signed(input.benchmarkMomentum, side) >= -0.9 && (breadth == null || breadth >= 0.37);
  const routerFit = ["trend_up", "trend_down", "expansion_up", "expansion_down", "transition"].includes(assetRegime);
  const setupActive = structure && priceNearMean && tacticalNotExtended && resumed && flow && marketSupport && routerFit;
  return makeSignal(input, regime, assetRegime, {
    traderId: "higher_timeframe_swing_v2", strategyId: "higher_timeframe_swing_challenger", playbookId: "HT5R_SWING_CONTEXT", baselineId: "HT5_HIGHER_TIMEFRAME_SWING", side,
    setupActive,
    setupScore: (structure ? 30 : 0) + (priceNearMean ? 16 : 0) + (tacticalNotExtended ? 18 : 0) + (resumed ? 22 : 0) + (routerFit ? 10 : 0),
    evidenceScore: 46 + (flow ? 18 : -22) + (marketSupport ? 14 : -18) + Math.min(16, Math.abs(t4h) * 24),
    thesis: "HT5 挑战版让4h定义故事、1h验证持续性，15m/5m只负责判断现在是否过度延伸；它允许浅整理，不强迫每次都出现明显逆向15m回撤。",
    expectedBehavior: "价格应重新沿4h主结构扩张；若1h转向且5m基底被破坏，故事失效。",
    stop: swingStop(rows, side, currentAtr, 14, 0.22), rr: 3.0, minutes: 480,
    checks: [
      { key: "ht5r-structure", label: "4h 与 1h 主故事一致", passed: structure, required: true, detail: `4h ${t4h.toFixed(2)} / 1h ${t1h.toFixed(2)}` },
      { key: "ht5r-location", label: "当前价格未过度延伸", passed: priceNearMean && tacticalNotExtended, required: true, detail: `基底 ${baseRangeAtr.toFixed(2)} ATR / 15m ${t15.toFixed(2)}` },
      { key: "ht5r-resume", label: "5m 重新服从大周期", passed: resumed, required: true, detail: resumed ? "恢复K线成立" : "尚未恢复" },
      { key: "ht5r-flow", label: "现货与订单簿未强烈逆风", passed: flow, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)}` },
      { key: "ht5r-market", label: "基准和市场广度可接受", passed: marketSupport, required: true, detail: `Breadth ${breadth == null ? "--" : breadth.toFixed(2)}` },
      { key: "ht5r-router", label: "环境允许大周期持有", passed: routerFit, required: true, detail: assetRegime },
    ],
  });
}

function rangeRotation(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const rangeRows = rows.slice(-34, -2);
  const previous = rows.at(-2);
  const latest = rows.at(-1);
  const high = rangeRows.length ? Math.max(...rangeRows.map((row) => row.high)) : 0;
  const low = rangeRows.length ? Math.min(...rangeRows.map((row) => row.low)) : 0;
  const width = high - low;
  const previousLocation = width > 0 && previous ? (previous.close - low) / width : 0.5;
  const atUpper = previousLocation >= 0.78;
  const atLower = previousLocation <= 0.22;
  const side: Hte31TradeSide = atUpper ? "SHORT" : "LONG";
  const inward = Boolean(latest && previous && currentAtr && (side === "SHORT"
    ? latest.close < latest.open && latest.close < previous.close && latest.close < high - width * 0.10
    : latest.close > latest.open && latest.close > previous.close && latest.close > low + width * 0.10));
  const weakTrend = Math.abs(higherTimeframeScore(input)) <= 0.30;
  const viableWidth = Boolean(currentAtr && width >= currentAtr * 2.2 && width <= currentAtr * 9);
  const flow = signed(input.spotCvdRatio, side) >= -0.003 && signed(input.orderBookImbalance, side) >= -0.045;
  const routerFit = ["range", "compression", "transition"].includes(assetRegime);
  const setupActive = (atUpper || atLower) && inward && weakTrend && viableWidth && flow && routerFit;
  return makeSignal(input, regime, assetRegime, {
    traderId: "range_rotation", strategyId: "range_rotation", playbookId: "HT6_RANGE_ROTATION", side,
    setupActive,
    setupScore: (atUpper || atLower ? 28 : 0) + (inward ? 24 : 0) + (weakTrend ? 18 : 0) + (viableWidth ? 16 : 0) + (routerFit ? 14 : 0),
    evidenceScore: 44 + (flow ? 18 : -22) + Math.min(16, width / Math.max(currentAtr ?? 1, Number.EPSILON) * 3),
    thesis: "HT6 只在高周期缺少持续方向、价格多次围绕明确区间轮动时，从边缘向中枢交易；它不把趋势中的一次停顿误判为震荡。",
    expectedBehavior: "离开边缘后应向区间中枢推进；若边界被放量接受，区间故事立即失效并让位给突破策略。",
    stop: swingStop(rows, side, currentAtr, 8, 0.16), rr: 1.7, minutes: 150,
    checks: [
      { key: "ht6-range", label: "存在可交易区间", passed: viableWidth, required: true, detail: `${(width / Math.max(currentAtr ?? 1, Number.EPSILON)).toFixed(2)} ATR` },
      { key: "ht6-edge", label: "价格位于区间边缘", passed: atUpper || atLower, required: true, detail: `${Math.round(previousLocation * 100)}%` },
      { key: "ht6-inward", label: "边缘出现向内拒绝", passed: inward, required: true, detail: inward ? "已向中枢转向" : "仍未离开边缘" },
      { key: "ht6-trend", label: "高周期没有强趋势", passed: weakTrend, required: true, detail: `${higherTimeframeScore(input).toFixed(2)}` },
      { key: "ht6-flow", label: "微观资金流不反对轮动", passed: flow, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)}` },
      { key: "ht6-router", label: "环境允许区间轮动", passed: routerFit, required: true, detail: assetRegime },
    ],
  });
}

function compressionExpansion(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const recentAtr = atr(rows.slice(-24, -2), 10);
  const olderAtr = atr(rows.slice(-54, -24), 14);
  const compressionRatio = recentAtr != null && olderAtr != null && olderAtr > 0 ? recentAtr / olderAtr : 99;
  const prior = rows.slice(-24, -1);
  const latest = rows.at(-1);
  const priorHigh = prior.length ? Math.max(...prior.map((row) => row.high)) : 0;
  const priorLow = prior.length ? Math.min(...prior.map((row) => row.low)) : 0;
  const side: Hte31TradeSide = latest && latest.close >= (priorHigh + priorLow) / 2 ? "LONG" : "SHORT";
  const broken = Boolean(latest && currentAtr && (side === "LONG"
    ? latest.close > priorHigh + currentAtr * 0.04
    : latest.close < priorLow - currentAtr * 0.04));
  const bodyAtr = latest && currentAtr ? Math.abs(latest.close - latest.open) / currentAtr : 0;
  const rangeAtr = latest && currentAtr ? (latest.high - latest.low) / currentAtr : 0;
  const volume = currentVolumeRatio(rows);
  const expansion = bodyAtr >= 0.28 && rangeAtr >= 0.82 && volume >= 1.12;
  const compressed = compressionRatio <= 0.84 || assetRegime === "compression";
  const flow = signed(input.spotCvdRatio, side) >= -0.002 && signed(input.orderBookImbalance, side) >= -0.04;
  const setupActive = compressed && broken && expansion && flow;
  return makeSignal(input, regime, assetRegime, {
    traderId: "compression_expansion", strategyId: "compression_expansion", playbookId: "HT7_COMPRESSION_EXPANSION", side,
    setupActive,
    setupScore: (compressed ? 30 : 0) + (broken ? 30 : 0) + (expansion ? 26 : 0) + Math.min(14, volume * 8),
    evidenceScore: 42 + (flow ? 20 : -24) + Math.min(20, bodyAtr * 22) + Math.min(14, volume * 6),
    thesis: "HT7 等待波动率和成交区间真正压缩后，只交易带量、带实体并被资金流接受的首次扩张。",
    expectedBehavior: "突破后应迅速离开压缩盒；若收盘重新进入盒内，扩张故事失效，不继续等待第二次解释。",
    stop: swingStop(rows, side, currentAtr, 10, 0.14), rr: 2.3, minutes: 180,
    checks: [
      { key: "ht7-compression", label: "波动率先完成压缩", passed: compressed, required: true, detail: `${compressionRatio.toFixed(2)}x` },
      { key: "ht7-breakout", label: "收盘离开压缩盒", passed: broken, required: true, detail: side === "LONG" ? `>${priorHigh.toFixed(6)}` : `<${priorLow.toFixed(6)}` },
      { key: "ht7-expansion", label: "量能与实体同步扩张", passed: expansion, required: true, detail: `${volume.toFixed(2)}x / ${bodyAtr.toFixed(2)} ATR` },
      { key: "ht7-flow", label: "资金流接受扩张方向", passed: flow, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)}` },
    ],
  });
}

function relativeStrength(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const rank = input.crossSectionRank ?? 0.5;
  const side: Hte31TradeSide = rank >= 0.5 ? "LONG" : "SHORT";
  const leader = side === "LONG" ? rank >= 0.76 : rank <= 0.24;
  const relativeMove = (input.changePercentage ?? 0) - (input.benchmarkMomentum ?? 0);
  const relativeConfirmed = signed(relativeMove, side) >= 0.80;
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const resumed = Boolean(latest && previous && currentAtr && Math.abs(latest.close - latest.open) >= currentAtr * 0.12 && (side === "LONG"
    ? latest.close > latest.open && latest.close > previous.close
    : latest.close < latest.open && latest.close < previous.close));
  const structure = signed(input.timeframeTrend1h, side) >= 0.05 && signed(input.timeframeTrend4h, side) >= -0.06;
  const flow = signed(input.spotCvdRatio, side) >= -0.003 && signed(input.orderBookImbalance, side) >= -0.05;
  const routerFit = !["leverage_liquidation"].includes(assetRegime);
  const setupActive = leader && relativeConfirmed && resumed && structure && flow && routerFit;
  return makeSignal(input, regime, assetRegime, {
    traderId: "relative_strength", strategyId: "relative_strength", playbookId: "HT8_RELATIVE_STRENGTH", side,
    setupActive,
    setupScore: (leader ? 30 : 0) + (relativeConfirmed ? 24 : 0) + (resumed ? 20 : 0) + (structure ? 18 : 0) + (routerFit ? 8 : 0),
    evidenceScore: 44 + (flow ? 18 : -22) + Math.min(22, signed(relativeMove, side) * 7) + Math.min(12, Math.abs(rank - 0.5) * 24),
    thesis: "HT8 不预测整个市场，而是交易同一时刻显著强于或弱于基准、并且自身周期结构继续确认的领涨/领跌币。",
    expectedBehavior: "相对优势应继续保持；若币种排名快速回到中位且自身结构转弱，轮动故事失效。",
    stop: swingStop(rows, side, currentAtr, 12, 0.16), rr: 2.2, minutes: 240,
    checks: [
      { key: "ht8-rank", label: "横截面位于强弱两端", passed: leader, required: true, detail: `${Math.round(rank * 100)}%` },
      { key: "ht8-relative", label: "相对基准优势明确", passed: relativeConfirmed, required: true, detail: `${relativeMove.toFixed(2)}%` },
      { key: "ht8-structure", label: "自身1h/4h结构不反对", passed: structure, required: true, detail: `1h ${signed(input.timeframeTrend1h, side).toFixed(2)} / 4h ${signed(input.timeframeTrend4h, side).toFixed(2)}` },
      { key: "ht8-resume", label: "5m 已重新沿强弱方向运行", passed: resumed, required: true, detail: resumed ? "恢复成立" : "等待恢复" },
      { key: "ht8-flow", label: "微观资金流未反向", passed: flow, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)}` },
    ],
  });
}

function momentumContinuation(input: Hte31Input, rows: Hte31Candle[], regime: Hte31MarketRegime, assetRegime: Hte31AssetRegime) {
  const currentAtr = atr(rows);
  const impulseRows = rows.slice(-18, -5);
  const pauseRows = rows.slice(-5, -1);
  const latest = rows.at(-1);
  const impulseRaw = impulseRows.length ? impulseRows.at(-1)!.close - impulseRows[0].open : 0;
  const side = directionFrom(impulseRaw || higherTimeframeScore(input));
  const impulseAtr = currentAtr ? Math.abs(impulseRaw) / currentAtr : 0;
  const impulseExtreme = side === "LONG"
    ? Math.max(...impulseRows.map((row) => row.high))
    : Math.min(...impulseRows.map((row) => row.low));
  const pauseExtreme = side === "LONG"
    ? Math.min(...pauseRows.map((row) => row.low))
    : Math.max(...pauseRows.map((row) => row.high));
  const retracement = Math.max(0, sideDirection(side) * (impulseExtreme - pauseExtreme));
  const retracementRatio = retracement / Math.max(Math.abs(impulseRaw), Number.EPSILON);
  const pauseRangeAtr = currentAtr && pauseRows.length
    ? (Math.max(...pauseRows.map((row) => row.high)) - Math.min(...pauseRows.map((row) => row.low))) / currentAtr
    : 99;
  const pauseBoundary = side === "LONG"
    ? Math.max(...pauseRows.map((row) => row.high))
    : Math.min(...pauseRows.map((row) => row.low));
  const bodyAtr = latest && currentAtr ? Math.abs(latest.close - latest.open) / currentAtr : 0;
  const resumed = Boolean(latest && currentAtr && bodyAtr >= 0.16 && (side === "LONG"
    ? latest.close > latest.open && latest.close > pauseBoundary
    : latest.close < latest.open && latest.close < pauseBoundary));
  const shallowPause = retracementRatio <= 0.45 && pauseRangeAtr <= 1.35;
  const volume = currentVolumeRatio(rows);
  const flow = signed(input.spotCvdRatio, side) >= -0.004 && signed(input.orderBookImbalance, side) >= -0.06;
  const structure = signed(input.timeframeTrend1h, side) >= -0.02 && signed(input.timeframeTrend4h, side) >= -0.10;
  const routerFit = ["trend_up", "trend_down", "expansion_up", "expansion_down", "transition"].includes(assetRegime);
  const setupActive = impulseAtr >= 1.55 && shallowPause && resumed && volume >= 0.86 && flow && structure && routerFit;
  return makeSignal(input, regime, assetRegime, {
    traderId: "momentum_continuation", strategyId: "momentum_continuation", playbookId: "HT9_MOMENTUM_CONTINUATION", side,
    setupActive,
    setupScore: (impulseAtr >= 1.55 ? 28 : 0) + (shallowPause ? 26 : 0) + (resumed ? 26 : 0) + (routerFit ? 10 : 0) + Math.min(10, volume * 6),
    evidenceScore: 42 + (flow ? 18 : -22) + (structure ? 14 : -18) + Math.min(18, impulseAtr * 6) + Math.min(12, bodyAtr * 18),
    thesis: "HT9 专门处理强趋势中的浅回踩或横向停顿：不要求回到 EMA20，只要求前面有真实推进、整理没有吞掉推进、并重新加速。",
    expectedBehavior: "突破浅整理后应快速续走；若整理低点/高点被反向破坏，延续故事立即失效。",
    stop: swingStop(rows, side, currentAtr, 8, 0.14), rr: 2.4, minutes: 210,
    checks: [
      { key: "ht9-impulse", label: "前段趋势推进清晰", passed: impulseAtr >= 1.55, required: true, detail: `${impulseAtr.toFixed(2)} ATR` },
      { key: "ht9-pause", label: "回踩浅且整理受控", passed: shallowPause, required: true, detail: `回撤 ${(retracementRatio * 100).toFixed(0)}% / 区间 ${pauseRangeAtr.toFixed(2)} ATR` },
      { key: "ht9-resume", label: "最新K线突破整理并加速", passed: resumed, required: true, detail: `${bodyAtr.toFixed(2)} ATR` },
      { key: "ht9-volume", label: "恢复时量能可接受", passed: volume >= 0.86, required: true, detail: `${volume.toFixed(2)}x` },
      { key: "ht9-flow", label: "资金流未反向压制", passed: flow, required: true, detail: `Spot ${signed(input.spotCvdRatio, side).toFixed(3)}` },
      { key: "ht9-structure", label: "1h/4h 不反对延续", passed: structure, required: true, detail: `1h ${signed(input.timeframeTrend1h, side).toFixed(2)}` },
      { key: "ht9-router", label: "环境允许动量延续", passed: routerFit, required: true, detail: assetRegime },
    ],
  });
}

export function evaluateHte31ResearchStrategies(input: Hte31Input): Hte31Signal[] {
  const rows = completed(input);
  if (rows.length < 42) return [];
  const regime = classifyHte31MarketRegime(input);
  const assetRegime = classifyHte31AssetRegime(input);
  return [
    acceptedBreakout(input, rows, regime, assetRegime),
    adaptivePullback(input, rows, regime, assetRegime),
    failedAuction(input, rows, regime, assetRegime),
    swingContext(input, rows, regime, assetRegime),
    rangeRotation(input, rows, regime, assetRegime),
    compressionExpansion(input, rows, regime, assetRegime),
    relativeStrength(input, rows, regime, assetRegime),
    momentumContinuation(input, rows, regime, assetRegime),
  ];
}
