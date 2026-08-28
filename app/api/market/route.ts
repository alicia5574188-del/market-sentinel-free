import { analyzeGateSymbol, SYMBOL_PATTERN } from "../../../lib/gate-client";
import { getGlobalRiskContext } from "../../../lib/global-risk";
import { getExperience, getOpenTrade, getPriorLong, getSettings, previewDecisionContract } from "../../../lib/repository";
import { getLatestV2MarketContext, getV2Opportunity } from "../../../lib/sentinel-v2-repository";
import { requireApiAccount } from "../../api-auth";

const LAST_GOOD_TTL_MS = 90_000;
type CachedMarketPayload = Record<string, unknown> & { observedAt: number; symbol: string };
const lastGoodBySymbol = new Map<string, { savedAt: number; payload: CachedMarketPayload }>();

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

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  // Only the query string is needed here. Avoid constructing a URL from
  // request.url so iOS standalone / Workers request formatting cannot make the
  // entire selected-symbol endpoint fail before market data is fetched.
  const queryIndex = request.url.indexOf("?");
  const query = queryIndex >= 0 ? request.url.slice(queryIndex + 1) : "";
  const symbol = (new URLSearchParams(query).get("symbol") ?? "SOL_USDT").toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) return Response.json({ error: "symbol must look like SOL_USDT" }, { status: 400 });

  try {
    // Gate market data is essential. Historical/V2/D1 enrichments are optional:
    // one transient auxiliary failure must not take down the whole live card.
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

    // Contract preview is explanatory only. Strategy 2.0 owns new-entry
    // authority, so preview failures are recorded but cannot degrade live data.
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
  }
}
