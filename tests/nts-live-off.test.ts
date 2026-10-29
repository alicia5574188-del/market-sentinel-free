import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { initialForward } from "../lib/forward-relations.ts";
import { DEFAULT_NTS_CONFIG, normalizeNtsConfig } from "../lib/nts/config.ts";
import { NtsHost } from "../lib/nts/host.ts";
import { CONTRACT, memStorage, openScenario, quote } from "./nts-fixtures.ts";

const NTS_FILES = readdirSync("lib/nts").filter(f => f.endsWith(".ts"));
const BASE = "c6b8eb32";
const git = (...args: string[]) => { try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64e6 }); } catch { return null; } };

test("lib/nts 只依赖纸面账户/归档/自身：不引用任何实盘或 Gate 下单模块", () => {
  const allowed = /^(\.\/[a-z-]+\.ts|\.\.\/forward-relations\.ts|\.\.\/run-log-archive\.ts|\.\.\/living\/runlog-d1\.ts|node:[a-z]+)$/;
  for (const f of NTS_FILES) {
    const src = readFileSync(`lib/nts/${f}`, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g)) assert.match(m[1]!, allowed, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /gate-live|live-(?:session|turnover|exit|maker|leverage|entry)|arena-live|requestedEnabled|placeOrder|createOrder|\/futures\/usdt\/orders/i, `${f} 触及实盘`);
  }
});
test("配置：交易系统没有任何实盘开关；规范化后只允许 BTC/ETH、100x、纸面", () => {
  const raw = JSON.stringify(DEFAULT_NTS_CONFIG); assert.doesNotMatch(raw, /live/i);
  const c = normalizeNtsConfig({ symbols: ["BTC_USDT", "DOGE_USDT", "ETH_USDT"], leverage: 1000, firstMarginPct: 0.5, addMarginPct: 0.9, maxLossPct: 3, live: true } as never);
  assert.deepEqual([...c.symbols], ["BTC_USDT", "ETH_USDT"]); assert.ok(c.leverage <= 100); assert.ok(c.maxLossPct <= 0.05); assert.ok(c.firstMarginPct <= 0.05 && c.addMarginPct <= 0.05);
  assert.equal((c as unknown as Record<string, unknown>).live, undefined);
});
test("开出来的单一律是纸面：liveEligible=false、REAL_QUOTE_PAPER_MODEL；宿主依赖里没有实盘入口", async () => {
  const st = memStorage(); const r = { phase: "done", resetLogged: true, hotCleared: true, verified: true, startedAt: 1, passes: 0, copied: 0, deleted: 0, d1: {}, failures: 0, lastError: null, doneAt: 1, doBackupCursor: null, version: 1 };
  st.m.set("nts:reset:v1", r);
  const deps = { storage: st as never, db: () => null, candles: async () => [], ticker: async () => null, spend: () => false, reserve: () => ({ finish() {} }), resetMemory() {}, now: () => 1_760_000_000_000 };
  assert.deepEqual(Object.keys(deps).sort(), ["candles", "db", "now", "reserve", "resetMemory", "spend", "storage", "ticker"], "宿主依赖里没有任何下单/实盘函数");
  const host = new NtsHost(deps as never); await host.boot(1_760_000_000_000);
  const sc = openScenario(1_760_000_000_000); host.engine.tick = (() => [sc.action]) as never;
  const draft = host.before(1_760_000_000_000, initialForward(1_760_000_000_000), { BTC_USDT: sc.q }, { BTC_USDT: CONTRACT }); assert.ok(draft);
  for (const p of draft.positions) { assert.equal((p as { liveEligible: boolean }).liveEligible, false); assert.equal((p as { execution: string }).execution, "REAL_QUOTE_PAPER_MODEL"); }
  assert.equal(draft.liveEligible, false); assert.equal(draft.initialEquity, 1000);
  assert.equal(quote(1, 2, 3).fresh, true);
});
test("worker 路由：/api/nts/* 全部要登录；开关只收 POST 且必须同源；DO 内路由不对外", () => {
  const h = readFileSync("worker/http-handlers.ts", "utf8"), body = h.slice(h.indexOf("export async function ownerNts"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 3);
  assert.ok(fn.indexOf("ownerAuthenticated") > -1 && fn.indexOf("ownerAuthenticated") < fn.indexOf("MARKET_STREAM"), "先鉴权再碰 DO");
  assert.match(fn, /route === "toggle"[\s\S]*request\.method !== "POST"[\s\S]*sameOriginMutation/);
  assert.match(fn, /request\.method !== "GET"/);
  const w = readFileSync("worker/index-clean.ts", "utf8");
  for (const r of ["status", "log", "log-backup", "toggle"]) assert.match(w, new RegExp(`/api/nts/${r}"\\) return ownerNts\\(request, env, "${r}"\\)`));
  assert.ok(!/\/nts-(?:status|log|toggle)/.test(readFileSync("worker/http-handlers.ts", "utf8").replace(/stream\.fetch\([^)]*\)/g, "")), "只通过 DO stub 访问");
});
test("相对基线(c6b8eb32)：实盘/Gate 下单相关文件零改动，worker 新增行不碰实盘开关和 live 状态", { skip: git("rev-parse", "--verify", `${BASE}^{commit}`) == null }, () => {
  const names = (git("diff", "--name-only", BASE) ?? "").split("\n").filter(Boolean);
  const liveFiles = names.filter(n => /^lib\/(gate-live|gate-readonly|gate-market|gate-quantity|gate-stream|arena-live|entry-gate|live-[a-z-]+)\.ts$/.test(n));
  assert.deepEqual(liveFiles, [], "实盘相关文件不应被改动");
  const added = (git("diff", "-U0", BASE, "--", "worker/index-clean.ts", "worker/http-handlers.ts") ?? "").split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
  const bad = added.filter(l => /runtime\.live\b[^;]*=|requestedEnabled|liveOrder|placeOrder|ownerLiveMode|live\.requested/.test(l) && !/ntsHealth|nts/i.test(l));
  assert.deepEqual(bad, [], "worker 新增行触及实盘");
});

test("配置往返幂等：写回再读出（开关切换后重启）不会把数组变成对象，也不会放宽硬性上限", async () => {
  const { normalizeNtsConfig, DEFAULT_NTS_CONFIG } = await import("../lib/nts/config.ts");
  const once = normalizeNtsConfig({ enabled: false, log: { traceEveryMs: 300000 }, smc: { rrMin: 2, obTfs: ["4h", "1d"] }, leverage: 500, maxLossPct: 0.5, symbols: ["DOGE_USDT"] });
  const twice = normalizeNtsConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.ok(Array.isArray(twice.log.postExitMarksMin) && [...twice.log.postExitMarksMin].join() === "30,60,120");
  assert.equal(once.enabled, false); assert.equal(once.log.traceEveryMs, 300000); assert.equal(once.smc.rrMin, 2); assert.deepEqual(once.smc.obTfs, ["4h", "1d"]);
  assert.equal(once.leverage, 100); assert.equal(once.maxLossPct, 0.05); assert.deepEqual(once.symbols, DEFAULT_NTS_CONFIG.symbols);
  assert.deepEqual(normalizeNtsConfig({ log: { postExitMarksMin: [10, "x"] } }).log.postExitMarksMin, [30, 60, 120]);
});
