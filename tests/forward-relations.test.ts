import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advanceForward, initialForward, normalizeForward, frameFromCandles, synthesizeRules, conditionMatches,
  forwardEquity, freshQuote, forwardSummary, FORWARD_VERSION, BAR_MS, type ForwardState, type Measurement, type Rule, type Candle } from "../lib/forward-relations.ts";
import { readForwardStore, prepareForwardWrite, FORWARD_STORAGE } from "../lib/forward-store.ts";

const T=1_790_000_100_000, START=Math.floor(T/BAR_MS)*BAR_MS;
function candles(end:number,n=50,drift=.0001):Candle[]{return Array.from({length:n},(_,i)=>{
  const open=100*Math.exp(i*drift),close=open*Math.exp(drift);return{time:(end-(n-i)*BAR_MS)/1000,open,close,high:Math.max(open,close)*1.002,low:Math.min(open,close)*.998,volume:100+i};});}
function measurements(sign=1):Measurement[]{return Array.from({length:20},(_,k)=>Array.from({length:8},(_,j)=>{
  const x=j%2?1:-1,at=START+(k+1)*15*60_000;return{symbol:`S${j}`,at,seenAt:at+1000,price:100,x:[x,0,0,0,0,0,0,0],
    horizon:15,endAt:at+15*60_000,availableAt:at+15*60_000+1000,response:sign*x*.015,up:sign*x>0?.025:.002,down:sign*x<0?.025:.002};})).flat();}
function rule(now:number):Rule{return{id:"fr-test",signature:"test",parentId:null,version:1,createdAt:now-1000,expiresAt:now+DAY,
  status:"EXPERIMENTAL",conditions:[{feature:0,op:"GE",threshold:-99}],side:"LONG",horizon:60,stopRate:.02,armRate:.015,givebackRate:.007,
  exitMode:"REACTION_DECAY",samples:50,trainGroups:6,checkGroups:4,estimatedNetRate:.01,priorResponse:.01,recentResponse:.012,standardError:.001,
  reason:"synthetic functional fixture, never a market result",mutation:"CREATE",grammar:"test",liveEligible:false};}
const DAY=86400000;
const quote=(now:number,price=100)=>({bestBid:price,bestAsk:price+.01,observedAt:now,fresh:true});
function opened(){const now=START+10*BAR_MS,s=initialForward(START);s.lastFitAt=now;s.rules=[rule(now)];
  return advanceForward({state:s,now,paths:{BTC_USDT:candles(now)},quotes:{BTC_USDT:quote(now)},contracts:{BTC_USDT:{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005}}}).state;}

test("new account is PAPER-only, empty and exactly 1000; no inherited research PnL",()=>{
  const s=initialForward(START);assert.equal(s.balance,1000);assert.equal(s.rules.length,0);assert.equal(s.measured,0);assert.equal(s.positions.length,0);assert.equal(s.liveEligible,false);
});
test("corrupt or unknown persisted versions fail without reset",()=>{
  const s=initialForward(START);s.version="unknown";assert.throws(()=>normalizeForward(s,START+DAY));
});
test("incomplete future bars cannot change existing features",()=>{
  const a=candles(START);const f=frameFromCandles("BTC",a,START+1000);
  const future=candles(START+DAY).map(r=>({...r,close:99999}));assert.deepEqual(frameFromCandles("BTC",[...a,...future],START+1000),f);
});
test("feature gaps and invalid candle ranges fail closed",()=>{
  const a=candles(START);a.splice(-5,1);assert.equal(frameFromCandles("BTC",a,START+1000),null);
  const b=candles(START);b[b.length-1].high=1;assert.equal(frameFromCandles("BTC",b,START+1000),null);
});
test("startup historical candles produce zero historical outcome labels",()=>{
  const s=advanceForward({state:initialForward(START),now:START+1000,paths:{BTC:candles(START-BAR_MS)},quotes:{},contracts:{}}).state;
  assert.equal(s.measured,0);assert.equal(s.observations,0);assert.equal(s.resolved,0);assert.equal(s.balance,1000);
});
test("a 15 minute market measurement matures only after all future bars exist",()=>{
  let s=initialForward(START);let a=candles(START);
  s=advanceForward({state:s,now:START+1000,paths:{BTC:a},quotes:{},contracts:{}}).state;
  assert.equal(s.observations,3);assert.equal(s.measured,0);
  const p=s.pending["BTC:15"];
  a=[...a,...candles(START+3*BAR_MS,3)];
  s=advanceForward({state:s,now:START+3*BAR_MS+1000,paths:{BTC:a},quotes:{},contracts:{}}).state;
  assert.equal(s.measured,1);assert.equal(s.samples[0].at,p.at);assert.equal(s.samples[0].endAt,p.dueAt);
  assert.ok(s.samples[0].availableAt>s.samples[0].endAt);assert.equal(s.resolved,0);
});
test("duplicate cycles and restart serialization do not duplicate measurements",()=>{
  const input={now:START+1000,paths:{BTC:candles(START)},quotes:{},contracts:{}};
  const first=advanceForward({...input,state:initialForward(START)}).state;
  const second=advanceForward({...input,state:JSON.parse(JSON.stringify(first)) as ForwardState}).state;
  assert.equal(second.observations,first.observations);assert.equal(second.revision,first.revision);
});
test("conditional-response rule generation learns direction rather than using fixed direction",()=>{
  const s=initialForward(START);s.samples=measurements();const now=s.samples.at(-1)!.availableAt+1;synthesizeRules(s,now);
  assert.ok(s.rules.some(r=>r.side==="LONG"&&conditionMatches([1,0,0,0,0,0,0,0],r.conditions)));
  assert.ok(s.rules.some(r=>r.side==="SHORT"&&conditionMatches([-1,0,0,0,0,0,0,0],r.conditions)));
  assert.equal(s.resolved,0);assert.equal(s.balance,1000);assert.ok(s.rules.every(r=>r.liveEligible===false));
});
test("reversed new market responses generate new logic and preserve prior versions",()=>{
  const s=initialForward(START);s.samples=measurements();const now=s.samples.at(-1)!.availableAt+1;synthesizeRules(s,now);const ids=s.rules.map(r=>r.id);
  s.samples=measurements(-1);synthesizeRules(s,now+1);
  assert.ok(s.rules.filter(r=>r.status==="EXPERIMENTAL").some(r=>r.side==="SHORT"&&conditionMatches([1,0,0,0,0,0,0,0],r.conditions)));
  assert.ok(ids.every(id=>s.rules.find(r=>r.id===id)?.status==="DORMANT"));
});
test("unknown future outcome labels cannot change a generated rule",()=>{
  const s=initialForward(START);s.samples=measurements();const now=s.samples.at(-1)!.availableAt+1;
  const other=structuredClone(s);other.samples.push({...s.samples[0],availableAt:now+DAY,endAt:now+DAY,response:999});
  synthesizeRules(s,now);synthesizeRules(other,now);assert.deepEqual(other.rules,s.rules);
});
test("expired measurements cannot be relabeled as fresh evidence",()=>{
  const s=initialForward(START);s.samples=measurements();synthesizeRules(s,s.samples.at(-1)!.availableAt+DAY);assert.equal(s.rules.length,0);
});
test("costless, flat responses cannot generate paid round-trip trades",()=>{
  const s=initialForward(START);s.samples=measurements().map(m=>({...m,response:0}));synthesizeRules(s,s.samples.at(-1)!.availableAt+1);assert.equal(s.rules.length,0);
});
test("fresh quote validation blocks stale, crossed and future quotes",()=>{
  assert.equal(freshQuote(quote(START),START+9000),false);assert.equal(freshQuote({...quote(START),bestAsk:99},START),false);
  assert.equal(freshQuote(quote(START+2000),START),false);assert.equal(freshQuote(quote(START),START),true);
});
test("PAPER execution uses current ask plus slippage and integer contract lots",()=>{
  const s=opened();assert.equal(s.positions.length,1);const t=s.positions[0];assert.ok(t.entryPrice>100.01);assert.equal(t.contracts,Math.floor(t.contracts));
  assert.equal(t.quantity,t.contracts*t.quantoMultiplier);assert.equal(s.balance,1000-t.entryFee);assert.equal(t.liveEligible,false);
  assert.ok(t.plannedRisk<=1000*.015+1e-8);assert.equal(t.openedAt,START+10*BAR_MS);
});
test("an expired quote cannot cause a stop exit or a new order",()=>{
  const s=opened(),now=s.lastCycleAt+10000;
  const n=advanceForward({state:s,now,paths:{},quotes:{BTC_USDT:quote(now-9000,80)},contracts:{}}).state;
  assert.equal(n.positions.length,1);assert.equal(n.resolved,0);assert.equal(n.balance,s.balance);
});
test("sequence recovery blocks new entries even with a recent quote",()=>{
  const now=START+10*BAR_MS,s=initialForward(START);s.lastFitAt=now;s.rules=[rule(now)];
  const n=advanceForward({state:s,now,paths:{BTC_USDT:candles(now)},quotes:{BTC_USDT:{...quote(now),entryReady:false}},
    contracts:{BTC_USDT:{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005}}}).state;
  assert.equal(n.positions.length,0);assert.equal(n.balance,1000);
});
test("gap stops fill at observable adverse quote, never retrospectively at ideal stop",()=>{
  const s=opened(),now=s.lastCycleAt+10000,t=s.positions[0];
  const n=advanceForward({state:s,now,paths:{},quotes:{BTC_USDT:quote(now,90)},contracts:{}}).state;
  assert.equal(n.positions.length,0);assert.equal(n.resolved,1);assert.ok(n.history[0].exitPrice!<t.stopPrice);
  assert.ok(Math.abs(n.balance-(1000+n.history[0].netPnl!))<1e-8);
});
test("marked equity provisions exit fees once; realized closure reconciles exactly",()=>{
  const s=opened(),now=s.lastCycleAt+65*60000,q={BTC_USDT:quote(now,105)};
  const marked=forwardEquity(s,q,now).equity,n=advanceForward({state:s,now,paths:{},quotes:q,contracts:{}}).state;
  assert.equal(n.positions.length,0);assert.ok(Math.abs(n.balance-marked)<1e-8);
});
test("a position freezes its original rule geometry across rule revisions",()=>{
  const s=opened(),stop=s.positions[0].stopPrice;s.rules[0].stopRate=.09;
  const n=advanceForward({state:s,now:s.lastCycleAt+10000,paths:{},quotes:{BTC_USDT:quote(s.lastCycleAt+10000,100)},contracts:{}}).state;
  assert.equal(n.positions[0].stopPrice,stop);assert.equal(n.positions[0].rule.stopRate,.02);
});
test("no automatic reset after a losing account",()=>{
  const s=initialForward(START);s.balance=-1;const n=advanceForward({state:s,now:START+1000,paths:{BTC:candles(START)},quotes:{},contracts:{}}).state;
  assert.equal(n.balance,-1);assert.equal(n.initialEquity,1000);
});
class MemoryStore {data=new Map<string,unknown>();async get<T>(key:string){return this.data.get(key) as T|undefined;} async put(entries:Record<string,unknown>){for(const[k,v]of Object.entries(entries))this.data.set(k,structuredClone(v));}}
test("chunked persistence round-trips full account, learning and pending observations",async()=>{
  const store=new MemoryStore(),s=opened();s.samples=measurements();const out=await prepareForwardWrite(null,s,START+DAY);await store.put(out.entries);
  assert.deepEqual(await readForwardStore(store,START+DAY),s);for(const[k,v]of Object.entries(out.entries))if(k.includes("chunk:"))assert.ok((v as Uint8Array).byteLength<=80*1024);
});
test("missing chunk or tampering refuses recovery rather than inventing a new balance",async()=>{
  const store=new MemoryStore(),s=opened(),out=await prepareForwardWrite(null,s,START+DAY);await store.put(out.entries);store.data.delete(`${FORWARD_STORAGE}chunk:0`);
  await assert.rejects(()=>readForwardStore(store,START+DAY));
});
test("version is explicit and live authority stays absent in API summary",()=>{
  const s=opened(),v=forwardSummary(s,{},START+DAY);assert.equal(v.version,FORWARD_VERSION);assert.equal(v.liveEligible,false);assert.equal(v.boundaries.historyBackfill,false);
});
test("integration preserves old account but retires its new entries and isolates new LIVE authority",()=>{
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8"),core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  assert.match(worker,/allowNewEntries: false/);assert.match(worker,/desiredPortfolio = canonicalLivePortfolio/);
  assert.doesNotMatch(core,/GateLiveClient|createEntry\(|fetch\(|eval\(|new Function/);
  assert.match(worker,/await this\.ctx\.storage\.transaction/);assert.match(worker,/forwardState\?\.positions\.map/);
});
