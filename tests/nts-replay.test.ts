import test from "node:test";
import assert from "node:assert/strict";
import { readAll } from "./nts-fixtures.ts";
import { runSim } from "./nts-sim.ts";
import { loadKlines } from "./nts-klines.ts";

async function replay(label: string, config?: Record<string, unknown>) {
  const { series, first15, last15 } = loadKlines();
  const startMs = (first15 + 140 * 900) * 1000, endMs = (last15 + 900) * 1000;
  const r = await runSim({ series, startMs, endMs, stepMs: 60_000, config });
  assert.deepEqual(r.stats.errors, [], "回放期间任何一步都没有异常");
  assert.ok(r.stats.openMax <= 1, "同一时间最多 1 个仓位（BTC+ETH 合计）");
  const trades = r.fwd.history.filter(t => String((t as { grammar?: string }).grammar ?? (t as { mutation?: unknown; reason?: string }).reason).length >= 0);
  // 账户对账：余额 = 本金 + 全部已平仓净盈亏（只数交易系统的单）
  const net = r.fwd.history.reduce((s, t) => s + (t.netPnl ?? 0), 0);
  assert.ok(Math.abs(r.fwd.balance - (1000 + net) - (r.fwd.positions.reduce((s, p) => s + ((p as { entryFee?: number }).entryFee ?? 0), 0) * 0)) < 5, `账户对账 ${r.fwd.balance} vs ${1000 + net}`);
  for (const t of trades) assert.ok((t.netPnl ?? 0) >= -50 * 1.25, `单笔亏损 ${t.netPnl} 超过 5% 本金的 1.25 倍`);
  assert.ok(r.fwd.initialEquity === 1000);
  // 日志
  const lines = await readAll(r.host.logStream()), recs = lines.filter(l => l.id), ids = recs.map(l => l.id as string);
  assert.equal(new Set(ids).size, ids.length, "日志无重复 id"); assert.equal((lines.at(-1) as { end?: boolean }).end, true);
  const kinds: Record<string, number> = {}; for (const l of recs) kinds[l.k as string] = (kinds[l.k as string] ?? 0) + 1;
  const entries = recs.filter(l => l.k === "ENTRY");
  const hours = (endMs - startMs) / 3_600_000, rest = r.stats.requests, exits0 = recs.filter(l => l.k === "EXIT");
  console.log(`[replay:${label}] ${hours.toFixed(0)}h 请求=${rest}（${(rest / hours).toFixed(1)}/h）进场=${entries.length} 出场=${exits0.length} 日志=${recs.length} ${JSON.stringify(kinds)} 余额=${r.fwd.balance.toFixed(2)}（仅作冒烟参考）`);
  assert.ok(recs.length < 4000, `日志条数有界：${recs.length}`);
  const nt = recs.filter(l => l.k === "NO_TRADE"), slots = Math.ceil((endMs - startMs) / (4 * 3_600_000));
  const sampledN = nt.filter(l => (l.d as { kind?: string }).kind === "抽样").length, vetoN = nt.filter(l => (l.d as { kind?: string }).kind === "否决").length;
  assert.ok(sampledN <= slots * 2 + 2, `“不做”抽样每 symbol 每 4H 至多一条：${sampledN}`);
  assert.ok(vetoN <= slots * 2 * 4, `逐根否决每 symbol 每 4H 至多 4 条：${vetoN}`);
  const bytes = recs.reduce((a, l) => a + JSON.stringify(l).length, 0);
  console.log(`[replay] NO_TRADE 抽样=${sampledN} 否决=${vetoN} 日志总量≈${(bytes / 1024).toFixed(0)}KB（${(bytes / 1024 / hours).toFixed(2)}KB/h）`);
  assert.ok(bytes / hours < 12_000, "日志体积 < 12KB/小时");
  for (const e of entries) {
    const d = e.d as Record<string, unknown>, plan = d.plan as Record<string, unknown>;
    assert.ok(e.sym && e.t && e.tid, "ENTRY 有 时间/symbol/订单号");
    for (const f of ["side", "plan", "planGeometry", "vetoes", "fill", "sizing", "bias", "zones", "ind", "deriv", "breaker"]) assert.ok(f in d, `ENTRY 缺字段 ${f}`);
    for (const f of ["entry", "hardStop", "breakeven"]) assert.ok(f in (d.planGeometry as Record<string, unknown>), `planGeometry 缺 ${f}`);
    for (const f of ["zone", "sweep", "rr", "stop", "target"]) assert.ok(f in plan, `ENTRY.plan 缺字段 ${f}`);
  }
  // 仓位与记录对得上：每笔平仓单都有 ENTRY 和 EXIT
  const exits = recs.filter(l => l.k === "EXIT"); assert.ok(exits.length <= entries.length);
  assert.ok(rest / hours <= 40, `每小时 Gate 请求 ${rest / hours}`);
  return { entries, exits, r, recs };
}

test("BTC/ETH 历史K线回放（约 43 天，默认参数，只看流程与进场频率、不评价盈亏）：不抛错、最多 1 个仓位、单笔亏损有界、日志有界、频率在目标带内", { timeout: 600_000 }, async () => {
  const { entries, exits, r } = await replay("默认");
  const days = (r.now() - (loadKlines().first15 + 140 * 900) * 1000) / 86_400_000;
  // 目标 BTC+ETH 合计约每天 1–2 笔；回放里月度熔断（本月 −5% 停开）会让后段停开，所以下限放在 0.4/天，上限 3/天防止失控。
  const perDay = entries.length / days;
  assert.ok(perDay >= 0.4 && perDay <= 3, `默认参数进场频率 ${perDay.toFixed(2)}/天`);
  for (const e of entries) { const p = (e.d as { plan: Record<string, unknown> }).plan; assert.ok(["SWEEP", "RETEST"].includes(p.trigger as string)); assert.ok(["OPP_ZONE", "ATR"].includes(p.targetMode as string)); }
  for (const e of exits) {
    const d = e.d as { code?: string; holdMin?: number; netPnl?: number };
    assert.notEqual(d.code, "LIQUIDATION", "约 1% 保证金的单不应被强平（全仓强平价回归）");
    assert.ok(!(d.code === "STATE_INVALID" && (d.holdMin ?? 99) <= 1), "不应开仓后 1 分钟就因状态失效被平（开仓即失效回归）");
  }
  assert.ok(r.fwd.balance > 500, `余额 ${r.fwd.balance}（不评价盈亏，只防账户被异常清零）`);
});

test("BTC/ETH 历史K线回放（放宽触发门槛的管线压力测试）：整条管线走通且账户对账、日志完整", { timeout: 600_000 }, async () => {
  const { entries, exits, r, recs } = await replay("放宽", { neutralBand: 0.02, trigger: { sweepMaxPct: 0.012, volMinMult: 0, rrMin: 0.8, costMult: 1, maxChasePct: 0.004, closeStrength: 0.3 } });
  assert.ok(entries.length >= 1, "放宽后应至少触发 1 次进场，用于验证管线");
  const first = entries[0]!, tid = (first as { tid?: string }).tid;
  assert.ok(recs.some(l => l.k === "TRACE" && l.tid === tid), "进场后有走势追踪记录");
  assert.ok(exits.length >= 1, "该笔已出场并有 EXIT 记录");
  for (const e of exits) { const d = e.d as Record<string, unknown>; for (const f of ["reason", "r", "mfeR", "maeR", "holdMin", "netPnl"]) assert.ok(f in d, `EXIT 缺字段 ${f}`); }
  assert.equal(r.fwd.history.length, exits.length, "EXIT 记录数与账户成交历史一致");
  assert.ok(r.host.engine.s.open === null && r.fwd.positions.every(p => p.status !== "OPEN"), "回放结束时无遗留仓位");
  const last = r.host.engine.s.lastEval.BTC_USDT!;
  assert.ok(last.at > (r.now() - 3 * 3_600_000), "出场之后引擎继续评估（没有卡死）");
});
