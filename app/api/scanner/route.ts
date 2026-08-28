import { getSettings, listOpenTrades, publicSettings } from "../../../lib/repository";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";
import { getQuickScanner } from "../../../lib/scanner";
import { requireApiAccount } from "../../api-auth";

function unavailableContext(observedAt: number) {
  return {
    observedAt,
    benchmarkMomentum: null,
    optionsIvPercentile: null,
    macroEventRisk: null,
    macroEventLabel: null,
    etfFlowScore: null,
    nextEvents: [],
    options: { btcDvol: null, ethDvol: null, percentile30d: null },
    sources: {
      gateBenchmarks: "unavailable",
      deribitDvol: "unavailable",
      blsCalendar: "unavailable",
      fomcCalendar: "official-static",
      etfFlow: "not-configured",
    },
  };
}

async function backgroundScannerResponse() {
  const bindings = getRuntimeBindings();
  const scanner = bindings.MARKET_SCANNER?.getByName("market-scanner");
  if (scanner) {
    try {
      const snapshot = await scanner.readModel();
      if (snapshot) {
        const ageMs = Math.max(0, Date.now() - snapshot.observedAt);
        return Response.json({
          ...snapshot,
          snapshotSource: "background_scanner",
          snapshotAgeMs: ageMs,
          ...(ageMs > 150_000 ? { error: "后台市场快照已超过实时窗口，等待扫描器自动恢复" } : {}),
        }, {
          headers: {
            "Cache-Control": "private, max-age=5, stale-while-revalidate=15",
            "X-Sentinel-Background-Snapshot": ageMs <= 150_000 ? "fresh" : "stale",
          },
        });
      }
    } catch {
      // Fall through to a D1-only starter shell. Production foreground must not
      // compensate for a scheduler/read-model issue by hitting Gate directly.
    }
  }

  try {
    const [settings, openTrades] = await Promise.all([getSettings(), listOpenTrades()]);
    const observedAt = Date.now();
    return Response.json({
      observedAt,
      universe: [],
      context: unavailableContext(observedAt),
      v2: null,
      openTrades,
      settings: publicSettings(settings),
      snapshotSource: "background_scanner",
      snapshotAgeMs: null,
      error: "后台首轮全市场快照尚未生成；前台不会自行向 Gate 发起重复扫描",
    }, {
      headers: { "Cache-Control": "private, no-store", "X-Sentinel-Background-Snapshot": "missing" },
    });
  } catch (error) {
    return Response.json({
      observedAt: Date.now(),
      error: error instanceof Error ? error.message : "后台行情快照暂不可用",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  const bindings = getRuntimeBindings();
  if (bindings.BACKGROUND_MODE === "cloudflare-free") return backgroundScannerResponse();

  try {
    return Response.json(await getQuickScanner(), {
      headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=30" },
    });
  } catch (error) {
    return Response.json({ observedAt: Date.now(), error: error instanceof Error ? error.message : "全市场初筛不可用" }, { status: 503 });
  }
}
