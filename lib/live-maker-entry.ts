import type { GateLiveOrder } from "./gate-live.ts";

/** Maker-first entry for inverse LIVE copies.
 * One post-only (poc) order rests at our own side of the book for a bounded
 * window. Whatever does not fill is cancelled and the caller sends the exact
 * remainder as the existing IOC market order. The LIVE entry is never skipped:
 * a rejected/unfilled maker simply means the full quantity goes to market.
 * Any state that cannot be confirmed throws, so the caller must NOT send a
 * market order on top of an unknown maker exposure. */
export const LIVE_MAKER_ENTRY_POLICY = "maker-first-2s-then-market-v1";
export const LIVE_MAKER_WAIT_MS = 2_000;

export type MakerClient = {
  placeMaker(body: Record<string, unknown>, beforeSend: () => boolean): Promise<string | null>;
  inspect(orderId: string): Promise<GateLiveOrder | null>;
  cancel(orderId: string): Promise<void>;
};
export type MakerResult = {
  policy: typeof LIVE_MAKER_ENTRY_POLICY;
  makerOrderId: string | null;
  makerPrice: number;
  filledContracts: number;
  fillPrice: number | null;
  remainingText: string;
  rejected: boolean;
  waitedMs: number;
};
export class MakerStateUnknownError extends Error {}

export function makerEntryTag(entryTag: string) { return `${entryTag}m`; }

function decimals(text: string) { const i = text.indexOf("."); return i < 0 ? 0 : text.length - i - 1; }
/** Exact decimal subtraction in contract quanta. */
export function remainingContractsText(totalText: string, filled: number) {
  const d = decimals(totalText), scale = 10 ** d;
  const total = Math.round(Number(totalText) * scale), done = Math.round(Math.abs(filled) * scale);
  if (!Number.isSafeInteger(total) || total <= 0 || done < 0) throw new Error("挂单剩余数量无法核对");
  const left = Math.max(0, total - done);
  return d ? (left / scale).toFixed(d) : String(left);
}
function filledOf(order: GateLiveOrder) {
  const size = Math.abs(Number(order.size)), left = Math.abs(Number(order.left));
  if (!Number.isFinite(size) || !Number.isFinite(left)) throw new MakerStateUnknownError("挂单成交数量无法读取");
  return Math.max(0, size - left);
}

export async function makerFirstEntry(client: MakerClient, input: {
  symbol: string; side: "LONG" | "SHORT"; contractsText: string; bestBid: number; bestAsk: number; tag: string;
  beforeSend: () => boolean; reduceOnly?: boolean; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}): Promise<MakerResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = input.now ?? Date.now, waitMs = input.waitMs ?? LIVE_MAKER_WAIT_MS, pollMs = input.pollMs ?? 400;
  // Rest on OUR side: buy at bid, sell at ask. poc is rejected instead of taking.
  const price = input.side === "LONG" ? input.bestBid : input.bestAsk;
  const base = { policy: LIVE_MAKER_ENTRY_POLICY, makerPrice: price, waitedMs: 0 } as const;
  const full = (rejected: boolean, makerOrderId: string | null = null): MakerResult =>
    ({ ...base, makerOrderId, filledContracts: 0, fillPrice: null, remainingText: input.contractsText, rejected });
  if (!(price > 0) || !Number.isFinite(price)) return full(true);
  const body = { contract: input.symbol, size: `${input.side === "SHORT" ? "-" : ""}${input.contractsText}`,
    price: String(price), tif: "poc", text: input.tag, reduce_only: !!input.reduceOnly };
  let id: string | null;
  try { id = await client.placeMaker(body, input.beforeSend); }
  catch (error) {
    // A definitive exchange rejection (e.g. poc would cross) never rested.
    if (error instanceof Error && error.name === "GateEntryCancelledError") throw error;
    const status = Number((error instanceof Error ? error.message : "").match(/Gate\s+(\d{3})/)?.[1] ?? 0);
    if (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) return full(true);
    throw new MakerStateUnknownError(`挂单提交结果不明确：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!id) throw new MakerStateUnknownError("挂单已发送但没有返回订单编号");
  const started = now();
  let order: GateLiveOrder | null = null;
  while (true) {
    order = await client.inspect(id);
    if (order && order.status !== "open") break;
    if (now() - started >= waitMs) break;
    await sleep(pollMs);
  }
  if (!order || order.status === "open") {
    await client.cancel(id);
    order = null;
    for (let i = 0; i < 3 && (!order || order.status === "open"); i++) {
      order = await client.inspect(id);
      if (!order || order.status === "open") await sleep(200);
    }
    if (!order || order.status === "open") throw new MakerStateUnknownError("挂单撤销后仍未确认最终成交数量");
  }
  const filled = filledOf(order), fp = Number(order.fill_price);
  return { ...base, makerOrderId: id, filledContracts: filled, fillPrice: filled > 0 && fp > 0 ? fp : null,
    remainingText: remainingContractsText(input.contractsText, filled), rejected: false, waitedMs: now() - started };
}
