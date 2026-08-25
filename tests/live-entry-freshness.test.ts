import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LIVE_ENTRY_MAX_AGE_MS, liveEntryCandidateCutoff } from "../lib/live-trading-repository.ts";

test("live entry candidates never predate the current enable session", () => {
  const now = 2_000_000;
  const enabledAt = now - 30_000;
  assert.equal(liveEntryCandidateCutoff(enabledAt, now), enabledAt);
});

test("live entry candidates expire after two minutes even if the switch stayed on", () => {
  const now = 2_000_000;
  const enabledAt = now - 60 * 60_000;
  assert.equal(LIVE_ENTRY_MAX_AGE_MS, 120_000);
  assert.equal(liveEntryCandidateCutoff(enabledAt, now), now - LIVE_ENTRY_MAX_AGE_MS);
});

test("candidate query applies the freshness cutoff and prioritizes the newest eligible signal", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/live-trading-repository.ts", import.meta.url)), "utf8");
  assert.match(source, /gte\(tradeCases\.entryAt, liveEntryCandidateCutoff\(enabledAt, now\)\)/);
  assert.match(source, /orderBy\(desc\(tradeCases\.entryAt\)\)/);
});
