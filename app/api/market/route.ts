import { analyzeGateSymbol, SYMBOL_PATTERN } from "../../../lib/gate-client";
import { getGlobalRiskContext } from "../../../lib/global-risk";
import { getExperience, getOpenTrade, getPriorLong, getSettings } from "../../../lib/repository";
import { requireApiAccount } from "../../api-auth";

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "SOL_USDT").toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) return Response.json({ error: "symbol must look like SOL_USDT" }, { status: 400 });

  try {
    const [global, settings, priorLongProbability, experience, openTrade] = await Promise.all([
      getGlobalRiskContext(),
      getSettings(),
      getPriorLong(symbol),
      getExperience(symbol),
      getOpenTrade(symbol),
    ]);
    const packet = await analyzeGateSymbol(symbol, {
      detail: "full",
      global,
      priorLongProbability,
      experience,
      alertStyle: settings.alertStyle,
    });
    return Response.json({ ...packet, openTrade, experience }, {
      headers: { "Cache-Control": "private, max-age=2, stale-while-revalidate=5" },
    });
  } catch (error) {
    return Response.json({
      mode: "degraded",
      source: "Gate API v4",
      researchStatus: "uncalibrated-beta",
      observedAt: Date.now(),
      symbol,
      error: error instanceof Error ? error.message : "Gate 数据适配器异常",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
