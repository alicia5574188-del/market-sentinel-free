import { DurableObject } from "cloudflare:workers";
import { readHistoricalArchive, readStoredHistoricalArchive } from "../lib/historical-archive";
import { fetchGateChartCandles, SYMBOL_PATTERN } from "../lib/gate-client";
import type { Hte31Candle } from "../lib/hte31-types";
import { HISTORICAL_UNIVERSE } from "../lib/direct-market-universe";

export class HistoricalArchive extends DurableObject {
  async read(symbol:string,now:number,candles:Hte31Candle[]) {
    if(!SYMBOL_PATTERN.test(symbol)||!HISTORICAL_UNIVERSE.includes(symbol))throw new Error('历史品种不在固定币池内');
    return readStoredHistoricalArchive(this.ctx.storage,now,candles);
  }
  async history(symbol: string, now: number, candles: Hte31Candle[]) {
    if (!SYMBOL_PATTERN.test(symbol) || !HISTORICAL_UNIVERSE.includes(symbol)) throw new Error("历史品种不在固定币池内");
    return this.ctx.blockConcurrencyWhile(() => readHistoricalArchive(this.ctx.storage, fetchGateChartCandles, symbol, now, candles));
  }
}
