import type { MarketSnapshot, Position, Regime, ThesisFactor, ThesisState } from '../types.ts';
import { evaluateThesis } from '../analysis/thesis.ts';
import { evaluateTrigger } from '../analysis/trigger.ts';
import { calcRange } from '../data/features.ts';
import { CONFIG } from '../config.ts';

export type Action =
  | { type: 'HOLD' }
  | { type: 'CLOSE'; reason: string }
  | { type: 'REVERSE'; direction: 'LONG' | 'SHORT'; reason: string }
  | { type: 'OPEN'; direction: 'LONG' | 'SHORT'; reason: string };

export interface DecisionContext {
  thesisState: ThesisState;
  thesisStateAt: number;
  regime: Regime;
}

export interface DecisionResult {
  action: Action;
  thesisScore: number;
  thesisState: ThesisState;
  detail: string;
  factors: ThesisFactor[];
  triggerNotes: string[];
  newContext: DecisionContext;
}

export function decide(
  pos: Position | null,
  snap: MarketSnapshot,
  ctx: DecisionContext,
  now: number,
): DecisionResult {
  if (!pos) {
    const sig = detectFakeBreakout(snap);
    if (sig) {
      return {
        action: { type: 'OPEN', direction: sig.side, reason: sig.reason },
        thesisScore: 0,
        thesisState: 'ALIVE',
        detail: 'new fake breakout',
        factors: [],
        triggerNotes: [],
        newContext: { thesisState: 'ALIVE', thesisStateAt: now, regime: 'RANGE' },
      };
    }
    return {
      action: { type: 'HOLD' },
      thesisScore: 0,
      thesisState: ctx.thesisState,
      detail: 'no signal',
      factors: [],
      triggerNotes: [],
      newContext: ctx,
    };
  }

  const thesis = evaluateThesis(pos, snap, ctx.thesisState, ctx.thesisStateAt, now);
  const newCtx: DecisionContext = {
    thesisState: thesis.state,
    thesisStateAt: thesis.state !== ctx.thesisState ? now : ctx.thesisStateAt,
    regime: ctx.regime,
  };

  const trig = evaluateTrigger(pos, snap);

  if (pos.thesis === 'FAKE_BREAKOUT' && trig.triggered && trig.direction) {
    // 旧的假突破假设已死。新开的趋势仓必须从 ALIVE 重新计时，
    // 否则下一拍慢层会看见 DEAD，把刚反手的仓立刻平掉。
    newCtx.regime = 'TREND';
    newCtx.thesisState = 'ALIVE';
    newCtx.thesisStateAt = now;
    return {
      action: { type: 'REVERSE', direction: trig.direction, reason: `快层:${trig.reasons.join(',')}` },
      thesisScore: thesis.score,
      thesisState: 'DEAD',
      detail: trig.reasons.join(','),
      factors: thesis.factors,
      triggerNotes: trig.reasons,
      newContext: newCtx,
    };
  }

  if (thesis.state === 'DEAD') {
    return {
      action: { type: 'CLOSE', reason: `慢层死:${thesis.score.toFixed(2)}` },
      thesisScore: thesis.score,
      thesisState: thesis.state,
      detail: thesis.detail,
      factors: thesis.factors,
      triggerNotes: trig.reasons,
      newContext: newCtx,
    };
  }

  return {
    action: { type: 'HOLD' },
    thesisScore: thesis.score,
    thesisState: thesis.state,
    detail: thesis.detail,
    factors: thesis.factors,
    triggerNotes: trig.reasons,
    newContext: newCtx,
  };
}

function detectFakeBreakout(snap: MarketSnapshot): { side: 'LONG' | 'SHORT'; reason: string } | null {
  const candles = snap.candles['1h'] ?? [];
  if (candles.length < CONFIG.minCandles1h) return null;
  const range = calcRange(candles, CONFIG.range.lookback, CONFIG.range.breakoutExclude);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || !prev || range.high === 0) return null;
  if (prev.high > range.high && last.close < range.high) {
    return { side: 'SHORT', reason: `上破${range.high.toFixed(1)}后收回` };
  }
  if (prev.low < range.low && last.close > range.low) {
    return { side: 'LONG', reason: `下破${range.low.toFixed(1)}后收回` };
  }
  return null;
}
