/**
 * S1 was withdrawn (user, 2026-10-19: "退回旧规则"). New TREND/SHOCK trades use the earlier entry gate again;
 * trades S1 opened that are still open keep their stored stop / leverage / liquidation price and are managed by the
 * earlier exit stack; rows S1 already closed keep exporting and rendering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {WINNER_POLICY_VERSION as V,type WinnerPlan} from "../lib/winner-policy.ts";
import type {MarketSymbolState,CandleLike} from "../lib/market-intelligence-engine.ts";
import {initialForward,normalizeForward,fillForwardPortfolio,advanceForward,type Opportunity,type Trade,type ForwardState} from "../lib/forward-relations.ts";
import {orderRecord} from "../lib/order-journal.ts";
import {closedLogRow} from "../lib/run-log.ts";
import * as s1 from "../lib/s1-rule.ts";
import type {S1Note} from "../lib/s1-rule.ts";

const T=1790809800000,B=300000;
const healthy:MarketSymbolState={symbol:"TEST_USDT",watchScore:90,regime:"DIVERGENT",stage:"READY",clusterId:"corr:TEST",correlation:.5,beta:1,volatility:.004,dataConfidence:96,actualMove:.025,expectedMove:.003,residual:.022,residualZ:1.8,residualPersistence:1,relativeStrength:.8,longScore:90,shortScore:10,pathLong:.9,pathShort:.1,roomLong:.05,roomShort:.001,sourceCount:4,venueAgreement:1,venuePressure:.7,reasons:[],signalSide:"LONG",signalSince:T-3*B,signalBars:3,signalLastBar:T};
const plan=():WinnerPlan=>({version:V,intent:"TREND",eventAt:T-B,initialStop:99,target:null,targetArea:null,origin:null,riskGroup:"corr:TEST:LONG:TREND",source:"RELATIVE_CORE"});
const quote=(price:number,now=T)=>({bestBid:price,bestAsk:price,midpoint:price,observedAt:now,fresh:true,entryReady:true,sourceCount:4,disagreementRate:0,bookImbalance:.4,bidLiquidityChange:.2,askLiquidityChange:-.2,liquiditySourceCount:3});
function row(time:number,open:number,close:number,low=Math.min(open,close)-.1,high=Math.max(open,close)+.1):CandleLike{return{time:time/1000,open,close,low,high,volume:100};}

/** A long opened by the current code, then dressed up exactly as S1 left its open trades: S1 note, S1 stop as the
 * winner plan's initial stop, S1 take-profit as armPrice / plan target, 20x with the liquidation price fixed at open. */
function s1Open(branch:"follow"|"reverse"="follow"){
  const s=initialForward(T-B);s.extremumRegime.symbols.TEST_USDT=healthy;s.extremumRegime.updatedAt=T;
  const o:Opportunity={id:"test-winner",symbol:"TEST_USDT",side:"LONG",mode:"RELATIVE",premium:true,score:90,eligible:true,completedAt:T,expiresAt:T+B,price:100,stopPrice:99,targetPrice:105,stopRate:.01,targetRate:.05,directionStrength:90,pathEfficiency:90,momentumPersistence:100,positionScore:80,spaceScore:90,executionScore:100,grossRemainingSpaceRate:.05,netRemainingSpaceRate:.0481,pullbackRiskRate:.01,edgeRatio:4.81,expectedHoldMinutes:180,marketFit:80,regionId:null,regionQuality:null,reason:"S1 legacy fixture",strategyVersion:"market-intelligence-v1",winnerPlan:plan(),tradePlan:"WINNER_TREND",liquidityInvalidationPrice:99,clusterId:healthy.clusterId,thesisId:"test-winner"};
  s.opportunities=[o];
  assert.equal(fillForwardPortfolio(s,{TEST_USDT:quote(100)},{TEST_USDT:{quantoMultiplier:.01,leverageMax:50,maintenanceRate:.005,minContracts:1}},T,1000,false),1);
  const t=s.positions[0]!;
  const note:S1Note=branch==="follow"?{v:"S1",branch:"follow",signal:"LONG",side:"LONG",btc:.8,stop:1,tp:6,hold:1440}
    :{v:"S1",branch:"reverse",signal:"SHORT",side:"LONG",btc:-.3,stop:1,tp:null,hold:360};
  t.entryContext!.s1=note;delete t.entryContext!.entryGate;
  t.stopPrice=99;t.entryContext!.winnerPlan!.initialStop=99;t.entryContext!.winnerPlan!.target=branch==="follow"?106:null;
  t.armPrice=branch==="follow"?106:t.armPrice;t.expectedHoldMinutes=branch==="follow"?1440:360;
  t.leverage=20;t.margin=t.notional/20;t.maintenanceRate=.005;t.liquidationPrice=100*(1-1/20)/(1-.005);
  t.entryContext!.stageNote={...(t.entryContext!.stageNote??{}),liveStage:"SHOCK"} as never;
  if(branch==="reverse")delete t.positionIntelligence;// S1 reverse trades were opened without an entry assessment of their own side
  delete t.winnerManagement;// S1's manager never wrote one
  return {s,t};
}
const tick=(state:ForwardState,now:number,px:number,minutes?:CandleLike[])=>advanceForward({state,now,paths:{},minutePaths:minutes?{TEST_USDT:minutes as never}:undefined,
  quotes:{TEST_USDT:quote(px,now)},contracts:{TEST_USDT:{quantoMultiplier:.01,leverageMax:50,maintenanceRate:.005,minContracts:1}} as never}).state;
const find=(state:ForwardState,id:string)=>(state.positions.find(t=>t.id===id)??state.history.find(t=>t.id===id)) as Trade;

test("S1 decision code is gone: the old gate decides TREND/SHOCK and no S1 exit runs",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  for(const re of [/s1Decision/,/s1Levels/,/s1Exit/,/manageS1Trade/,/S1_PLAN/])assert.doesNotMatch(core,re);
  const advance=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  assert.match(advance,/entryGate\(gateInput\)/);
  const loop=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function manageIntelligenceTrades")+1600);
  assert.doesNotMatch(loop,/s1/i,"no S1 branch in the position manager: legacy S1 trades fall through to the earlier exits");
  for(const k of ["s1Decision","s1Levels","s1Exit","S1_FOLLOW_MIN_PCT"])assert.equal(k in s1,false,`${k} no longer exported`);
});

test("an open S1 trade survives a reload untouched (note, stop, leverage, margin, liquidation price)",()=>{
  const {s,t}=s1Open();
  const before={stop:t.stopPrice,lev:t.leverage,margin:t.margin,liq:t.liquidationPrice,arm:t.armPrice,note:structuredClone(t.entryContext!.s1)};
  const n=normalizeForward(structuredClone(s),T+1000),r=n.positions[0]!;
  assert.deepEqual({stop:r.stopPrice,lev:r.leverage,margin:r.margin,liq:r.liquidationPrice,arm:r.armPrice,note:r.entryContext!.s1},before);
});

test("open S1 follow trade, quiet market: stays open, nothing recomputed, stop never loosened",()=>{
  const {s,t}=s1Open();
  const liq=t.liquidationPrice,lev=t.leverage,margin=t.margin;
  const next=tick(s,T+60_000,100.4),r=find(next,t.id);
  assert.equal(r.status,"OPEN");
  assert.equal(r.leverage,lev);assert.equal(r.margin,margin);assert.equal(r.liquidationPrice,liq);
  assert.ok(r.stopPrice>=99,`stop ${r.stopPrice} not looser than the S1 stop`);
  assert.ok((r.winnerManagement?.protectedStop??0)>=99,"winner manager starts from the S1 stop");
  assert.equal(r.entryContext?.s1?.branch,"follow");
});

test("open S1 follow trade does not take profit at the old 6% target; the old 5%-peak giveback applies instead",()=>{
  const {s,t}=s1Open();
  let st=tick(s,T+60_000,106.2);
  assert.equal(find(st,t.id).status,"OPEN","no S1_TP: the 6% armPrice / plan target is not an exit for a TREND winner plan");
  st=tick(st,T+120_000,105.3);// peak 6.2%, now 5.3%: gave back 0.9% ≥ 0.8% → old PEAK_GIVEBACK
  const r=find(st,t.id);
  assert.equal(r.status,"CLOSED");assert.equal(r.exitReason,"PEAK_GIVEBACK");
});

test("open S1 trades get no 6h / 24h time exit; the stored stop still closes them (old structure exit)",()=>{
  for(const branch of ["follow","reverse"] as const){
    const {s,t}=s1Open(branch);
    let st=tick(s,T+7*3600_000,100.3);
    const mid=find(st,t.id);
    assert.ok(mid.status==="OPEN"||!String(mid.exitReason).startsWith("S1_"),`${branch}: no S1 time exit (${mid.exitReason})`);
    assert.equal(mid.status,"OPEN",`${branch}: still open after 7h (${mid.exitReason})`);
    st=tick(st,T+7*3600_000+60_000,98.9,[row(T+7*3600_000,99.4,98.9,98.85,99.45)]);
    const r=find(st,t.id);
    assert.equal(r.status,"CLOSED",`${branch}: stop hit`);
    assert.notEqual(r.exitReason,"LIQUIDATION");assert.ok(!String(r.exitReason).startsWith("S1_"));
    assert.ok(r.exitPrice!>98.5&&r.exitPrice!<=99,`${branch}: filled near the S1 stop, got ${r.exitPrice}`);
  }
});

test("open S1 trade at 20x still liquidates on a gap past its stored liquidation price",()=>{
  const {s,t}=s1Open();
  const liq=t.liquidationPrice!;
  const st=tick(s,T+60_000,95,[row(T,95.2,95)]),r=find(st,t.id);
  assert.equal(r.status,"CLOSED");assert.equal(r.exitReason,"LIQUIDATION");assert.ok(Math.abs(r.exitPrice!-liq)<1e-9);
});

test("historical S1 rows keep exporting: entry_rule S1, S1 columns, S1_* exit codes; later old-stack exits recorded as is",()=>{
  const {t}=s1Open();
  const closed=(code:string)=>({...structuredClone(t),status:"CLOSED" as const,closedAt:T+B,exitPrice:99,exitReason:code,netPnl:-10,grossPnl:-9,exitFee:.1});
  for(const [code,short] of [["S1_TP","TP"],["S1_SL","SL"],["S1_TIME_6H","TIME_6H"],["S1_TIME_24H","TIME_24H"],["LIQUIDATION","LIQUIDATION"],["PEAK_GIVEBACK","PEAK_GIVEBACK"]]){
    const row=orderRecord(closed(code!));
    assert.equal(row.entry_rule,"S1");assert.equal(row.s1_branch,"follow");assert.equal(row.s1_plan,"TP6_SL1");assert.equal(row.s1_exit_reason,short);
    const log=closedLogRow(closed(code!));
    assert.equal(log.exit_trigger,code);assert.equal(log.s1_exit_reason,short);assert.equal(log.leverage,20);
  }
  const open=orderRecord(t);assert.equal(open.entry_rule,"S1");assert.equal(open.s1_exit_reason,null);
  assert.deepEqual(s1.S1_EXIT_CODES,["S1_SL","S1_TP","S1_TIME_6H","S1_TIME_24H"]);
});

test("order cards keep readable labels for S1 exit codes and the 顺势/反向 tag (read-only)",()=>{
  const card=readFileSync(new URL("../app/order-card.tsx",import.meta.url),"utf8");
  for(const code of s1.S1_EXIT_CODES){
    assert.match(card,new RegExp(`${code}:"[^"]+"`),`${code} short label`);
    assert.ok(card.split(`${code}:"`).length>=3,`${code} has a short and a plain label`);
  }
  const dash=readFileSync(new URL("../app/forward-dashboard.tsx",import.meta.url),"utf8");
  for(const code of s1.S1_EXIT_CODES)assert.match(dash,new RegExp(`${code}:"[^"]+"`));
  assert.match(dash,/function s1Tag\(t:Trade\)/);assert.match(dash,/const n=t\.entryContext\?\.s1;/);
  assert.match(dash,/S1 已退回旧规则/);
});

test("garbage in entryContext.s1 is ignored, not a crash",()=>{
  for(const bad of [null,undefined,1,"S1",{},{v:"S1"},{v:"S2",signal:"LONG",side:"LONG"},{v:"S1",signal:"UP",side:"LONG"}])
    assert.equal(s1.s1Fields(bad,"S1_TP",true),null,JSON.stringify(bad));
});
