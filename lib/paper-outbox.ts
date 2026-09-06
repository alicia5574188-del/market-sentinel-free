import type { PaperPosition } from "./liquidity-core.ts";

export type ReviewCandle = { time: number; volume: number; close: number; high: number; low: number; open: number };
export type PositionOutboxItem = { key: string; position: PaperPosition; equity: number; equityVersion: number; entryCandles?: ReviewCandle[] };

export function enqueuePositionTransition(outbox: PositionOutboxItem[], prior: PaperPosition | null, next: PaperPosition | null, equity = 1_000, equityVersion = 0, entryCandles?: ReviewCandle[]) {
  if (!next || (prior?.id === next.id && prior.status === next.status && prior.currentStop === next.currentStop)) return outbox;
  const key = `${next.id}:${equityVersion}`;
  const retainedCandles = entryCandles ?? outbox.find((item) => item.position.id === next.id)?.entryCandles;
  return [...outbox.filter((item) => item.position.id !== next.id), { key, position: { ...next }, equity, equityVersion, ...(retainedCandles?.length ? { entryCandles: retainedCandles } : {}) }];
}

export async function drainPositionOutbox(outbox: PositionOutboxItem[], writer: (item: PositionOutboxItem) => Promise<void>) {
  let drained = 0;
  while (drained < outbox.length) {
    try { await writer(outbox[drained]); }
    catch { break; }
    drained += 1;
  }
  return outbox.slice(drained);
}
