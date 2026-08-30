// HTE 3.1 Clean production entry.
//
// Historical Durable Object namespaces must remain exported because they were
// provisioned by legacy migrations. Removing/deleting those classes during the
// HTE31 rollout made Cloudflare lifecycle reconciliation unnecessarily risky.
//
// They are no longer bound in production. If an old object still owns a stored
// alarm, Cloudflare can nevertheless wake that namespace. These tombstones do
// not inherit any legacy scanner/position implementation: the first wake only
// deletes the alarm + private scheduler storage and then stops permanently.
// No HTE31 D1 ledger, Gate credentials, or live-order lineage lives in these
// retired namespaces.
import { DurableObject } from "cloudflare:workers";
import workerDefault, { LiveTradingCoordinator } from "./index";
import type { CloudflareEnv } from "./index";

export default workerDefault;
export { LiveTradingCoordinator };

async function retireLegacyScheduler(ctx: { storage: { deleteAlarm(): Promise<void>; deleteAll(): Promise<void> } }) {
  // Explicit deleteAlarm keeps this safe for both old and new compatibility
  // dates; deleteAll then removes every private scheduler key/metadata row.
  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
}

class LegacySchedulerTombstone extends DurableObject<CloudflareEnv> {
  async alarm(): Promise<void> {
    await retireLegacyScheduler(this.ctx);
  }
}

// These export names are historical Cloudflare migration identities. Keep them
// exported, but never bind them to production traffic again.
export class PositionMonitor extends LegacySchedulerTombstone {}
export class MarketScanner extends LegacySchedulerTombstone {}
export class MarketScannerV2 extends LegacySchedulerTombstone {}

export { HTE31MarketScanner, HTE31TradeManager } from "./hte31-recovery-manager";
