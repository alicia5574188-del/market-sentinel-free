// HTE 3.1 Clean production entry.
//
// Historical Durable Object namespaces must remain exported because they were
// provisioned by legacy migrations. Removing/deleting those classes during the
// HTE31 rollout made Cloudflare lifecycle reconciliation unnecessarily risky.
//
// They are no longer bound in production. If an old object still owns a stored
// alarm, Cloudflare can nevertheless wake that namespace. Override only the
// alarm handler so the first legacy wake deletes the alarm + private scheduler
// storage and then stops permanently. No HTE31 D1 ledger, Gate credentials, or
// live-order lineage lives in these retired namespaces.
import workerDefault, {
  LiveTradingCoordinator,
  MarketScanner as LegacyMarketScanner,
  PositionMonitor as LegacyPositionMonitor,
} from "./index";

export default workerDefault;
export { LiveTradingCoordinator };

async function retireLegacyScheduler(ctx: { storage: { deleteAlarm(): Promise<void>; deleteAll(): Promise<void> } }) {
  // Explicit deleteAlarm keeps this safe for both old and new compatibility
  // dates; deleteAll then removes every private scheduler key/metadata row.
  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
}

export class PositionMonitor extends LegacyPositionMonitor {
  override async alarm(): Promise<void> {
    await retireLegacyScheduler(this.ctx);
  }
}

export class MarketScanner extends LegacyMarketScanner {
  override async alarm(): Promise<void> {
    await retireLegacyScheduler(this.ctx);
  }
}

export class MarketScannerV2 extends LegacyMarketScanner {
  override async alarm(): Promise<void> {
    await retireLegacyScheduler(this.ctx);
  }
}

export { HTE31MarketScanner } from "./hte31-workers";
export { HTE31TradeManager } from "./hte31-recovery-manager";
