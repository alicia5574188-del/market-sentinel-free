import { analyzeGateSymbol, SYMBOL_PATTERN } from "../../../lib/gate-client";
import { getGlobalRiskContext } from "../../../lib/global-risk";
import { getExperience, getOpenTrade, getPriorLong, getSettings, previewDecisionContract } from "../../../lib/repository";
import { getLatestV2MarketContext, getV2Opportunity } from "../../../lib/sentinel-v2-repository";
import { requireApiAccount } from "../../api-auth";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "optional source failed";
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

    return Response.json({
      ...(contractPreview?.packet ?? packet),
      openTrade,
      experience: experience ?? { LONG: null, SHORT: null },
      v2: { market: v2Market, opportunity: v2Opportunity },
      optionalSourceErrors,
    }, {
      headers: { "Cache-Control": "private, max-age=2, stale-while-revalidate=5" },
    });
  } catch (error) {
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
