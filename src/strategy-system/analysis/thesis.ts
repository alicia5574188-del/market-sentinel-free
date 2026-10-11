import type { MarketSnapshot, Position, ThesisFactor, ThesisState } from '../types.ts';
import { CONFIG } from '../config.ts';
import {
  calcATR,
  calcRange,
  calcVolumeMean,
  calcHigherHighs,
  calcLowerLows,
  clamp,
} from '../data/features.ts';

export interface ThesisEvaluation {
  score: number;
  factors: ThesisFactor[];
  state: ThesisState;
  detail: string;
}

export function evaluateThesis(
  pos: Position,
  snap: MarketSnapshot,
  prevState: ThesisState,
  prevStateAt: number,
  now: number,
): ThesisEvaluation {
  const factors: ThesisFactor[] = [
    evaluatePriceStructure(pos, snap),
    evaluateVolume(pos, snap),
    evaluateDerivatives(pos, snap),
    evaluateCrossMarket(pos, snap),
    evaluateSentiment(pos, snap),
  ];

  const w = CONFIG.slowLayer.weights;
  const score =
    factors[0].score * w.priceStructure +
    factors[1].score * w.volume +
    factors[2].score * w.derivatives +
    factors[3].score * w.crossMarket +
    factors[4].score * w.sentiment;

  const state = applyHysteresis(score, prevState, prevStateAt, now);

  return {
    score,
    factors,
    state,
    detail: factors.map((f) => `${f.name}:${f.score.toFixed(2)}`).join('|'),
  };
}

function shelf(snap: MarketSnapshot) {
  const candles = snap.candles['1h'] ?? [];
  return calcRange(candles, CONFIG.range.lookback, CONFIG.range.shelfExclude);
}

function evaluatePriceStructure(pos: Position, snap: MarketSnapshot): ThesisFactor {
  const candles = snap.candles['1h'] ?? [];
  const atr = calcATR(candles, 14) || 1e-9;
  const range = shelf(snap);
  const price = snap.price;
  let score = 0;
  const d: string[] = [];

  if (pos.side === 'SHORT') {
    if (price > range.high) {
      score -= Math.min(1, (price - range.high) / atr / 2);
      d.push('站上区间');
    } else {
      score += 0.5;
      d.push('回区间');
    }
    const rc = candles.slice(-3);
    if (rc.length === 3 && rc.every((c) => c.close > range.high)) {
      score -= 0.5;
      d.push('3收上');
    }
    if (calcHigherHighs(candles, 10)) {
      score -= 0.3;
      d.push('HH');
    }
    if (calcLowerLows(candles, 10)) {
      score += 0.3;
      d.push('LL');
    }
  } else {
    if (price < range.low) {
      score -= Math.min(1, (range.low - price) / atr / 2);
      d.push('跌破区间');
    } else {
      score += 0.5;
      d.push('回区间');
    }
    const rc = candles.slice(-3);
    if (rc.length === 3 && rc.every((c) => c.close < range.low)) {
      score -= 0.5;
      d.push('3收下');
    }
    if (calcLowerLows(candles, 10)) {
      score -= 0.3;
      d.push('LL');
    }
    if (calcHigherHighs(candles, 10)) {
      score += 0.3;
      d.push('HH');
    }
  }

  return {
    name: 'price',
    score: clamp(score, -1, 1),
    weight: CONFIG.slowLayer.weights.priceStructure,
    detail: d.join(','),
  };
}

function evaluateVolume(pos: Position, snap: MarketSnapshot): ThesisFactor {
  const candles = snap.candles['1h'] ?? [];
  const volMean = calcVolumeMean(candles, 20, 1) || 1e-9;
  const lastVol = candles[candles.length - 1]?.volume ?? 0;
  const r = lastVol / volMean;
  let score = 0;
  const d: string[] = [];
  if (r > 3) {
    score -= 0.8;
    d.push(`量比${r.toFixed(1)}`);
  } else if (r > 2) {
    score -= 0.4;
    d.push(`量比${r.toFixed(1)}`);
  } else if (r < 1.2) {
    score += 0.3;
    d.push('量平');
  }

  const { bidDepth, askDepth } = snap.orderbook;
  if (pos.side === 'SHORT') {
    if (bidDepth > askDepth * 1.5) {
      score += 0.3;
      d.push('买厚');
    } else if (askDepth > bidDepth * 1.5) {
      score -= 0.3;
      d.push('卖厚');
    }
  } else {
    if (askDepth > bidDepth * 1.5) {
      score += 0.3;
      d.push('卖厚');
    } else if (bidDepth > askDepth * 1.5) {
      score -= 0.3;
      d.push('买厚');
    }
  }

  const t = snap.takerBuyRatio;
  if (pos.side === 'SHORT') {
    if (t > 0.65) {
      score -= 0.3;
      d.push('主买强');
    } else if (t < 0.35) {
      score += 0.3;
      d.push('主卖强');
    }
  } else {
    if (t < 0.35) {
      score -= 0.3;
      d.push('主卖强');
    } else if (t > 0.65) {
      score += 0.3;
      d.push('主买强');
    }
  }

  return {
    name: 'volume',
    score: clamp(score, -1, 1),
    weight: CONFIG.slowLayer.weights.volume,
    detail: d.join(','),
  };
}

function evaluateDerivatives(pos: Position, snap: MarketSnapshot): ThesisFactor {
  let score = 0;
  const d: string[] = [];
  const fr = snap.fundingRate;
  if (pos.side === 'SHORT') {
    if (fr > 0.0005) {
      score -= 0.4;
      d.push('资金正高');
    } else if (fr < -0.0001) {
      score += 0.2;
      d.push('资金负');
    }
  } else {
    if (fr < -0.0005) {
      score -= 0.4;
      d.push('资金负高');
    } else if (fr > 0.0001) {
      score += 0.2;
      d.push('资金正');
    }
  }
  const oi = snap.openInterestChange24h;
  if (oi > 0.1) {
    score -= 0.3;
    d.push(`OI+${(oi * 100).toFixed(0)}%`);
  } else if (oi < -0.1) {
    score += 0.3;
    d.push(`OI${(oi * 100).toFixed(0)}%`);
  }

  return {
    name: 'deriv',
    score: clamp(score, -1, 1),
    weight: CONFIG.slowLayer.weights.derivatives,
    detail: d.join(','),
  };
}

function evaluateCrossMarket(pos: Position, snap: MarketSnapshot): ThesisFactor {
  let score = 0;
  const d: string[] = [];
  const ch = snap.btcChange24h;
  if (pos.side === 'SHORT') {
    if (ch > 0.02) {
      score -= 0.4;
      d.push(`BTC+${(ch * 100).toFixed(1)}%`);
    } else if (ch < -0.02) {
      score += 0.4;
      d.push(`BTC${(ch * 100).toFixed(1)}%`);
    }
  } else {
    if (ch < -0.02) {
      score -= 0.4;
      d.push(`BTC${(ch * 100).toFixed(1)}%`);
    } else if (ch > 0.02) {
      score += 0.4;
      d.push(`BTC+${(ch * 100).toFixed(1)}%`);
    }
  }
  if (snap.btcRegime === 'TREND') {
    if (pos.side === 'SHORT' && ch > 0) {
      score -= 0.3;
      d.push('BTC升势');
    }
    if (pos.side === 'LONG' && ch < 0) {
      score -= 0.3;
      d.push('BTC跌势');
    }
  }
  return {
    name: 'cross',
    score: clamp(score, -1, 1),
    weight: CONFIG.slowLayer.weights.crossMarket,
    detail: d.join(','),
  };
}

function evaluateSentiment(pos: Position, snap: MarketSnapshot): ThesisFactor {
  let score = 0;
  const d: string[] = [];
  const fgi = snap.fearGreedIndex;
  if (pos.side === 'SHORT') {
    if (fgi > 80) {
      score += 0.4;
      d.push(`贪${fgi}`);
    } else if (fgi < 20) {
      score -= 0.2;
      d.push(`恐${fgi}`);
    }
  } else {
    if (fgi < 20) {
      score += 0.4;
      d.push(`恐${fgi}`);
    } else if (fgi > 80) {
      score -= 0.2;
      d.push(`贪${fgi}`);
    }
  }
  return {
    name: 'sent',
    score: clamp(score, -1, 1),
    weight: CONFIG.slowLayer.weights.sentiment,
    detail: d.join(','),
  };
}

function applyHysteresis(score: number, prev: ThesisState, prevAt: number, now: number): ThesisState {
  const dwell = now - prevAt;
  const { enterDying, exitDying } = CONFIG.slowLayer.hysteresis;

  if ((prev === 'DYING' || prev === 'DEAD') && dwell < CONFIG.slowLayer.minDwellMs) {
    return prev;
  }
  if (prev === 'ALIVE') {
    if (score < enterDying) return 'DYING';
    if (score < 0) return 'WEAKENING';
    return 'ALIVE';
  }
  if (prev === 'WEAKENING') {
    if (score < enterDying) return 'DYING';
    if (score > 0.3) return 'ALIVE';
    return 'WEAKENING';
  }
  if (prev === 'DYING') {
    if (score > exitDying) return 'ALIVE';
    if (score < enterDying - 0.2) return 'DEAD';
    return 'DYING';
  }
  return 'DEAD';
}
