/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type { CloudflareEnv } from "./index";

/**
 * Archive target for the retired HTE 3.0 simulation Durable Objects.
 *
 * We intentionally preserve their storage instead of deleting it during the
 * HTE 3.1 production cutover. They have no runtime bindings. If a legacy alarm
 * survived the rename, the first invocation clears it permanently and records
 * only that the namespace has been retired.
 */
class RetiredSimulationObject extends DurableObject<CloudflareEnv> {
  async alarm() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("hte31RetiredAt", Date.now());
  }
}

export class RetiredPositionMonitor extends RetiredSimulationObject {}
export class RetiredMarketScanner extends RetiredSimulationObject {}
export class RetiredMarketScannerV2 extends RetiredSimulationObject {}
