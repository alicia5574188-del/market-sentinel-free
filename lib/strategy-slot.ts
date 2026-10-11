/** The only place a strategy may be attached.
 * There is no strategy right now. Resetting the account must not install an old one. */
import type {ForwardState} from './forward-relations.ts';
import {resetForwardAccountPreservingLearning} from './forward-relations.ts';
import {assertInverseTrial, newInverseTrial} from './shadow-inverse-ledger.ts';

export const STRATEGY_EPOCH = 'strategy-empty-2026-10-11' as const;

export function emptyStrategyAccount(previous: ForwardState, now: number): ForwardState {
  const next = resetForwardAccountPreservingLearning(previous, now);
  next.lastExitAt = {};
  next.positions = [];
  next.history = [];
  next.balance = next.initialEquity;
  next.inverseTrial = newInverseTrial(next, now, next.initialEquity);
  next.inverseTrial.strategySlot = 'empty';
  next.inverseTrial.paperPolicy = undefined;
  next.inverseTrial.desk = undefined;
  next.inverseTrial.rx = undefined;
  next.latestReason = '没有策略。行情和账户还在。新策略接上之前不会下单。';
  assertInverseTrial(next);
  return next;
}
