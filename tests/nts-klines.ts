import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { Bar, Tf } from "../lib/nts/types.ts";
import type { Series } from "./nts-sim.ts";

/** Real Gate BTC/ETH perpetual klines (public, fetched once 2026-10-29). Replay smoke test only: no tuning, and the results say nothing about profitability. */
export function loadKlines(file?: string): { series: Series; first15: number; last15: number } {
  const raw = JSON.parse(gunzipSync(readFileSync(file ?? new URL("./fixtures/nts-klines.json.gz", import.meta.url))).toString()) as { series: Record<string, Record<Tf, number[][]>> };
  const series: Series = {};
  for (const [sym, tfs] of Object.entries(raw.series)) { series[sym] = {} as Record<Tf, Bar[]>; for (const [tf, rows] of Object.entries(tfs)) series[sym]![tf as Tf] = rows.map(r => ({ time: r[0]!, open: r[1]!, high: r[2]!, low: r[3]!, close: r[4]!, volume: r[5]! })); }
  const b = series.BTC_USDT!["15m"]; return { series, first15: b[0]!.time, last15: b.at(-1)!.time };
}
