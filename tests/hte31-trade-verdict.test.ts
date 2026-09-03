import assert from "node:assert/strict";
import test from "node:test";
import { buildHte31TradeFinalVerdict } from "../lib/hte31-trade-verdict.ts";
import type { Hte31CounterfactualReport } from "../lib/hte31-counterfactual.ts";
import type { ResonanceEntryQualityReport } from "../lib/resonance-entry-quality.ts";

function entry(classification: ResonanceEntryQualityReport["classification"]): ResonanceEntryQualityReport {
  return {
    generatedAt: 1, sampleSufficient: true, classification,
    classificationLabel: classification, entryEfficiency: 50, initialMaeR: 0.5,
    timeToHalfRMinutes: null, timeToOneRMinutes: null, originalTerminalR: -1,
    oppositeFourHourR: 1, delayedEntries: [], bestDelayBars: null,
    earlierEntryAdvantageR: null, evidence: [],
  };
}

const counterfactual: Hte31CounterfactualReport = {
  generatedAt: 1,
  horizons: [{ minutes: 240, observedAt: 1, originalR: -1, oppositeR: 0.9 }],
  reversals: [],
  summary: "test",
};

const trade = {
  status: "closed" as const,
  netPnlUsdt: -10,
  riskBudgetUsdt: 10,
  postExitStatus: "complete" as const,
  postExitLabel: "正常退出",
  exitEfficiency: 50,
  stopRecovery: false,
  postExitMfePct: 0.2,
};

test("a closed trade waits for the complete post-exit observation before final judgment", () => {
  const result = buildHte31TradeFinalVerdict({ trade: { ...trade, postExitStatus: "observing" }, entryQuality: entry("normal_noise"), counterfactual });
  assert.equal(result.final, false);
  assert.equal(result.code, "INSUFFICIENT_EVIDENCE");
});

test("direction error concludes the exact trade should not have been taken", () => {
  const result = buildHte31TradeFinalVerdict({ trade, entryQuality: entry("direction_wrong"), counterfactual });
  assert.equal(result.final, true);
  assert.equal(result.code, "DIRECTION_WRONG");
  assert.equal(result.shouldTrade, false);
  assert.match(result.profitPath, /反向/);
});

test("no viable alternative produces an explicit no-trade verdict", () => {
  const noPath = { ...counterfactual, horizons: [{ minutes: 240, observedAt: 1, originalR: -0.8, oppositeR: 0.1 }] };
  const result = buildHte31TradeFinalVerdict({ trade, entryQuality: entry("normal_noise"), counterfactual: noPath });
  assert.equal(result.code, "NO_TRADE");
  assert.equal(result.shouldTrade, false);
});
