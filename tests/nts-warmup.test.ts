import test from "node:test";
import assert from "node:assert/strict";
import { NtsEngine, WARMUP_WAIT_MS } from "../lib/nts/engine.ts";
import { NtsLog } from "../lib/nts/log.ts";
import { DEFAULT_NTS_CONFIG } from "../lib/nts/config.ts";
import { initialForward } from "../lib/forward-relations.ts";
import { flat, T0, CONTRACT, quote } from "./nts-fixtures.ts";

const cfg = { ...DEFAULT_NTS_CONFIG, symbols: ["BTC_USDT"] };
const b15 = flat(300, 900);
const closeMs = (b15[b15.length - 1]!.time + 900) * 1000;
const tick = (e: NtsEngine, now: number) => e.tick({ now, forward: initialForward(now) as never, quotes: { BTC_USDT: quote(99.99, 100.01, now) }, contracts: { BTC_USDT: CONTRACT }, enabled: true });

test("重启冷启动：只有 15m 到了时不按“数据不足”决策，等其余K线/衍生品补齐后再决策这根", () => {
  const e = new NtsEngine(cfg, new NtsLog(cfg), null, closeMs);
  e.ingestCandles("BTC_USDT", "15m", b15, closeMs + 5_000);
  tick(e, closeMs + 10_000);
  assert.equal(e.s.recent.length, 0, "等待期间不写数据不足");
  assert.equal(e.s.decided.BTC_USDT, undefined);
  e.ingestCandles("BTC_USDT", "1h", flat(300, 3600), closeMs + 20_000);
  e.ingestCandles("BTC_USDT", "4h", flat(300, 14400), closeMs + 25_000);
  e.ingestCandles("BTC_USDT", "1d", flat(260, 86400), closeMs + 30_000);
  e.ingestTicker("BTC_USDT", { funding: 0.0001, oi: 1000, mark: 100, index: 100 }, closeMs + 35_000);
  tick(e, closeMs + 40_000);
  assert.equal(e.s.decided.BTC_USDT, b15[b15.length - 1]!.time);
  assert.ok(e.s.recent.length >= 1);
  assert.doesNotMatch(e.s.recent[0]!.text, /数据不足/);
});

test("数据一直补不齐：收盘 8 分钟后仍按“数据不足”记一条（不会永远静默）", () => {
  const e = new NtsEngine(cfg, new NtsLog(cfg), null, closeMs);
  e.ingestCandles("BTC_USDT", "15m", b15, closeMs + 5_000);
  tick(e, closeMs + WARMUP_WAIT_MS - 1000);
  assert.equal(e.s.recent.length, 0);
  tick(e, closeMs + WARMUP_WAIT_MS + 1000);
  assert.match(e.s.recent[0]!.text, /数据不足/);
});

test("冷启动取数顺序：先大周期/衍生品，15m 最后", () => {
  const e = new NtsEngine({ ...cfg, data: { ...cfg.data, restPerSec: 100 } }, new NtsLog(cfg), null, T0 * 1000);
  const kinds: string[] = []; let now = closeMs;
  for (let i = 0; i < 10; i++) { now += 21_000; const j = e.nextJob(now, true); if (j) { kinds.push(j.kind); if (j.kind === "ticker") e.ingestTicker(j.sym, { funding: 0, oi: 1, mark: 1, index: 1 }, now); else e.ingestCandles(j.sym, j.kind, j.kind === "15m" ? b15 : flat(300, j.kind === "1h" ? 3600 : j.kind === "4h" ? 14400 : 86400), now); } }
  // 两个币种（配置固定 BTC/ETH）：先 2 个衍生品，再 6 个大周期，最后 2 个 15m
  assert.deepEqual(kinds.slice(0, 2), ["ticker", "ticker"], kinds.join(","));
  assert.ok(kinds.slice(2, 8).every(k => k !== "15m" && k !== "ticker"), kinds.join(","));
  assert.deepEqual(kinds.slice(8), ["15m", "15m"], kinds.join(","));
});

test("最近决策每根 15m 都刷新：同类原因只保留一条、时间更新", () => {
  const e = new NtsEngine(cfg, new NtsLog(cfg), null, closeMs);
  for (const [tf, b] of [["1h", flat(300, 3600)], ["4h", flat(300, 14400)], ["1d", flat(260, 86400)]] as const) e.ingestCandles("BTC_USDT", tf, b, closeMs);
  e.ingestTicker("BTC_USDT", { funding: 0, oi: 1, mark: 100, index: 100 }, closeMs);
  let last = 0;
  for (let k = 0; k < 4; k++) {
    const bb = flat(300 + k, 900), at = (bb[bb.length - 1]!.time + 900) * 1000 + 5_000;
    e.ingestCandles("BTC_USDT", "15m", bb, at);
    e.ingestTicker("BTC_USDT", { funding: 0, oi: 1, mark: 100, index: 100 }, at);
    tick(e, at); last = at;
  }
  assert.equal(e.s.recent[0]!.at, last);
  assert.ok(e.s.recent.filter(x => x.sym === "BTC_USDT").length <= 2);
});
