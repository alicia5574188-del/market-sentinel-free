import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Learning Arena is explicitly read-only and avoids fake Learning Alpha", async () => {
  const [ui, api, model, adapter] = await Promise.all([
    readFile(new URL("../app/strategy-2-learning-arena.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/learning-arena/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/strategy-2-learning-arena-core.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/strategy-2-learning-arena.ts", import.meta.url), "utf8"),
  ]);

  assert.match(ui, /LEARNING ARENA · READ ONLY/);
  assert.match(ui, /所有指标只读，不参与开仓和风控/);
  assert.match(ui, /时期差异，不等于 Learning Alpha/);
  assert.match(ui, /Frozen Baseline/);
  assert.match(ui, /Challenger/);
  assert.match(model, /learningAlphaR: null/);
  assert.match(model, /changesTradingLogic: false/);
  assert.match(model, /changesRisk: false/);
  assert.match(model, /changesExecution: false/);
  assert.match(adapter, /eq\(tradeCases\.status, "closed"\)/);
  assert.match(adapter, /eq\(tradeCases\.simulationModel, "contract_v2"\)/);
  assert.match(adapter, /Math\.min\(2500, limit\)/);
  assert.match(api, /ARENA_CACHE_MS = 5 \* 60_000/);
});

test("Learning Arena polling is delayed and infrequent to protect Worker resources", async () => {
  const ui = await readFile(new URL("../app/strategy-2-learning-arena.tsx", import.meta.url), "utf8");
  assert.match(ui, /setTimeout\(\(\) => \{ void load\(\); \}, 4_000\)/);
  assert.match(ui, /setInterval\(\(\) => \{ void load\(\); \}, 5 \* 60_000\)/);
  assert.match(ui, /if \(document\.hidden \|\| loading\) return/);
  assert.match(ui, /Keep the last trustworthy Arena snapshot/);
});
