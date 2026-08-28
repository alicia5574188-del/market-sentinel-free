import { analyzeGateSymbol, SYMBOL_PATTERN } from "../../../lib/gate-client";
import { getGlobalRiskContext } from "../../../lib/global-risk";
import { getExperience, getOpenTrade, getPriorLong, getSettings, previewDecisionContract } from "../../../lib/repository";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";
import { getLatestV2MarketContext, getV2Opportunity } from "../../../lib/sentinel-v2-repository";
import { acquireHeavyUiRead, heavyUiReadBusyResponse } from "../../../lib/ui-heavy-read-admission";
import { requireApiAccount } from "../../api-auth";

const LAST_GOOD_TTL_MS = 90_000;
const BACKGROUND_READ_FRESH_MS = 150_000;
const BACKGROUND_DEEP_FRESH_MS = 180_000;
type CachedMarketPayload = Record<string, unknown> & { observedAt: number; symbol: string };
const lastGoodBySymbol = new Map<string, { savedAt: number; payload: CachedMarketPayload }>();

type BackgroundTicker = {
  symbol: string;
  price: number;
  changePercentage: number;
  volumeUsd: number;
  fundingRate: number | null;
  basisPct: number | null;
};

type BackgroundV2 = {
  market?: unknown;
  opportunities?: Array<{ symbol?: string; observedAt?: number; opportunityScore?: number }>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "optional source failed";
}

function rememberLastGood(symbol: string, payload: CachedMarketPayload) {
  lastGoodBySymbol.set(symbol, { savedAt: Date.now(), payload });
  if (lastGoodBySymbol.size <= 16) return;
  const oldest = [...lastGoodBySymbol.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)[0]?.[0];
  if (oldest) lastGoodBySymbol.delete(oldest);
}

function staleFallback(symbol: string, error: unknown) {
  const cached = lastGoodBySymbol.get(symbol);
  if (!cached || Date.now() - cached.savedAt > LAST_GOOD_TTL_MS) return null;
  return Response.json({
    ...cached.payload,
    mode: "degraded",
    staleFallback: true,
    staleAgeMs: Date.now() - cached.savedAt,
    error: `实时 Gate 核心行情短暂不可用，暂保留最近有效快照：${errorMessage(error)}`,
  }, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Sentinel-Stale-Fallback": "1",
    },
  });
}

function backgroundOpportunity(v2: BackgroundV2 | null, symbol: string) {
  const candidates = (v2?.opportunities ?? []).filter((item) => item.symbol === symbol);
  return candidates.sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0) || (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0))[0] ?? null;
}

async function backgroundMarketResponse(symbol: string) {
  const bindings = getRuntimeBindings();
  const scanner = bindings.MARKET_SCANNER?.getByName("market-scanner");
  if (!scanner) {
    return Response.json({
      mode: "degraded",
      source: "Background Market Scanner",
      researchStatus: "uncalibrated-beta",
      observedAt: Date.now(),
      symbol,
      snapshotSource: "background_scanner",
      error: "后台市场快照服务尚未就绪，前台不会回退为 Gate 重型计算",
    }, { headers: { "Cache-Control": "private, no-store", "X-Sentinel-Background-Snapshot": "missing" } });
  }

  try {
    const snapshot = await scanner.marketSnapshot(symbol);
    const readModel = snapshot.readModel;
    const deep = snapshot.deep;
    const now = Date.now();
    const backgroundAgeMs = readModel ? Math.max(0, now - readModel.observedAt) : null;
    const deepAgeMs = deep ? Math.max(0, now - deep.savedAt) : null;
    const universe = (readModel?.universe ?? []) as BackgroundTicker[];
    const ticker = universe.find((item) => item.symbol === symbol) ?? null;
    const openTrades = (readModel?.openTrades ?? []) as Array<{ symbol?: string }>;
    const openTrade = openTrades.find((trade) => trade.symbol === symbol) ?? null;
    const v2 = (readModel?.v2 ?? null) as BackgroundV2 | null;
    const opportunity = backgroundOpportunity(v2, symbol);
    const readFresh = backgroundAgeMs != null && backgroundAgeMs <= BACKGROUND_READ_FRESH_MS;
    const deepFresh = deepAgeMs != null && deepAgeMs <= BACKGROUND_DEEP_FRESH_MS;

    if (deep && deepFresh) {
      const payload = {
        ...deep.packet,
        mode: readFresh ? deep.packet.mode : "degraded",
        source: "Background Market Scanner snapshot",
        snapshotSource: "background_scanner",
        backgroundAgeMs,
        deepAgeMs,
        openTrade,
        experience: { LONG: null, SHORT: null },
        v2: { market: v2?.market ?? null, opportunity },
        ...(readFresh ? {} : {
          staleFallback: true,
          staleAgeMs: backgroundAgeMs,
          error: "后台全市场快照已超过实时窗口；保留最近一次深度证据但不把它标记为实时数据",
        }),
      } as CachedMarketPayload;
      if (readFresh) rememberLastGood(symbol, payload);
      return Response.json(payload, {
        headers: {
          "Cache-Control": "private, max-age=3, stale-while-revalidate=10",
          "X-Sentinel-Background-Snapshot": readFresh ? "fresh" : "stale",
        },
      });
    }

    const error = !readModel
      ? "后台首轮市场快照尚未生成，等待扫描器完成；前台不会自行向 Gate 发起重型分析"
      : deep
        ? "该标的后台深度证据已过实时窗口，正在等待下一轮深度复核"
        : "该标的正在等待后台深度复核；前台只展示可验证的全市场粗粒度快照";
    return Response.json({
      mode: "degraded",
      source: "Background Market Scanner snapshot",
      researchStatus: "uncalibrated-beta",
      observedAt: readModel?.observedAt ?? now,
      symbol,
      snapshotSource: "background_scanner",
      backgroundAgeMs,
      deepAgeMs,
      openTrade,
      v2: { market: v2?.market ?? null, opportunity },
      error,
      ...(ticker ? {
        market: {
          futuresPrice: ticker.price,
          volumeUsd: ticker.volumeUsd,
          changePercentage: ticker.changePercentage,
          fundingRate: ticker.fundingRate,
          basisPct: ticker.basisPct,
          openInterestChangePct: null,
          spotCvdRatio: null,
          orderBookImbalance: null,
          liquidationImbalance: null,
          multiTimeframeTrend: null,
        },
      } : {}),
    }, {
      headers: {
        "Cache-Control": "private, max-age=3, stale-while-revalidate=10",
        "X-Sentinel-Background-Snapshot": readFresh ? "coarse" : "stale",
      },
    });
  } catch (error) {
    return Response.json({
      mode: "degraded",
      source: "Background Market Scanner",
      researchStatus: "uncalibrated-beta",
      observedAt: Date.now(),
      symbol,
      snapshotSource: "background_scanner",
      error: `后台市场快照读取暂不可用：${errorMessage(error)}。前台不会回退为 Gate 重型计算`,
    }, { headers: { "Cache-Control": "private, no-store", "X-Sentinel-Background-Snapshot": "error" } });
  }
}

async function directMarketResponse(symbol: string) {
  const lease = acquireHeavyUiRead(`/api/market:${symbol}`);
  if (!lease) {
    const fallback = staleFallback(symbol, "Worker 正在执行另一项重型只读刷新，已主动削峰");
    if (fallback) return fallback;
    return heavyUiReadBusyResponse("/api/market");
  }

  try {
    const [globalResult, settingsResult, priorResult, experienceResult, openTradeResult, v2MarketResult, v2OpportunityResult] = await Promise.allSettled([
      getGlobalRiskContext(),
      getSettings(),
      getPriorLong(symbol),
      getExperience(symbol),
      getOpenTrade(symbol),
      getLatestV2MarketContext(),
      getV2Opportunity(symbol),
    ] as const);

    const optionalSourceErrors: Record<string, string> = {};
    if (globalResult.status === "rejected") optionalSourceErrors.globalRisk = errorMessage(globalResult.reason);
    if (settingsResult.status === "rejected") optionalSourceErrors.settings = errorMessage(settingsResult.reason);
    if (priorResult.status === "rejected") optionalSourceErrors.prior = errorMessage(priorResult.reason);
    if (experienceResult.status === "rejected") optionalSourceErrors.experience = errorMessage(experienceResult.reason);
    if (openTradeResult.status === "rejected") optionalSourceErrors.openTrade = errorMessage(openTradeResult.reason);
    if (v2MarketResult.status === "rejected") optionalSourceErrors.v2Market = errorMessage(v2MarketResult.reason);
    if (v2OpportunityResult.status === "rejected") optionalSourceErrors.v2Opportunity = errorMessage(v2OpportunityResult.reason);

    const global = globalResult.status === "fulfilled" ? globalResult.value : undefined;
    const settings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
    const priorLongProbability = priorResult.status === "fulfilled" ? priorResult.value : null;
    const experience = experienceResult.status === "fulfilled" ? experienceResult.value : undefined;
    const openTrade = openTradeResult.status === "fulfilled" ? openTradeResult.value : null;
    const v2Market = v2MarketResult.status === "fulfilled" ? v2MarketResult.value : null;
    const v2Opportunity = v2OpportunityResult.status === "fulfilled" ? v2OpportunityResult.value : null;

    const packet = await analyzeGateSymbol(symbol, {
      detail: "full",
      global,
      priorLongProbability,
      experience,
      alertStyle: settings?.alertStyle,
    });

    let contractPreview: Awaited<ReturnType<typeof previewDecisionContract>> = null;
    if (!openTrade && settings) {
      try {
        contractPreview = await previewDecisionContract(packet, settings);
      } catch (error) {
        optionalSourceErrors.contractPreview = errorMessage(error);
      }
    }

    const payload = {
      ...(contractPreview?.packet ?? packet),
      openTrade,
      experience: experience ?? { LONG: null, SHORT: null },
      v2: { market: v2Market, opportunity: v2Opportunity },
      optionalSourceErrors,
    } as CachedMarketPayload;
    rememberLastGood(symbol, payload);

    return Response.json(payload, {
      headers: { "Cache-Control": "private, max-age=2, stale-while-revalidate=5" },
    });
  } catch (error) {
    const fallback = staleFallback(symbol, error);
    if (fallback) return fallback;
    return Response.json({
      mode: "degraded",
      source: "Gate API v4",
      researchStatus: "uncalibrated-beta",
      observedAt: Date.now(),
      symbol,
      error: error instanceof Error ? error.message : "Gate 核心行情暂不可用",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  } finally {
    lease.release();
  }
}

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  const queryIndex = request.url.indexOf("?");
  const query = queryIndex >= 0 ? request.url.slice(queryIndex + 1) : "";
  const symbol = (new URLSearchParams(query).get("symbol") ?? "SOL_USDT").toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) return Response.json({ error: "symbol must look like SOL_USDT" }, { status: 400 });

  const bindings = getRuntimeBindings();
  if (bindings.BACKGROUND_MODE === "cloudflare-free") {
    return backgroundMarketResponse(symbol);
  }
  return directMarketResponse(symbol);
}
