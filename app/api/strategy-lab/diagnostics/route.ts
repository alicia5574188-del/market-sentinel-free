import { requireApiAccount } from "../../../api-auth";
import { ensureBackgroundSchedulers } from "../../../../lib/background-scheduler";
import { analyzeGateSymbol, fetchGateChartCandles, SYMBOL_PATTERN } from "../../../../lib/gate-client.ts";
import { getGlobalRiskContext } from "../../../../lib/global-risk.ts";
import { getExperience, getPriorLong, getSettings } from "../../../../lib/repository.ts";
import { evaluateShadowStrategies } from "../../../../lib/shadow-strategy-engine.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  const url = new URL(request.url);
  const symbol = String(url.searchParams.get("symbol") ?? "BTC_USDT").toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    return Response.json({ error: "无效的 Gate 合约代码" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const settings = await getSettings();
    const [context, priorLongProbability, experience, background] = await Promise.all([
      getGlobalRiskContext(),
      getPriorLong(symbol),
      getExperience(symbol),
      ensureBackgroundSchedulers(),
    ]);
    const now = Date.now();
    const [packet, candles5m] = await Promise.all([
      analyzeGateSymbol(symbol, {
        global: context,
        priorLongProbability,
        experience,
        alertStyle: settings.alertStyle,
        detail: "scan",
      }),
      fetchGateChartCandles(symbol, now - 18 * 60 * 60_000, now),
    ]);

    if (!candles5m.length) throw new Error("V3 影子 5m K 线为空");

    const strategies = evaluateShadowStrategies({
      symbol,
      observedAt: packet.observedAt,
      futuresPrice: packet.market.futuresPrice,
      volumeUsd: packet.market.volumeUsd,
      changePercentage: packet.market.changePercentage,
      fundingRate: packet.market.fundingRate,
      openInterestChangePct: packet.market.openInterestChangePct,
      spotCvdRatio: packet.market.spotCvdRatio,
      orderBookImbalance: packet.market.orderBookImbalance,
      liquidationImbalance: packet.market.liquidationImbalance,
      multiTimeframeTrend: packet.market.multiTimeframeTrend,
      benchmarkMomentum: context.benchmarkMomentum,
      macroEventRisk: packet.market.macroEventRisk,
      dataQuality: packet.decision.dataQuality,
      candles5m,
    });

    return Response.json({
      observedAt: packet.observedAt,
      symbol,
      dataQuality: packet.decision.dataQuality,
      sourceErrors: packet.sourceErrors,
      background: {
        active: background.active,
        scannerState: background.scanner?.state ?? null,
        scannerLastRunAt: background.scanner?.lastRunAt ?? null,
        scannerLastSuccessAt: background.scanner?.lastSuccessAt ?? null,
        scannerLastError: background.scanner?.lastError ?? background.error ?? null,
        scanCadenceSeconds: background.scanCadenceSeconds,
        deepBatchSize: background.deepBatchSize,
      },
      regime: strategies[0]?.regime ?? null,
      market: {
        futuresPrice: packet.market.futuresPrice,
        volumeUsd: packet.market.volumeUsd,
        changePercentage: packet.market.changePercentage,
        fundingRate: packet.market.fundingRate,
        openInterestChangePct: packet.market.openInterestChangePct,
        spotCvdRatio: packet.market.spotCvdRatio,
        orderBookImbalance: packet.market.orderBookImbalance,
        liquidationImbalance: packet.market.liquidationImbalance,
        multiTimeframeTrend: packet.market.multiTimeframeTrend,
        benchmarkMomentum: context.benchmarkMomentum,
      },
      strategies: strategies.map((strategy) => ({
        strategyId: strategy.strategyId,
        label: strategy.label,
        state: strategy.state,
        side: strategy.side,
        score: strategy.score,
        confidence: strategy.confidence,
        reasons: strategy.reasons,
        blockers: strategy.blockers,
        entryPlanReady: Boolean(strategy.entryPlan?.ready),
        checks: strategy.entryPlan?.checks.map((check) => ({
          key: check.key,
          label: check.label,
          passed: check.passed,
          required: check.required,
          detail: check.detail,
        })) ?? [],
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "V3 策略诊断暂不可用",
      symbol,
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
