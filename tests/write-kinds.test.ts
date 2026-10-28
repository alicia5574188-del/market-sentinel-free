import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {noteWriteKinds,writeKeyBreakdown,writeKindOfKey,writeKindsView,WRITE_KINDS_VERSION} from "../lib/write-kinds.ts";
import {FORWARD_STORAGE,FORWARD_PROTECTION_STORAGE,FORWARD_SAMPLE_MANIFEST_STORAGE,FORWARD_SAMPLE_PAGE_PREFIX,FORWARD_SAMPLE_RECOVERY_PREFIX} from "../lib/forward-store.ts";
import {TRADE_PATH_INDEX_KEY,TRADE_PATH_PAGE_PREFIX} from "../lib/trade-path.ts";
import {ORDER_JOURNAL_KEY} from "../lib/order-journal.ts";
import {LIVE_PARITY_PREFIX} from "../lib/live-parity.ts";

const T0=Date.parse("2026-10-22T12:00:00Z");

test("storage keys are classified with the storage modules' own prefixes",()=>{
  assert.equal(writeKindOfKey(`${FORWARD_STORAGE}head`),"forward-head");
  assert.equal(writeKindOfKey(`${FORWARD_STORAGE}chunk:3`),"forward-chunk");
  assert.equal(writeKindOfKey(`${FORWARD_STORAGE}archive:0000001761134400000:12`),"forward-archive");
  assert.equal(writeKindOfKey(FORWARD_PROTECTION_STORAGE),"forward-protection");
  assert.equal(writeKindOfKey(FORWARD_SAMPLE_MANIFEST_STORAGE),"forward-samples");
  assert.equal(writeKindOfKey(`${FORWARD_SAMPLE_PAGE_PREFIX}x`),"forward-samples");
  assert.equal(writeKindOfKey(`${FORWARD_SAMPLE_RECOVERY_PREFIX}x`),"forward-samples");
  assert.equal(writeKindOfKey(TRADE_PATH_INDEX_KEY),"trade-path");
  assert.equal(writeKindOfKey(`${TRADE_PATH_PAGE_PREFIX}7`),"trade-path");
  assert.equal(writeKindOfKey(ORDER_JOURNAL_KEY),"order-journal");
  assert.equal(writeKindOfKey(`${LIVE_PARITY_PREFIX}binding:a`),"live-parity");
  assert.equal(writeKindOfKey("log:eqmin:2026-10-22"),"log");
  assert.deepEqual(writeKeyBreakdown([`${FORWARD_STORAGE}head`,`${FORWARD_STORAGE}chunk:0`,`${FORWARD_STORAGE}chunk:1`]),{"forward-head":1,"forward-chunk":2});
});

test("committed rows accumulate by kind; a short breakdown charges the rest to unclassified",()=>{
  let book=noteWriteKinds(null,T0,"checkpoint",1);
  book=noteWriteKinds(book,T0+1,{"forward-head":1,"forward-chunk":2},5);
  book=noteWriteKinds(book,T0+2,{checkpoint:1,"live-journal":0},1);
  assert.equal(book.version,WRITE_KINDS_VERSION);
  assert.equal(book.total,7);
  assert.deepEqual(book.counts,{checkpoint:2,"forward-head":1,"forward-chunk":2,"unclassified":2});
  // Never more than the committed rows, and invalid counts are ignored.
  book=noteWriteKinds(book,T0+3,{a:9},2);book=noteWriteKinds(book,T0+3,"x",0);
  assert.equal(book.total,9);assert.equal(book.counts.a,2);assert.equal(book.counts.x,undefined);
});

test("the UTC day rolls the book and keeps yesterday; the view sorts and reports a rate",()=>{
  let book=noteWriteKinds(null,T0,"checkpoint",4);
  book=noteWriteKinds(book,T0,"trade-path",6);
  const next=T0+13*3_600_000; // 2026-10-23 01:00Z
  book=noteWriteKinds(book,next,"checkpoint",1);
  assert.equal(book.day,"2026-10-23");assert.equal(book.total,1);
  assert.deepEqual(book.previous,{day:"2026-10-22",total:10,counts:{checkpoint:4,"trade-path":6}});
  const view=writeKindsView(book,next+3_600_000);
  assert.equal(view.total,1);assert.equal(view.perHour,1);
  assert.deepEqual(Object.keys(view.previous!.counts),["trade-path","checkpoint"]);
  // A stale book (no write yet today) shows zero today and its day as previous.
  const stale=writeKindsView(noteWriteKinds(null,T0,"a",3),next);
  assert.equal(stale.total,0);assert.equal(stale.previous?.total,3);
  assert.equal(writeKindsView(undefined,T0).total,0);
});

test("the worker only measures: every reservation is tagged and counting happens after commit",()=>{
  const src=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8")+readFileSync(new URL("../worker/member-executor.ts",import.meta.url),"utf8");
  const calls=src.match(/this\.reserve(?:NonAlarm|Critical)Writes\([^;]*?\)(?=[;:)])/g)??[];
  assert.ok(calls.length>=15,`found ${calls.length}`);
  for(const call of calls)assert.match(call,/,\s*("[a-z-]+"|writeKeyBreakdown\(|\{)/,call);
  assert.equal((src.match(/this\.noteWriteKind\(tag,writes\)/g)??[]).length,2);
  assert.match(src,/if\(committed\)\{this\.runtime\.nonAlarmWrites\+=writes;this\.noteWriteKind\(tag,writes\);\}/);
  assert.match(src,/if\(committed\)\{this\.runtime\.criticalWrites\+=writes;this\.noteWriteKind\(tag,writes\);\}/);
  // No new storage put for the counter: it rides the existing checkpoint.
  assert.doesNotMatch(src,/storage\.put\([^)]*writeKinds/);
  assert.match(src,/writesByKind:writeKindsView\(this\.runtime\.writeKinds,Date\.now\(\)\)/);
});
