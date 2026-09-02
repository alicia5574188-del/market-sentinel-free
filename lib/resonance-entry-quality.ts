import type { Hte31Candle } from "./hte31-types.ts";

export type ResonanceEntryQualityClassification =
  | "direction_wrong"
  | "entry_too_early"
  | "entry_too_late"
  | "normal_noise"
  | "stop_too_tight"
  | "insufficient_data";

export type ResonanceEntryTimingCounterfactual = {
  delayBars: 1 | 2 | 3;
  delayMinutes: number;
  entryAt: number | null;
  entryPrice: number | null;
  valid: boolean;
  observedMinutes: number;
  terminalR: number | null;
  improvementR: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
  stopped: boolean | null;
};

export type ResonanceEntryQualityReport = {
  generatedAt: number;
  sampleSufficient: boolean;
  classification: ResonanceEntryQualityClassification;
  classificationLabel: string;
  entryEfficiency: number | null;
  initialMaeR: number | null;
  timeToHalfRMinutes: number | null;
  timeToOneRMinutes: number | null;
  originalTerminalR: number | null;
  oppositeFourHourR: number | null;
  delayedEntries: ResonanceEntryTimingCounterfactual[];
  bestDelayBars: 1 | 2 | 3 | null;
  earlierEntryAdvantageR: number | null;
  evidence: string[];
};

export type ResonanceEntryQualityPattern = {
  setupId: string;
  assetRegime: string;
  classification: ResonanceEntryQualityClassification;
  classificationLabel: string;
  sampleSize: number;
  repeatedCount: number;
  qualifiesForEntryChange: boolean;
};

export type ResonanceEntryQualitySample = {
  setupId: string;
  assetRegime: string;
  entryQuality: ResonanceEntryQualityReport | null;
};

type TradeLike = {
  side: "LONG" | "SHORT";
  entryAt: number;
  entryPrice: number;
  initialStopPrice: number;
  exitAt?: number | null;
  maxHoldingMinutes?: number | null;
  stopRecovery?: boolean | null;
  postExitLabel?: string | null;
};

type TimedCandle = Hte31Candle & { _time: number };

type PathResult = {
  entryAt: number;
  entryPrice: number;
  terminalAt: number;
  observedMinutes: number;
  terminalR: number;
  maxFavorableR: number;
  maxAdverseR: number;
  stopped: boolean;
};

const BAR_MINUTES = 5;
const MIN_FUTURE_BARS = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function candleMs(candle: Hte31Candle) {
  return candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
}

function direction(side: "LONG" | "SHORT") {
  return side === "LONG" ? 1 : -1;
}

function normalizeCandles(candles: Hte31Candle[]) {
  const byTime = new Map<number, Hte31Candle>();
  for (const candle of candles) byTime.set(candleMs(candle), candle);
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, candle]) => ({ ...candle, _time: time }));
}

function favorableAndAdverse(side: TradeLike["side"], entryPrice: number, risk: number, rows: TimedCandle[]) {
  if (!rows.length || !(risk > 0)) return { favorableR: 0, adverseR: 0 };
  const high = Math.max(entryPrice, ...rows.map((row) => row.high));
  const low = Math.min(entryPrice, ...rows.map((row) => row.low));
  return side === "LONG"
    ? { favorableR: Math.max(0, (high - entryPrice) / risk), adverseR: Math.max(0, (entryPrice - low) / risk) }
    : { favorableR: Math.max(0, (entryPrice - low) / risk), adverseR: Math.max(0, (high - entryPrice) / risk) };
}

function simulatePath(input: {
  side: TradeLike["side"];
  entryAt: number;
  entryPrice: number;
  stopPrice: number;
  rows: TimedCandle[];
  endAt: number;
  roundTripCostBps: number;
}): PathResult | null {
  const risk = Math.abs(input.entryPrice - input.stopPrice);
  const stopOnCorrectSide = input.side === "LONG" ? input.stopPrice < input.entryPrice : input.stopPrice > input.entryPrice;
  if (!(input.entryPrice > 0 && risk > 0) || !stopOnCorrectSide) return null;
  const path = input.rows.filter((row) => row._time > input.entryAt && row._time <= input.endAt);
  if (!path.length) return null;

  const observed: TimedCandle[] = [];
  let stopped = false;
  let terminalPrice = path.at(-1)!.close;
  for (const row of path) {
    observed.push(row);
    const stopHit = input.side === "LONG" ? row.low <= input.stopPrice : row.high >= input.stopPrice;
    if (stopHit) {
      stopped = true;
      terminalPrice = input.stopPrice;
      break;
    }
  }
  const excursions = favorableAndAdverse(input.side, input.entryPrice, risk, observed);
  const feeR = input.entryPrice * Math.max(0, input.roundTripCostBps) / 10_000 / risk;
  return {
    entryAt: input.entryAt,
    entryPrice: input.entryPrice,
    terminalAt: observed.at(-1)!._time,
    observedMinutes: round(Math.max(BAR_MINUTES, (observed.at(-1)!._time - input.entryAt) / 60_000), 1),
    terminalR: round(direction(input.side) * (terminalPrice - input.entryPrice) / risk - feeR, 3),
    maxFavorableR: round(excursions.favorableR, 3),
    maxAdverseR: round(excursions.adverseR, 3),
    stopped,
  };
}

function timeToR(rows: TimedCandle[], trade: TradeLike, thresholdR: number, endAt: number) {
  const risk = Math.abs(trade.entryPrice - trade.initialStopPrice);
  const target = trade.entryPrice + direction(trade.side) * risk * thresholdR;
  for (const row of rows) {
    if (row._time <= trade.entryAt || row._time > endAt) continue;
    const stopHit = trade.side === "LONG" ? row.low <= trade.initialStopPrice : row.high >= trade.initialStopPrice;
    if (stopHit) return null;
    const targetHit = trade.side === "LONG" ? row.high >= target : row.low <= target;
    if (targetHit) return round(Math.max(BAR_MINUTES, (row._time - trade.entryAt) / 60_000), 1);
  }
  return null;
}

function maeBeforeHalfR(rows: TimedCandle[], trade: TradeLike, endAt: number) {
  const risk = Math.abs(trade.entryPrice - trade.initialStopPrice);
  const target = trade.entryPrice + direction(trade.side) * risk * 0.5;
  const observed: TimedCandle[] = [];
  for (const row of rows) {
    if (row._time <= trade.entryAt || row._time > endAt) continue;
    observed.push(row);
    const targetHit = trade.side === "LONG" ? row.high >= target : row.low <= target;
    const stopHit = trade.side === "LONG" ? row.low <= trade.initialStopPrice : row.high >= trade.initialStopPrice;
    if (targetHit || stopHit) break;
  }
  return round(favorableAndAdverse(trade.side, trade.entryPrice, risk, observed).adverseR, 3);
}

function classificationLabel(value: ResonanceEntryQualityClassification) {
  return ({
    direction_wrong: "方向错",
    entry_too_early: "入场过早",
    entry_too_late: "入场过晚",
    normal_noise: "正常噪声",
    stop_too_tight: "止损过紧",
    insufficient_data: "样本不足",
  } satisfies Record<ResonanceEntryQualityClassification, string>)[value];
}

export function buildResonanceEntryQualityPattern(samples: ResonanceEntryQualitySample[]): ResonanceEntryQualityPattern | null {
  const groups = new Map<string, ResonanceEntryQualitySample[]>();
  for (const sample of samples) {
    if (!sample.entryQuality?.sampleSufficient) continue;
    const key = `${sample.setupId}|${sample.assetRegime}`;
    const bucket = groups.get(key) ?? [];
    if (bucket.length < 5) bucket.push(sample);
    groups.set(key, bucket);
  }
  const patterns = [...groups.values()].flatMap((items) => {
    if (!items.length) return [];
    const counts = new Map<ResonanceEntryQualityClassification, number>();
    for (const item of items) {
      const classification = item.entryQuality!.classification;
      if (classification === "insufficient_data" || classification === "normal_noise") continue;
      counts.set(classification, (counts.get(classification) ?? 0) + 1);
    }
    const [classification, repeatedCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["normal_noise" as const, 0];
    const sampleSize = items.length;
    return [{
      setupId: items[0].setupId,
      assetRegime: items[0].assetRegime,
      classification,
      classificationLabel: classificationLabel(classification),
      sampleSize,
      repeatedCount,
      qualifiesForEntryChange: sampleSize >= 3 && repeatedCount >= 2 && repeatedCount / sampleSize >= 0.6,
    }];
  });
  return patterns.sort((a, b) => Number(b.qualifiesForEntryChange) - Number(a.qualifiesForEntryChange)
    || b.repeatedCount - a.repeatedCount || b.sampleSize - a.sampleSize)[0] ?? null;
}

/**
 * Observer-only entry diagnosis. It never mutates stops, sizing, live orders or
 * strategy thresholds. Delayed entries activate from the candle after the
 * hypothetical fill, avoiding impossible same-candle hindsight.
 */
export function buildResonanceEntryQuality(
  trade: TradeLike,
  candles: Hte31Candle[],
  roundTripCostBps = 0,
  now = Date.now(),
): ResonanceEntryQualityReport {
  const rows = normalizeCandles(candles);
  const future = rows.filter((row) => row._time > trade.entryAt);
  const risk = Math.abs(trade.entryPrice - trade.initialStopPrice);
  const maxHoldingMinutes = clamp(trade.maxHoldingMinutes ?? 240, 30, 720);
  const analysisEndAt = Math.min(now, trade.entryAt + maxHoldingMinutes * 60_000);
  const sampleSufficient = trade.entryPrice > 0 && risk > 0
    && future.filter((row) => row._time <= analysisEndAt).length >= MIN_FUTURE_BARS;

  if (!sampleSufficient) {
    return {
      generatedAt: now,
      sampleSufficient: false,
      classification: "insufficient_data",
      classificationLabel: classificationLabel("insufficient_data"),
      entryEfficiency: null,
      initialMaeR: null,
      timeToHalfRMinutes: null,
      timeToOneRMinutes: null,
      originalTerminalR: null,
      oppositeFourHourR: null,
      delayedEntries: ([1, 2, 3] as const).map((delayBars) => ({
        delayBars,
        delayMinutes: delayBars * BAR_MINUTES,
        entryAt: null,
        entryPrice: null,
        valid: false,
        observedMinutes: 0,
        terminalR: null,
        improvementR: null,
        maxFavorableR: null,
        maxAdverseR: null,
        stopped: null,
      })),
      bestDelayBars: null,
      earlierEntryAdvantageR: null,
      evidence: [`有效进场后K线不足 ${MIN_FUTURE_BARS} 根，暂不归因。`],
    };
  }

  const original = simulatePath({
    side: trade.side,
    entryAt: trade.entryAt,
    entryPrice: trade.entryPrice,
    stopPrice: trade.initialStopPrice,
    rows,
    endAt: analysisEndAt,
    roundTripCostBps,
  })!;
  const earlyEndAt = Math.min(analysisEndAt, trade.exitAt ?? analysisEndAt);
  const earlyRows = future.filter((row) => row._time <= earlyEndAt).slice(0, 6);
  const earlyExcursions = favorableAndAdverse(trade.side, trade.entryPrice, risk, earlyRows);
  const entryEfficiency = earlyExcursions.favorableR + earlyExcursions.adverseR > 0
    ? round(100 * earlyExcursions.favorableR / (earlyExcursions.favorableR + earlyExcursions.adverseR), 1)
    : 50;
  const initialMaeR = maeBeforeHalfR(rows, trade, analysisEndAt);
  const timeToHalfRMinutes = timeToR(rows, trade, 0.5, analysisEndAt);
  const timeToOneRMinutes = timeToR(rows, trade, 1, analysisEndAt);

  const delayedEntries = ([1, 2, 3] as const).map((delayBars): ResonanceEntryTimingCounterfactual => {
    const anchor = future[delayBars - 1];
    if (!anchor || anchor._time >= analysisEndAt) {
      return { delayBars, delayMinutes: delayBars * BAR_MINUTES, entryAt: null, entryPrice: null, valid: false, observedMinutes: 0, terminalR: null, improvementR: null, maxFavorableR: null, maxAdverseR: null, stopped: null };
    }
    const result = simulatePath({
      side: trade.side,
      entryAt: anchor._time,
      entryPrice: anchor.close,
      stopPrice: trade.initialStopPrice,
      rows,
      endAt: Math.min(now, anchor._time + maxHoldingMinutes * 60_000),
      roundTripCostBps,
    });
    return result ? {
      delayBars,
      delayMinutes: delayBars * BAR_MINUTES,
      entryAt: result.entryAt,
      entryPrice: round(result.entryPrice, 8),
      valid: true,
      observedMinutes: result.observedMinutes,
      terminalR: result.terminalR,
      improvementR: round(result.terminalR - original.terminalR, 3),
      maxFavorableR: result.maxFavorableR,
      maxAdverseR: result.maxAdverseR,
      stopped: result.stopped,
    } : { delayBars, delayMinutes: delayBars * BAR_MINUTES, entryAt: anchor._time, entryPrice: round(anchor.close, 8), valid: false, observedMinutes: 0, terminalR: null, improvementR: null, maxFavorableR: null, maxAdverseR: null, stopped: null };
  });

  const prior = rows.filter((row) => row._time <= trade.entryAt).slice(-3);
  const earlier = prior.map((anchor) => simulatePath({
    side: trade.side,
    entryAt: anchor._time,
    entryPrice: anchor.close,
    stopPrice: trade.initialStopPrice,
    rows,
    endAt: Math.min(now, anchor._time + maxHoldingMinutes * 60_000),
    roundTripCostBps,
  })).filter((item): item is PathResult => Boolean(item));
  const bestEarlier = [...earlier].sort((a, b) => b.terminalR - a.terminalR)[0] ?? null;
  const earlierEntryAdvantageR = bestEarlier ? round(bestEarlier.terminalR - original.terminalR, 3) : null;
  const bestDelay = [...delayedEntries]
    .filter((item) => item.valid && item.terminalR != null && item.improvementR != null)
    .sort((a, b) => (b.improvementR ?? -99) - (a.improvementR ?? -99))[0] ?? null;

  const fourHourAt = trade.entryAt + 240 * 60_000;
  const fourHourTerminal = rows.filter((row) => row._time > trade.entryAt && row._time <= fourHourAt).at(-1) ?? null;
  const fourHourComplete = now >= fourHourAt && fourHourTerminal != null && fourHourTerminal._time >= fourHourAt - 10 * 60_000;
  const feeR = trade.entryPrice * Math.max(0, roundTripCostBps) / 10_000 / risk;
  const grossFourHourR = fourHourComplete ? direction(trade.side) * (fourHourTerminal.close - trade.entryPrice) / risk : null;
  const originalFourHourR = grossFourHourR == null ? null : grossFourHourR - feeR;
  const oppositeFourHourR = grossFourHourR == null ? null : -grossFourHourR - feeR;
  const postStopRows = original.stopped
    ? rows.filter((row) => row._time > original.terminalAt && row._time <= Math.min(now, trade.entryAt + 12 * 60 * 60_000))
    : [];
  const postStopRecoveryR = favorableAndAdverse(trade.side, trade.entryPrice, risk, postStopRows).favorableR;

  let classification: ResonanceEntryQualityClassification = "normal_noise";
  if (originalFourHourR != null && oppositeFourHourR != null && originalFourHourR < -0.15 && oppositeFourHourR > originalFourHourR + 0.6) {
    classification = "direction_wrong";
  } else if (bestDelay && (bestDelay.terminalR ?? -99) >= 0.35 && (bestDelay.improvementR ?? 0) >= 0.5
    && initialMaeR >= 0.5 && (bestDelay.maxAdverseR ?? 99) <= Math.max(0, original.maxAdverseR - 0.25)) {
    classification = "entry_too_early";
  } else if (bestEarlier && bestEarlier.terminalR >= 0.35 && (earlierEntryAdvantageR ?? 0) >= 0.5
    && bestEarlier.maxAdverseR <= original.maxAdverseR + 0.1) {
    classification = "entry_too_late";
  } else if (trade.stopRecovery || trade.postExitLabel === "疑似假止损" || (original.stopped && postStopRecoveryR >= 0.75)) {
    classification = "stop_too_tight";
  }

  const evidence = [
    `Entry Efficiency ${entryEfficiency.toFixed(1)}% · 首次 +0.5R 前 MAE ${initialMaeR.toFixed(2)}R`,
    `达到 +0.5R：${timeToHalfRMinutes == null ? "未达到" : `${timeToHalfRMinutes} 分钟`} · +1R：${timeToOneRMinutes == null ? "未达到" : `${timeToOneRMinutes} 分钟`}`,
    bestDelay?.valid
      ? `最佳延迟：晚 ${bestDelay.delayMinutes} 分钟，结果改善 ${(bestDelay.improvementR ?? 0) >= 0 ? "+" : ""}${(bestDelay.improvementR ?? 0).toFixed(2)}R`
      : "晚 5/10/15 分钟的路径尚未形成有效对照",
    `进场归因：${classificationLabel(classification)}（进入统一策略学习）`,
  ];

  return {
    generatedAt: now,
    sampleSufficient: true,
    classification,
    classificationLabel: classificationLabel(classification),
    entryEfficiency,
    initialMaeR,
    timeToHalfRMinutes,
    timeToOneRMinutes,
    originalTerminalR: original.terminalR,
    oppositeFourHourR: oppositeFourHourR == null ? null : round(oppositeFourHourR, 3),
    delayedEntries,
    bestDelayBars: bestDelay?.delayBars ?? null,
    earlierEntryAdvantageR,
    evidence,
  };
}
