import test from "node:test";
import assert from "node:assert/strict";
import {initialForward,forwardEquity,type Trade} from "../lib/forward-relations.ts";
import {prepareForwardWrite,readForwardStore,FORWARD_STORAGE} from "../lib/forward-store.ts";
import {archivedEquity,type CurveContext} from "../lib/equity-curve.ts";

const T=1_790_780_400_000,POLICY="market-intelligence-v1";
function position(i=0,quoteAt=T,rich=false):Trade{
  const openedAt=T-30_000;
  return{id:`archive-position-${i}`,symbol:`S${i}_USDT`,side:"LONG",status:"OPEN",openedAt,closedAt:null,
    entryPrice:100,exitPrice:null,lastPrice:101,lastQuoteAt:quoteAt,quantity:1,contracts:1000,quantoMultiplier:.001,
    notional:100,leverage:10,margin:10,plannedRisk:2,stopPrice:98,armPrice:104,favorable:.01,adverse:0,
    entryFee:.07,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,
    relationFailureBars:0,lastRelationBar:openedAt,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
    firstProfitAt:T-10_000,holdScore:80,profitFloorRate:0,expectedHoldMinutes:180,peakPnlRate:.01,
    exitControl:{policy:POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
    rule:{id:`r-${i}`,signature:`archive-${i}`,parentId:null,version:1,createdAt:openedAt,expiresAt:T+3600_000,
      status:"EXPERIMENTAL",conditions:[],side:"LONG",horizon:180,stopRate:.02,armRate:.01,givebackRate:.005,
      exitMode:"HORIZON",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:.03,priorResponse:null,
      recentResponse:0,standardError:0,reason:rich?"归档压力测试证据".repeat(1500):"archive contract fixture",
      mutation:"CREATE",grammar:POLICY,liveEligible:false}};
}
async function saved(positions:Trade[]){
  const state=initialForward(T-60_000);
  state.storage={persistedAt:T,error:null};state.revision=1;state.positions=positions;
  state.balance=state.initialEquity-positions.reduce((n,t)=>n+t.entryFee,0);
  state.fees=positions.reduce((n,t)=>n+t.entryFee,0);
  state.events=positions.map((t,i)=>({id:`archive-event-${i}-1`,at:T,kind:"PROTECTION" as const,subject:t.id,reason:"fixture"}));
  const equity=forwardEquity(state,{},T).equity;
  state.daily=[{day:"2026-09-30",firstAt:state.startedAt,lastAt:T,startEquity:1000,endEquity:equity,exactBoundary:false}];
  const before=structuredClone(state.positions),balance=state.balance;
  const write=await prepareForwardWrite(null,state,T,{compact:true});
  assert.deepEqual(state.positions,before);assert.equal(state.balance,balance);
  const context:CurveContext={startedAt:state.startedAt,initialEquity:state.initialEquity,policy:state.policyVersion,
    exitPolicy:POLICY,comparableSince:state.startedAt,persistedAt:T};
  const packets=Object.entries(write.entries).filter(([key])=>key.startsWith(`${FORWARD_STORAGE}archive:`));
  return{state,write,context,packets,equity};
}

test("real compact archive writer preserves quote freshness and exit policy for the equity reader",async()=>{
  const {packets,context,equity}=await saved([position()]);
  assert.equal(packets.length,1);
  const packet=packets[0]![1] as {account:{positions:Record<string,unknown>[]}};
  const row=packet.account.positions[0]!;
  assert.equal(row.lastQuoteAt,T);assert.deepEqual(row.exitControl,{policy:POLICY});
  assert.equal("rule" in row,false);assert.equal("positionIntelligence" in row,false);
  const point=archivedEquity(packet,context,T+1);
  assert.ok(point,"an active position must not make a real saved equity point disappear");
  assert.equal(point.equity,equity);assert.equal(point.at,T);assert.equal(point.homogeneous,true);
  assert.equal(point.stale,undefined);
});

test("compact archive keeps stale observations stale and rejects future or unknown quote timestamps",async()=>{
  const stale=await saved([position(0,T-9001)]);
  const point=archivedEquity(stale.packets[0]![1],stale.context,T+1);
  assert.ok(point);assert.equal(point.stale,true);assert.equal(point.homogeneous,false);
  const future=await saved([position(0,T+2000)]);
  assert.equal(archivedEquity(future.packets[0]![1],future.context,T+1),null);
  const unknown=position();delete (unknown as Partial<Trade>).lastQuoteAt;
  const missing=await saved([unknown]);
  assert.equal(archivedEquity(missing.packets[0]![1],missing.context,T+1),null);
});

test("compaction does not relabel an inherited position as current exit policy",async()=>{
  const inherited=position();inherited.exitControl!.policy="legacy-exit-policy";
  const {packets,context,equity}=await saved([inherited]);
  const point=archivedEquity(packets[0]![1],context,T+1);
  assert.ok(point);assert.equal(point.equity,equity);assert.equal(point.homogeneous,false);
});

test("a second commit in the same millisecond gets its own equity time",async()=>{
  const first=await saved([position()]);
  const next=structuredClone(first.state);next.revision=2;next.daily[0]!.endEquity=first.equity+5;
  const write=await prepareForwardWrite(first.state,next,T,{compact:true});
  const packets=Object.entries(write.entries).filter(([key])=>key.startsWith(`${FORWARD_STORAGE}archive:`));
  const points=packets.flatMap(([,value])=>{const p=archivedEquity(value,first.context,T+10);return p?[p]:[];});
  assert.equal(points.length,1);assert.equal(points[0]!.at,T+1);assert.equal(points[0]!.equity,first.equity+5);
});
test("oversized twelve-position archives preserve all trade evidence and exactly one real equity observation",async()=>{
  const {state,write,packets,context,equity}=await saved(Array.from({length:12},(_,i)=>position(i,T,true)));
  assert.ok(packets.length>1,"fixture must exercise the archive sharding path");
  const ids:string[]=[],points=[];
  for(const [key,value] of packets){
    assert.ok(new TextEncoder().encode(JSON.stringify(value)).length<=120*1024,key);
    ids.push(...(value as {trades:Trade[]}).trades.map(t=>t.id));
    const point=archivedEquity(value,context,T+1);if(point)points.push(point);
  }
  assert.equal(ids.length,12);assert.deepEqual(new Set(ids),new Set(state.positions.map(t=>t.id)));
  assert.equal(points.length,1);assert.equal(points[0]!.equity,equity);assert.equal(points[0]!.homogeneous,true);
  const data=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({get:async<V>(key:string)=>structuredClone(data.get(key)) as V|undefined},T+1);
  assert.equal(restored.startedAt,state.startedAt);assert.equal(restored.balance,state.balance);
  assert.deepEqual(restored.positions.map(t=>[t.id,t.quantity,t.entryPrice,t.stopPrice,t.lastQuoteAt]),
    state.positions.map(t=>[t.id,t.quantity,t.entryPrice,t.stopPrice,t.lastQuoteAt]));
});
