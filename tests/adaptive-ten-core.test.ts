import test from "node:test";
import assert from "node:assert/strict";
import {ADAPTIVE_ENGINE_VERSION,ADAPTIVE_REALTIME_POSITION_CAP,ADAPTIVE_TARGET_POSITIONS,advanceForward,forwardSummary,
  initialForward,normalizeForward,type Candle,type Contract,type Quote} from "../lib/forward-relations.ts";
import {restoreForwardProtectionCheckpoint} from "../lib/forward-protection-checkpoint.ts";

const START=Date.parse("2026-09-24T00:00:00Z")/1000;
const path=(step=.0015,bars=60):Candle[]=>{const out:Candle[]=[];let prev=100;
  for(let i=0;i<bars;i++){const close=prev*(1+step);out.push({time:START+i*300,open:prev,close,
    high:Math.max(prev,close)*1.0006,low:Math.min(prev,close)*.9994,volume:1000+i});prev=close;}return out;};
const quote=(price:number,now:number):Quote=>({bestBid:price*.9999,bestAsk:price*1.0001,observedAt:now,fresh:true,entryReady:true});
const contract:Contract={quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,minContracts:1};

test("ordinary 5m participation fills toward ten seats without requiring a winding region",()=>{
  const symbols=Array.from({length:12},(_,i)=>`S${i}_USDT`),paths=Object.fromEntries(symbols.map(s=>[s,path()]));
  const latest=paths[symbols[0]]!.at(-1)!.close,now=(paths[symbols[0]]!.at(-1)!.time+300)*1000+1000;
  const quotes=Object.fromEntries(symbols.map(s=>[s,quote(latest,now)])),contracts=Object.fromEntries(symbols.map(s=>[s,contract]));
  let s=initialForward(now-60_000);
  for(let i=0;i<5;i++)s=advanceForward({state:s,now:now+i*1000,paths,quotes,contracts,entrySymbols:symbols,allowDataCycle:i===0}).state;
  assert.equal(s.positions.length,ADAPTIVE_TARGET_POSITIONS);
  assert.ok(s.opportunities.some(o=>o.mode==="FLOW"&&o.eligible));
  assert.ok(s.positions.every(t=>t.entryContext?.mode==="FLOW"));
  assert.equal(s.positions.some(t=>t.entryContext?.regionId),false);
});

test("ordinary participation never forces the eleventh seat",()=>{
  const symbols=Array.from({length:14},(_,i)=>`T${i}_USDT`),paths=Object.fromEntries(symbols.map(s=>[s,path(.0016)]));
  const price=paths[symbols[0]]!.at(-1)!.close,now=(paths[symbols[0]]!.at(-1)!.time+300)*1000+1000;
  const quotes=Object.fromEntries(symbols.map(s=>[s,quote(price,now)])),contracts=Object.fromEntries(symbols.map(s=>[s,contract]));
  let s=initialForward(now-60_000);
  for(let i=0;i<8;i++)s=advanceForward({state:s,now:now+i*1000,paths,quotes,contracts,entrySymbols:symbols,allowDataCycle:i===0}).state;
  assert.equal(s.positions.length,10);
  assert.equal(ADAPTIVE_REALTIME_POSITION_CAP,11);
});

test("strategy normalization upgrades an old account in place instead of creating a fresh ledger",()=>{
  const s=initialForward(1000);s.startedAt=123;s.balance=876.54;s.initialEquity=1000;s.resolved=7;s.turnover=4321;
  s.engineVersion="legacy";s.strategyAuthorityVersion="legacy";s.executionVersion="legacy";s.storage={persistedAt:999,error:null};
  const n=normalizeForward(s,5000);
  assert.equal(n.startedAt,123);assert.equal(n.balance,876.54);assert.equal(n.resolved,7);assert.equal(n.turnover,4321);
  assert.equal(n.storage.persistedAt,999);assert.equal(n.engineVersion,ADAPTIVE_ENGINE_VERSION);
  assert.equal(n.strategyAuthorityVersion,ADAPTIVE_ENGINE_VERSION);assert.equal(n.executionVersion,ADAPTIVE_ENGINE_VERSION);
});

test("profit protection tightens after a strong favorable move and never loosens",()=>{
  const symbols=["BTC_USDT"],paths={BTC_USDT:path(.0015)},price=path(.0015).at(-1)!.close;
  const now=(paths.BTC_USDT.at(-1)!.time+300)*1000+1000,contracts={BTC_USDT:contract};
  let s=initialForward(now-60_000);
  s=advanceForward({state:s,now,paths,quotes:{BTC_USDT:quote(price,now)},contracts,entrySymbols:symbols}).state;
  assert.equal(s.positions.length,1);const entry=s.positions[0]!.entryPrice,oldStop=s.positions[0]!.stopPrice;
  const favorable=entry*1.014;
  s=advanceForward({state:s,now:now+2000,paths,quotes:{BTC_USDT:quote(favorable,now+2000)},contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  assert.equal(s.positions.length,1);
  const protectedStop=s.positions[0]!.stopPrice,floor=s.positions[0]!.profitFloorRate??0;
  assert.ok(floor>0);assert.ok(protectedStop>oldStop);assert.ok(protectedStop>entry);
  const stillProfit=entry*1.011;
  s=advanceForward({state:s,now:now+3000,paths,quotes:{BTC_USDT:quote(stillProfit,now+3000)},contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  if(s.positions.length)assert.ok(s.positions[0]!.stopPrice>=protectedStop);
});

test("forward summary exposes the actual ten-seat engine instead of retired strategy labels",()=>{
  const s=initialForward(1000),view=forwardSummary(s,{},2000);
  assert.equal(view.engineVersion,ADAPTIVE_ENGINE_VERSION);assert.equal(view.targetPositions,10);assert.equal(view.realtimePositionCap,11);
  assert.match(view.boundaries.grammar,/5m方向—空间/);assert.match(view.boundaries.sampleMeaning,/实时市场方向优先/);
});


test("retired protection overlay is inert when the current PAPER account has no open risk",()=>{
  const s=initialForward(1000);s.storage={persistedAt:900,error:null};
  const legacy={version:"forward-protection-checkpoint-v1",startedAt:s.startedAt,baseRevision:s.revision,basePersistedAt:900,
    quoteCycleAt:1100,peakEquity:1000,maxDrawdown:0,positions:[]};
  assert.deepEqual(restoreForwardProtectionCheckpoint(s,legacy),s);
});

test("retired protection overlay migrates only tighter protection and observed path for an open trade",()=>{
  const p=path(.0015),now=(p.at(-1)!.time+300)*1000+1000,price=p.at(-1)!.close;
  let s=initialForward(now-60_000);
  s=advanceForward({state:s,now,paths:{BTC_USDT:p},quotes:{BTC_USDT:quote(price,now)},contracts:{BTC_USDT:contract},
    entrySymbols:["BTC_USDT"]}).state;
  assert.equal(s.positions.length,1);s.storage={persistedAt:now,error:null};
  const t=s.positions[0]!,stop=t.entryPrice*1.004,quoteAt=now+1000;
  const legacy={version:"forward-protection-checkpoint-v1",startedAt:s.startedAt,baseRevision:s.revision,basePersistedAt:now,
    quoteCycleAt:quoteAt,peakEquity:s.peakEquity+1,maxDrawdown:s.maxDrawdown,positions:[{
      id:t.id,openedAt:t.openedAt,favorable:.02,adverse:.004,lastPrice:t.entryPrice*1.01,lastQuoteAt:quoteAt,
      stopPrice:stop,relationFailureBars:0,lastRelationBar:quoteAt,profitProtection:{floorRate:.003},
    }]};
  const n=restoreForwardProtectionCheckpoint(s,legacy);
  assert.equal(n.positions[0]!.stopPrice,stop);assert.equal(n.positions[0]!.favorable,.02);
  assert.ok((n.positions[0]!.profitFloorRate??0)>=.004);assert.equal(n.positions[0]!.entryContext?.version,"adaptive-ten-entry-v1");
});
