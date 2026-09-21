/** Execution timing only. No new signal, PnL gate, target, or risk budget.
 * A persisted per-trade policy makes the rollout explicit: inherited positions
 * keep their original timing. Price geometry is ALWAYS the frozen source rule.
 */
import type { Trade } from "./forward-relations.ts";

export const TIMELY_PROTECTION_POLICY = "timely-protection-v1";
export type ExitControl = { policy: typeof TIMELY_PROTECTION_POLICY;
  armedAt: number | null; armedQuoteAt: number | null;
  maxObservationGapMs: number; maxQuoteAgeMs: number;
  profitFloorVersion?: string; profitFloorRate?: number; profitFloorUpdatedAt?: number;
  profitFloorMode?: string; profitFloorDeferred?: boolean };
export type ExitTrigger = "HARD_STOP" | "HORIZON" | "RELATION_CHANGE" | "PROFIT_GIVEBACK" | "MARKET_TURN" | "MARKET_STATE" | "TURN_FORECAST" | "MULTI_TURN" | "MAX_LIFETIME";
export type ExitDecision = { trigger: ExitTrigger; reason: string; boundaryRate: number | null };
export type ExitAudit = { policy: string; trigger: ExitTrigger; decisionAt: number;
  quoteAt: number; quoteAgeMs: number; observationGapMs: number;
  maxObservationGapMs: number; maxQuoteAgeMs: number;
  armedAt: number | null; armedQuoteAt: number | null;
  triggerPrice: number | null; executionPrice: number; overshootRate: number | null;
  plannedRisk: number; realizedLoss: number; lossAbovePlan: number };

export function newExitControl(): ExitControl {
  return { policy: TIMELY_PROTECTION_POLICY, armedAt: null, armedQuoteAt: null,
    maxObservationGapMs: 0, maxQuoteAgeMs: 0 };
}

/** Called only AFTER validating a fresh executable bid/ask. A sampling gap is
 * NOT proof of an outage or of the first market crossing; do not label it so.
 */
export function observeExitControl(t: Trade, quoteAt: number, now: number) {
  const c = t.exitControl;
  const gap = Math.max(0, quoteAt - t.lastQuoteAt);
  if (c?.policy === TIMELY_PROTECTION_POLICY) {
    c.maxObservationGapMs = Math.max(c.maxObservationGapMs, gap);
    c.maxQuoteAgeMs = Math.max(c.maxQuoteAgeMs, Math.max(0, now - quoteAt));
    if (t.rule.exitMode === "REACTION_DECAY" && t.favorable >= t.rule.armRate && c.armedAt == null) {
      c.armedAt = now; c.armedQuoteAt = quoteAt;
    }
  }
  return gap;
}

/** Same thresholds and two-distinct-closed-bar confirmation as the baseline.
 * Only the extra five-/fifteen-minute age embargoes are removed for NEW trades.
 * Being armed alone never exits a position; a subsequent giveback is required.
 */
export function protectedExitDecision(t: Trade, returnRate: number, now: number): ExitDecision | null {
  const r = t.rule, elapsed = now - t.openedAt;
  const timely = t.exitControl?.policy === TIMELY_PROTECTION_POLICY;
  if (elapsed < 0) return null;
  if (returnRate <= -r.stopRate)
    return { trigger: "HARD_STOP", reason: "保护止损：当前可执行价触及原始风险边界", boundaryRate: -r.stopRate };
  if (elapsed >= r.horizon * 60_000)
    return { trigger: "HORIZON", reason: "反应期限结束：按生成规则退出", boundaryRate: null };
  if ((timely || elapsed >= 15 * 60_000) && t.relationFailureBars >= 2)
    return { trigger: "RELATION_CHANGE", reason: "关系变化：连续两根已收盘K线出现相反方向的新证据", boundaryRate: null };
  if (r.exitMode === "REACTION_DECAY" && (timely || elapsed >= 5 * 60_000)
    && t.favorable >= r.armRate && t.favorable - returnRate >= r.givebackRate)
    return { trigger: "PROFIT_GIVEBACK", reason: "反应回吐：有利波动后触发生成的回吐边界", boundaryRate: t.favorable - r.givebackRate };
  return null;
}

export function makeExitAudit(t: Trade, decision: ExitDecision,
  px: number, quoteAt: number, now: number, observationGapMs: number): ExitAudit {
  const d = t.side === "LONG" ? 1 : -1;
  const boundary = decision.boundaryRate;
  return { policy: t.exitControl?.policy ?? "legacy-age-guard-v1", trigger: decision.trigger,
    decisionAt: now, quoteAt, quoteAgeMs: Math.max(0, now - quoteAt), observationGapMs,
    maxObservationGapMs: t.exitControl?.maxObservationGapMs ?? observationGapMs,
    maxQuoteAgeMs: t.exitControl?.maxQuoteAgeMs ?? Math.max(0, now - quoteAt),
    armedAt: t.exitControl?.armedAt ?? null, armedQuoteAt: t.exitControl?.armedQuoteAt ?? null,
    triggerPrice: boundary == null ? null : t.entryPrice * (1 + d * boundary),
    executionPrice: px,
    overshootRate: boundary == null ? null : Math.max(0, boundary - d * (px / t.entryPrice - 1)),
    plannedRisk: t.plannedRisk, realizedLoss: Math.max(0, -(t.netPnl ?? 0)),
    lossAbovePlan: Math.max(0, -(t.netPnl ?? 0) - t.plannedRisk) };
}