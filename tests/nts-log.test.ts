import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NTS_CONFIG as C, normalizeNtsConfig } from "../lib/nts/config.ts";
import { NTS_LOG_PREFIX, NtsLog, chunkKey, logExportStream, type NtsRec } from "../lib/nts/log.ts";
import { memStorage, readAll } from "./nts-fixtures.ts";

const H = 3_600_000, T = 1_760_000_000_000;
const rec = (id: string, t = T, pad = 0): NtsRec => ({ id, k: "TRACE", t, sym: "BTC_USDT", d: { x: "y".repeat(pad) } });
async function flush(log: NtsLog, st: ReturnType<typeof memStorage>) { const out = log.take(); await st.put(out); return Object.keys(out); }

test("追加 + 按 id 去重 + 按小时分块；键名字典序等于时间序", () => {
  const log = new NtsLog(C);
  assert.equal(log.append(rec("a"), T), true); assert.equal(log.append(rec("a"), T), false); assert.equal(log.appended, 1); assert.equal(log.dropped, 1);
  log.append(rec("b", T + 2 * H), T + 2 * H); log.append(rec("c", T + H), T + H);
  const keys = Object.keys(log.take());
  assert.equal(keys.length, 3); assert.ok(keys.every(k => k.startsWith(NTS_LOG_PREFIX)));
  assert.ok(chunkKey(T, 0) < chunkKey(T + H, 0) && chunkKey(T + H, 0) < chunkKey(T + H, 1));
});
test("单块超过上限就另起一块（单个存储值不会无限变大）", () => {
  const cfg = normalizeNtsConfig({ ...C, log: { ...C.log, maxChunkBytes: 1000 } }), log = new NtsLog(cfg);
  for (let i = 0; i < 20; i++) log.append(rec("r" + i, T, 200), T);
  const chunks = log.take(); assert.ok(Object.keys(chunks).length >= 4);
  for (const c of Object.values(chunks)) assert.ok(JSON.stringify(c).length < 1000 + 400);
});
test("take 后落盘失败 → restore 把块放回待写；没有丢失", async () => {
  const st = memStorage(), log = new NtsLog(C); log.append(rec("a"), T); log.append(rec("b"), T);
  st.st.failPut = true; const out = log.take(), keys = Object.keys(out);
  await assert.rejects(st.put(out)); log.restore(keys);
  assert.equal(log.pending, 1);
  st.st.failPut = false; await flush(log, st);
  const lines = await readAll(logExportStream(st, async () => {}, { t: 1 }));
  assert.equal(lines.filter(l => l.id).length, 2);
});
test("重启后（新的 NtsLog 从存储 load）同一个 id 不会再写一遍，新记录接在尾块后", async () => {
  const st = memStorage(), a = new NtsLog(C); a.append(rec("e1"), T); a.append(rec("e2"), T); await flush(a, st);
  const b = new NtsLog(C); await b.load(st);
  assert.equal(b.append(rec("e1"), T + 1000), false, "重启后重复 id 被拒");
  assert.equal(b.append(rec("e3"), T + 1000), true); await flush(b, st);
  const lines = await readAll(logExportStream(st, async () => {}, { t: 1 })), ids = lines.filter(l => l.id).map(l => l.id);
  assert.deepEqual(ids, ["e1", "e2", "e3"]);
  assert.equal(st.m.size, 1, "同一小时内仍是同一块");
});
test("导出：流式（NDJSON）、含头尾、先 flush 未落盘记录；flush 失败也能导出已落盘部分", async () => {
  const st = memStorage(), log = new NtsLog(C);
  for (let i = 0; i < 30; i++) log.append(rec("r" + i, T + i * H), T + i * H);
  const lines = await readAll(logExportStream(st, async () => { await flush(log, st); }, { version: "x" }, 4));
  assert.deepEqual(lines[0], { meta: { version: "x" } }); assert.equal(lines.at(-1)!.end, true); assert.equal(lines.at(-1)!.records, 30);
  assert.equal(lines.filter(l => l.id).length, 30);
  const ts = lines.filter(l => l.id).map(l => l.t as number); assert.deepEqual(ts, [...ts].sort((x, y) => x - y));
  const st2 = memStorage(), log2 = new NtsLog(C); log2.append(rec("z"), T); await flush(log2, st2); log2.append(rec("late"), T);
  const l2 = await readAll(logExportStream(st2, async () => { throw new Error("budget"); }, {}));
  assert.equal(l2.filter(l => l.id).length, 1, "flush 失败不阻断导出");
});
test("导出是逐页拉取，不会一次把全部读进内存（分页大小生效）", async () => {
  const st = memStorage(); const calls: number[] = []; const orig = st.list.bind(st);
  st.list = (async (o: Parameters<typeof orig>[0]) => { calls.push(o.limit ?? -1); return orig(o); }) as typeof st.list;
  const log = new NtsLog(C); for (let i = 0; i < 25; i++) log.append(rec("r" + i, T + i * H), T + i * H); await flush(log, st);
  await readAll(logExportStream(st, async () => {}, {}, 5));
  assert.ok(calls.every(c => c === 5) && calls.length >= 6, JSON.stringify(calls));
});
