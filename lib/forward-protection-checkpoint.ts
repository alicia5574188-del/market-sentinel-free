/** Compact restart continuity for already-observed protection, not a new exit
 * strategy or financial ledger. The full atomic forward record stays authority.
 */
import type { ForwardState, Trade } from "./forward-relations.ts";

export const FORWARD_PROTECTION_CHECKPOINT_VERSION = "forward-protection-checkpoint-v1";
type ProtectionRow = Pick<Trade, "id" | "openedAt" | "favorable" | "adverse" | "lastPrice" | "lastQuoteAt"
  | "relationFailureBars" | "lastRelationBar" | "exitControl">;
export type ForwardProtectionCheckpoint = {
  version: typeof FORWARD_PROTECTION_CHECKPOINT_VERSION;
  startedAt: number; baseRevision: number; basePersistedAt: number; quoteCycleAt: number;
  peakEquity: number; maxDrawdown: number; positions: ProtectionRow[];
};

/** Quote timestamps/audit extrema alone do not request another write. Account
 * equity peaks affect portfolio risk budgets for EVERY exit mode; historical
 * maximum drawdown must also survive restart. Save actual new extrema without
 * time throttling or rounding, alongside trail peaks/bar confirmations that can
 * change the next exit, before publishing the in-memory result.
 */
export function forwardProtectionChanged(previous: ForwardState, next: ForwardState) {
  if ((Number.isFinite(next.peakEquity) && next.peakEquity > previous.peakEquity)
    || (Number.isFinite(next.maxDrawdown) && next.maxDrawdown > previous.maxDrawdown)) return true;
  const prior = new Map(previous.positions.map(t => [t.id, t]));
  return next.positions.some(t => {
    const p = prior.get(t.id);
    if (!p || p.openedAt !== t.openedAt) return false; // Financial change saves the full account.
    return (t.rule.exitMode === "REACTION_DECAY" && t.favorable >= t.rule.armRate && t.favorable !== p.favorable)
      || t.relationFailureBars !== p.relationFailureBars || t.lastRelationBar !== p.lastRelationBar;
  });
}

export function buildForwardProtectionCheckpoint(s: ForwardState): ForwardProtectionCheckpoint {
  return { version: FORWARD_PROTECTION_CHECKPOINT_VERSION, startedAt: s.startedAt,
    baseRevision: s.revision, basePersistedAt: s.storage.persistedAt, quoteCycleAt: s.lastQuoteCycleAt,
    peakEquity: s.peakEquity, maxDrawdown: s.maxDrawdown,
    positions: s.positions.map(t => ({ id: t.id, openedAt: t.openedAt, favorable: t.favorable, adverse: t.adverse,
      lastPrice: t.lastPrice, lastQuoteAt: t.lastQuoteAt, relationFailureBars: t.relationFailureBars,
      lastRelationBar: t.lastRelationBar, ...(t.exitControl ? { exitControl: { ...t.exitControl } } : {}) })) };
}

/** An older overlay is harmless after any new full-account commit. A matching
 * but malformed overlay is a storage error, never permission to reset/forget
 * the position's protection. No field affecting quantity, geometry, cash,
 * history, learning or owner intent is copied from this record.
 */
export function restoreForwardProtectionCheckpoint(s: ForwardState, value: unknown): ForwardState {
  if (value == null) return s;
  const c = value as ForwardProtectionCheckpoint;
  const invalid = () => { throw new Error("前向保护检查点异常；保留账户，禁止遗忘已观测保护状态"); };
  if (!c || ![c.startedAt, c.baseRevision, c.basePersistedAt].every(Number.isFinite)) return invalid();
  if (c.startedAt !== s.startedAt || c.baseRevision !== s.revision || c.basePersistedAt !== s.storage.persistedAt) return s;
  if (c.version !== FORWARD_PROTECTION_CHECKPOINT_VERSION || !Number.isFinite(c.quoteCycleAt)) return invalid();
  if (c.quoteCycleAt < s.lastQuoteCycleAt) return s;
  if (!Number.isFinite(c.peakEquity) || c.peakEquity < s.peakEquity
    || !Number.isFinite(c.maxDrawdown) || c.maxDrawdown < s.maxDrawdown
    || !Array.isArray(c.positions) || c.positions.length !== s.positions.length) return invalid();
  const rows = new Map(c.positions.map(row => [row?.id, row]));
  if (rows.size !== c.positions.length) return invalid();
  for (const t of s.positions) {
    const r = rows.get(t.id);
    if (!r || r.openedAt !== t.openedAt
      || ![r.favorable, r.adverse, r.lastPrice, r.lastQuoteAt, r.relationFailureBars, r.lastRelationBar].every(Number.isFinite)
      || r.favorable < t.favorable || r.adverse < t.adverse || r.lastPrice <= 0 || r.lastQuoteAt < t.lastQuoteAt
      || r.lastQuoteAt > c.quoteCycleAt + 1000 || r.lastRelationBar < t.lastRelationBar
      || r.lastRelationBar > c.quoteCycleAt || !Number.isSafeInteger(r.relationFailureBars) || r.relationFailureBars < 0
      || !!r.exitControl !== !!t.exitControl) return invalid();
    if (r.exitControl && t.exitControl) {
      const a = r.exitControl, b = t.exitControl;
      if (a.policy !== b.policy || !Number.isFinite(a.maxObservationGapMs) || !Number.isFinite(a.maxQuoteAgeMs)
        || a.maxObservationGapMs < b.maxObservationGapMs || a.maxQuoteAgeMs < b.maxQuoteAgeMs
        || ![a.armedAt, a.armedQuoteAt].every(v => v === null || (Number.isFinite(v) && v >= t.openedAt && v <= c.quoteCycleAt + 1000))
        || (a.armedAt === null) !== (a.armedQuoteAt === null)
        || (b.armedAt !== null && (a.armedAt !== b.armedAt || a.armedQuoteAt !== b.armedQuoteAt))) return invalid();
    }
  }
  const restored = structuredClone(s);
  for (const t of restored.positions) {
    const r = rows.get(t.id)!;
    t.favorable = r.favorable; t.adverse = r.adverse; t.lastPrice = r.lastPrice; t.lastQuoteAt = r.lastQuoteAt;
    t.relationFailureBars = r.relationFailureBars; t.lastRelationBar = r.lastRelationBar;
    if (r.exitControl) t.exitControl = { policy: r.exitControl.policy, armedAt: r.exitControl.armedAt,
      armedQuoteAt: r.exitControl.armedQuoteAt, maxObservationGapMs: r.exitControl.maxObservationGapMs,
      maxQuoteAgeMs: r.exitControl.maxQuoteAgeMs };
  }
  restored.lastQuoteCycleAt = c.quoteCycleAt;
  restored.peakEquity = c.peakEquity; restored.maxDrawdown = c.maxDrawdown;
  return restored;
}
