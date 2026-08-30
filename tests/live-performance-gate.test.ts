import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_LOSS_STREAK_COOLDOWN_MS,
  evaluateLivePerformanceGate,
} from "../lib/live-performance-gate.ts";

const now = Date.UTC(2026, 7, 25, 1, 30, 0);

test("two consecutive live losses trigger a six-hour entry cooldown", () => {
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [
      { realizedPnlUsdt: -1.2, entryEquityUsdt: 100, closedAt: now - 30 * 60_000 },
      { realizedPnlUsdt: -0.8, entryEquityUsdt: 100, closedAt: now - 90 * 60_000 },
      { realizedPnlUsdt: 2.1, entryEquityUsdt: 100, closedAt: now - 3 * 60 * 60_000 },
    ],
    recentSimulation: [],
  });
  assert.equal(result.passed, false);
  assert.equal(result.liveLossStreak, 2);
  assert.equal(result.cooldownUntil, now - 30 * 60_000 + LIVE_LOSS_STREAK_COOLDOWN_MS);
  assert.match(result.reason ?? "", /连续 2 笔亏损/);
});

test("expired live cooldown automatically allows entry again", () => {
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [
      { realizedPnlUsdt: -1.2, entryEquityUsdt: 100, closedAt: now - 7 * 60 * 60_000 },
      { realizedPnlUsdt: -0.8, entryEquityUsdt: 100, closedAt: now - 8 * 60 * 60_000 },
    ],
    recentSimulation: [],
  });
  assert.equal(result.passed, true);
});

test("unattributed recent live close fails closed until pnl is known", () => {
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [{ realizedPnlUsdt: null, entryEquityUsdt: 100, closedAt: now - 5 * 60_000 }],
    recentSimulation: [],
  });
  assert.equal(result.passed, false);
  assert.match(result.reason ?? "", /盈亏尚未完成归因/);
});

test("10 percent live strategy drawdown blocks entry without using raw Gate balance", () => {
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [
      // The real Gate equity snapshot at entry was 100U. A 10.5U realized loss
      // is therefore a 10.5% strategy drawdown. No current Gate balance enters
      // this calculation, so a later futures/spot transfer cannot manufacture it.
      { realizedPnlUsdt: -10.5, entryEquityUsdt: 100, closedAt: now - 7 * 60 * 60_000 },
    ],
    recentSimulation: [],
  });
  assert.equal(result.passed, false);
  assert.ok(result.liveStrategyDrawdownPct >= 10);
  assert.match(result.reason ?? "", /交易回撤/);
  assert.match(result.reason ?? "", /转入\/转出不计入/);
});

test("profit recovery removes current strategy drawdown lock", () => {
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [
      { realizedPnlUsdt: 12, entryEquityUsdt: 100, closedAt: now - 7 * 60 * 60_000 },
      { realizedPnlUsdt: -10, entryEquityUsdt: 100, closedAt: now - 8 * 60 * 60_000 },
    ],
    recentSimulation: [],
  });
  assert.equal(result.passed, true);
  assert.ok(result.liveStrategyDrawdownPct < 10);
});

test("three consecutive simulation losses block live entry without stopping simulation", () => {
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [],
    recentSimulation: [
      { netMovePct: -0.7, exitAt: now - 1_000 },
      { netMovePct: -0.4, exitAt: now - 2_000 },
      { netMovePct: -0.2, exitAt: now - 3_000 },
      { netMovePct: 1.1, exitAt: now - 4_000 },
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.simulationLossStreak, 3);
  assert.match(result.reason ?? "", /连续 3 笔亏损/);
});

test("rolling simulation window blocks materially weak performance after enough samples", () => {
  const values = [-0.8, 0.2, -0.5, 0.3, -0.4, -0.2, 0.1, -0.1];
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [],
    recentSimulation: values.map((netMovePct, index) => ({ netMovePct, exitAt: now - index * 1_000 })),
  });
  assert.equal(result.passed, false);
  assert.equal(result.simulationSampleCount, 8);
  assert.equal(result.simulationWinRate, 3 / 8);
  assert.ok(result.simulationNetPct < 0);
});

test("full eight-trade window blocks negative expectancy even at 50 percent win rate", () => {
  const values = [0.5, 0.4, 0.3, 0.2, -1.5, -1.4, -1.6, -1.675];
  const result = evaluateLivePerformanceGate({
    now,
    recentLive: [],
    recentSimulation: values.map((netMovePct, index) => ({ netMovePct, exitAt: now - index * 1_000 })),
  });
  assert.equal(result.passed, false);
  assert.equal(result.simulationSampleCount, 8);
  assert.equal(result.simulationWinRate, 0.5);
  assert.equal(result.simulationNetPct, -4.775);
  assert.ok((result.simulationExpectancyPct ?? 0) < 0);
  assert.ok((result.simulationProfitFactor ?? 99) < 1);
  assert.match(result.reason ?? "", /负期望/);
});

test("small samples or recovered recent performance do not over-block live entry", () => {
  const small = evaluateLivePerformanceGate({
    now,
    recentLive: [],
    recentSimulation: [
      { netMovePct: -0.4, exitAt: now - 1_000 },
      { netMovePct: 0.6, exitAt: now - 2_000 },
    ],
  });
  assert.equal(small.passed, true);

  const recovered = evaluateLivePerformanceGate({
    now,
    recentLive: [],
    recentSimulation: [0.5, 0.4, -0.2, 0.3, -0.1, 0.2, -0.15, 0.1]
      .map((netMovePct, index) => ({ netMovePct, exitAt: now - index * 1_000 })),
  });
  assert.equal(recovered.passed, true);
  assert.ok((recovered.simulationWinRate ?? 0) >= 0.4);
  assert.ok((recovered.simulationProfitFactor ?? 0) > 1);
});
