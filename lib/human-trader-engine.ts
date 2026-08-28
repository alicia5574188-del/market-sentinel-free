import type { Candle, SignalMetric } from "./signal-engine.ts";
import { classifyShadowRegime, type MarketRegime } from "./shadow-strategy-engine.ts";
import {
  classifyStrategy2AssetRegime,
  type Strategy2AssetRegime,
  type Strategy2Input,
  type Strategy2Signal,
} from "./strategy-2-engine.ts";
import type { EntryCheck, EntryPlan, ExitRule, TradeSide } from "./trade-lifecycle.ts";

export type HumanTraderId = "dennis_trend" | "raschke_pullback" | "turtle_soup";

export const HUMAN_TRADER_PLAYBOOKS: Record<HumanTraderId, string> = {
  dennis_trend: "HT1_DENNIS_TREND",
  raschke_pullback: "HT2_RASCHKE_PULLBACK",
  turtle_soup: "HT3_TURTLE_SOUP",
};

export const HUMAN_TRADER_LABELS: Record<HumanTraderId, string> = {
  dennis_trend: "HT1 Dennis 趋势突破",
  raschke_pullback: "HT2 Raschke 趋势回踩",
  turtle_soup: "HT3 Turtle Soup 假突破",
};

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

function completed(input: Strategy2Input) {
  return input.candles5m
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .filter((candle) => candleMs(candle.time) + FIVE_MINUTES <= input.observedAt)
    .sort((a, b) => a.time - b.time);
}

function atr(rows: Candle[], period = 14) {
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

function volumeRatio(rows: Candle[]) {
  if (rows.length < 22) return null;
  return rows.at(-1)!.volume / Math.max(mean(rows.slice(-21, -1).map((row) => row.volume)), Number.EPSILON);
}

function signed(value: number | null | undefined, side: TradeSide) {
  return (value ?? 0) * (side === "LONG" ? 1 : -1);
}

function swingStop(rows: Candle[], side: TradeSide, currentAtr: number | null, lookback = 10, padding = 0.16) {
  if (!rows.length || currentAtr == null) return 0;
  const window = rows.slice(-lookback);
  return side === "LONG"
    ? Math.min(...window.map((row) => row.low)) - currentAtr * padding
    : Math.max(...window.map((row) => row.high)) + currentAtr * padding;
}

function exits(side: TradeSide, stop: number, tp1: number, tp2: number, minutes: number): ExitRule[] {
  return [
    { code: "stop_loss", label: "结构止损", condition: `${side === "LONG" ? "价格 ≤" : "价格 ≥"} ${stop}` },
    { code: "breakeven", label: "第一目标保护", condition: `到达 ${tp1} 后止损移动到入场价` },
    { code: "take_profit", label: "第二目标", condition: `到达 ${tp2} 完成退出` },
    { code: "structure_reversal", label: "交易员 Thesis 失效", condition: "该交易员定义的结构前提不再成立" },
    { code: "flow_reversal", label: "资金流反转", condition: "主动流连续反向并破坏原 Thesis" },
    { code: "macro_risk", label: "紧急风险退出", condition: "全局风险进入 RED / 紧急事件" },
    { code: "timeout", label: "时间止损", condition: `${minutes} 分钟仍未兑现该 Setup 的预期行为则退出` },
  ];
}

function hardBlockers(input: Strategy2Input) {
  const blockers: string[] = [];
  if (input.dataQuality < 0.68) blockers.push("DATA_UNSAFE");
  if (input.volumeUsd < 12_000_000) blockers.push("LIQUIDITY_TOO_LOW");
  if (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.0015) blockers.push("LEVERAGE_EXTREME");
  if ((input.macroEventRisk ?? 0) >= 0.98) blockers.push("EMERGENCY_EVENT_RISK");
  return blockers;
}

function plan(input: Strategy2Input, side: TradeSide, stop: number, rr: number, minutes: number, checks: EntryCheck[]): EntryPlan | null {
  const rows = completed(input);
  const currentAtr = atr(rows);
  const entry = input.futuresPrice;
  if (currentAtr == null || entry <= 0 || stop <= 0) return null;
  const risk = Math.abs(entry - stop);
  const riskPct = risk / entry * 100;
  if (risk <= 0 || riskPct > 5) return null;
  const direction = side === "LONG" ? 1 : -1;
  const tp1 = entry + direction * risk;
  const tp2 = entry + direction * risk * rr;
  const hard: EntryCheck[] = [
    { key: "hte-data", label: "数据安全", passed: input.dataQuality >= 0.68, required: true, detail: `${Math.round(input.dataQuality * 100)}%` },
    { key: "hte-liquidity", label: "流动性安全", passed: input.volumeUsd >= 12_000_000, required: true, detail: `${(input.volumeUsd / 1e6).toFixed(1)}M` },
    { key: "hte-funding", label: "杠杆拥挤安全", passed: input.fundingRate == null || Math.abs(input.fundingRate) < 0.0015, required: true, detail: `${((input.fundingRate ?? 0) * 100).toFixed(4)}%` },
    { key: "hte-event", label: "事件安全", passed: (input.macroEventRisk ?? 0) < 0.98, required: true, detail: `${Math.round((input.macroEventRisk ?? 0) * 100)}` },
    { key: "hte-stop", label: "结构止损距离", passed: riskPct <= 5, required: true, detail: `${riskPct.toFixed(2)}%` },
  ];
  const allChecks = [...hard, ...checks];
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
    exitRules: exits(side, stop, tp1, tp2, minutes),
  };
}

function commonMetrics(input: Strategy2Input, regime: MarketRegime, assetRegime: Strategy2AssetRegime, trader: HumanTraderId): SignalMetric[] {
  return [
    { key: "human-trader", label: "主交易员", score: 1, detail: HUMAN_TRADER_LABELS[trader], available: true, category: "cross" },
    { key: "asset-regime", label: "单币环境", score: Math.abs(regime.trendScore), detail: assetRegime, available: true, category: "cross" },
    { key: "multi-timeframe", label: "多周期结构", score: regime.trendScore, detail: `${(regime.trendScore * 100).toFixed(0)}`, available: input.multiTimeframeTrend != null, category: "price" },
    { key: "spot-flow", label: "现货主动流", score: input.spotCvdRatio ?? 0, detail: input.spotCvdRatio == null ? "--" : `${(input.spotCvdRatio * 100).toFixed(1)}%`, available: input.spotCvdRatio != null, category: "spot" },
    { key: "order-book", label: "订单簿", score: input.orderBookImbalance ?? 0, detail: input.orderBookImbalance == null ? "--" : `${(input.orderBookImbalance * 100).toFixed(1)}%`, available: input.orderBookImbalance != null, category: "microstructure" },
  ];
}

function signal(input: Strategy2Input, config: {
  trader: HumanTraderId;
  strategyId: "trend_breakout" | "trend_pullback" | "failed_breakout";
  side: TradeSide;
  assetRegime: Strategy2AssetRegime;
  regime: MarketRegime;
  setupActive: boolean;
  routerEligible: boolean;
  setupScore: number;
  evidenceScore: number;
  thesis: string;
  expectedBehavior: string;
  stop: number;
  rr: number;
  minutes: number;
  checks: EntryCheck[];
}): Strategy2Signal {
  const blockers = hardBlockers(input);
  const entryPlan = plan(input, config.side, config.stop, config.rr, config.minutes, [
    { key: "hte-router", label: "交易员环境路由", passed: config.routerEligible, required: true, detail: config.assetRegime },
    ...config.checks,
  ]);
  const hardGatePassed = blockers.length === 0 && Boolean(entryPlan?.ready);
  const ready = config.setupActive && config.routerEligible && hardGatePassed;
  const direction = config.side === "LONG" ? 1 : -1;
  const score = direction * clamp(config.setupScore * 0.62 + config.evidenceScore * 0.38) / 100;
  const failedRequired = entryPlan?.checks.filter((check) => check.required && !check.passed).map((check) => `${check.label}未通过`) ?? [];
  return {
    strategyId: config.strategyId,
    label: HUMAN_TRADER_LABELS[config.trader],
    shadowOnly: true,
    state: blockers.length ? "blocked" : ready ? "ready" : "watching",
    side: blockers.length ? "WAIT" : config.side,
    score: Number(score.toFixed(4)),
    confidence: Math.round(clamp(48 + config.setupScore * 0.28 + config.evidenceScore * 0.18 + input.dataQuality * 12)),
    regime: config.regime,
    thesis: `${config.thesis} 预期行为：${config.expectedBehavior}`,
    reasons: config.checks.filter((check) => check.passed).map((check) => check.label),
    blockers: [...new Set([...blockers, ...failedRequired])],
    entryPlan,
    metrics: commonMetrics(input, config.regime, config.assetRegime, config.trader),
    strategyMeta: {
      playbookId: HUMAN_TRADER_PLAYBOOKS[config.trader],
      assetRegime: config.assetRegime,
      setupScore: Math.round(clamp(config.setupScore)),
      evidenceScore: Math.round(clamp(config.evidenceScore)),
      triggerActive: config.setupActive,
      hardGatePassed,
      candidateSide: config.side,
      supportingPlaybooks: [],
      strategyConflict: 0,
    },
  };
}

function dennis(input: Strategy2Input, rows: Candle[], regime: MarketRegime, assetRegime: Strategy2AssetRegime): Strategy2Signal {
  const currentAtr = atr(rows);
  const prior = rows.slice(-23, -2);
  const latest = rows.at(-1);
  const priorHigh = prior.length ? Math.max(...prior.map((row) => row.high)) : 0;
  const priorLow = prior.length ? Math.min(...prior.map((row) => row.low)) : 0;
  const trend = input.multiTimeframeTrend ?? 0;
  const side: TradeSide = trend >= 0 ? "LONG" : "SHORT";
  const breakout = Boolean(latest && currentAtr && (side === "LONG"
    ? latest.close > priorHigh + currentAtr * 0.04
    : latest.close < priorLow - currentAtr * 0.04));
  const body = latest ? Math.abs(latest.close - latest.open) : 0;
  const expansion = Boolean(latest && currentAtr && (latest.high - latest.low) >= currentAtr * 0.9 && body >= currentAtr * 0.25);
  const volume = volumeRatio(rows) ?? 0;
  const flow = signed(input.spotCvdRatio, side);
  const notOpposed = flow >= -0.006 && signed(input.orderBookImbalance, side) >= -0.08;
  const routerEligible = ["trend_up", "trend_down", "expansion_up", "expansion_down", "compression"].includes(assetRegime);
  const trendAligned = Math.abs(trend) >= 0.32;
  const setupActive = prior.length >= 18 && breakout && trendAligned && expansion;
  const expansionAtr = latest && currentAtr ? (latest.high - latest.low) / Math.max(currentAtr, Number.EPSILON) : 0;
  return signal(input, {
    trader: "dennis_trend",
    strategyId: "trend_breakout",
    side,
    assetRegime,
    regime,
    setupActive,
    routerEligible,
    setupScore: (breakout ? 44 : 0) + (trendAligned ? 28 : 0) + (expansion ? 18 : 0) + Math.min(10, Math.max(0, (volume - 0.8) * 15)),
    evidenceScore: 48 + (notOpposed ? 18 : -24) + Math.min(22, Math.max(-18, flow * 450)) + Math.min(12, Math.max(0, (volume - 1) * 20)),
    thesis: "Dennis 交易员只参与已经离开旧区间的真实趋势突破，不在区间内部预测方向。",
    expectedBehavior: "突破后应在接下来数根 5m K 线维持在旧区间外；快速跌回/涨回旧区间视为 Thesis 失败。",
    stop: swingStop(rows, side, currentAtr, 12, 0.14),
    rr: 2.4,
    minutes: 240,
    checks: [
      { key: "dennis-trend", label: "高周期趋势成立", passed: trendAligned, required: true, detail: `${Math.round(Math.abs(trend) * 100)}` },
      { key: "dennis-breakout", label: "收盘有效突破旧区间", passed: breakout, required: true, detail: side === "LONG" ? `>${priorHigh}` : `<${priorLow}` },
      { key: "dennis-expansion", label: "突破K线真实扩张", passed: expansion, required: true, detail: `${expansionAtr.toFixed(2)} ATR` },
      { key: "dennis-flow", label: "资金流没有反向压制", passed: notOpposed, required: true, detail: `Spot ${flow.toFixed(3)}` },
    ],
  });
}

function raschke(input: Strategy2Input, rows: Candle[], regime: MarketRegime, assetRegime: Strategy2AssetRegime): Strategy2Signal {
  const currentAtr = atr(rows);
  const closes = rows.map((row) => row.close);
  const ema20 = ema(closes.slice(-50), 20);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const trend = input.multiTimeframeTrend ?? 0;
  const side: TradeSide = trend >= 0 ? "LONG" : "SHORT";
  const routerEligible = ["trend_up", "trend_down", "expansion_up", "expansion_down"].includes(assetRegime);
  const strongTrend = Math.abs(trend) >= 0.38;
  const impulseWindow = rows.slice(-16, -4);
  const impulse = Boolean(currentAtr && impulseWindow.length >= 8
    && (Math.max(...impulseWindow.map((row) => row.high)) - Math.min(...impulseWindow.map((row) => row.low))) >= currentAtr * 2.2);
  const nearEma = Boolean(latest && ema20 && currentAtr && Math.abs(latest.close - ema20) <= currentAtr * 0.9);
  const local = rows.slice(-12);
  const controlled = Boolean(latest && previous && currentAtr && local.length >= 8 && (side === "LONG"
    ? Math.min(latest.low, previous.low) > Math.min(...local.slice(0, -2).map((row) => row.low)) - currentAtr * 0.12
    : Math.max(latest.high, previous.high) < Math.max(...local.slice(0, -2).map((row) => row.high)) + currentAtr * 0.12));
  const resume = Boolean(latest && previous && (side === "LONG"
    ? latest.close > latest.open && latest.close > previous.close
    : latest.close < latest.open && latest.close < previous.close));
  const flow = signed(input.spotCvdRatio, side);
  const notOpposed = flow >= -0.004;
  const setupActive = strongTrend && impulse && nearEma && controlled && resume;
  return signal(input, {
    trader: "raschke_pullback",
    strategyId: "trend_pullback",
    side,
    assetRegime,
    regime,
    setupActive,
    routerEligible,
    setupScore: (strongTrend ? 28 : 0) + (impulse ? 24 : 0) + (nearEma ? 22 : 0) + (controlled ? 14 : 0) + (resume ? 12 : 0),
    evidenceScore: 52 + (notOpposed ? 18 : -25) + Math.min(20, Math.max(-15, flow * 450)),
    thesis: "Raschke 交易员不追第一次突破；只在强趋势已经证明自己之后，等待靠近短期均值的受控回踩并出现恢复K线。",
    expectedBehavior: "恢复K线出现后应重新离开均值区；若回踩继续扩展并破坏局部结构，不给第二次解释机会。",
    stop: swingStop(rows, side, currentAtr, 10, 0.16),
    rr: 2.2,
    minutes: 180,
    checks: [
      { key: "raschke-trend", label: "强趋势已先成立", passed: strongTrend, required: true, detail: `${Math.round(Math.abs(trend) * 100)}` },
      { key: "raschke-impulse", label: "趋势已有推进段", passed: impulse, required: true, detail: "先有趋势，再等回踩" },
      { key: "raschke-pullback", label: "回踩进入均值区", passed: nearEma && controlled, required: true, detail: ema20 == null ? "EMA20 --" : `EMA20 ${ema20.toFixed(6)}` },
      { key: "raschke-resume", label: "回踩后重新恢复", passed: resume, required: true, detail: "最新收盘重新顺势" },
      { key: "raschke-flow", label: "现货流未反向压制", passed: notOpposed, required: true, detail: `Spot ${flow.toFixed(3)}` },
    ],
  });
}

function turtleSoup(input: Strategy2Input, rows: Candle[], regime: MarketRegime, assetRegime: Strategy2AssetRegime): Strategy2Signal {
  const currentAtr = atr(rows);
  const prior = rows.slice(-32, -2);
  const sweep = rows.at(-2);
  const reclaim = rows.at(-1);
  const priorHigh = prior.length ? Math.max(...prior.map((row) => row.high)) : 0;
  const priorLow = prior.length ? Math.min(...prior.map((row) => row.low)) : 0;
  const priorHighIndex = prior.findIndex((row) => row.high === priorHigh);
  const priorLowIndex = prior.findIndex((row) => row.low === priorLow);
  const highExtremeMature = priorHighIndex >= 0 && priorHighIndex <= prior.length - 6;
  const lowExtremeMature = priorLowIndex >= 0 && priorLowIndex <= prior.length - 6;
  const extremeMature = highExtremeMature || lowExtremeMature;

  const highExcursion = sweep && currentAtr ? (sweep.high - priorHigh) / Math.max(currentAtr, Number.EPSILON) : 0;
  const lowExcursion = sweep && currentAtr ? (priorLow - sweep.low) / Math.max(currentAtr, Number.EPSILON) : 0;
  const sweptHigh = Boolean(sweep && currentAtr && highExtremeMature
    && sweep.high > priorHigh + currentAtr * 0.12
    && sweep.high < priorHigh + currentAtr * 1.25);
  const sweptLow = Boolean(sweep && currentAtr && lowExtremeMature
    && sweep.low < priorLow - currentAtr * 0.12
    && sweep.low > priorLow - currentAtr * 1.25);
  const failedHigh = Boolean(sweptHigh && reclaim && currentAtr && reclaim.close < priorHigh - currentAtr * 0.08);
  const failedLow = Boolean(sweptLow && reclaim && currentAtr && reclaim.close > priorLow + currentAtr * 0.08);
  const side: TradeSide = failedHigh ? "SHORT" : "LONG";

  const flow = signed(input.spotCvdRatio, side);
  const book = signed(input.orderBookImbalance, side);
  const reclaimBody = Boolean(reclaim && currentAtr && Math.abs(reclaim.close - reclaim.open) >= currentAtr * 0.24);
  const baselineVolume = mean(rows.slice(-24, -3).map((row) => row.volume));
  const sweepVolumeRatio = sweep ? sweep.volume / Math.max(baselineVolume, Number.EPSILON) : 0;
  const flowConfirm = flow >= 0.002;
  const bookConfirm = book >= 0.02;
  const volumeConfirm = sweepVolumeRatio >= 1.15;
  const confirmationVotes = [flowConfirm, bookConfirm, reclaimBody, volumeConfirm].filter(Boolean).length;
  const microConfirm = confirmationVotes >= 3;

  const trend = signed(input.multiTimeframeTrend, side);
  const fightingStrongTrend = trend < -0.38 && !["transition", "leverage_liquidation"].includes(assetRegime);
  const routerEligible = ["range", "compression", "transition", "leverage_liquidation"].includes(assetRegime) && !fightingStrongTrend;
  const liquidEnough = input.volumeUsd >= 30_000_000;
  const setupActive = (failedHigh || failedLow) && extremeMature && microConfirm && liquidEnough;

  return signal(input, {
    trader: "turtle_soup",
    strategyId: "failed_breakout",
    side,
    assetRegime,
    regime,
    setupActive,
    routerEligible,
    setupScore: (failedHigh || failedLow ? 52 : 0)
      + (extremeMature ? 10 : 0)
      + (reclaimBody ? 12 : 0)
      + (volumeConfirm ? 10 : 0)
      + (assetRegime === "transition" || assetRegime === "range" ? 12 : 6),
    evidenceScore: 38
      + confirmationVotes * 12
      + Math.min(12, Math.max(-12, flow * 350))
      + Math.min(10, Math.max(-10, book * 100)),
    thesis: "Turtle Soup 只交易成熟旧极值被明显扫过、放量后重新深度收回区间，并由多源微观结构确认的失败突破；不再把普通刺破当成反转。",
    expectedBehavior: "收回后应继续远离被扫极值；若再次触及/突破被扫极值，或微观流重新同向突破，立即判定 Thesis 失败。",
    stop: swingStop(rows, side, currentAtr, 8, 0.18),
    rr: 2.1,
    minutes: 100,
    checks: [
      { key: "soup-mature", label: "被扫极值已经成熟", passed: extremeMature, required: true, detail: failedHigh || sweptHigh ? `旧高距扫单至少 5 根 5m K` : `旧低距扫单至少 5 根 5m K` },
      { key: "soup-sweep", label: "旧高/旧低被明显扫过", passed: sweptHigh || sweptLow, required: true, detail: sweptHigh ? `扫高 ${highExcursion.toFixed(2)} ATR` : sweptLow ? `扫低 ${lowExcursion.toFixed(2)} ATR` : "扫单幅度不足/过度" },
      { key: "soup-reclaim", label: "下一根深度收回区间", passed: failedHigh || failedLow, required: true, detail: failedHigh ? "高点假突破确认" : failedLow ? "低点假突破确认" : "收回深度不足" },
      { key: "soup-volume", label: "扫单成交量放大", passed: volumeConfirm, required: true, detail: `${sweepVolumeRatio.toFixed(2)}x` },
      { key: "soup-micro", label: "反向微观结构多源确认", passed: microConfirm, required: true, detail: `${confirmationVotes}/4 · Spot ${flow.toFixed(3)} / Book ${book.toFixed(3)}` },
      { key: "soup-liquidity", label: "反转交易只做高流动性合约", passed: liquidEnough, required: true, detail: `${(input.volumeUsd / 1e6).toFixed(1)}M` },
      { key: "soup-trend", label: "不硬抗持续强趋势", passed: !fightingStrongTrend, required: true, detail: `逆向趋势 ${trend.toFixed(2)}` },
    ],
  });
}

/**
 * Human Trader Engine 3.0.
 * Exactly three independent traders are evaluated. Their setups are never
 * added, averaged or allowed to vote each other across an entry threshold.
 */
export function evaluateHumanTraderPool(input: Strategy2Input): Strategy2Signal[] {
  const rows = completed(input);
  const regime = classifyShadowRegime(input);
  const assetRegime = classifyStrategy2AssetRegime(input);
  if (rows.length < 34) {
    const traders = ["dennis_trend", "raschke_pullback", "turtle_soup"] as HumanTraderId[];
    return traders.map((trader, index) => ({
      strategyId: index === 0 ? "trend_breakout" : index === 1 ? "trend_pullback" : "failed_breakout",
      label: HUMAN_TRADER_LABELS[trader],
      shadowOnly: true,
      state: "blocked",
      side: "WAIT",
      score: 0,
      confidence: 0,
      regime,
      thesis: "5m 完成K线不足，Human Trader Engine 拒绝推断。",
      reasons: [],
      blockers: ["INSUFFICIENT_CANDLES"],
      entryPlan: null,
      metrics: commonMetrics(input, regime, assetRegime, trader),
      strategyMeta: {
        playbookId: HUMAN_TRADER_PLAYBOOKS[trader],
        assetRegime,
        setupScore: 0,
        evidenceScore: 0,
        triggerActive: false,
        hardGatePassed: false,
        candidateSide: "LONG",
        supportingPlaybooks: [],
        strategyConflict: 0,
      },
    }));
  }
  return [
    dennis(input, rows, regime, assetRegime),
    raschke(input, rows, regime, assetRegime),
    turtleSoup(input, rows, regime, assetRegime),
  ];
}
