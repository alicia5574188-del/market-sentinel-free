import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, initialForward, normalizeForward, synthesizeRules, forwardEquity, BAR_MS,
  type Rule, type Measurement, type Candle } from "../lib/forward-relations.ts";
import { EVIDENCE_POLICY, PREVIOUS_POLICY, inspectCondition, blankDiagnostics, costAwareGiveback, modeledCost } from "../lib/forward-evidence.ts";
import { readForwardStore, prepareForwardWrite } from "../lib/forward-store.ts";
const START=1_790_000_100_000, NOW=START+10*BAR_MS+90_000;
function rows():Measurement[]{return Array.from({length:12},(_,i)=>Array.from({length:8},(_,j)=>{
  const at=START+(i+1)*900000;return{symbol:`S${j}`,at,seenAt:at+90000,price:100,x:Array(8).fill(0),horizon:15,
    endAt:at+900000,availableAt:at+990000,response:.02,up:.03,down:.003};})).flat();}
function fixture(names=["S0"]){const s=initialForward(START),data=rows(),c=inspectCondition({rows:data,conditions:[{feature:0,op:"GE",threshold:-99}],horizon:15,
  now:data.at(-1)!.availableAt+1,feedback:[]},blankDiagnostics())!;
  const r:Rule={...c,id:"r",signature:"s",parentId:null,version:1,createdAt:NOW-1000,expiresAt:NOW+3600000,
    status:"EXPERIMENTAL",reason:"Synthetic, not a market result",mutation:"CREATE",grammar:"test",liveEligible:false,
    evidence:{...c.evidence,symbols:names},stopRate:.02};s.rules=[r];s.lastFitAt=NOW;return s;
}
function market(now=NOW,names=["S0"],fresh=true,price=100){const at=Math.floor(now/BAR_MS)*BAR_MS;
  return {paths:Object.fromEntries(names.map(s=>[s,Array.from({length:25},(_,i)=>({time:(at-(25-i)*BAR_MS)/1000,
    open:100,close:100,high:100.1,low:99.9,volume:100}) satisfies Candle)])),
    quotes:Object.fromEntries(names.map(s=>[s,{bestBid:price,bestAsk:price+.01,observedAt:now,fresh,entryReady:fresh}])),
    contracts:Object.fromEntries(names.map(s=>[s,{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005}]))};}
const pending=()=>advanceForward({state:fixture(),now:NOW,...market(NOW,["S0"],false)}).state;

test("unready quote retains a bounded signal without creating a PAPER trade",()=>{
  const s=pending();assert.equal(s.positions.length,0);assert.equal(s.balance,1000);assert.equal(s.quoteRetries!.length,1);
  assert.equal(s.quoteRetries![0].expiresAt,Math.floor(NOW/BAR_MS)*BAR_MS+BAR_MS);
});
test("quote recovery enters during the same bar at the recovery price and time",()=>{
  const before=pending(),now=NOW+20000,result=advanceForward({state:before,now,...market(now)}),s=result.state;
  assert.equal(s.positions.length,1);assert.equal(s.positions[0].openedAt,now);assert.ok(s.positions[0].entryPrice>100.01);
  assert.equal(s.participation!.retryFills,1);assert.equal(s.quoteRetries!.length,0);assert.equal(result.changed,true);
  assert.equal(before.positions.length,0);assert.equal(before.balance,1000);
});
test("retry does not refit or mature additional observations between data cycles",()=>{
  const before=pending(),now=NOW+20000,s=advanceForward({state:before,now,...market(now)}).state;
  assert.equal(s.lastFitAt,before.lastFitAt);assert.equal(s.observations,before.observations);assert.equal(s.measured,before.measured);
});
test("waiting retries do not force an extra storage commit every ten seconds",()=>{
  const before=pending(),now=NOW+20000,result=advanceForward({state:before,now,...market(now,["S0"],false)});
  assert.equal(result.changed,false);assert.equal(result.state.quoteRetries![0].firstAt,NOW);
});
test("stale quote cannot be relabeled fresh by a retry",()=>{
  const before=pending(),now=NOW+20000,m=market(now);m.quotes.S0.observedAt=NOW;
  const s=advanceForward({state:before,now,...m}).state;assert.equal(s.positions.length,0);assert.equal(s.balance,1000);
});
test("quote queue expires at next completed-bar boundary without backdated fills",()=>{
  const before=pending(),now=before.quoteRetries![0].expiresAt,s=advanceForward({state:before,now,paths:{},...{quotes:market(now).quotes,contracts:market(now).contracts}}).state;
  assert.equal(s.positions.length,0);assert.equal(s.quoteRetries!.length,0);
});
test("a retired rule cannot execute its queued observation",()=>{
  const before=pending();before.rules[0].status="DORMANT";const now=NOW+20000,s=advanceForward({state:before,now,...market(now)}).state;
  assert.equal(s.positions.length,0);assert.equal(s.quoteRetries!.length,0);
});
test("moved signal feature invalidates a queued condition",()=>{
  const before=pending();before.frames.S0.x[0]=-100;const now=NOW+20000,s=advanceForward({state:before,now,...market(now)}).state;
  assert.equal(s.positions.length,0);
});
test("already-consumed favorable move cannot be recovered as hypothetical past profit",()=>{
  const before=pending(),now=NOW+20000,s=advanceForward({state:before,now,...market(now,["S0"],true,110)}).state;
  assert.equal(s.positions.length,0);assert.ok(Object.keys(s.entryDiagnostics!.reasons).some(r=>r.includes("剩余优势")));
});
test("successful retries do not duplicate an order on subsequent heartbeats",()=>{
  let s=pending();s=advanceForward({state:s,now:NOW+20000,...market(NOW+20000)}).state;
  const t=s.positions[0],n=advanceForward({state:s,now:NOW+40000,...market(NOW+40000)}).state;
  assert.equal(n.positions.length,1);assert.equal(n.positions[0].id,t.id);assert.equal(n.fees,s.fees);
});
test("pending quote and completed retry survive atomic chunk persistence exactly",async()=>{
  const original=pending(),write=await prepareForwardWrite(null,original,NOW),db=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({async get<T>(key:string){return db.get(key) as T|undefined;}},NOW+10000);
  const s=advanceForward({state:restored,now:NOW+20000,...market(NOW+20000)}).state;
  assert.equal(s.positions.length,1);assert.equal(s.participation!.retryFills,1);
  const final=await prepareForwardWrite(restored,s,NOW+20000);assert.ok(Object.keys(final.entries).some(k=>k.includes("archive:")));
});
test("simultaneous eight-coin opportunities retain meaningful lots under existing total caps",()=>{
  const names=Array.from({length:8},(_,i)=>`S${i}`),m=market(NOW,names),s=advanceForward({state:fixture(names),now:NOW,...m}).state;
  assert.equal(s.positions.length,8);const eq=forwardEquity(s,m.quotes,NOW).equity;
  assert.ok(s.positions.every(t=>t.notional>=eq*.05));assert.ok(s.positions.reduce((n,t)=>n+t.plannedRisk,0)<=eq*.065+1e-8);
  assert.ok(s.positions.reduce((n,t)=>n+t.notional,0)<=eq*4+1e-8);
  const notionals=s.positions.map(t=>t.notional);assert.ok(Math.max(...notionals)/Math.min(...notionals)<1.05);
});
test("an actual same-bar close cannot reopen under another version in the same evaluation",()=>{
  let s=advanceForward({state:fixture(),now:NOW,...market()}).state;const now=Math.floor(NOW/BAR_MS)*BAR_MS+BAR_MS+90000;
  s.rules[0].version=99;s=advanceForward({state:s,now,...market(now,["S0"],true,90)}).state;
  assert.equal(s.resolved,1);assert.equal(s.positions.length,0);
});
test("v1.1 migration keeps start, loss ledger, samples and previous upgrade boundary",()=>{
  const s=fixture();s.policyVersion=PREVIOUS_POLICY;s.balance=959;s.resolved=61;s.samples=rows();
  s.policyUpgrade={at:START,from:"legacy-forward-v1.0",to:PREVIOUS_POLICY,equity:943,balance:944,stalePositions:0,resolved:48,positionIds:[]};
  const norm=normalizeForward(structuredClone(s),NOW),r=advanceForward({state:norm,now:NOW,paths:{},quotes:{},contracts:{}}).state;
  assert.equal(r.balance,959);assert.equal(r.startedAt,s.startedAt);assert.equal(r.resolved,61);assert.equal(r.policyVersion,EVIDENCE_POLICY);
  assert.deepEqual(r.policyUpgrades![0],s.policyUpgrade);assert.equal(r.policyUpgrade!.from,PREVIOUS_POLICY);assert.equal(r.initialEquity,1000);
});
test("known v1.1 migration is one-time; unknown policy still fails closed",()=>{
  const s=fixture();s.policyVersion=PREVIOUS_POLICY;let r=advanceForward({state:s,now:NOW,paths:{},quotes:{},contracts:{}}).state;
  const marker=structuredClone(r.policyUpgrade);r=advanceForward({state:r,now:NOW+10000,paths:{},quotes:{},contracts:{}}).state;
  assert.deepEqual(r.policyUpgrade,marker);r.policyVersion="future";assert.throws(()=>normalizeForward(r,NOW));
});
test("new cost-aware giveback retains cost allowance at ideal activation for all horizons",()=>{
  for(const h of[15,60,180]){const c=modeledCost(h),arm=c*2,giveback=costAwareGiveback(arm,arm*.8,c);
    assert.ok(arm-giveback>=c*1.25-1e-12);assert.ok(giveback>0);}
});
test("already cost-sufficient original exit geometry stays unchanged",()=>{
  assert.equal(costAwareGiveback(.03,.012,.0022),.012);
});
test("a delayed adverse gap after arming still realizes the observable loss, not ideal profit",()=>{
  let s=advanceForward({state:fixture(),now:NOW,...market()}).state;
  const r=s.positions[0].rule;r.exitMode="REACTION_DECAY";r.armRate=.0044;r.givebackRate=.00165;
  s=advanceForward({state:s,now:NOW+20000,...market(NOW+20000,["S0"],true,101)}).state;
  s=advanceForward({state:s,now:NOW+BAR_MS+20000,paths:{},quotes:market(NOW+BAR_MS+20000,["S0"],true,95).quotes,contracts:{}}).state;
  assert.equal(s.history.length,1);assert.ok(s.history[0].netPnl!<0);assert.ok(s.history[0].exitPrice!<96);
});
test("midpoint admission does not charge entry slippage twice",()=>{
  const s=fixture();s.rules[0].estimatedNetRate=.0004;s.rules[0].evidence!.rawNet=.0004;s.rules[0].evidence!.quality=.5;
  const r=advanceForward({state:s,now:NOW,...market()}).state;assert.equal(r.positions.length,1);
  assert.ok(r.positions[0].entryFee>0);assert.ok(r.positions[0].entryPrice>100.01);assert.ok(r.positions[0].forecast!.remainingNetRate>0);
});
test("flat data still generates no paid-trade hypotheses; no forced minimum frequency",()=>{
  const s=fixture();s.rules=[];s.samples=rows().map(r=>({...r,response:0}));synthesizeRules(s,s.samples.at(-1)!.availableAt+1);
  assert.equal(s.rules.filter(r=>r.status==="EXPERIMENTAL").length,0);
});