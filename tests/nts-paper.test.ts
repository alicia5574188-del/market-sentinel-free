import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, crossLiquidation, tradeLiquidationPrice, type ForwardState } from "../lib/forward-relations.ts";
import { DEFAULT_NTS_CONFIG as C } from "../lib/nts/config.ts";
import { isNtsTrade } from "../lib/nts/engine.ts";
import { CONTRACT, openScenario, quote } from "./nts-fixtures.ts";

const kinds = (eng: ReturnType<typeof openScenario>["eng"]) => Object.values(eng.log.take()).flatMap(c => c.recs.map(r => r.k));

test("纸面开仓：首仓约 2% 本金做保证金、100 倍、不可转实盘；开仓费进账户；写一条完整 ENTRY 日志", () => {
  const f = openScenario(), before = f.fwd.balance;
  assert.equal(f.eng.execute(f.fwd, [f.action], f.c), true);
  const t = f.fwd.positions[0]!;
  assert.ok(isNtsTrade(t)); assert.equal(t.liveEligible, false); assert.equal(t.leverage, C.leverage); assert.equal(t.side, "LONG");
  assert.ok(t.margin <= before * C.firstMarginPct * 1.001 && t.margin > before * 0.01, `margin ${t.margin}`);
  assert.ok(Math.abs(before - f.fwd.balance - t.entryFee) < 1e-9, "余额只扣了开仓费");
  assert.ok(Math.abs(t.entryFee - t.notional * 0.0007) < 1e-9);
  assert.ok(t.stopPrice < t.entryPrice);
  assert.ok(t.liquidationPrice! < t.stopPrice, "强平价在止损之外（止损先到）");
  const recs = Object.values(f.eng.log.take()).flatMap(c => c.recs), e = recs.find(r => r.k === "ENTRY")!;
  assert.ok(e && e.tid === t.id);
  for (const key of ["side", "plan", "fill", "sizing", "vetoes", "fixture"]) assert.ok(key in e.d, `ENTRY 缺 ${key}`);
});
test("同一时刻只持一笔：已有持仓时再开会失败，且不留半截状态", () => {
  const f = openScenario(); f.eng.execute(f.fwd, [f.action], f.c);
  const bal = f.fwd.balance, again = { ...f.action, barTime: f.barTime + 900 };
  assert.equal(f.eng.execute(f.fwd, [again], f.c), false);
  assert.equal(f.fwd.positions.length, 1); assert.equal(f.fwd.balance, bal);
});
test("行情不新鲜 / 没有合约规格 → 不下单，写一条否决日志", () => {
  const f = openScenario(); const stale = { ...f.c, quotes: { BTC_USDT: { ...f.q, fresh: false, observedAt: f.now - 60_000 } } };
  assert.equal(f.eng.execute(f.fwd, [f.action], stale), false); assert.equal(f.fwd.positions.length, 0);
  const g = openScenario(); assert.equal(g.eng.execute(g.fwd, [g.action], { ...g.c, contracts: {} }), false);
  assert.ok(kinds(g.eng).includes("NO_TRADE"));
});
test("补仓：+3% 本金保证金，均价、总保证金更新；硬止损仍在订单块外侧（不跟均价移动）；保本价按新均价重算", () => {
  const f = openScenario(); f.eng.execute(f.fwd, [f.action], f.c);
  const t = f.fwd.positions[0]!, m1 = t.margin, e1 = t.entryPrice, add = { type: "ADD" as const, check: { ok: true, price: e1 * 0.995, reason: "到区 50% 位且结构未破" }, barTime: f.barTime + 900 };
  const q2 = quote(e1 * 0.995, e1 * 0.9952, f.now + 3_600_000), c2 = { ...f.c, now: f.now + 3_600_000, quotes: { BTC_USDT: q2 } };
  assert.equal(f.eng.execute(f.fwd, [add], c2), true);
  assert.ok(t.margin > m1 + f.fwd.initialEquity * 0.02 && t.margin < m1 + f.fwd.initialEquity * C.addMarginPct * 1.01);
  assert.ok(t.entryPrice < e1 && t.entryPrice > q2.bestAsk, "均价介于两次成交价之间");
  const o = f.eng.s.open!;
  assert.ok(o.addedAt != null && o.geo.hardStop === f.dec.plan.stop, "硬止损 = 计划止损（订单块下沿 − ATR 缓冲）");
  assert.ok(o.geo.hardStop < o.zone!.lo, "止损在区外");
  assert.ok(Math.abs(o.geo.breakeven - o.avg * (1 + C.breakevenPct)) < 1e-9, "保本价 = 新均价 +0.20%");
  assert.ok(Math.abs(t.stopPrice - o.geo.hardStop) / t.stopPrice < 0.0006, "账户里的止损价与硬止损一致");
  assert.ok(kinds(f.eng).includes("ADD"));
});
test("平仓：余额 = 起始 + 净盈亏（含两边手续费、滑点），历史里有这一笔，EXIT 日志含 R 与 MFE/MAE", () => {
  const f = openScenario(); f.eng.execute(f.fwd, [f.action], f.c);
  const t = f.fwd.positions[0]!, up = quote(t.entryPrice * 1.004, t.entryPrice * 1.0041, f.now + 600_000);
  assert.equal(f.eng.execute(f.fwd, [{ type: "CLOSE", code: "TARGET", reason: "到目标", stage: "未补仓" }], { ...f.c, now: up.observedAt, quotes: { BTC_USDT: up } }), true);
  assert.equal(f.fwd.positions.length, 0);
  const h = f.fwd.history.find(x => x.id === t.id)!;
  assert.ok(h && h.netPnl != null && h.exitFee > 0 && h.entryFee > 0);
  assert.ok(Math.abs(f.fwd.balance - (1000 + h.netPnl!)) < 1e-6, `balance ${f.fwd.balance} vs ${1000 + h.netPnl!}`);
  assert.equal(f.eng.s.open, null); assert.equal(f.eng.s.month.trades, 1); assert.equal(f.eng.s.lastExit?.code, "TARGET");
  const ex = Object.values(f.eng.log.take()).flatMap(c => c.recs).find(r => r.k === "EXIT")!;
  for (const key of ["r", "netPnl", "mfeR", "maeR", "reason", "holdMin", "balanceAfter"]) assert.ok(key in ex.d, `EXIT 缺 ${key}`);
  // 重复收尾不会重复计数、不重复写
  assert.equal(f.eng.reconcile(f.fwd, { BTC_USDT: up }, up.observedAt + 1000), false);
  assert.equal(f.eng.s.month.trades, 1);
});
test("硬止损：价格打到账户里的止损价 → 账户引擎按 STRUCTURE_STOP 平，reconcile 补记 HARD_STOP，亏损不超过 1R", () => {
  const f = openScenario(); f.eng.execute(f.fwd, [f.action], f.c);
  const t = f.fwd.positions[0]!, stop = t.stopPrice, oneR = f.eng.s.open!.oneR;
  const crash = quote(stop * 0.9995, stop * 0.9997, f.now + 120_000);
  const res = advanceForward({ state: f.fwd, now: crash.observedAt, quotes: { BTC_USDT: crash }, contracts: { BTC_USDT: CONTRACT } });
  const after: ForwardState = res.state, h = after.history.find(x => x.id === t.id)!;
  assert.ok(h, "已平仓进历史"); assert.match(h.exitReason ?? "", /STOP/);
  assert.ok(f.eng.reconcile(after, { BTC_USDT: crash }, crash.observedAt));
  assert.equal(f.eng.s.lastExit?.code, "HARD_STOP");
  assert.ok(h.netPnl! < 0 && -h.netPnl! <= oneR * 1.15, `loss ${h.netPnl} vs 1R ${oneR}`);
});
test("强平（跳空穿过止损和强平价）：按 LIQUIDATION 记账；账户不会为负", () => {
  const f = openScenario(); f.eng.execute(f.fwd, [f.action], f.c);
  const t = f.fwd.positions[0]!, gap = quote(t.entryPrice * 0.9, t.entryPrice * 0.9001, f.now + 120_000);
  const after = advanceForward({ state: f.fwd, now: gap.observedAt, quotes: { BTC_USDT: gap }, contracts: { BTC_USDT: CONTRACT } }).state;
  const h = after.history.find(x => x.id === t.id)!;
  assert.ok(h); assert.ok(after.balance >= 0);
  assert.ok(f.eng.reconcile(after, { BTC_USDT: gap }, gap.observedAt));
  assert.ok(["LIQUIDATION", "HARD_STOP"].includes(f.eng.s.lastExit!.code));
});
test("全仓：钱包覆盖名义价值时没有价格强平价；不能回退成 100x 逐仓公式（回归：半仓单跌 0.7% 被按整个钱包记爆仓）", () => {
  const cl = crossLiquidation("LONG", 76582, 0.0081, 998, 0.003);
  assert.equal(cl.price, null);
  const f = openScenario(); f.eng.execute(f.fwd, [f.action], f.c);
  const t = f.fwd.positions[0]!; t.liquidationPrice = null; t.crossLiquidationLoss = cl.loss; t.stopPrice = t.entryPrice * 0.988; // 回放里那笔：止损 1.12%，逐仓强平 ≈0.7%
  assert.equal(tradeLiquidationPrice(t), null);
  const dip = quote(t.entryPrice * 0.991, t.entryPrice * 0.9911, f.now + 120_000);
  assert.ok(dip.bestBid > t.stopPrice, "下跌在止损之内");
  const after = advanceForward({ state: f.fwd, now: dip.observedAt, quotes: { BTC_USDT: dip }, contracts: { BTC_USDT: CONTRACT } }).state;
  assert.ok(!after.history.some(x => x.id === t.id && x.exitReason === "LIQUIDATION"), "不应强平");
  assert.ok(after.balance > 900);
});
test("模拟账户本金保持 1000U，不被新系统重置或改写", () => {
  const f = openScenario(); assert.equal(f.fwd.balance, 1000); assert.equal(f.fwd.initialEquity, 1000);
  f.eng.execute(f.fwd, [f.action], f.c); assert.equal(f.fwd.initialEquity, 1000); assert.equal(f.fwd.accountResets?.length ?? 0, f.fwd.accountResets?.length ?? 0);
});
