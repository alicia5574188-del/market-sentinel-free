import type { Hte31AssetRegime, Hte31Candle, Hte31Input, Hte31MarketRegime } from "./hte31-types.ts";

const FIVE_MINUTES = 300_000;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function candleMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

function completed5m(input: Hte31Input) {
  return input.candles5m
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .filter((candle) => candleMs(candle.time) + FIVE_MINUTES <= input.observedAt)
    .sort((a, b) => a.time - b.time);
}

function atr(candles: Hte31Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close),
  ));
  return mean(ranges.slice(-period));
}

function volumeRatio(candles: Hte31Candle[]) {
  if (candles.length < 22) return null;
  const reference = candles.slice(-21, -1).map((candle) => candle.volume);
  return candles.at(-1)!.volume / Math.max(mean(reference), Number.EPSILON);
}

function rollingAtrRatio(candles: Hte31Candle[]) {
  if (candles.length < 42) return null;
  const recent = atr(candles.slice(-20), 10);
  const older = atr(candles.slice(-42, -12), 14);
  if (recent == null || older == null || older <= 0) return null;
  return recent / older;
}

function rangeWidthPct(candles: Hte31Candle[], lookback = 24) {
  const window = candles.slice(-lookback);
  const last = window.at(-1)?.close ?? 0;
  if (window.length < 12 || last <= 0) return null;
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  return (high - low) / last * 100;
}

function recentMove(candles: Hte31Candle[], lookback = 6) {
  const first = candles.at(-(lookback + 1))?.close ?? 0;
  const last = candles.at(-1)?.close ?? 0;
  return first > 0 ? (last / first - 1) * 100 : 0;
}

/**
 * Exact HTE31-owned copy of the legacy shadow regime classifier.
 * Keep behavior byte-for-byte equivalent at the decision level until a
 * separately reviewed strategy change intentionally alters thresholds.
 */
export function classifyHte31MarketRegime(input: Hte31Input): Hte31MarketRegime {
  const candles = completed5m(input);
  const atr5 = atr(candles);
  const atrPct = atr5 != null && input.futuresPrice > 0 ? atr5 / input.futuresPrice * 100 : null;
  const compressionRatio = rollingAtrRatio(candles);
  const width = rangeWidthPct(candles);
  const trend = clamp(input.multiTimeframeTrend ?? 0, -1, 1);
  const relativeStrength24h = input.changePercentage == null || input.benchmarkMomentum == null
    ? null
    : input.changePercentage - input.benchmarkMomentum;
  const stress = input.dataQuality < 0.68
    || (input.macroEventRisk ?? 0) >= 0.85
    || (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.001);

  let kind: Hte31MarketRegime["kind"];
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

/**
 * Exact HTE31-owned copy of the Strategy 2 asset-regime router currently used
 * by the three Human Trader setups. This is intentionally a behavior-preserving
 * extraction, not a strategy optimization.
 */
export function classifyHte31AssetRegime(input: Hte31Input): Hte31AssetRegime {
  const rows = completed5m(input);
  const base = classifyHte31MarketRegime(input);
  const recentAtr = atr(rows.slice(-20), 10);
  const olderAtr = atr(rows.slice(-42, -12), 14);
  const atrRatio = recentAtr != null && olderAtr != null && olderAtr > 0
    ? recentAtr / olderAtr
    : base.compressionRatio;
  const move = recentMove(rows);
  const volume = volumeRatio(rows) ?? 1;
  const trend = input.multiTimeframeTrend ?? base.trendScore;

  if (Math.abs(input.liquidationImbalance ?? 0) >= 0.48) return "leverage_liquidation";
  if (atrRatio != null && atrRatio <= 0.80) return "compression";
  if ((atrRatio != null && atrRatio >= 1.18) || volume >= 1.35) {
    if (Math.abs(move) >= 0.25 || Math.abs(trend) >= 0.28) {
      return (move || trend) >= 0 ? "expansion_up" : "expansion_down";
    }
  }
  if (Math.abs(trend) >= 0.34) return trend >= 0 ? "trend_up" : "trend_down";
  if (Math.abs(trend) <= 0.24 && (base.rangeWidthPct ?? 99) <= 6) return "range";
  return "transition";
}
