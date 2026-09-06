import type { PaperPosition } from "./liquidity-core.ts";

export type PositionOutboxItem = { key: string; position: PaperPosition; equity: number; equityVersion: number };

export function enqueuePositionTransition(outbox: PositionOutboxItem[], prior: PaperPosition | null, next: PaperPosition | null, equity = 1_000, equityVersion = 0) {
  if (!next || (prior?.id === next.id && prior.status === next.status && prior.currentStop === next.currentStop)) return outbox;
  const key = `${next.id}:${equityVersion}`;
  return [...outbox.filter((item) => item.position.id !== next.id), { key, position: { ...next }, equity, equityVersion }];
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
