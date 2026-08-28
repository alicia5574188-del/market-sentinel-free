import { requireApiAccount } from "../../../api-auth";
import { getStrategy2LearningArena } from "../../../../lib/strategy-2-learning-arena";

const ARENA_CACHE_MS = 5 * 60_000;
let arenaCache: { savedAt: number; value: Awaited<ReturnType<typeof getStrategy2LearningArena>> } | null = null;
let arenaPending: Promise<Awaited<ReturnType<typeof getStrategy2LearningArena>>> | null = null;

async function cachedArena() {
  const now = Date.now();
  if (arenaCache && now - arenaCache.savedAt < ARENA_CACHE_MS) return arenaCache.value;
  if (!arenaPending) {
    arenaPending = getStrategy2LearningArena(1000).then((value) => {
      arenaCache = { savedAt: Date.now(), value };
      return value;
    }).finally(() => { arenaPending = null; });
  }
  return arenaPending;
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  try {
    const arena = await cachedArena();
    return Response.json(arena, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Sentinel-Research-Only": "1",
      },
    });
  } catch (error) {
    return Response.json({
      version: "learning-arena-v1",
      readOnly: true,
      error: error instanceof Error ? error.message : "Learning Arena 暂不可用",
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
