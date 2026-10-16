import test from 'node:test';
import assert from 'node:assert/strict';
import {WINNER_POLICY_VERSION as V,trendCore,selectWinnerOpportunity,reactionGeometry,advanceWinnerManagement,rhythmBreakDecision,type WinnerPlan} from '../lib/winner-policy.ts';
import type {MarketSymbolState,CandleLike} from '../lib/market-intelligence-engine.ts';
import {realizeTradeSlice,assertTradeRealization,realizedContribution} from '../lib/trade-realization.ts';
import {initialForward,normalizeForward,fillForwardPortfolio,manageWinnerTrade,forwardEquity,type Opportunity} from '../lib/forward-relations.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {winnerEventHeadroom,recordWinnerRiskLoss,type WinnerRiskLedger} from '../lib/winner-risk.ts';
import {prepareForwardWrite,readForwardStore} from '../lib/forward-store.ts';
const T=1790809800000,B=300000;
const healthy:MarketSymbolState={symbol:'TEST_USDT',watchScore:90,regime:'DIVERGENT',stage:'READY',clusterId:'corr:TEST',correlation:.5,beta:1,volatility:.004,dataConfidence:96,actualMove:.025,expectedMove:.003,residual:.022,residualZ:1.8,residualPersistence:1,relativeStrength:.8,longScore:90,shortScore:10,pathLong:.9,pathShort:.1,roomLong:.05,roomShort:.001,sourceCount:4,venueAgreement:1,venuePressure:.7,reasons:[],signalSide:'LONG',signalSince:T-3*B,signalBars:3,signalLastBar:T};
function row(time:number,open:number,close:number,low=Math.min(open,close)-.1,high=Math.max(open,close)+.1):CandleLike{return{time:time/1000,open,close,low,high,volume:100};}
function plan(intent:'TREND'|'RANGE'='TREND'):WinnerPlan{return{version:V,intent,eventAt:T-B,initialStop:99,target:intent==='RANGE'?102:null,targetArea:null,origin:null,riskGroup:'corr:TEST:LONG:'+intent,source:intent==='RANGE'?'EDGE_REJECTION':'RELATIVE_CORE'};}
const quote=(price:number,now=T)=>({bestBid:price,bestAsk:price,midpoint:price,observedAt:now,fresh:true,entryReady:true,sourceCount:4,disagreementRate:0,bookImbalance:.4,bidLiquidityChange:.2,askLiquidityChange:-.2,liquiditySourceCount:3});
function fixture(){const s=initialForward(T-B);s.extremumRegime.symbols.TEST_USDT=healthy;s.extremumRegime.updatedAt=T;
  const p=plan(),o:Opportunity={id:'test-winner',symbol:'TEST_USDT',side:'LONG',mode:'RELATIVE',premium:true,score:90,eligible:true,completedAt:T,expiresAt:T+B,price:100,stopPrice:99,targetPrice:105,stopRate:.01,targetRate:.05,directionStrength:90,pathEfficiency:90,momentumPersistence:100,positionScore:80,spaceScore:90,executionScore:100,grossRemainingSpaceRate:.05,netRemainingSpaceRate:.0481,pullbackRiskRate:.01,edgeRatio:4.81,expectedHoldMinutes:180,marketFit:80,regionId:null,regionQuality:null,reason:'Synthetic accounting and policy fixture; never a profitability replay',strategyVersion:'market-intelligence-v1',winnerPlan:p,tradePlan:'WINNER_TREND',liquidityInvalidationPrice:99,clusterId:healthy.clusterId,thesisId:'test-winner'};
  s.opportunities=[o];assert.equal(fillForwardPortfolio(s,{TEST_USDT:quote(100)},{TEST_USDT:{quantoMultiplier:.01,leverageMax:10,maintenanceRate:.005,minContracts:1}},T,1000,false),1);return{s,t:s.positions[0]!};}
const inputs={side:'LONG' as const,price:104.5,entryPrice:100,openedAt:T,now:T+3*B,plan:plan(),rows:[] as CandleLike[],cost:.0019,remainingFraction:1,concernFamilies:[] as string[],supportFamilies:['PATH','STRUCTURE'],positionExit:false,trendEligible:true};

test('relative core keeps independent entry authority without a map or a full-region breakout',()=>{
  for(const price of [100,110]){const o=selectWinnerOpportunity({state:healthy,price,rows:[],now:T,majorScore:-.2,shortScore:0});assert.equal(o.eligible,true);assert.equal(o.plan.source,'RELATIVE_CORE');assert.equal(o.plan.intent,'TREND');assert.equal(o.mode,'REVERSAL');}
});
test('relative outperformance while the asset itself declines is not a long entry',()=>{
  assert.equal(trendCore({state:{...healthy,actualMove:-.01},side:'LONG',price:100,cost:.0019,majorScore:0,shortScore:0}).eligible,false);
});
test('range definition precedes the excursion and keeps its full wick extremes',()=>{
  const base=Array.from({length:12},(_,i)=>row(T-(15-i)*B,i%2?103.3:100.7,i%2?103.4:100.6,i%2?103:100,i%2?104:101));
  const rows=[...base,row(T-3*B,100.3,100.2,99.8,100.4),row(T-2*B,100.2,100.4,100.1,100.5),row(T-B,100.4,100.5,100.3,100.6)];
  const g=reactionGeometry(rows,T);assert.equal(g.area?.balanced,true);assert.equal(g.area?.lower,100);assert.equal(g.area?.upper,104);assert.equal(g.rejection?.side,'LONG');
  const o=selectWinnerOpportunity({state:{...healthy,longScore:60,shortScore:40,residualZ:.1,actualMove:0},price:100.4,rows,now:T,majorScore:0,shortScore:0});
  assert.equal(o.eligible,true);assert.equal(o.plan.intent,'RANGE');assert.equal(o.plan.target,g.area?.center);assert.ok(o.plan.target!<104);assert.ok(o.plan.initialStop<99.8);
  const late=selectWinnerOpportunity({state:{...healthy,longScore:60,shortScore:40,residualZ:.1,actualMove:0},price:101.9,rows,now:T,majorScore:0,shortScore:0});assert.equal(late.eligible,false);
});
test('incomplete/future candles cannot provide an entry or a protection event',()=>{
  const g=reactionGeometry([row(T,100,110)],T+1);assert.equal(g.rows.length,0);
  const x=advanceWinnerManagement({...inputs,rows:[row(T+3*B,100,80)],now:T+3*B+10});assert.equal(x.state.lastBarAt,0);assert.equal(x.action,'HOLD');
});
test('healthy runner may exceed its first estimated target and tolerate a normal pullback',()=>{
  const a=advanceWinnerManagement({...inputs,price:104.5,plan:{...plan(),target:103},rows:[]});assert.equal(a.action,'HOLD');
  const b=advanceWinnerManagement({...inputs,price:103.8,previous:a.state,now:inputs.now+2000,plan:{...plan(),target:103}});assert.equal(b.action,'HOLD');assert.ok(b.state.protectedStop<=103.8);
});
test('re-entry ineligibility, a single relative concern, and elapsed time do not close a good runner',()=>{
  for(const age of [1,120,500]){const x=advanceWinnerManagement({...inputs,now:T+age*60000,price:103.5,trendEligible:false,concernFamilies:['RELATIVE']});assert.equal(x.action,'HOLD');}
});
test('pre-existing structure protection and hard loss boundary exit immediately',()=>{
  const loss=advanceWinnerManagement({...inputs,price:98.9,now:T+1000});assert.equal(loss.action,'EXIT');
  const checkpoint=advanceWinnerManagement({...inputs,price:103,currentStop:103.1});assert.equal(checkpoint.action,'EXIT');assert.equal(checkpoint.state.protectedStop,103.1);
});
test('finite return to center exits unless own new trend authority supports promotion',()=>{
  const a=advanceWinnerManagement({...inputs,plan:plan('RANGE'),price:102,trendEligible:false});assert.equal(a.reason,'RANGE_CENTER_EXIT');
  const b=advanceWinnerManagement({...inputs,plan:plan('RANGE'),price:102,trendEligible:true});assert.equal(b.action,'HOLD');assert.equal(b.state.promotedAt,inputs.now);assert.equal(b.state.targetLevel,null);
});
test('obstacle reduction needs a later complete post-entry bar, not two seconds or delayed data',()=>{
  const p={...plan(),target:104.8},rows=[row(T,104.8,104.7,104.6,104.9),row(T+B,104.7,104.5,104.4,104.8)];
  const a=advanceWinnerManagement({...inputs,plan:p,now:T+2*B+100,rows,concernFamilies:['RELATIVE']});assert.equal(a.action,'HOLD');assert.equal(a.state.obstacleBars,0);
  const b=advanceWinnerManagement({...inputs,plan:p,now:T+2*B+2100,rows,previous:a.state,concernFamilies:['RELATIVE']});assert.equal(b.action,'HOLD');assert.equal(b.state.obstacleBars,0);
  const c=advanceWinnerManagement({...inputs,plan:p,now:T+3*B+100,rows:[...rows,row(T+2*B,104.5,104.4,104.3,104.7)],previous:b.state,concernFamilies:['RELATIVE']});
  assert.equal(c.action,'REDUCE');assert.ok(c.fraction<=.65);const done={...c.state,trimCount:1,lastTrimEvent:c.state.obstacleSince};
  assert.equal(advanceWinnerManagement({...inputs,plan:p,now:T+3*B+2100,rows:[...rows,row(T+2*B,104.5,104.4,104.3,104.7)],previous:done,concernFamilies:['RELATIVE']}).action,'HOLD');
});
test('shock and trend lock a 1.5 point giveback only after a 10 point peak',()=>{
  const armed=fixture();
  armed.t.entryContext!.environment="SHOCK";
  armed.t.favorable=.16;armed.t.peakPnlRate=.16;
  assert.equal(manageWinnerTrade(armed.s,armed.t,quote(114.6,T+2*B),T+2*B,{},{}),false);
  assert.equal(armed.t.status,"OPEN");
  assert.equal(manageWinnerTrade(armed.s,armed.t,quote(114.4,T+3*B),T+3*B,{},{}),true);
  assert.equal(armed.t.exitReason,"PEAK_GIVEBACK");
  const early=fixture();
  early.t.entryContext!.environment="TREND";
  early.t.favorable=.09;early.t.peakPnlRate=.09;
  assert.equal(manageWinnerTrade(early.s,early.t,quote(107,T+2*B),T+2*B,{},{}),false);
  assert.equal(early.t.status,"OPEN");
  const other=fixture();
  other.t.entryContext!.environment="TRANSITION";
  other.t.favorable=.16;other.t.peakPnlRate=.16;
  assert.equal(manageWinnerTrade(other.s,other.t,quote(114,T+2*B),T+2*B,{},{}),false);
  assert.equal(other.t.status,"OPEN");
});
function rhythmPath(stall:number){
  const px:number[]=[];let price=100;
  for(let i=0;i<40;i++){if(i%4===0)price+=.35;px.push(price);}
  for(let i=0;i<stall;i++)px.push(price-.2-i*.12);
  return px.map((value,i)=>({time:(T+i*60_000)/1000,open:value,high:value+.05,low:value-.05,close:value,volume:1}));
}
test('a shock or trend exit follows this trade’s own push rhythm, at the live quote',()=>{
  const stalled=rhythmPath(12),last=stalled.at(-1)!,now=last.time*1000+60_000;
  const broken=rhythmBreakDecision({side:'LONG',entryPrice:100,openedAt:T,now,price:last.close,minutes:stalled,cost:.0019});
  assert.equal(broken.exit,true);
  const brief=rhythmPath(3),end=brief.at(-1)!;
  assert.equal(rhythmBreakDecision({side:'LONG',entryPrice:100,openedAt:T,now:end.time*1000+60_000,price:end.close,minutes:brief,cost:.0019}).exit,false);
  const trend=fixture();
  trend.t.entryContext!.environment="TREND";
  assert.equal(manageWinnerTrade(trend.s,trend.t,quote(last.close,now),now,{},{TEST_USDT:stalled}),true);
  assert.equal(trend.t.exitReason,"RHYTHM_BREAK");
  assert.equal(trend.t.exitPrice,last.close);
  const transition=fixture();
  transition.t.entryContext!.environment="TRANSITION";
  assert.equal(manageWinnerTrade(transition.s,transition.t,quote(last.close,now),now,{},{TEST_USDT:stalled}),false);
  assert.equal(transition.t.status,"OPEN");
  const stamped=fixture();
  stamped.t.entryContext!.environment="TRANSITION";
  stamped.t.entryContext!.stageNote={liveStage:"TREND",priorStage:"TRANSITION",stageAgeMin:4,minutesSinceShock:null,shockPush:0,syncDrop:null};
  assert.equal(manageWinnerTrade(stamped.s,stamped.t,quote(last.close,now),now,{},{TEST_USDT:stalled}),true);
  assert.equal(stamped.t.exitReason,"RHYTHM_BREAK");
  assert.equal(stamped.t.exitPrice,last.close);
});
test('expectancy, a five-point giveback, and a later small loss do not add an exit',()=>{
  const reached=fixture();
  reached.t.entryContext!.marketExpectancy=.02;
  assert.equal(manageWinnerTrade(reached.s,reached.t,quote(102,T+2*B),T+2*B,{},{}),false);
  assert.equal(reached.t.status,'OPEN');
  const giveback=fixture();
  giveback.t.favorable=.05;giveback.t.peakPnlRate=.05;giveback.t.firstProfitAt=T;giveback.t.entryContext!.marketExpectancy=.08;
  assert.equal(manageWinnerTrade(giveback.s,giveback.t,quote(104.2,T+2*B),T+2*B,{},{}),false);
  assert.equal(giveback.t.status,'OPEN');
  const loss=fixture();
  loss.t.firstProfitAt=T;loss.t.favorable=.01;
  assert.equal(manageWinnerTrade(loss.s,loss.t,quote(99.4,T+2*B),T+2*B,{},{}),false);
  assert.equal(loss.t.status,'OPEN');
});
test('a profit stop fills near the stop only when the minute traded through it',()=>{
  const {s,t}=fixture();
  t.stopPrice=104;t.favorable=.06;t.lastPrice=105;
  const bar={time:(T+60_000)/1000,open:105,high:105.2,low:102,close:102,volume:1};
  assert.equal(manageWinnerTrade(s,t,quote(102,T+2*B),T+2*B,{},{TEST_USDT:[bar]}),true);
  assert.equal(t.exitReason,'WINNER_STRUCTURE_EXIT');
  assert.ok(Math.abs(t.exitPrice!-104*.999)<1e-8);
  const missed=fixture();
  missed.t.stopPrice=104;missed.t.favorable=.06;missed.t.lastPrice=102.5;
  assert.equal(manageWinnerTrade(missed.s,missed.t,quote(102,T+2*B),T+2*B,{},{}),true);
  assert.equal(missed.t.exitPrice,102);
});
test('partial realization, then final close: entry fee once, original identity once, money reconciles',()=>{
  const {s,t}=fixture(),n=t.notional,q=t.quantity,fee=t.entryFee;
  const r=realizeTradeSlice({trade:t,price:104,now:T+B,quoteAt:T+B,fraction:.4,feeRate:.0007,fundingPerDay:.0002,minContracts:1,reason:'fixture'});assert.ok(r);assertTradeRealization(t);
  s.balance+=r.credit;s.grossPnl+=r.gross;s.fees+=r.fee;s.fundingAllowance+=r.funding;s.turnover+=r.notional;
  const expected=1000-fee+r.credit+(t.quantity*(103-100))-t.quantity*103*.0007;
  assert.ok(Math.abs(forwardEquity(s,{TEST_USDT:quote(103,T+B)},T+B).equity-expected)<1e-8);
  const remaining=t.quantity,remainingNotional=t.notional;
  assert.equal(manageWinnerTrade(s,t,quote(98,T+2*B),T+2*B,{},{}),true);
  assert.equal(t.exitReason,"WINNER_STRUCTURE_EXIT");
  assert.equal(t.exitPrice,98);
  const net=r.gross+remaining*(98-100)-fee-r.fee-remaining*98*.0007-r.funding-remainingNotional*.0002*(2*B)/86400000;
  assert.ok(Math.abs(t.netPnl!-net)<1e-8);assert.ok(Math.abs(s.balance-(1000+net))<1e-8);
  assert.equal(s.resolved,1);assert.equal(s.history.length,1);assert.equal(t.notional,n);assert.equal(t.quantity,q);assertTradeRealization(t);
  assert.ok(Math.abs(s.grossPnl-t.grossPnl!)<1e-8);assert.ok(Math.abs(s.fees-(fee+t.exitFee))<1e-8);
});
test('bad, zero, tiny, nonprofitable and stale reduction requests do not mutate money or sizes',()=>{
  const {t}=fixture(),before=JSON.stringify(t);
  for(const change of [{fraction:0},{fraction:.0001},{fraction:.9},{price:99},{quoteAt:T-10001},{fraction:NaN}])
    assert.equal(realizeTradeSlice({trade:t,price:104,now:T,quoteAt:T,fraction:.4,feeRate:.0007,fundingPerDay:.0002,minContracts:1,reason:'fixture',...change}),null);
  assert.equal(JSON.stringify(t),before);
});
test('remaining size and loss budget survive source-store round trip; corrupted size is rejected',async()=>{
  const {s,t}=fixture();const result=realizeTradeSlice({trade:t,price:104,now:T+B,quoteAt:T+B,fraction:.4,feeRate:.0007,fundingPerDay:.0002,minContracts:1,reason:'fixture'})!;
  s.balance+=result.credit;s.grossPnl+=result.gross;s.fees+=result.fee;s.fundingAllowance+=result.funding;s.turnover+=result.notional;
  s.winnerRisk={key:{eventAt:T-B,loss:5,lastFailureAt:T,updatedAt:T}};
  const write=await prepareForwardWrite(null,s,T+B),memory=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({async get(key:string){return memory.get(key);}} as Parameters<typeof readForwardStore>[0],T+B);
  assert.ok(restored);const state=restored!;assert.deepEqual(state.positions[0]!.realization,t.realization);assert.deepEqual(state.winnerRisk,s.winnerRisk);
  assert.equal(state.balance,s.balance);assertTradeRealization(state.positions[0]!);
  const broken=structuredClone(s);broken.positions[0]!.contracts++;
  assert.throws(()=>normalizeForward(broken,T+B),/兑现/);
});
test('a not-opened partial closed without restoring size loads again and does not move cash',()=>{
  const {s,t}=fixture();
  const result=realizeTradeSlice({trade:t,price:104,now:T+B,quoteAt:T+B,fraction:.4,feeRate:.0007,fundingPerDay:.0002,minContracts:1,reason:'fixture'})!;
  assert.ok(result);
  const initialQty=t.realization!.initialQuantity,booked=s.balance;
  t.unopened=true;t.status='CLOSED';t.closedAt=T+B;
  s.positions=[];s.unopenedTrades=[t];
  const n=normalizeForward(structuredClone(s),T+2*B);
  assert.equal(n.balance,booked);assert.equal(n.positions.length,0);
  const row=n.unopenedTrades![0]!;
  assert.equal(row.quantity,initialQty);assertTradeRealization(row);
});
test('compact protection restoration cannot loosen a new runner stop or repeat an already completed trim',()=>{
  const {s,t}=fixture();t.winnerManagement={...advanceWinnerManagement({...inputs,price:104.5}).state,trimCount:1,lastTrimEvent:T+B};t.stopPrice=t.winnerManagement.protectedStop;
  const later=structuredClone(s);later.positions[0]!.stopPrice=103;later.positions[0]!.winnerManagement!.protectedStop=103;
  const next=restoreForwardProtectionCheckpoint(s,buildForwardProtectionCheckpoint(later));assert.equal(next.positions[0]!.stopPrice,103);assert.equal(next.positions[0]!.winnerManagement!.trimCount,1);
  const check=advanceWinnerManagement({...inputs,price:103.5,previous:t.winnerManagement,currentStop:103});assert.ok(check.state.protectedStop>=103);
});
test('profits and elapsed time cannot replenish failed episode budget; a new causal event can',()=>{
  const l:WinnerRiskLedger={};recordWinnerRiskLoss(l,'group',T-B,-6,T);recordWinnerRiskLoss(l,'group',T-B,30,T+B);
  assert.equal(winnerEventHeadroom(l,'group',T-B,1000,4).headroom,5);
  assert.equal(winnerEventHeadroom(l,'group',T-B,1000,0).headroom,9);
  assert.equal(winnerEventHeadroom(l,'group',T+B+1,1000,0).headroom,15);
});
test('partial contribution excludes entry fee because account already paid it once',()=>{
  const {t}=fixture();realizeTradeSlice({trade:t,price:104,now:T+B,quoteAt:T+B,fraction:.4,feeRate:.0007,fundingPerDay:.0002,minContracts:1,reason:'fixture'});
  assert.equal(realizedContribution(t),t.realization!.gross-t.realization!.fees-t.realization!.funding);
});
