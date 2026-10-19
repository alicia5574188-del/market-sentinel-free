import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {s1Decision,s1Levels,s1Exit,s1Fields,S1_FOLLOW_MIN_PCT,S1_FOLLOW_SL_PCT,S1_FOLLOW_TP_PCT,S1_REVERSE_HOLD_MIN,S1_FOLLOW_MAX_MIN,type S1Note} from "../lib/s1-rule.ts";
import {SHADOW_FOLLOW_MIN_PCT,SHADOW_FOLLOW_SL_PCT,SHADOW_FOLLOW_TP_PCT,SHADOW_REVERSE_HOLD_MIN,SHADOW_FOLLOW_MAX_MIN} from "../lib/shadow-branch.ts";
import {orderRecord} from "../lib/order-journal.ts";
import {accountLogBook,shadowSignalOf} from "../lib/run-log.ts";
import {LOG_REQUIRED,LOG_REQUIRED_WHEN_CLOSED} from "../lib/log-complete.ts";
import type {Trade} from "../lib/forward-relations.ts";

const T=2_000_000_000_000;

test("S1 constants are the backtest's (shadow-branch / shadow_backfill.py)",()=>{
  assert.equal(S1_FOLLOW_MIN_PCT,SHADOW_FOLLOW_MIN_PCT);assert.equal(S1_FOLLOW_SL_PCT,SHADOW_FOLLOW_SL_PCT);
  assert.equal(S1_FOLLOW_TP_PCT,SHADOW_FOLLOW_TP_PCT);assert.equal(S1_REVERSE_HOLD_MIN,SHADOW_REVERSE_HOLD_MIN);
  assert.equal(S1_FOLLOW_MAX_MIN,SHADOW_FOLLOW_MAX_MIN);
});

test("follow branch at exactly 0.57 (both sides), reverse just below",()=>{
  for(const stage of ["TREND","SHOCK"]){
    const l=s1Decision({stage,signalSide:"LONG",btc1hPct:0.57});
    assert.deepEqual(l,{action:"OPEN",note:{v:"S1",branch:"follow",signal:"LONG",side:"LONG",btc:0.57,stop:1,tp:6,hold:1440}});
    const s=s1Decision({stage,signalSide:"SHORT",btc1hPct:-0.57});
    assert.equal(s.action,"OPEN");if(s.action==="OPEN"){assert.equal(s.note.branch,"follow");assert.equal(s.note.side,"SHORT");assert.equal(s.note.btc,0.57);}
    const below=s1Decision({stage,signalSide:"LONG",btc1hPct:0.5699});
    assert.deepEqual(below,{action:"OPEN",note:{v:"S1",branch:"reverse",signal:"LONG",side:"SHORT",btc:0.5699,stop:null,tp:null,hold:360}});
    // BTC against the signal: reverse, aligned value negative
    const against=s1Decision({stage,signalSide:"SHORT",btc1hPct:0.8});
    assert.equal(against.action,"OPEN");if(against.action==="OPEN"){assert.equal(against.note.branch,"reverse");assert.equal(against.note.side,"LONG");assert.equal(against.note.btc,-0.8);}
  }
});

test("BTC 1h missing blocks TREND/SHOCK (note only), other stages pass untouched",()=>{
  for(const stage of ["TREND","SHOCK"])for(const btc of [null,undefined,Number.NaN,Infinity]){
    const d=s1Decision({stage,signalSide:"LONG",btc1hPct:btc as never});
    assert.equal(d.action,"BLOCK");if(d.action==="BLOCK"){assert.equal(d.note.branch,null);assert.equal(d.note.btc,null);}
  }
  for(const stage of ["TRANSITION","ROTATION","RANGE",null,undefined,""])for(const btc of [null,0.9,-0.9])
    assert.deepEqual(s1Decision({stage,signalSide:"SHORT",btc1hPct:btc}),{action:"PASS"});
});

test("levels: follow = 1% stop / 6% TP / 24h; reverse = own stop mirrored, no TP, 6h",()=>{
  const f=s1Decision({stage:"SHOCK",signalSide:"LONG",btc1hPct:1.2});assert.equal(f.action,"OPEN");
  const fl=s1Levels((f as {note:S1Note}).note,.023)!;
  assert.deepEqual({side:fl.side,stopRate:fl.stopRate,tpRate:fl.tpRate,holdMin:fl.holdMin},{side:"LONG",stopRate:.01,tpRate:.06,holdMin:1440},"own stop is ignored on follow");
  const r=s1Decision({stage:"TREND",signalSide:"LONG",btc1hPct:0.1});
  const rl=s1Levels((r as {note:S1Note}).note,.0175)!;
  assert.equal(rl.side,"SHORT");assert.equal(rl.stopRate,.0175);assert.equal(rl.tpRate,null);assert.equal(rl.holdMin,360);
  assert.equal(rl.note.stop,1.75);assert.equal(rl.note.tp,null);
  for(const bad of [null,undefined,0,-0.01,Number.NaN,.25])assert.equal(s1Levels((r as {note:S1Note}).note,bad as never),null,`no usable own stop ${String(bad)}`);
});

test("exit decisions: TP6 / SL1 for follow, own stop + 6h time for reverse, stop wins first",()=>{
  const follow:S1Note={v:"S1",branch:"follow",signal:"LONG",side:"LONG",btc:0.9,stop:1,tp:6,hold:1440};
  const base={note:follow,side:"LONG" as const,stopPrice:99,tpPrice:106,openedAt:T};
  assert.equal(s1Exit({...base,now:T+60_000,price:106}),"S1_TP");
  assert.equal(s1Exit({...base,now:T+60_000,price:105.99}),null);
  assert.equal(s1Exit({...base,now:T+60_000,price:99}),"S1_SL");
  assert.equal(s1Exit({...base,now:T+1439*60_000,price:101}),null);
  assert.equal(s1Exit({...base,now:T+1440*60_000,price:101}),"S1_TIME_24H");
  const shortFollow:S1Note={...follow,signal:"SHORT",side:"SHORT"};
  assert.equal(s1Exit({note:shortFollow,side:"SHORT",stopPrice:101,tpPrice:94,openedAt:T,now:T+1,price:94}),"S1_TP");
  assert.equal(s1Exit({note:shortFollow,side:"SHORT",stopPrice:101,tpPrice:94,openedAt:T,now:T+1,price:101.2}),"S1_SL");
  const rev:S1Note={v:"S1",branch:"reverse",signal:"LONG",side:"SHORT",btc:0.1,stop:2,tp:null,hold:360};
  const r={note:rev,side:"SHORT" as const,stopPrice:102,tpPrice:null,openedAt:T};
  assert.equal(s1Exit({...r,now:T+60_000,price:90}),null,"reverse has no take profit");
  assert.equal(s1Exit({...r,now:T+60_000,price:102}),"S1_SL");
  assert.equal(s1Exit({...r,now:T+359*60_000,price:99}),null);
  assert.equal(s1Exit({...r,now:T+360*60_000,price:99}),"S1_TIME_6H");
  assert.equal(s1Exit({...r,note:{...rev,branch:null},now:T+999*60_000,price:50}),null,"note-only rows have no S1 exits");
});

/** Same fixture as tests/entry-gate.test.ts (washout flip): a SHORT signal on a real market-intelligence opportunity. */
async function fixture(stage:"SHOCK"|"TREND"|"TRANSITION"){
  const {buildMarketIntelligence,initialMarketIntelligenceState,MARKET_INTELLIGENCE_VERSION}=await import("../lib/market-intelligence-engine.ts");
  const {initialForward}=await import("../lib/forward-relations.ts");
  const candles=(start:number,step:number,vol=.002)=>{const out=[] as Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>;let px=start;
    for(let i=0;i<72;i++){const move=step+Math.sin(i/5)*vol*.15,open=px,close=px*(1+move);out.push({time:(T-(72-i)*300_000)/1000,open,close,
      high:Math.max(open,close)*(1+vol*.25),low:Math.min(open,close)*(1-vol*.25),volume:1000+i});px=close;}return out;};
  const q=(px:number,move=-.0003)=>({bestBid:px*.99995,bestAsk:px*1.00005,observedAt:T,fresh:true,entryReady:true,sourceCount:4,
    disagreementRate:.00008,sourceBreadth:move>0?.75:-.75,directionalAgreement:.9,medianShortMove:move});
  const paths={BTC_USDT:candles(100,-.0010),ETH_USDT:candles(100,-.0013),SOL_USDT:candles(100,-.0009)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close)]));
  const built=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  const base=built.opportunities[0]!,quote=quotes[base.symbol]!;
  const opportunity={...base,side:"SHORT" as const,premium:false,winnerPlan:undefined,eligible:true,tradePlan:"LIQUIDITY_MIGRATION" as const,environmentForceRetest:false,
    environmentRiskScale:1,strategyVersion:MARKET_INTELLIGENCE_VERSION,thesisId:`s1-${stage}`,thesisSince:T-300_000,
    netRemainingSpaceRate:.04,grossRemainingSpaceRate:.045,edgeRatio:4,targetRate:.04,
    liquidityInvalidationPrice:quote.bestBid*1.01,liquidityInvalidationRate:.01,rapidLiquidityAuthorization:true};
  const state=initialForward(T-600_000);state.extremumRegime=built.state;state.environmentContext={...state.environmentContext,environment:stage};
  return {state,opportunity,quote};
}
const open=async(stage:"SHOCK"|"TREND"|"TRANSITION",btc:number|null,contract={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1})=>{
  const {openIntelligenceTradeForTest}=await import("../lib/forward-relations.ts");
  const {state,opportunity,quote}=await fixture(stage);
  const d=s1Decision({stage,signalSide:"SHORT",btc1hPct:btc});
  const note=d.action==="PASS"?null:d.note;
  const error=openIntelligenceTradeForTest(state,opportunity as never,quote as never,contract as never,T,1000,undefined,undefined,undefined,null,null,d.action==="BLOCK",null,note);
  return {error,state,opportunity,quote,t:(d.action==="BLOCK"?state.unopenedTrades?.[0]:state.positions[0]) as Trade|undefined};
};

test("follow opens the signal side with a 1% stop / 6% target; SHOCK 10x sizing from the 1% stop at 20x",async()=>{
  const {error,t,quote}=await open("SHOCK",-0.8);
  assert.equal(error,null);const tr=t!;
  assert.equal(tr.side,"SHORT");assert.equal(tr.entryPrice,quote.bestBid);
  assert.ok(Math.abs(tr.stopPrice/tr.entryPrice-1.01)<1e-9,"stop 1% above a short");
  assert.ok(Math.abs(tr.armPrice/tr.entryPrice-0.94)<1e-9,"target 6% below a short");
  assert.equal(tr.rule.stopRate,.01);assert.equal(tr.expectedHoldMinutes,1440);
  // risk 1000 × 0.55% × 10 = 55 U; notional = 55 / (1% + 0.19%) ≈ 4622 U (cap 1000 × 0.7 × 10 = 7000 U does not bind)
  const want=1000*.0055*10/(.01+.0019);
  assert.ok(tr.notional<=want&&tr.notional>want-tr.entryPrice*.001*1.01,`notional ${tr.notional} vs ${want}`);
  assert.equal(tr.entryContext?.sizeMultiple,10);
  assert.equal(tr.leverage,20,"1% stop needs a 2% liquidation buffer: 20x clears at mmr 0.5%");
  assert.ok(Math.abs(tr.margin-tr.notional/20)<1e-6);
  assert.ok(tr.liquidationPrice!>tr.stopPrice*1.02,"short liquidation well above the stop");
  assert.deepEqual(tr.entryContext?.s1,{v:"S1",branch:"follow",signal:"SHORT",side:"SHORT",btc:0.8,stop:1,tp:6,hold:1440});
  assert.equal(tr.entryContext?.entryGate,undefined,"the old gate is not applied to S1 trades");
  const row=orderRecord(tr);
  assert.equal(row.entry_rule,"S1");
  assert.deepEqual({a:row.btc1h_aligned_pct,b:row.s1_branch,o:row.original_side,s:row.s1_side,p:row.s1_plan,st:row.s1_stop_pct,tp:row.s1_tp_pct,x:row.s1_exit_reason},
    {a:0.8,b:"follow",o:"SHORT",s:"SHORT",p:"TP6_SL1",st:1,tp:6,x:null});
});

test("leverage steps down for the 1% stop when the maintenance rate is high; TREND sizes at 5x",async()=>{
  const {error,t}=await open("TREND",-0.9,{quantoMultiplier:.001,leverageMax:50,maintenanceRate:.03,minContracts:1});
  assert.equal(error,null);
  // need 1/L − 3% − 0.2% >= 2%  →  L <= 19.2  →  19x
  assert.equal(t!.leverage,19);
  const want=1000*.0055*5/(.01+.0019);
  assert.ok(t!.notional<=want&&t!.notional>want-t!.entryPrice*.001*1.01,`notional ${t!.notional}`);
  assert.equal(t!.entryContext?.sizeMultiple,5);
});

test("reverse opens the opposite side with the order's own stop width mirrored, no target, 6h",async()=>{
  const ref=await open("TRANSITION",null);// same signal outside TREND/SHOCK: the order's own stop, untouched
  const ownStop=ref.t!.rule.stopRate;
  const {error,t,quote}=await open("SHOCK",0.3);// BTC +0.3% against a SHORT → aligned −0.3 → reverse → LONG
  assert.equal(error,null);const tr=t!;
  assert.equal(tr.side,"LONG");assert.equal(tr.entryPrice,quote.bestAsk);
  assert.ok(tr.stopPrice<tr.entryPrice,"long stop below entry");
  assert.ok(Math.abs((tr.entryPrice-tr.stopPrice)/tr.entryPrice-ownStop)<1e-6,`mirrored own stop ${ownStop}`);
  assert.equal(tr.expectedHoldMinutes,360);
  assert.equal(tr.entryContext?.s1?.branch,"reverse");assert.equal(tr.entryContext?.s1?.signal,"SHORT");assert.equal(tr.entryContext?.s1?.side,"LONG");
  assert.equal(tr.entryContext?.s1?.btc,-0.3);assert.ok(Math.abs(tr.entryContext!.s1!.stop!-ownStop*100)<1e-3);
  const row=orderRecord(tr);
  assert.equal(row.s1_plan,"own_stop_6h");assert.equal(row.s1_tp_pct,null);assert.equal(row.original_side,"SHORT");assert.equal(row.s1_side,"LONG");
  assert.deepEqual(shadowSignalOf(row as never),{side:"SHORT",gateBtc1hPct:0.3},"shadow replay of an S1 row uses the original signal and the same BTC value");
});

test("BTC missing in SHOCK: nothing opens, a note-only row carries the S1 columns with an empty branch",async()=>{
  const {error,state,t}=await open("SHOCK",null);
  assert.equal(error,null);assert.equal(state.positions.length,0);
  assert.equal(t!.unopened,true);
  const row=orderRecord(t!);
  assert.equal(row.entry_rule,"NOT_OPENED");assert.equal(row.s1_branch,null);assert.equal(row.btc1h_aligned_pct,null);assert.equal(row.original_side,"SHORT");
});

test("non-TREND/SHOCK: opened exactly as before (no S1 note, no S1 columns, no extra stored bytes)",async()=>{
  const {openIntelligenceTradeForTest}=await import("../lib/forward-relations.ts");
  const a=await fixture("TRANSITION"),b=await fixture("TRANSITION");
  const c={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1};
  assert.equal(openIntelligenceTradeForTest(a.state,a.opportunity as never,a.quote as never,c as never,T,1000,undefined,undefined,undefined,null,null,true),null);
  assert.equal(openIntelligenceTradeForTest(b.state,b.opportunity as never,b.quote as never,c as never,T,1000,undefined,undefined,undefined,null,null,true,null,null),null);
  const ta=a.state.unopenedTrades![0]!,tb=b.state.unopenedTrades![0]!;
  assert.equal(JSON.stringify(ta),JSON.stringify(tb));
  assert.equal(ta.entryContext?.s1,undefined);
  const row=orderRecord(ta);
  for(const k of ["btc1h_aligned_pct","s1_branch","original_side","s1_side","s1_plan","s1_stop_pct","s1_tp_pct","s1_exit_reason"])assert.ok(!(k in row),k);
  for(const k of ["s1_branch","s1_exit_reason","btc1h_aligned_pct"])assert.ok(!(LOG_REQUIRED as readonly string[]).includes(k)&&!(LOG_REQUIRED_WHEN_CLOSED as readonly string[]).includes(k));
});

/** A minimal open market-intelligence trade carrying an S1 note, managed by the real exit lane. */
async function managed(note:S1Note|null,side:"LONG"|"SHORT",openedAt:number,quotes:[number,number][]){
  const {initialForward,drainLegacyForwardPositions}=await import("../lib/forward-relations.ts");
  const {MARKET_INTELLIGENCE_VERSION}=await import("../lib/market-intelligence-engine.ts");
  const s=initialForward(T-86_400_000*2),d=side==="LONG"?1:-1,entry=100,stopPct=note?.stop??2;
  const t={id:"mi-s1",symbol:"ETH_USDT",side,openedAt,closedAt:null,status:"OPEN",entryPrice:entry,exitPrice:null,quantity:10,contracts:10000,
    quantoMultiplier:.001,notional:1000,leverage:20,margin:50,liquidationPrice:entry*(1-d*.045),maintenanceRate:.005,plannedRisk:12,
    stopPrice:entry*(1-d*stopPct/100),armPrice:entry*(1+d*(note?.tp??4)/100),favorable:0,adverse:0,lastPrice:entry,lastQuoteAt:openedAt,
    entryFee:.7,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:openedAt,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,expectedHoldMinutes:note?.hold??180,
    rule:{id:"r",signature:"x",parentId:null,version:1,createdAt:openedAt,expiresAt:openedAt+86_400_000,status:"EXPERIMENTAL",conditions:[],side,horizon:360,stopRate:stopPct/100,
      armRate:0,givebackRate:0,exitMode:"HORIZON",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:.01,priorResponse:null,recentResponse:0,standardError:0,
      reason:"t",mutation:"CREATE",grammar:MARKET_INTELLIGENCE_VERSION,liveEligible:false},
    entryContext:{version:"adaptive-ten-entry-v1",capturedAt:openedAt,timeframe:"5m",side,mode:"CONTINUATION",reserve:false,reason:"t",entryScore:60,
      directionStrength:60,spaceScore:60,positionScore:60,executionScore:60,remainingSpaceRate:.02,pullbackRiskRate:.01,edgeRatio:2,expectedHoldMinutes:180,
      marketFit:1,regionId:null,strategyVersion:MARKET_INTELLIGENCE_VERSION,environment:"SHOCK",...(note?{s1:note}:{})}} as unknown as Trade;
  s.positions=[t];
  const out:Trade[]=[];
  for(const [i,[px,minutes]] of quotes.entries()){
    const now=openedAt+minutes*60_000;
    drainLegacyForwardPositions(s,{now,quotes:{ETH_USDT:{bestBid:px,bestAsk:px,observedAt:now,fresh:true}},paths:{},contracts:{}});
    void i;const done=s.history.find(x=>x.id==="mi-s1");if(done){out.push(done);break;}
  }
  return {s,closed:out[0]};
}

test("managed exits: follow TP fills at the 6% target, follow SL at the 1% stop, reverse leaves at 6h; S1 columns carry the exit",async()=>{
  const follow:S1Note={v:"S1",branch:"follow",signal:"LONG",side:"LONG",btc:0.9,stop:1,tp:6,hold:1440};
  const tp=await managed(follow,"LONG",T,[[103,5],[106.4,30]]);
  assert.equal(tp.closed?.exitReason,"S1_TP");assert.ok(Math.abs(tp.closed!.exitPrice!-106)<1e-9,"TP limit fills at the target");
  assert.equal(orderRecord(tp.closed!).s1_exit_reason,"TP");
  const sl=await managed(follow,"LONG",T,[[99.5,5],[98.95,6]]);
  assert.equal(sl.closed?.exitReason,"S1_SL");assert.equal(orderRecord(sl.closed!).s1_exit_reason,"SL");
  const rev:S1Note={v:"S1",branch:"reverse",signal:"LONG",side:"SHORT",btc:0.1,stop:2,tp:null,hold:360};
  const time=await managed(rev,"SHORT",T,[[95,30],[90,200],[99,359],[98.5,360]]);
  assert.equal(time.closed?.exitReason,"S1_TIME_6H","no take profit on reverse; held until 6h");
  assert.equal(time.closed?.exitPrice,98.5);assert.equal(orderRecord(time.closed!).s1_exit_reason,"TIME_6H");
  const revStop=await managed(rev,"SHORT",T,[[101,5],[102.05,6]]);
  assert.equal(revStop.closed?.exitReason,"S1_SL","own stop mirrored above a reverse short");
  const day=await managed(follow,"LONG",T,[[101,60],[102,1440]]);
  assert.equal(day.closed?.exitReason,"S1_TIME_24H");
});

test("S1 trades bypass the old exit managers (peak giveback, rhythm, position value, profit floors); positions without a note keep them",async()=>{
  const follow:S1Note={v:"S1",branch:"follow",signal:"LONG",side:"LONG",btc:0.9,stop:1,tp:6,hold:1440};
  // +5.5% then back to +4.6%: the old SHOCK/TREND giveback (5–10% peak, 0.8 pt) would exit; S1 holds for TP/SL/time
  const s1=await managed(follow,"LONG",T,[[105.5,30],[104.6,31],[104.5,60]]);
  assert.equal(s1.closed,undefined);
  const legacy=await managed(null,"LONG",T,[[100.2,30],[100.1,400]]);
  assert.ok(!legacy.closed||!String(legacy.closed.exitReason).startsWith("S1_"),"an existing (pre-deploy) position never gets an S1 exit");
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const lane=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function markAndManage"));
  assert.ok(lane.indexOf("liquidateIfHit(")<lane.indexOf("manageS1Trade(")&&lane.indexOf("manageS1Trade(")<lane.indexOf("entryContext?.transitionRule"),
    "liquidation first, then S1, before every other exit");
});

test("S1 replaces the old gate on the TREND/SHOCK path only; nothing here touches the live executor or Gate",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const advance=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  const nonTrend=advance.indexOf('if(stage!=="SHOCK"&&stage!=="TREND")'),s1=advance.indexOf("s1Decision({stage,signalSide:o.side,btc1hPct})");
  assert.ok(nonTrend>0&&s1>nonTrend,"S1 runs after the TRANSITION/ROTATION note-only branch");
  assert.doesNotMatch(advance,/entryGate\(/,"the old gate no longer decides TREND/SHOCK direction (not double-applied)");
  assert.match(advance,/openIntelligenceTrade\([^;]*,true,null,s1d\.note\)/);
  assert.match(advance,/openIntelligenceTrade\([^;]*,false,null,s1Note\)/);
  const mod=readFileSync(new URL("../lib/s1-rule.ts",import.meta.url),"utf8");
  assert.doesNotMatch(mod,/^import /m,"pure module");
  assert.doesNotMatch(mod,/fetch\(|gate-live|gate-readonly/);
});

test("closed S1 rows through the run-log book: columns present on S1 rows only",async()=>{
  const follow:S1Note={v:"S1",branch:"follow",signal:"SHORT",side:"SHORT",btc:1.1,stop:1,tp:6,hold:1440};
  const r=await managed(follow,"SHORT",T,[[93.9,20]]);
  assert.equal(r.closed?.exitReason,"S1_TP");
  const book=accountLogBook(r.s,{},T+60*60_000);
  const row=book.positions.find(x=>x.id==="mi-s1")!;
  assert.equal(row.entry_rule,"S1");assert.equal(row.s1_branch,"follow");assert.equal(row.s1_exit_reason,"TP");assert.equal(row.original_side,"SHORT");
  assert.equal(s1Fields(undefined,null,false),null);
});
