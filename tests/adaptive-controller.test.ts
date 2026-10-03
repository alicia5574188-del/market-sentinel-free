import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveMarketRoute,adaptiveHoldingDecision,ADAPTIVE_CONTROLLER_VERSION} from '../lib/adaptive-controller.ts';
import {advanceEpisodeResearch,researchHolding} from '../lib/episode-research.ts';
import {initialMarketAuthority,type CoinEpisode} from '../lib/market-authority.ts';
import {initialForward,normalizeForward,type Candle,type Quote,type Trade} from '../lib/forward-relations.ts';
import {migrateDirectStrategy,advanceDirectStrategy} from '../lib/direct-strategy.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
const T=1791000000000;
const bar=(at:number,p:number):Candle=>({time:at/1000,open:p,high:p+.1,low:p-.1,close:p,volume:100});
const paths=Array.from({length:24},(_,i)=>bar(T-(24-i)*300000,100));
const minutes=(prices:number[])=>prices.map((p,i)=>bar(T-(prices.length-i)*60000,p));
const q=(price=102):Quote=>({bestBid:price,bestAsk:price+.01,observedAt:T,fresh:true,entryReady:true,sourceCount:3});
function setup(){
  const a=initialMarketAuthority(T-3600000);a.fresh=true;a.phase='HANDOFF';a.routingPolicy='mixed-own-structure-v1';a.cohort=['A_USDT'];
  const p:CoinEpisode={reference:{lower:98,upper:103,center:100,formedAt:T-3600000,balanced:true,basis:'OHLCV_PROXY'},
    lastAt:T,phase:'HANDOFF',side:null,dataReady:true,proofAt:T-600000,stop:99,eventPrice:104,atr:1,
    warning:false,failed:false,rejected:'SHORT',rejectedAt:T,rejectedPrice:102,extreme:103.1,upperFailed:true,lowerFailed:false,
    independentBars:0,independentAt:0,relation:'FOLLOWER',reason:'actual failed departure'};
  a.coins.A_USDT=p;
  const state={symbol:'A_USDT',clusterId:'A',dataConfidence:90,sourceCount:3};
  const i={now:T,accountStartedAt:T-7200000,authority:a,states:{A_USDT:state} as never,paths:{A_USDT:paths},
    minutePaths:{A_USDT:minutes([103.2,102.5,102])},quotes:{A_USDT:q()},positions:[] as Trade[],history:[] as Trade[]};
  const r=advanceEpisodeResearch(i).symbols.A_USDT!;
  return{a,p,r,i};
}
function holding(side:'LONG'|'SHORT'='LONG'):Trade{const d=side==='LONG'?1:-1;
  return{id:'held',symbol:'A_USDT',status:'OPEN',side,openedAt:T-1200000,closedAt:null,entryPrice:100,
    quantity:10,contracts:10,quantoMultiplier:1,notional:1000,margin:200,leverage:5,plannedRisk:11,
    stopPrice:100-d,lastPrice:100,lastQuoteAt:T,entryFee:.5,exitFee:0,favorable:0,adverse:0,
    unified:{version:'dual-thesis-v2',branch:'CONTINUATION',initialStop:100-d,marketRoute:{branch:'CONTINUATION',side,target:100+d*10},
      explanationEvents:[]},entryContext:{winnerPlan:{initialStop:100-d}},review:{peakNetPnl:0}} as unknown as Trade;
}
test('actual failed departure can return without a redundant two-sided range embargo',()=>{
  const {a,r,i}=setup(),x=adaptiveMarketRoute(a,r,'A_USDT',102,T,i.minutePaths.A_USDT,paths);
  assert.equal(x.route?.branch,'RETURN');assert.equal(x.route?.side,'SHORT');assert.equal(x.route?.target,100);
  assert.equal(x.route?.controllerVersion,ADAPTIVE_CONTROLLER_VERSION);assert.equal(x.route?.relation,'LOCAL');
});
test('failed continuation has its own frozen response price even without a range rejection price',()=>{
  const {a,p,r,i}=setup();p.side='LONG';p.failed=true;p.rejected=null;p.rejectedPrice=0;
  Object.assign(r,{phase:'RECOVERY_FAILED',side:'LONG',frontier:103.3,failedAt:T-60000,failedPrice:102.2,failedPriceAt:T});
  i.minutePaths.A_USDT=minutes([103.2,102.5,102.2]);
  r.hypotheses.return={side:'SHORT',stage:'FAILED_TREND',basisAt:T,target:100};
  const x=adaptiveMarketRoute(a,r,'A_USDT',102.4,T,i.minutePaths.A_USDT,paths);
  assert.equal(x.route?.branch,'RETURN');assert.equal(x.route?.proofPrice,102.2);assert.equal(x.route?.proofAt,T);
});
test('extension alone, stale coverage and a target behind the actual direction cannot authorize a return',()=>{
  const {a,r,i}=setup();
  for(const changed of [{...r,fresh:false},{...r,hypotheses:{...r.hypotheses,return:{...r.hypotheses.return,stage:'UNCONFIRMED' as const}}},
    {...r,hypotheses:{...r.hypotheses,return:{...r.hypotheses.return,target:103}}}])
    assert.equal(adaptiveMarketRoute(a,changed,'A_USDT',102,T,i.minutePaths.A_USDT,paths).route,null);
});
test('accepted persistent uptrend vetoes a blind fade; a genuine independent failure can qualify',()=>{
  const {a,p,r,i}=setup();a.phase='UP';
  assert.equal(adaptiveMarketRoute(a,r,'A_USDT',102,T,i.minutePaths.A_USDT,paths).code,'ADAPTIVE_SUSTAINED_TREND');
  p.relation='INDEPENDENT';assert.equal(adaptiveMarketRoute(a,r,'A_USDT',102,T,i.minutePaths.A_USDT,paths).route?.branch,'RETURN');
});
test('continuation uses the stable research anchor and rejects chasing a distant holding premise',()=>{
  const {a,p,r}=setup();a.phase='UP';p.phase='UP';p.side='LONG';p.stop=103.8;p.atr=4;p.eventPrice=104;p.rejected=null;
  const proven={...r,side:'LONG' as const,phase:'ADVANCING' as const,holdingSupport:102};
  const x=adaptiveMarketRoute(a,proven,'A_USDT',104,T);assert.equal(x.route?.stop,102);
  assert.equal(adaptiveMarketRoute(a,{...proven,holdingSupport:98},'A_USDT',104,T).code,'ADAPTIVE_HOLDING_LOCATION');
});
test('market handoff and a fast coin stop cannot close an intact filled holding or tighten its hard stop',()=>{
  const {a,p}=setup(),t=holding();p.side='LONG';p.phase='HANDOFF';p.failed=true;p.stop=103.8;
  const before=JSON.stringify(t),x=adaptiveHoldingDecision(t,q(102),T,paths,minutes([103,102.5,102]),a);
  assert.equal(x.exit,null);assert.equal(x.stop,99);assert.equal(x.observed.premise,'PULLBACK');assert.equal(JSON.stringify(t),before);
});
test('a completed holding pivot is observed without turning its single wick into a hard exit',()=>{
  const {a}=setup(),t=holding();t.entryPrice=101;t.notional=1010;
  const old=researchHolding(t,undefined,{paths,minutes:minutes([102,102.5,103]),quote:q(103),now:T});
  old.holdingSupport=101;old.holdingSupportAt=T-300000;
  const x=adaptiveHoldingDecision(t,q(101.5),T,paths,minutes([102,101.8,101.5]),a,old);
  assert.equal(x.exit,null);assert.equal(x.stop,99);assert.equal(x.memory.holdingSupport,101);
});
test('completed anchor break plus failed recovery exits before the wider initial loss boundary',()=>{
  const {a}=setup(),t=holding(),old=researchHolding(t,undefined,{paths,quote:q(),now:T});old.holdingSupport=101;
  const x=adaptiveHoldingDecision(t,q(100.3),T,paths,minutes([101.5,100.7,100.3]),a,old);
  assert.equal(x.exit,'ADAPTIVE_RECOVERY_FAILED');assert.equal(x.stop,99);
});
test('one reclaim does not restore damaged premise; inherited controller memory survives observation eviction',()=>{
  const {a}=setup(),t=holding();t.unified!.adaptive={version:ADAPTIVE_CONTROLLER_VERSION,adoptedAt:T-1000,
    holdingSupport:101,holdingSupportAt:T-300000,peakNetPnl:0,premise:'RECOVERY_FAILED',sourceAt:T-60000,
    signal:'EXIT_CANDIDATE',reason:'failed'};
  const x=adaptiveHoldingDecision(t,q(101.2),T,paths,minutes([100.5,100.7,101.2]),a);
  assert.equal(x.memory.premise,'RECOVERY_BUILDING');assert.equal(x.exit,null);assert.equal(x.memory.holdingSupport,101);
});
test('earned profit with completed counter-pressure tightens protection and never widens an existing stop',()=>{
  const {a}=setup(),t=holding();t.review!.peakNetPnl=49;
  const x=adaptiveHoldingDecision(t,q(103.2),T,paths,minutes([104.5,104,103.2]),a);
  assert.equal(x.exit,null);assert.ok(x.stop>103&&x.stop<103.2);
  t.stopPrice=103.1;const next=adaptiveHoldingDecision(t,q(104),T,paths,minutes([103,103.5,104]),a);
  assert.equal(next.stop,103.1);assert.equal(next.exit,null);
});
test('gross winner that already crossed its cost-aware floor exits at current price, without invented peak fills',()=>{
  const {a}=setup(),t=holding();t.review!.peakNetPnl=49;
  const x=adaptiveHoldingDecision(t,q(102),T,paths,minutes([104,103,102]),a);
  assert.equal(x.exit,'ADAPTIVE_EARNED_PROFIT_EXIT');assert.ok(x.observed.netPnl!<29.4);assert.equal(t.status,'OPEN');
});
test('healthy rising profit, slow starts, missing candles and stale quotes do not receive an age exit',()=>{
  const {a}=setup();
  for(const [prices,price] of [[[104,104.5,105],105],[[100.01,100.02,100.03],100.03]] as const){
    const t=holding();t.openedAt=T-7200000;t.review!.peakNetPnl=prices[0]>104?49:0;
    assert.equal(adaptiveHoldingDecision(t,q(price),T,paths,minutes([...prices]),a).exit,null);
  }
  const t=holding();t.review!.peakNetPnl=49;
  assert.equal(adaptiveHoldingDecision(t,q(102),T,[],[],a).exit,null);
  assert.equal(adaptiveHoldingDecision(t,{...q(102),fresh:false},T,paths,minutes([104,103,102]),a).exit,null);
});
test('actual hard stops still work when the research or common-market inputs are unavailable',()=>{
  const {a}=setup();a.fresh=false;
  for(const side of ['LONG','SHORT'] as const){const t=holding(side),x=adaptiveHoldingDecision(t,q(side==='LONG'?98:102),T,[],[],a);
    assert.equal(x.exit,'ADAPTIVE_HARD_PROTECTION');assert.equal(x.stop,t.stopPrice);}
  assert.equal(adaptiveHoldingDecision(holding(),{...q(98),fresh:false},T,[],[],a).exit,null);
  assert.equal(adaptiveHoldingDecision(holding(),{...q(98),observedAt:T+1},T,[],[],a).exit,null);
});
test('short profit defense and short failed recovery mirror long logic',()=>{
  const {a}=setup(),t=holding('SHORT');t.review!.peakNetPnl=49;
  const x=adaptiveHoldingDecision(t,q(96.8),T,paths,minutes([95.5,96,96.8]),a);
  assert.equal(x.exit,null);assert.ok(x.stop<97&&x.stop>96.8);
  const old=researchHolding(t,undefined,{paths,quote:q(),now:T});old.holdingSupport=99;
  const damaged=adaptiveHoldingDecision(t,q(99.7),T,paths,minutes([98.5,99.3,99.7]),a,old);
  assert.equal(damaged.exit,'ADAPTIVE_RECOVERY_FAILED');
});
test('future and pre-entry candles cannot trigger earned-profit decisions',()=>{
  const {a}=setup(),t=holding();t.openedAt=T;t.review!.peakNetPnl=49;
  const x=adaptiveHoldingDecision(t,q(102),T,paths,[...minutes([104,103,102]),bar(T+60000,50)],a);
  assert.equal(x.exit,null);assert.equal(x.observed.premise,'UNOBSERVED');
});
test('controller memory is part of financial protection restoration; account identity and old history remain',()=>{
  const {a}=setup(),s=initialForward(T-7200000);migrateDirectStrategy(s,T);s.directStrategy!.marketAuthority=a;
  s.directStrategy!.adaptive={version:ADAPTIVE_CONTROLLER_VERSION,cutoverAt:T};const t=holding();s.positions=[t];
  t.unified!.adaptive=adaptiveHoldingDecision(t,q(103),T,paths,minutes([102,102.5,103]),a).memory;
  const restored=restoreForwardProtectionCheckpoint(s,buildForwardProtectionCheckpoint(s));
  assert.deepEqual(restored.positions[0]!.unified!.adaptive,t.unified!.adaptive);assert.equal(restored.startedAt,s.startedAt);
});
test('real execution controller ignores a permission-only handoff while managing an actual route holding',()=>{
  const {a}=setup(),s=initialForward(T-7200000);migrateDirectStrategy(s,T);s.directStrategy!.marketAuthority=a;
  s.directStrategy!.adaptive={version:ADAPTIVE_CONTROLLER_VERSION,cutoverAt:T};const t=holding(),ref=a.coins.A_USDT!.reference;
  Object.assign(t.unified!,{sourceId:'own-entry',referenceId:'own-entry',entryReason:'accepted own direction',holdReason:'retained support',
    exitCondition:'failed recovery',epsilon:0,region:ref,lastDecisionAt:T-60000,lastBarAt:T-60000,referenceContracts:t.contracts,
    confirmation:{side:'LONG',at:t.openedAt,bars:[t.openedAt],path:'HOLD_OUTSIDE',stop:99,boundary:103,epsilon:0},
    marketRoute:{version:'market-regime-authority-v1',epoch:1,phase:'UP',relation:'LOCAL',branch:'CONTINUATION',side:'LONG',
      proofAt:t.openedAt,stop:99,target:110,targetBasis:'VOLATILITY_ESTIMATE',reference:ref,reason:'accepted'}});
  Object.assign(t,{rule:{expiresAt:T+3600000},armPrice:110,fundingAllowance:0,netPnl:null,grossPnl:null,exitPrice:null,exitReason:null,
    relationFailureBars:0,lastRelationBar:0,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false});s.positions=[t];
  // Missing whole-market coverage preserves the filled own-price hard boundary.
  const next=advanceDirectStrategy({state:s,now:T,allowDataCycle:false,quotes:{A_USDT:q(102)},paths:{A_USDT:paths},
    minutePaths:{A_USDT:minutes([103,102.5,102])},contracts:{A_USDT:{quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1}}});
  assert.equal(next.state.positions[0]!.status,'OPEN');assert.ok(next.state.positions[0]!.unified!.adaptive);
  assert.equal(next.state.startedAt,s.startedAt);assert.equal(next.state.history.length,0);
  const corrupt=structuredClone(next.state);corrupt.positions[0]!.unified!.adaptive!.holdingSupport=NaN;
  assert.throws(()=>normalizeForward(corrupt,T),/自适应持仓依据损坏/);
});
