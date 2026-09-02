import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const advanced = fs.readFileSync(new URL("../lib/hte31-advanced-traders.ts", import.meta.url), "utf8");
const scanner = fs.readFileSync(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8");
const paper = fs.readFileSync(new URL("../lib/resonance-paper-execution.ts", import.meta.url), "utf8");

test("HT4 anti-crowd exhaustion thresholds remain frozen while other strategies are researched", () => {
  assert.match(advanced, /const shortTrendMature = Math\.abs\(shortTrend\) >= 0\.45;/);
  assert.match(advanced, /const stretched = stretchAtr >= 0\.72;/);
  assert.match(advanced, /const crowdingConfirmed = counterVotes >= 3;/);
  assert.match(advanced, /const setupActive = shortTrendMature && stretched && crowdingConfirmed && failedContinuation && microReversal;/);
  assert.match(advanced, /rr: 2\.6,/);
  assert.match(advanced, /minutes: 300,/);
  assert.match(advanced, /strategyId: "trend_exhaustion_reversal"/);
});

test("research strategies are evaluated but are never handed to the execution path", () => {
  assert.match(scanner, /const researchSignals = evaluateHte31ResearchStrategies\(commonInput\);/);
  assert.match(scanner, /recordHte31DiagnosticCycle\(packet, signals, job\.settings, researchSignals\)/);
  assert.match(scanner, /tryOpenResonanceTrade\(packet, signals, job\.candles/);
  assert.doesNotMatch(scanner, /tryOpenResonanceTrade\(packet, researchSignals/);
  assert.doesNotMatch(paper, /dennis_trend_r|raschke_pullback_r|turtle_soup_r|range_rotation|compression_release|relative_strength|shallow_pullback/);
});
