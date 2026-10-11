import type { MarketSnapshot, Position } from '../types.ts';
import { CONFIG } from '../config.ts';
import { calcATR, calcRange, calcVolumeMean } from '../data/features.ts';

export interface TriggerResult {
  triggered: boolean;
  direction: 'LONG' | 'SHORT' | null;
  reasons: string[];
  confidence: number;
}

export function evaluateTrigger(pos: Position, snap: MarketSnapshot): TriggerResult {
  const candles = snap.candles['1h'] ?? [];
  const atr = calcATR(candles, 14) || 1e-9;
  const range = calcRange(candles, CONFIG.range.lookback, CONFIG.fastLayer.consecutiveCloses);
  const volMean = calcVolumeMean(candles, 20, 1) || 1e-9;
  const price = snap.price;

  const priceHits: string[] = [];
  const volumeHits: string[] = [];
  const crossHits: string[] = [];
  const derivHits: string[] = [];

  if (pos.side === 'SHORT') {
    const dist = (price - range.high) / atr;
    if (dist > CONFIG.fastLayer.atrMultiplier) priceHits.push(`上破${dist.toFixed(1)}ATR`);
    const rc = candles.slice(-CONFIG.fastLayer.consecutiveCloses);
    if (rc.length === CONFIG.fastLayer.consecutiveCloses) {
      const allAbove = rc.every((c) => c.close > range.high);
      const rising = rc.every((c, i) => i === 0 || c.close > rc[i - 1].close);
      if (allAbove && rising) priceHits.push(`${CONFIG.fastLayer.consecutiveCloses}连阳`);
    }
  } else {
    const dist = (range.low - price) / atr;
    if (dist > CONFIG.fastLayer.atrMultiplier) priceHits.push(`下破${dist.toFixed(1)}ATR`);
    const rc = candles.slice(-CONFIG.fastLayer.consecutiveCloses);
    if (rc.length === CONFIG.fastLayer.consecutiveCloses) {
      const allBelow = rc.every((c) => c.close < range.low);
      const falling = rc.every((c, i) => i === 0 || c.close < rc[i - 1].close);
      if (allBelow && falling) priceHits.push(`${CONFIG.fastLayer.consecutiveCloses}连阴`);
    }
  }

  const lastVol = candles[candles.length - 1]?.volume ?? 0;
  const volRatio = lastVol / volMean;
  if (volRatio > CONFIG.fastLayer.volumeMultiplier) volumeHits.push(`量比${volRatio.toFixed(1)}`);
  if (pos.side === 'SHORT' && snap.takerBuyRatio > 0.7) volumeHits.push('主买强');
  if (pos.side === 'LONG' && snap.takerBuyRatio < 0.3) volumeHits.push('主卖强');

  if (snap.btcRegime === 'TREND') {
    if (pos.side === 'SHORT' && snap.btcChange24h > 0.03) crossHits.push(`BTC+${(snap.btcChange24h * 100).toFixed(1)}%`);
    if (pos.side === 'LONG' && snap.btcChange24h < -0.03) crossHits.push(`BTC${(snap.btcChange24h * 100).toFixed(1)}%`);
  }

  if (pos.side === 'SHORT') {
    if (snap.openInterestChange24h > 0.15 && snap.fundingRate > 0.0003) derivHits.push('OI增+资金正');
  } else {
    if (snap.openInterestChange24h > 0.15 && snap.fundingRate < -0.0003) derivHits.push('OI增+资金负');
  }

  const triggered =
    priceHits.length >= 1 &&
    volumeHits.length >= 1 &&
    (crossHits.length >= 1 || derivHits.length >= 1);

  const direction: 'LONG' | 'SHORT' | null = triggered ? (pos.side === 'SHORT' ? 'LONG' : 'SHORT') : null;

  const all = [...priceHits, ...volumeHits, ...crossHits, ...derivHits];

  return {
    triggered,
    direction,
    reasons: all,
    confidence: triggered ? Math.min(1, all.length / 6) : 0,
  };
}
