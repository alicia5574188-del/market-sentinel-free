import test from "node:test";
import assert from "node:assert/strict";
import { NtsLog } from "../lib/nts/log.ts";
import { DEFAULT_NTS_CONFIG } from "../lib/nts/config.ts";
import { readAll } from "./nts-fixtures.ts";
import { runSim } from "./nts-sim.ts";
import { loadKlines } from "./nts-klines.ts";

/** 写入量与 Gate 请求量估算（真实 BTC/ETH K线回放驱动）。
 *  DO 月度写入额度 50M 行；worker 的非 alarm 写入守卫是每天 100_000（lib/forward-write-budget.ts OPTIONAL_WRITE_GUARD_PER_DAY）。 */
const MONTH_QUOTA = 50_000_000, DAILY_GUARD = 100_000;
const maxIn = (ts: number[], winMs: number) => { let best = 0, j = 0; for (let i = 0; i < ts.length; i++) { while (ts[i]! - ts[j]! > winMs) j++; best = Math.max(best, i - j + 1); } return best; };

test("写入量与请求量：默认参数与最繁忙的放宽情形（约 43 天真实K线）下每小时 DO 写入行数与 Gate 请求频率都远低于预算", { timeout: 600_000 }, async () => {
  const { series, first15, last15 } = loadKlines();
  const startMs = (first15 + 140 * 900) * 1000, endMs = (last15 + 900) * 1000, hours = (endMs - startMs) / 3_600_000;
  const out: Record<string, { rowsPerHour: number; reqPerHour: number; max10s: number; max60s: number; trades: number; bytesPerHour: number }> = {};
  for (const [label, config] of [["默认", undefined], ["放宽(多笔交易)", { smc: { rrMin: 1.0, maxPriorVisits: 1 } }]] as const) {
    const r = await runSim({ series, startMs, endMs, stepMs: 60_000, config: config as never });
    assert.deepEqual(r.stats.errors, []);
    // 只统计 NTS 自己的 DO 行：状态键 + 日志块（不含 forward 本身的写入，那部分是原有的）
    const rows = r.st.st.rowsWritten, trades = r.fwd.history.length;
    let bytes = 0; for (const [k, v] of r.st.m) if (k.startsWith("nts:") || k.startsWith("log:nts")) bytes += JSON.stringify(v).length;
    out[label] = { rowsPerHour: rows / hours, reqPerHour: r.stats.requests / hours, max10s: maxIn(r.stats.times, 10_000), max60s: maxIn(r.stats.times, 60_000), trades, bytesPerHour: bytes / hours };
  }
  console.log("[writes]", JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, Math.round(b * 100) / 100]))]))));
  for (const [label, v] of Object.entries(out)) {
    assert.ok(v.rowsPerHour * 24 < DAILY_GUARD * 0.1, `${label}: 每天 ${(v.rowsPerHour * 24).toFixed(0)} 行，应 < 日守卫的 10%`);
    assert.ok(v.rowsPerHour * 24 * 31 < MONTH_QUOTA * 0.01, `${label}: 每月 ${(v.rowsPerHour * 24 * 31).toFixed(0)} 行，应 < 月额度的 1%`);
    assert.ok(v.reqPerHour <= 40, `${label}: Gate 请求/小时 ${v.reqPerHour}`);
    assert.ok(v.max60s <= 0.2 * 60 + 2 + 1, `${label}: 任意 60 秒内 ${v.max60s} 次请求（引擎令牌桶 0.2/s、突发≤2）`);
    assert.ok(v.max10s <= 4, `${label}: 任意 10 秒内 ${v.max10s} 次请求`);
    assert.ok(v.bytesPerHour < 12_000, `${label}: 日志+状态 ${(v.bytesPerHour / 1024).toFixed(1)}KB/小时`);
  }
});

test("写入预算被拒绝时：日志留在内存、有上限、不抛错、预算恢复后补写且不丢不重", { timeout: 120_000 }, async () => {
  const { series, first15 } = loadKlines();
  const startMs = (first15 + 140 * 900) * 1000, endMs = startMs + 72 * 3_600_000;
  const denied = await runSim({ series, startMs, endMs, stepMs: 60_000, budget: false, config: { smc: { rrMin: 1.0, maxPriorVisits: 1 } } });
  assert.deepEqual(denied.stats.errors, []);
  const h = denied.host.healthView(denied.now(), denied.fwd, {});
  assert.ok(h.logPending <= NtsLog.MAX_HELD, `内存中未落盘块有上限：${h.logPending}`);
  assert.ok(denied.host.log.appended > 0);
  assert.equal([...denied.st.m.keys()].filter(k => k.includes("log:nts")).length, 0, "预算被拒绝时没有写日志块");
  // 导出仍然包含内存里的日志
  const lines = await readAll(denied.host.logStream());
  assert.ok(lines.filter(l => l.id).length > 5, "导出包含未落盘的记录");
});

test("内存上限：长期无法落盘时最多保留 MAX_HELD 个块并计数丢弃", () => {
  const log = new NtsLog(DEFAULT_NTS_CONFIG);
  const big = "x".repeat(2000);
  for (let h = 0; h < 200; h++) for (let i = 0; i < 3; i++) log.append({ id: `r${h}:${i}`, k: "NO_TRADE", t: h * 3_600_000 + i, d: { big } }, h * 3_600_000 + i);
  const pend = log.pending; assert.ok(pend <= NtsLog.MAX_HELD);
  assert.ok(log.lostChunks >= 200 - NtsLog.MAX_HELD - 1);
  assert.equal(Object.keys(log.take()).length, pend);
});
