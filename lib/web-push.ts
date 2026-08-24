import type { GateAnalysisPacket } from "./gate-client";
import { listActivePushSubscriptions, recordPushResult } from "./repository";
import { createEncryptedPushRequest, toArrayBuffer, type PushSubscriptionKeys, type VapidConfig } from "./web-push-crypto";

export { base64UrlToBytes, bytesToBase64Url, createEncryptedPushRequest } from "./web-push-crypto";
export type { VapidConfig } from "./web-push-crypto";

type PushSubscriptionRecord = PushSubscriptionKeys & { id: string };

export async function sendPush(subscription: PushSubscriptionRecord, payload: unknown, config: VapidConfig) {
  const request = await createEncryptedPushRequest(subscription, payload, config);
  const response = await fetch(subscription.endpoint, { method: "POST", headers: request.headers, body: toArrayBuffer(request.body), signal: AbortSignal.timeout(8_000) });
  return { ok: response.ok, status: response.status, expired: response.status === 404 || response.status === 410 };
}

export async function sendAllPush(payload: unknown, config: VapidConfig, accountId?: string | null) {
  const subscriptions = await listActivePushSubscriptions(accountId);
  const results = await Promise.allSettled(subscriptions.map(async (subscription) => {
    const result = await sendPush(subscription, payload, config);
    await recordPushResult(subscription.id, result.ok, result.expired);
    return result;
  }));
  return {
    attempted: subscriptions.length,
    delivered: results.filter((result) => result.status === "fulfilled" && result.value.ok).length,
  };
}

export async function notifyConfirmed(packet: GateAnalysisPacket, config: VapidConfig) {
  const price = packet.market.futuresPrice.toLocaleString("en-US", { maximumFractionDigits: packet.market.futuresPrice >= 100 ? 2 : 5 });
  const reason = packet.decision.evidence.slice(0, 2).map((item) => item.title).join(" + ");
  const invalidation = packet.decision.invalidation.length > 58 ? `${packet.decision.invalidation.slice(0, 58)}…` : packet.decision.invalidation;
  return sendAllPush({
    title: `${packet.symbol.replace("_", "")} ${packet.decision.side} · ${packet.decision.confidence}%`,
    body: `${packet.decision.action}｜因：${reason}｜现价 ${price}｜失效：${invalidation}`,
    url: `/?symbol=${encodeURIComponent(packet.symbol)}`,
    tag: `${packet.symbol}-${packet.decision.side}`,
    data: { symbol: packet.symbol, observedAt: packet.observedAt },
  }, config);
}

type LifecyclePushTrade = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  currentStopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  lastPrice: number;
  confidence: number;
  leverage: number;
  marginUsdt: number;
  contractNotionalUsdt: number;
  netMovePct: number | null;
  netPnlUsdt: number | null;
  exitReason: string | null;
  entryEvidence: { title: string }[];
  lesson: { summary?: string } | null;
};

function compactPrice(price: number) {
  return price.toLocaleString("en-US", { maximumFractionDigits: price >= 100 ? 2 : 6 });
}

export async function notifyTradeLifecycle(type: "entry" | "target1" | "exit", trade: LifecyclePushTrade, config: VapidConfig) {
  const reason = trade.entryEvidence.slice(0, 3).map((item) => item.title).join(" + ") || "全部进场检查通过";
  const payload = type === "entry" ? {
    title: `${trade.symbol.replace("_", "")} ${trade.side} · 模拟合约持仓`,
    body: `${trade.leverage}x逐仓｜保证金 ${trade.marginUsdt.toFixed(2)}U｜名义 ${trade.contractNotionalUsdt.toFixed(2)}U｜入场 ${compactPrice(trade.entryPrice)}｜止损 ${compactPrice(trade.currentStopPrice)}｜因：${reason}`,
  } : type === "target1" ? {
    title: `${trade.symbol.replace("_", "")} 已到 TP1 · 保护止损`,
    body: `现价 ${compactPrice(trade.lastPrice)}｜止损已移至入场价 ${compactPrice(trade.entryPrice)}｜继续等待 TP2 ${compactPrice(trade.takeProfit2Price)}`,
  } : {
    title: `${trade.symbol.replace("_", "")} ${trade.side} · 已平仓`,
    body: `${trade.exitReason ?? "命中系统出场规则"}｜净盈亏 ${(trade.netPnlUsdt ?? 0) >= 0 ? "+" : ""}${(trade.netPnlUsdt ?? 0).toFixed(2)}U / ${(trade.netMovePct ?? 0).toFixed(2)}%｜${trade.lesson?.summary ?? "复盘已写入下一次分析"}`,
  };
  return sendAllPush({
    ...payload,
    url: `/?symbol=${encodeURIComponent(trade.symbol)}&trade=${encodeURIComponent(trade.id)}`,
    tag: `trade-${trade.id}-${type}`,
    data: { tradeId: trade.id, symbol: trade.symbol, type },
  }, config);
}
