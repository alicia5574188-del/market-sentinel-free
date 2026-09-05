import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { hte31PostExitObservations } from "../../../../db/hte31-schema";
import { fetchGateChartCandles } from "../../../../lib/gate-client";
import { getHte31Trade, getHte31TradeChart } from "../../../../lib/hte31-repository";
import { buildHte31Counterfactual } from "../../../../lib/hte31-counterfactual";
import { buildResonanceEntryQuality } from "../../../../lib/resonance-entry-quality";
import { hte31CanonicalStrategyLabel, hte31StrategyFamilyForTrader, hte31TraderDefinition, type Hte31TraderId } from "../../../../lib/hte31-strategy-catalog";
import { buildHte31TradeFinalVerdict } from "../../../../lib/hte31-trade-verdict";
import { getSettings } from "../../../../lib/settings-repository";
import type { Candle } from "../../../../lib/signal-engine";
import { requireApiAccount } from "../../../api-auth";

export const dynamic = "force-dynamic";

function candleTime(candle: Candle) {
  return candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
}

function mergeCandles(...groups: Candle[][]) {
  const map = new Map<number, Candle>();
  for (const candle of groups.flat()) map.set(candleTime(candle), candle);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle).slice(-260);
}

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  const id = new URL(request.url).searchParams.get("trade") ?? "";
  if (!id.startsWith("hte31:") || id.length > 128) return Response.json({ error: "缺少有效 HTE 3.1 订单 ID" }, { status: 400 });

  const trade = await getHte31Trade(id);
  if (!trade) return Response.json({ error: "HTE 3.1 订单不存在" }, { status: 404 });
  const stored = await getHte31TradeChart(id);
  const observations = await getDb().select().from(hte31PostExitObservations)
    .where(eq(hte31PostExitObservations.tradeId, id))
    .orderBy(asc(hte31PostExitObservations.horizonMinutes));

  const now = Date.now();
  const postExitEnd = trade.exitAt ? Math.min(now, trade.exitAt + 12 * 60 * 60_000) : now;
  const from = trade.entryAt - 90 * 60_000;
  let fresh: Candle[] = [];
  let upstreamError: string | null = null;
  try {
    if (postExitEnd - from <= 72 * 60 * 60_000) fresh = await fetchGateChartCandles(trade.symbol, from, postExitEnd);
  } catch (error) {
    upstreamError = error instanceof Error ? error.message : "Gate K线暂不可用";
  }
  const candles = mergeCandles(
    stored?.entryCandles ?? [],
    stored?.holdingCandles ?? [],
    stored?.postExitCandles ?? [],
    fresh,
  );
  const settings = await getSettings();
  const counterfactual = buildHte31Counterfactual(trade, candles, settings.roundTripCostBps, now);
  const entryQuality = candles.length
    ? buildResonanceEntryQuality(trade, candles, settings.roundTripCostBps, now)
    : stored?.entryQuality ?? null;
  const finalVerdict = buildHte31TradeFinalVerdict({ trade, entryQuality, counterfactual });
  const traderId = trade.traderId as Hte31TraderId;
  const direct = trade.decisionAuthority === "direct_market_brain";
  const definition = direct ? null : hte31TraderDefinition(traderId);
  const family = direct ? null : hte31StrategyFamilyForTrader(traderId);

  return Response.json({
    version: "resonance-strategy-lifecycle-v1",
    tradeId: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    traderId: trade.traderId,
    setupId: trade.setupId,
    strategy: {
      familyId: family?.id ?? "DIRECT",
      familyName: family?.name ?? "市场大脑",
      variantId: definition?.variantId ?? trade.brainVersion ?? "direct-market-brain-v4-restored-core",
      variantName: definition?.variantName ?? "当前位置决策",
      canonicalLabel: hte31CanonicalStrategyLabel(traderId, trade.assetRegime),
      tags: definition?.tags ?? ["位置", "方向", "目标", "失效"],
    },
    observedAt: now,
    candles,
    currentPrice: candles.at(-1)?.close ?? trade.lastPrice,
    levels: {
      entry: trade.entryPrice,
      initialStop: trade.initialStopPrice,
      currentStop: trade.currentStopPrice,
      takeProfit1: trade.takeProfit1Price,
      takeProfit2: trade.takeProfit2Price,
    },
    markers: [
      { kind: "ENTRY", time: trade.entryAt, price: trade.entryPrice, label: trade.side === "LONG" ? "开多" : "开空" },
      ...(trade.exitAt && trade.exitPrice ? [{ kind: "EXIT", time: trade.exitAt, price: trade.exitPrice, label: trade.exitReason ?? "平仓" }] : []),
    ],
    postExitStartAt: trade.exitAt,
    observationUntilAt: trade.exitAt ? trade.exitAt + 12 * 60 * 60_000 : null,
    observations,
    counterfactual,
    finalVerdict,
    diagnosis: {
      mfePct: trade.mfePct,
      maePct: trade.maePct,
      postExitMfePct: trade.postExitMfePct,
      postExitMaePct: trade.postExitMaePct,
      exitCapturePct: trade.exitCapturePct,
      exitEfficiency: trade.exitEfficiency,
      stopRecovery: trade.stopRecovery,
      label: trade.postExitLabel,
      status: trade.postExitStatus,
      entryQuality,
    },
    upstreamError,
  }, { headers: { "Cache-Control": "private, max-age=5, stale-while-revalidate=15" } });
}
