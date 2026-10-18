/**
 * Review-only logs kept OUTSIDE the forward hot financial JSON.
 * Nothing here is read by an entry, an exit, sizing, a stop or live copying.
 * Every caller wraps these in try/catch: a log failure never blocks the forward save.
 */
import type { ForwardState, Trade } from "./forward-relations.ts";
import type { StageChange } from "./stage-chronicle.ts";
import type { SignalTally, SignalTallyMeta } from "./signal-repeat.ts";
import type { HotReviewOffload } from "./forward-store.ts";

export const REVIEW_LOG_PREFIX = "log:review:v1:";
export const REVIEW_STAGE_KEY = `${REVIEW_LOG_PREFIX}stage`;
export const REVIEW_TALLY_KEY = `${REVIEW_LOG_PREFIX}tally`;
const UNOPENED_PREFIX = `${REVIEW_LOG_PREFIX}unopened:`;
/** Closed not-opened rows stay hot while the trade-path recorder still samples them (360 min after open) plus margin. */
export const UNOPENED_HOT_WINDOW_MS = (360 + 30) * 60_000;
export const UNOPENED_COLD_CAP = 800;
/** Keep each stored value well under the per-value ceiling the repo already budgets for (112 KiB). */
const PART_BYTES = 96 * 1024;
const MAX_ROWS_PER_WRITE = 48;

export const unopenedIndexKey = (startedAt: number) => `${UNOPENED_PREFIX}${startedAt}:index`;
export const unopenedRowKey = (startedAt: number, id: string) => `${UNOPENED_PREFIX}${startedAt}:t:${id}`;

type Reader = { get<T>(key: string): Promise<T | undefined> };
type Parted = { version: "review-log-parts-v1"; parts: number; length: number };

/** In memory only. Tracks what is already durable so unchanged logs are not rewritten. */
export type ReviewLogCursor = {
  stageDigest: string | null;
  tallyDigest: string | null;
  startedAt: number | null;
  coldIds: string[]; // newest first, all durable
};
export const emptyReviewLogCursor = (): ReviewLogCursor => ({ stageDigest: null, tallyDigest: null, startedAt: null, coldIds: [] });

const enc = (v: unknown) => JSON.stringify(v);
function digest(text: string) {
  // FNV-1a 32-bit, change detection only.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(16)}:${text.length}`;
}
function parted(key: string, text: string, entries: Record<string, unknown>) {
  const parts = Math.max(1, Math.ceil(text.length / PART_BYTES));
  for (let i = 0; i < parts; i++) entries[`${key}:${i}`] = text.slice(i * PART_BYTES, (i + 1) * PART_BYTES);
  entries[key] = { version: "review-log-parts-v1", parts, length: text.length } satisfies Parted;
}
async function readParted<T>(storage: Reader, key: string): Promise<T | null> {
  const head = await storage.get<Parted>(key);
  if (!head || head.version !== "review-log-parts-v1" || !Number.isSafeInteger(head.parts) || head.parts < 1 || head.parts > 64) return null;
  const parts = await Promise.all(Array.from({ length: head.parts }, (_, i) => storage.get<string>(`${key}:${i}`)));
  if (parts.some(p => typeof p !== "string")) return null;
  const text = parts.join("");
  if (text.length !== head.length) return null;
  return JSON.parse(text) as T;
}

const stageText = (state: ForwardState) => enc({ version: "review-stage-v1", changes: state.stageChronicle?.changes ?? [] });
const tallyText = (state: ForwardState) => enc({ version: "review-tally-v1", tally: state.signalTally ?? {}, meta: state.signalTallyMeta ?? null });

/** What the hot JSON may leave out right now: only what the cursor proves is already durable and current. */
export function reviewLogOffload(state: ForwardState, cursor: ReviewLogCursor): HotReviewOffload {
  const sameAccount = cursor.startedAt === state.startedAt;
  return {
    stageDurable: cursor.stageDigest != null && cursor.stageDigest === digest(stageText(state)),
    tallyDurable: cursor.tallyDigest != null && cursor.tallyDigest === digest(tallyText(state)),
    coldUnopenedIds: new Set(sameAccount ? cursor.coldIds : []),
  };
}

/** Closed not-opened rows old enough that no live recorder touches them anymore. */
export function coldEligibleUnopened(state: ForwardState, now: number) {
  return (state.unopenedTrades ?? []).filter(t => t.status === "CLOSED" && t.openedAt < now - UNOPENED_HOT_WINDOW_MS);
}

/**
 * Build the log writes for this tick. Only changed values are written. Rows are immutable once closed and old,
 * so each is written once. Returns the cursor to adopt ONLY after the put succeeds.
 */
export function prepareReviewLogWrite(state: ForwardState, now: number, cursor: ReviewLogCursor) {
  const entries: Record<string, unknown> = {};
  const deletes: string[] = [];
  const next: ReviewLogCursor = { ...cursor, coldIds: [...cursor.coldIds] };
  if (next.startedAt !== state.startedAt) { next.startedAt = state.startedAt; next.coldIds = []; } // account-scoped; old account keys are left as they are

  const stage = stageText(state), stageDigest = digest(stage);
  if (stageDigest !== cursor.stageDigest) { parted(REVIEW_STAGE_KEY, stage, entries); next.stageDigest = stageDigest; }

  const tally = tallyText(state), tallyDigest = digest(tally);
  if (tallyDigest !== cursor.tallyDigest) { parted(REVIEW_TALLY_KEY, tally, entries); next.tallyDigest = tallyDigest; }

  const known = new Set(next.coldIds);
  const fresh = coldEligibleUnopened(state, now).filter(t => !known.has(t.id)).slice(0, MAX_ROWS_PER_WRITE);
  for (const t of fresh) entries[unopenedRowKey(state.startedAt, t.id)] = structuredClone(t);
  if (fresh.length) {
    const byTime = new Map<string, number>();
    for (const t of state.unopenedTrades ?? []) byTime.set(t.id, t.openedAt);
    const ids = [...fresh.map(t => t.id), ...next.coldIds];
    ids.sort((a, b) => (byTime.get(b) ?? 0) - (byTime.get(a) ?? 0));
    const keep = ids.slice(0, UNOPENED_COLD_CAP);
    for (const id of ids.slice(UNOPENED_COLD_CAP)) deletes.push(unopenedRowKey(state.startedAt, id));
    next.coldIds = keep;
    entries[unopenedIndexKey(state.startedAt)] = { version: "review-unopened-index-v1", ids: keep };
  }
  return { entries, deletes, cursor: next, writes: Object.keys(entries).length + deletes.length };
}

export type ReviewLog = {
  changes: StageChange[] | null;
  tally: Record<string, SignalTally> | null;
  meta: SignalTallyMeta | null;
  unopened: Trade[];
  cursor: ReviewLogCursor;
  /** True only when the cold not-opened index and every row it lists were read. A read error or a listed
   * row that is missing makes it false, so callers never treat a partial set as the whole account. */
  unopenedComplete: boolean;
};

export async function readReviewLog(storage: Reader, startedAt: number): Promise<ReviewLog> {
  const stage = await readParted<{ version: string; changes: StageChange[] }>(storage, REVIEW_STAGE_KEY).catch(() => null);
  const tally = await readParted<{ version: string; tally: Record<string, SignalTally>; meta: SignalTallyMeta | null }>(storage, REVIEW_TALLY_KEY).catch(() => null);
  let unopenedComplete = true;
  const index = await storage.get<{ version: string; ids: string[] }>(unopenedIndexKey(startedAt)).catch(() => { unopenedComplete = false; return undefined; });
  if (index !== undefined && index !== null && !Array.isArray(index.ids)) unopenedComplete = false;
  const ids = Array.isArray(index?.ids) ? index!.ids.filter(id => typeof id === "string").slice(0, UNOPENED_COLD_CAP) : [];
  const rows: Trade[] = [];
  const durable: string[] = [];
  for (let i = 0; i < ids.length; i += 64) {
    const batch = ids.slice(i, i + 64);
    const got = await Promise.all(batch.map(id => storage.get<Trade>(unopenedRowKey(startedAt, id)).catch(() => undefined)));
    got.forEach((t, j) => { if (t && t.id === batch[j]) { rows.push(t); durable.push(t.id); } else unopenedComplete = false; });
  }
  return {
    changes: Array.isArray(stage?.changes) ? stage!.changes : null,
    tally: tally?.tally && typeof tally.tally === "object" ? tally.tally : null,
    meta: tally?.meta ?? null,
    unopened: rows,
    cursor: { stageDigest: null, tallyDigest: null, startedAt, coldIds: durable },
    unopenedComplete,
  };
}

/** Put the cold logs back into the in-memory account after a load. Hot rows always win over cold copies. */
export function restoreReviewLog(state: ForwardState, log: ReviewLog) {
  if (log.changes?.length && state.stageChronicle) {
    const byAt = new Map<number, StageChange>();
    for (const c of log.changes) if (c && typeof c.at === "number") byAt.set(c.at, c);
    for (const c of state.stageChronicle.changes ?? []) byAt.set(c.at, { ...(byAt.get(c.at) ?? {}), ...c } as StageChange);
    state.stageChronicle = { ...state.stageChronicle, changes: [...byAt.values()].sort((a, b) => a.at - b.at).slice(-2000) };
  }
  if (log.tally) { state.signalTally = log.tally; if (log.meta) state.signalTallyMeta = log.meta; }
  if (log.unopened.length) {
    const hot = state.unopenedTrades ?? [];
    const seen = new Set(hot.map(t => t.id));
    const cold = log.unopened.filter(t => !seen.has(t.id)).sort((a, b) => b.openedAt - a.openedAt);
    const merged = [...hot, ...cold];
    state.unopenedTrades = [...merged.filter(t => t.status === "OPEN"), ...merged.filter(t => t.status !== "OPEN").slice(0, UNOPENED_COLD_CAP)];
  }
  return state;
}
