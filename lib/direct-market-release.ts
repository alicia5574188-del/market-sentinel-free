import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { hte31PaperResetState } from "../db/hte31-schema";
import { DIRECT_MARKET_BRAIN_VERSION } from "./direct-market-types.ts";

export const DIRECT_MARKET_RELEASE = {
  brainVersion: DIRECT_MARKET_BRAIN_VERSION,
  migrationTag: "0023_direct_market_v5_entry_integrity_cutover",
  cutover: "force_archive_paper",
} as const;

export async function ensureDirectMarketReleaseCutover(startingCapitalUsdt: number, now = Date.now()) {
  const db = getDb();
  const [state] = await db.select().from(hte31PaperResetState)
    .where(eq(hte31PaperResetState.id, "singleton")).limit(1);
  if (state?.activeBrainVersion === DIRECT_MARKET_RELEASE.brainVersion) return state;
  // A migration can finish under the previous Worker during deployment. Its
  // completed status proves that all paper positions closed and a new epoch
  // exists; promote the target without creating a second empty epoch.
  if (state?.status === "completed" && state.targetBrainVersion === DIRECT_MARKET_RELEASE.brainVersion) {
    await db.update(hte31PaperResetState).set({
      resetMode: "natural",
      activeBrainVersion: DIRECT_MARKET_RELEASE.brainVersion,
      targetBrainVersion: null,
      updatedAt: now,
    }).where(eq(hte31PaperResetState.id, "singleton"));
    const [promoted] = await db.select().from(hte31PaperResetState)
      .where(eq(hte31PaperResetState.id, "singleton")).limit(1);
    return promoted;
  }
  if (state?.status === "pending"
    && state.resetMode === "force_archive"
    && state.targetBrainVersion === DIRECT_MARKET_RELEASE.brainVersion) return state;

  const requestedCapitalUsdt = Math.min(1_000_000, Math.max(10, startingCapitalUsdt));
  await db.insert(hte31PaperResetState).values({
    id: "singleton",
    status: "pending",
    resetMode: "force_archive",
    activeBrainVersion: state?.activeBrainVersion ?? null,
    targetBrainVersion: DIRECT_MARKET_RELEASE.brainVersion,
    requestedCapitalUsdt,
    requestedAt: now,
    completedAt: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: hte31PaperResetState.id,
    set: {
      status: "pending",
      resetMode: "force_archive",
      targetBrainVersion: DIRECT_MARKET_RELEASE.brainVersion,
      requestedCapitalUsdt,
      requestedAt: now,
      completedAt: null,
      updatedAt: now,
    },
  });
  const [pending] = await db.select().from(hte31PaperResetState)
    .where(eq(hte31PaperResetState.id, "singleton")).limit(1);
  return pending;
}
