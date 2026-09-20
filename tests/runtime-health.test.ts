import assert from "node:assert/strict";
import test from "node:test";
import { runtimeAuthorityOperational, runtimeBackendOperational, runtimeNotice, runtimeReady, runtimeStatusLabel,
  type RuntimeHealthShape } from "../lib/runtime-health.ts";

const symbols = Array.from({ length: 10 }, (_, index) => `S${index}`);
const live = (): RuntimeHealthShape => ({ state: "LIVE", stale: false, authorityReady: true, lastError: null,
  symbols, realtimeReadiness: { capacity: 10, actionableMarkets: 6, protectedMarketsReady: true } });

test("runtime readiness separates service health from current opportunity count", () => {
  assert.equal(runtimeReady(live()), true);
  assert.equal(runtimeReady(null), false);
  assert.equal(runtimeReady(live(), false), false);
  assert.equal(runtimeReady({ ...live(), state: "DEGRADED" }), true, "isolated market degradation is not an authority outage");
  for (const state of ["STARTING", "WARMING", "RECONNECTING", "RECOVERY_REQUIRED"]) assert.equal(runtimeReady({ ...live(), state }), false);
  assert.equal(runtimeReady({ ...live(), stale: true }), false);
  assert.equal(runtimeReady({ ...live(), authorityReady: false }), false);
  assert.equal(runtimeReady({ ...live(), lastError: "D1 mirror pending" }), true, "optional history mirroring is not a trading outage");
  assert.equal(runtimeReady({ ...live(), symbols: symbols.slice(0, 9) }), true, "pool fill is diagnostic, not service liveness");
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true } }), true,
    "having no entry-ready market right now is normal and must not report an outage");
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 10, actionableMarkets: 6, protectedMarketsReady: false } }), false);
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 3, actionableMarkets: 3, protectedMarketsReady: true } }), true);
});

test("operator status reserves recovery wording for genuine authority failure", () => {
  const waiting = { ...live(), state: "DEGRADED", lastError: "10 realtime markets warming; entries blocked",
    realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true } };
  assert.equal(runtimeAuthorityOperational(waiting), true);
  assert.equal(runtimeStatusLabel(waiting), "后台运行中");
  assert.match(runtimeNotice(waiting) ?? "", /后台持续运行/);
  assert.doesNotMatch(runtimeNotice(waiting) ?? "", /系统正在自动恢复/);

  const reconnecting = { ...live(), state: "RECONNECTING", lastError: "10 market snapshots unavailable; retrying" };
  assert.equal(runtimeAuthorityOperational(reconnecting), false);
  assert.equal(runtimeStatusLabel(reconnecting), "行情重连中");
  assert.match(runtimeNotice(reconnecting) ?? "", /系统正在自动恢复/);

  const warming = { ...live(), state: "WARMING", realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true } };
  assert.equal(runtimeAuthorityOperational(warming), true);
  assert.equal(runtimeStatusLabel(warming), "后台运行中 · 数据预热");

  const strategyWarming = { ...live(), strategyData: { stableMarkets: 0, lastCompletedCandleAt: 0, hourlyPathFailures: 0 } };
  assert.equal(runtimeAuthorityOperational(strategyWarming), true);
  assert.equal(runtimeStatusLabel(strategyWarming), "后台运行中 · 策略路径预热");
});

test("phone transport delay never changes the last known backend trading authority", () => {
  assert.equal(runtimeBackendOperational(live()), true);
  assert.equal(runtimeAuthorityOperational(live(), false), false, "the page may truthfully report delayed transport");
  assert.equal(runtimeBackendOperational(live()), true, "a read-only page delay cannot stop or describe backend order authority");
  assert.equal(runtimeBackendOperational({ ...live(), stale: true }), false);
  assert.equal(runtimeBackendOperational({ ...live(), state: "RECONNECTING" }), false);
});

const T = 1_789_901_000_000;
const forwardLive = (): RuntimeHealthShape => ({ ...live(), lastSuccessAt: T,
  forward: { mode: "REAL_FEED_PAPER", lastCycleAt: T - 5 * 60_000, storage: { persistedAt: T - 5 * 60_000, error: null } } });

test("healthy forward source needs no trade or opportunity to be ready", () => {
  const runtime = { ...forwardLive(), realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true },
    strategyData: { stableMarkets: 0, lastCompletedCandleAt: 0 } };
  assert.equal(runtimeReady(runtime), true);
  assert.equal(runtimeStatusLabel(runtime), "后台运行中", "retired strategy warmup must not override the active forward source");
  assert.equal(runtimeNotice(runtime), null);
  assert.equal(runtimeReady({ ...runtime, lastSuccessAt: T + 10 * 60_000 }), true, "three cycles of tolerance include scheduling delays");
});

test("forward storage failures cannot hide behind healthy market transport", () => {
  const runtime = forwardLive();
  runtime.forward!.storage!.error = "synthetic write failure";
  assert.equal(runtimeReady(runtime), false);
  assert.equal(runtimeBackendOperational(runtime), true, "health reporting must not alter backend authority");
  assert.equal(runtimeAuthorityOperational(runtime), true);
  assert.equal(runtimeStatusLabel(runtime), "后台运行中 · 策略存储异常");
  assert.match(runtimeNotice(runtime) ?? "", /synthetic write failure/);
  assert.doesNotMatch(runtimeNotice(runtime) ?? "", /行情重连|暂停新开仓/);
});

test("missing forward state, cycle and durable state are separate diagnostic failures", () => {
  const cases: Array<[RuntimeHealthShape["forward"], string]> = [
    [null, "策略状态未恢复"],
    [{ mode: "RECOVERY_REQUIRED", storage: { error: null } }, "策略状态未恢复"],
    [{}, "策略周期未启动"],
    [{ lastCycleAt: 0, storage: { persistedAt: T, error: null } }, "策略周期未启动"],
    [{ lastCycleAt: Number.NaN, storage: { persistedAt: T, error: null } }, "策略周期未启动"],
    [{ lastCycleAt: T }, "策略尚未持久化"],
    [{ lastCycleAt: T, storage: { persistedAt: 0, error: null } }, "策略尚未持久化"],
    [{ lastCycleAt: T, storage: { persistedAt: T - 1, error: null } }, "策略持久化落后"],
  ];
  for (const [forward, label] of cases) {
    const runtime = { ...live(), lastSuccessAt: T, forward };
    assert.equal(runtimeReady(runtime), false, label);
    assert.equal(runtimeStatusLabel(runtime), `后台运行中 · ${label}`);
    assert.ok(runtimeNotice(runtime), label);
    assert.equal(runtimeBackendOperational(runtime), true, label);
  }
});

test("cycle stalls use source or explicit time, never the executing machine clock", () => {
  const snapshot = forwardLive();
  assert.equal(runtimeReady(snapshot), true, "historical snapshots are replayable");
  const stopped = { ...snapshot, lastSuccessAt: T + 10 * 60_000 + 1 };
  assert.equal(runtimeReady(stopped), false);
  assert.equal(runtimeStatusLabel(stopped), "后台运行中 · 策略周期未推进");
  assert.match(runtimeNotice(stopped) ?? "", /超过15分钟/);
  assert.equal(runtimeReady(snapshot, true, T + 10 * 60_000 + 1), false);
  assert.equal(runtimeStatusLabel(snapshot, true, false, T + 10 * 60_000 + 1), "后台运行中 · 策略周期未推进");
  assert.match(runtimeNotice(snapshot, T + 10 * 60_000 + 1) ?? "", /超过15分钟/);
  assert.equal(runtimeReady({ ...snapshot, lastSuccessAt: undefined }), true, "missing reference time cannot prove a stalled cycle");
});

test("legacy and member projections retain their transport and authority contracts", () => {
  assert.equal(runtimeReady(live()), true, "old runtime without a forward field remains compatible");
  const member = { ...forwardLive(), realtimeReadiness: undefined };
  assert.equal(runtimeBackendOperational(member), true);
  assert.equal(runtimeAuthorityOperational(member), true);
  assert.equal(runtimeStatusLabel(member), "后台运行中");
  assert.equal(runtimeNotice(member), null);
  assert.equal(runtimeReady(member), false, "member projection does not claim primary protected-market readiness");
  const absent = { ...member, forward: null };
  assert.equal(runtimeStatusLabel(absent), "后台运行中 · 策略状态未恢复");
  assert.equal(runtimeBackendOperational(absent), true, "diagnostics never change member trading authority");
  assert.equal(runtimeStatusLabel(absent, false), "页面数据延迟", "transport status keeps its priority");
  assert.equal(runtimeStatusLabel(absent, true, true), "页面连接中断");
});
