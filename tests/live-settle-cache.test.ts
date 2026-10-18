import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {type GatePositionClose,type SettlementPosition} from "../lib/live-settlement.ts";
import {LiveHistoryReader} from "../lib/live-history-reader.ts";
import {liveExitTag} from "../lib/gate-live.ts";
import {Memory} from "./member-fixtures.ts";

const T=1790000000000;
const position=(id="source-a",n=0):SettlementPosition=>({id,symbol:"BTC_USDT",side:"LONG",status:"CLOSED",entryAt:T+10000+n,exitAt:T+610000+n,
  entryPrice:100,exchangeSize:.1,parity:{sourceId:id,copiedAt:T,roundedContracts:.1}});
const native=(id="source-a"):GatePositionClose=>({contract:"BTC_USDT",side:"long",time:(T+605000)/1000,first_open_time:T/1000,
  pnl:"-0.07",pnl_pnl:"0.03",pnl_fee:"-0.1",pnl_fund:"0",text:liveExitTag(id),max_size:"0.1",accum_size:"0.1",long_price:"100",short_price:"103"});
function harness(storage=new Memory(),apiKey="fixture-only"){
  const client={credentials:{environment:"testnet",apiKey},count:0,async positionCloseHistory(){this.count++;return [native()];}};
  const tasks:Promise<void>[]=[];
  const input=(reader:LiveHistoryReader<SettlementPosition>,current:SettlementPosition[],now:number)=>({storage,client,current,now,valid:()=>true,reserve:()=>true,
    persist:async(entries:Record<string,unknown>)=>{await storage.transaction(async tx=>{await tx.put(entries);});},waitUntil:(t:Promise<void>)=>{tasks.push(t);}});
  return {storage,client,tasks,input};
}
const now=T+620000;

test("a settled record is persisted once and shown on the FIRST view after a restart, with no Gate call",async()=>{
  const h=harness(),p=position();
  await h.storage.put("live-parity:v1:closed:0000000000000001:source-a",{position:p});
  const first=new LiveHistoryReader<SettlementPosition>();
  await first.hydrate(h.input(first,[p],now));first.launch(h.input(first,[p],now));await Promise.all(h.tasks);
  assert.equal(h.client.count,1);assert.equal(first.view([p]).history[0].realizedPnl,-.07);
  // DO restart / new deploy: a brand-new reader. Before the fix the first view was "待结算" until a later refresh.
  const restarted=new LiveHistoryReader<SettlementPosition>();
  await restarted.hydrate(h.input(restarted,[p],now+3_600_000));
  const view=restarted.view([p]);
  assert.equal(view.history[0].realizedPnl,-.07);assert.equal(view.pending,0);
  assert.equal(h.client.count,1,"hydrate reads storage only");
  // The background refresh also leaves a settled record alone: Gate is not asked again.
  restarted.launch(h.input(restarted,[p],now+3_600_000));await Promise.all(h.tasks);
  assert.equal(h.client.count,1,"settled records are never re-settled");
});

test("runtime records are decorated only for the account whose cache is loaded",async()=>{
  const h=harness(),p=position();
  const r=new LiveHistoryReader<SettlementPosition>();
  r.launch(h.input(r,[p],now));await Promise.all(h.tasks);
  assert.equal((r.decorate([p],h.client)[0] as {realizedPnl?:number}).realizedPnl,-.07);
  assert.equal((r.decorate([p],null)[0] as {realizedPnl?:number}).realizedPnl,undefined);
  assert.equal((r.decorate([p],{...h.client,credentials:{environment:"testnet",apiKey:"other-account"}})[0] as {realizedPnl?:number}).realizedPnl,undefined);
});

test("another API key never sees the previous account's persisted settlements",async()=>{
  const h=harness(),p=position();
  const r=new LiveHistoryReader<SettlementPosition>();
  r.launch(h.input(r,[p],now));await Promise.all(h.tasks);
  const other=harness(h.storage,"other-account"),fresh=new LiveHistoryReader<SettlementPosition>();
  await fresh.hydrate(other.input(fresh,[p],now));
  assert.equal(fresh.view([p]).history[0].realizedPnl,undefined);
});

test("a damaged settlement cache is ignored by hydrate (no throw, no fake numbers)",async()=>{
  const h=harness(),p=position();
  const r=new LiveHistoryReader<SettlementPosition>();
  r.launch(h.input(r,[p],now));await Promise.all(h.tasks);
  const key=[...h.storage.data.keys()].find(k=>k.startsWith("live-history-settlement:v1:"))!;
  h.storage.data.set(key,{version:"gate-close-settlement-v1",values:{"source-a":{pnl:"bad"}}});
  const fresh=new LiveHistoryReader<SettlementPosition>();
  await assert.doesNotReject(()=>fresh.hydrate(h.input(fresh,[p],now)));
  assert.equal(fresh.view([p]).history[0].realizedPnl,undefined);
});

test("a storage failure during hydrate keeps the old behaviour",async()=>{
  const h=harness(),p=position();
  const broken={...h.storage,get:async()=>{throw new Error("injected");},list:h.storage.list.bind(h.storage),transaction:h.storage.transaction.bind(h.storage)};
  const r=new LiveHistoryReader<SettlementPosition>();
  await assert.doesNotReject(()=>r.hydrate({...h.input(r,[p],now),storage:broken as unknown as Memory}));
  assert.equal(r.view([p]).pending,1);
});

test("a record without a copy receipt can never match, so it does not keep asking Gate",async()=>{
  const h=harness(),manual={...position("manual"),parity:undefined};
  const r=new LiveHistoryReader<SettlementPosition>();
  r.launch(h.input(r,[manual],now));await Promise.all(h.tasks);
  assert.equal(h.client.count,0);
});

test("LIVE page keeps a bounded device copy of settled records and polls sooner only while a settlement read runs",()=>{
  const ui=readFileSync(new URL("../app/live-console.tsx",import.meta.url),"utf8");
  assert.match(ui,/sentinel-live-settled-v1/);assert.match(ui,/SETTLED_CACHE_LIMIT=80/);
  assert.match(ui,/p\.settlement\|\|!settledCache\[p\.id\]\?p:/,"device cache only fills records the server lists");
  assert.match(ui,/value\.updating&&value\.pending>0&&quick<4/);
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.match(worker,/historyReader\.hydrate\(/);assert.match(worker,/history:this\.decoratedLiveHistory\(\)/);
});
