import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceMarketAuthority,initialMarketAuthority,routeMarketCoin,routeStillPermitted,validMarketAuthority,
  MARKET_AUTHORITY_VERSION,type CoinEpisode,type MarketAuthority,type MarketRoute} from '../lib/market-authority.ts';
import type {MarketSymbolState,CandleLike} from '../lib/market-intelligence-engine.ts';
import {initialForward,type Opportunity,type Quote,normalizeForward,forwardUrgentQuoteSymbols,forwardUrgentMinuteSymbols} from '../lib/forward-relations.ts';
import {migrateDirectStrategy,researchDirectPlan,openDirectPlan,advanceDirectStrategy} from '../lib/direct-strategy.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {advancePaperExecution} from '../lib/paper-execution.ts';
import {buildProportionalMirror} from '../lib/live-parity.ts';
import {liveProtectionPrice,isInverseLiveReceipt} from '../lib/live-source-policy.ts';
const B=300000,T=1791000000000;
const symbols=['A_USDT','B_USDT','C_USDT'];
const bar=(at:number,open:number,high:number,low:number,close:number):CandleLike=>({time:at/1000,open,high,low,close,volume:100});
const base=Array.from({length:12},(_,i)=>bar(T+(i-15)*B,100,102,98,i%2?100.5:99.5));
const up=[bar(T-3*B,102.2,103,102.1,102.8),bar(T-2*B,102.8,103.8,102.7,103.4),bar(T-B,103.4,104.1,103.2,104)];
const down=up.map(r=>({...r,open:200-r.open,high:200-r.low,low:200-r.high,close:200-r.close}));
const quote=(price=104,at=T):Quote=>({bestBid:price-.01,bestAsk:price+.01,observedAt:at,fresh:true,entryReady:true,sourceCount:3});
const state=(symbol:string):MarketSymbolState=>({symbol,watchScore:90,regime:'MARKET_TREND',stage:'READY',clusterId:symbol,
  correlation:.9,beta:1,volatility:.002,dataConfidence:95,actualMove:.03,expectedMove:.03,residual:0,residualZ:0,
  residualPersistence:0,relativeStrength:.5,longScore:90,shortScore:90,pathLong:.8,pathShort:.8,roomLong:.1,roomShort:.1,
  sourceCount:3,venueAgreement:1,venuePressure:0,reasons:[],signalSide:'LONG',signalSince:T,signalBars:3,signalLastBar:T});
function observe(previous?:MarketAuthority,now=T,tail=up){return advanceMarketAuthority({previous,now,ready:true,symbols,
  paths:Object.fromEntries(symbols.map(s=>[s,[...base,...tail]])),states:Object.fromEntries(symbols.map(s=>[s,state(s)])),
  quotes:Object.fromEntries(symbols.map(s=>[s,quote(tail.at(-1)!.close,now)]))});}
function coin(phase:'UP'|'DOWN'|'RANGE'):CoinEpisode{
  return{reference:{lower:98,upper:102,center:100,formedAt:T-3*B,balanced:true,basis:'OHLCV_PROXY'},lastAt:T,
    phase,side:phase==='RANGE'?null:phase==='UP'?'LONG':'SHORT',proofAt:T,stop:phase==='DOWN'?98:102,
    eventPrice:phase==='DOWN'?96:104,atr:4,warning:false,failed:false,rejected:phase==='RANGE'?'SHORT':null,
    rejectedAt:T,rejectedPrice:102,extreme:103,upperFailed:true,lowerFailed:true,
    independentBars:0,independentAt:T,relation:'FOLLOWER',reason:'synthetic completed structure'};
}
function active(phase:'UP'|'DOWN'|'RANGE'):MarketAuthority{
  const a=initialMarketAuthority(T-60000);return{...a,phase,since:T-60000,fresh:true,cohort:symbols,groups:3,coverage:3,
    coins:Object.fromEntries(symbols.map(s=>[s,coin(phase)]))};
}
function opportunity(r:MarketRoute):Opportunity{return{id:`route:${r.proofAt}`,symbol:'A_USDT',side:r.side,marketRoute:r,mode:'CONTINUATION',
  premium:false,score:90,eligible:true,completedAt:T,expiresAt:T+600000,price:r.side==='LONG'?104:102,
  stopPrice:r.stop,targetPrice:r.target,stopRate:.02,targetRate:.06,directionStrength:90,pathEfficiency:90,momentumPersistence:90,
  positionScore:90,spaceScore:90,executionScore:90,grossRemainingSpaceRate:.06,netRemainingSpaceRate:.058,pullbackRiskRate:.02,
  edgeRatio:3,expectedHoldMinutes:180,marketFit:90,regionId:null,regionQuality:null,reason:r.reason,strategyVersion:'market-intelligence-v1',
  sourceCount:3,dataConfidence:95,clusterId:'A',winnerPlan:{version:'winner-preservation-v1',intent:r.branch==='RETURN'?'RANGE':'TREND',
    eventAt:T,initialStop:r.stop,target:r.branch==='RETURN'?r.target:null,targetArea:null,origin:r.reference,riskGroup:'A',source:'RELATIVE_CORE'}};}
function account(a:MarketAuthority){const s=initialForward(T-3600000);migrateDirectStrategy(s,T);s.directStrategy!.marketAuthority=a;
  s.extremumRegime.symbols=Object.fromEntries(symbols.map(x=>[x,state(x)]));s.extremumRegime.updatedAt=T;return s;}
const contract={quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01};
test('completed departure and retained progress elect a single UP or DOWN branch',()=>{
  for(const [tail,phase,side] of [[up,'UP','LONG'],[down,'DOWN','SHORT']] as const){
    const a=observe(undefined,T,tail);assert.equal(a.phase,phase);assert.equal(a.fresh,true);assert.ok(validMarketAuthority(a));
    for(const s of symbols){const r=routeMarketCoin(a,s,tail.at(-1)!.close,T)!;
      assert.equal(r.branch,'CONTINUATION');assert.equal(r.side,side);assert.equal(r.relation,'FOLLOWER');}
  }
});
test('one follower can have a different amplitude or residual label but cannot invert market permission',()=>{
  const a=active('UP');a.coins.B_USDT=coin('RANGE');
  assert.equal(routeMarketCoin(a,'B_USDT',102,T),null);assert.equal(routeMarketCoin(a,'A_USDT',104,T)!.branch,'CONTINUATION');
});
test('handoff cannot silently become a return and missing coverage cannot create a fresh intent',()=>{
  const a=active('RANGE');a.phase='HANDOFF';assert.equal(routeMarketCoin(a,'A_USDT',102,T),null);
  const stale=advanceMarketAuthority({previous:active('UP'),now:T,ready:false,symbols,paths:{},states:{},quotes:{}});
  assert.equal(stale.phase,'UP');assert.equal(stale.fresh,false);assert.equal(routeMarketCoin(stale,'A_USDT',104,T),null);
});
test('market warning retains accepted trend; common broken support enters handoff before reversal',()=>{
  const a=observe();const firstStop=a.coins.A_USDT!.stop;
  const one=[...up,bar(T,104,104.2,firstStop-.9,firstStop-.8)];
  const warning=observe(a,T+B,one);assert.equal(warning.phase,'UP');assert.equal(warning.warning,true);
  const two=[...one,bar(T+B,firstStop-.8,firstStop+.1,firstStop-1.2,firstStop-1)];
  const failed=observe(warning,T+2*B,two);assert.equal(failed.phase,'HANDOFF');
  assert.equal(routeMarketCoin(failed,'A_USDT',firstStop-.6,T+2*B),null);
});
test('unconfirmed followers only thin support; they cannot pose as broken accepted supports',()=>{
  for(const revokedSide of [undefined,'SHORT'] as const){
    const a=active('UP');for(const p of Object.values(a.coins)){p.phase='HANDOFF';p.side=null;p.revokedSide=revokedSide;p.failed=!!revokedSide;}
    const next=observe(a,T+2000);assert.equal(next.phase,'UP');assert.equal(next.warning,true);
    assert.equal(routeMarketCoin(next,'A_USDT',104,T+2000),null);
  }
});
test('a recorded support failure remains causal evidence while the next reference is being established',()=>{
  const a=active('UP');for(const p of Object.values(a.coins))Object.assign(p,{phase:'HANDOFF',failed:true,
    revokedSide:'LONG',revokedAt:T-5*B,lastAt:T-5*B,proofAt:T-12*B});
  const quiet=[bar(T-3*B,100,101,99,100),bar(T-2*B,100,101,99,100),bar(T-B,100,101,99,100)];
  const next=observe(a,T,quiet);assert.equal(next.phase,'HANDOFF');
  assert.equal(next.coins.A_USDT!.revokedSide,'LONG');assert.equal(next.coins.A_USDT!.revokedAt,T-5*B);
});
test('same completed bar cannot multiply independent evidence or move a frozen reference',()=>{
  const a=observe();const again=observe(a,T+2000);assert.deepEqual(again.coins,a.coins);
  assert.equal(again.epoch,a.epoch);assert.deepEqual(again.coins.A_USDT!.reference,a.coins.A_USDT!.reference);
});
test('official completed minutes accelerate acceptance against the same five-minute reference',()=>{
  const a=active('RANGE');for(const p of Object.values(a.coins)){p.phase='HANDOFF';p.side=null;p.lastAt=T-3*B;}
  const minutes=Array.from({length:15},(_,i)=>bar(T+(i-15)*60000,i<12?100:102.5+(i-12)*.4,
    i<12?100.5:103+(i-12)*.4,i<12?99.5:102.4+(i-12)*.4,i<12?100:102.9+(i-12)*.4));
  const next=advanceMarketAuthority({previous:a,now:T,ready:true,symbols,
    paths:Object.fromEntries(symbols.map(s=>[s,[...base,bar(T-3*B,100,101,99,100),bar(T-2*B,100,101,99,100),bar(T-B,100,101,99,100)]])),
    minutePaths:Object.fromEntries(symbols.map(s=>[s,minutes])),states:Object.fromEntries(symbols.map(s=>[s,state(s)])),
    quotes:Object.fromEntries(symbols.map(s=>[s,quote(103.7)]))});
  assert.equal(next.phase,'UP');assert.deepEqual(next.coins.A_USDT!.reference,a.coins.A_USDT!.reference);
});
test('independence needs three distinct completed residual observations, never three quote ticks',()=>{
  let a=observe();const v=state('A_USDT');Object.assign(v,{correlation:.2,residual:.015,residualZ:2,residualPersistence:1});
  const run=(now:number,rows:CandleLike[])=>advanceMarketAuthority({previous:a,now,ready:true,symbols,
    paths:Object.fromEntries(symbols.map(s=>[s,rows])),states:{A_USDT:v,B_USDT:state('B_USDT'),C_USDT:state('C_USDT')},
    quotes:Object.fromEntries(symbols.map(s=>[s,quote(rows.at(-1)!.close,now)]))});
  const rows=[...base,...up];a=run(T+2000,rows);assert.equal(a.coins.A_USDT!.independentBars,0);
  for(let n=1;n<=3;n++){rows.push(bar(T+(n-1)*B,104+n*.2,104.5+n*.2,103.8+n*.2,104.3+n*.2));a=run(T+n*B,rows);
    assert.equal(a.coins.A_USDT!.independentBars,n);assert.equal(a.coins.A_USDT!.relation,n===3?'INDEPENDENT':'FOLLOWER');}
});
test('a synchronous common factor remains one counted group and cannot be multiplied by duplicated members',()=>{
  const names=Array.from({length:9},(_,i)=>`C${i}_USDT`),states=Object.fromEntries(names.map(s=>[s,{...state(s),clusterId:'common'}]));
  const a=advanceMarketAuthority({now:T,ready:true,symbols:names,paths:Object.fromEntries(names.map(s=>[s,[...base,...up]])),states,
    quotes:Object.fromEntries(names.map(s=>[s,quote()]))});
  assert.equal(a.groups,1);assert.equal(a.phase,'UP');assert.equal(a.coverage,8);assert.equal(a.fresh,true);
});
test('both failed departures are required to earn range permission',()=>{
  const a=active('RANGE');for(const p of Object.values(a.coins)){p.phase='HANDOFF';p.side=null;p.lastAt=T-3*B;p.upperFailed=false;p.lowerFailed=false;}
  const attempt=[bar(T-3*B,101.9,103,101.5,101.8),bar(T-2*B,101.8,102,100.7,101),bar(T-B,101,101.1,100,100.5)];
  const onlyOne=observe(a,T,attempt);assert.equal(onlyOne.phase,'HANDOFF');assert.equal(routeMarketCoin(onlyOne,'A_USDT',100.5,T),null);
  attempt.push(bar(T,98.2,98.5,97,98.1),bar(T+B,98.1,99.1,98,99));
  const both=observe(onlyOne,T+2*B,attempt);assert.equal(both.phase,'RANGE');
});
test('gapped venue candles cannot certify a new departure or fresh electorate',()=>{
  const rows=[...base,...up];rows.splice(-2,1);
  const a=advanceMarketAuthority({now:T,ready:true,symbols,paths:Object.fromEntries(symbols.map(s=>[s,rows])),
    states:Object.fromEntries(symbols.map(s=>[s,state(s)])),quotes:Object.fromEntries(symbols.map(s=>[s,quote()]))});
  assert.equal(a.phase,'HANDOFF');assert.equal(a.fresh,false);assert.equal(routeMarketCoin(a,'A_USDT',104,T),null);
});
test('production adapter arms actual direction for both branches instead of standalone trend opening',()=>{
  const names=Array.from({length:6},(_,i)=>`P${i}_USDT`),history=Array.from({length:48},(_,i)=>
    bar(T+(i-51)*B,100,102,98,i%2?100.5:99.5));
  const paths=Object.fromEntries(names.map(s=>[s,[...history,...up]])),quotes=Object.fromEntries(names.map(s=>[s,quote()])),
    contracts=Object.fromEntries(names.map(s=>[s,contract]));
  const next=advanceDirectStrategy({state:initialForward(T-7200000),now:T,marketAuthority:true,paths,quotes,contracts});
  assert.equal(next.state.directStrategy!.marketAuthority!.phase,'UP');assert.equal(next.state.positions.length,0);
  const candidates=next.state.opportunities.filter(o=>o.eligible);assert.ok(candidates.length>0);
  assert.ok(candidates.every(o=>o.side==='LONG'&&o.marketRoute!.branch==='CONTINUATION'));
  const validations=Object.values(next.state.entryValidations).filter(v=>v.status==='WAITING');assert.ok(validations.length>0);
  assert.ok(validations.every(v=>v.side==='LONG'&&v.frozenOpportunity!.marketRoute!.side==='LONG'));
});
test('controller has bounded production metadata under a full thirty-symbol electorate',()=>{
  const names=Array.from({length:30},(_,i)=>`S${i}_USDT`),a=advanceMarketAuthority({now:T,ready:true,symbols:names,
    paths:Object.fromEntries(names.map(s=>[s,[...base,...up]])),states:Object.fromEntries(names.map(s=>[s,state(s)])),
    quotes:Object.fromEntries(names.map(s=>[s,quote()]))});
  assert.equal(Object.keys(a.coins).length,30);assert.ok(validMarketAuthority(a));
  assert.ok(Buffer.byteLength(JSON.stringify(a))<32000);assert.ok(a.events.length<=8);
});
test('frozen observers remain collected during scan rotation and held coin memory wins the thirty-slot bound',()=>{
  const a=observe(),rotated=Array.from({length:30},(_,i)=>`NEW${i}_USDT`),held='HELD_USDT',names=[...symbols,...rotated,held];
  const next=advanceMarketAuthority({previous:a,now:T+2000,ready:true,symbols:rotated,protectedSymbols:[held],
    paths:Object.fromEntries(names.map(s=>[s,[...base,...up]])),states:Object.fromEntries(names.map(s=>[s,state(s)])),
    quotes:Object.fromEntries(names.map(s=>[s,quote(104,T+2000)]))});
  assert.deepEqual(next.cohort,a.cohort);assert.equal(next.fresh,true);assert.ok(next.coins[held]);
  assert.equal(Object.keys(next.coins).length,30);
  const s=account(next);assert.ok(forwardUrgentQuoteSymbols(s,T+2000,names).includes(symbols[0]!));
  assert.ok(forwardUrgentMinuteSymbols(s,names).includes(symbols[0]!));
  assert.ok(forwardUrgentMinuteSymbols(s,names).length<=11);
});
test('only sustained independent permission can detach from the common branch',()=>{
  const a=active('DOWN');a.coins.A_USDT=coin('UP');
  assert.equal(routeMarketCoin(a,'A_USDT',104,T),null);
  a.coins.A_USDT!.relation='INDEPENDENT';a.coins.A_USDT!.independentBars=3;
  const r=routeMarketCoin(a,'A_USDT',104,T)!;assert.equal(r.side,'LONG');assert.equal(r.relation,'INDEPENDENT');
  a.coins.A_USDT!.relation='FOLLOWER';assert.equal(routeStillPermitted(a,r,'A_USDT'),false);
});
test('return requires failed attempt and uses actual side stop, finite center and position baseline',()=>{
  const a=active('RANGE'),r=routeMarketCoin(a,'A_USDT',102,T)!;assert.equal(r.branch,'RETURN');assert.equal(r.side,'SHORT');
  assert.equal(r.stop,103);assert.equal(r.target,100);
  const s=account(a),o=opportunity(r),q=quote(102),input={state:s,now:T,quotes:{A_USDT:q},paths:{},contracts:{A_USDT:contract}},
    p=researchDirectPlan(s,o,input);assert.equal(p.side,o.side);
  assert.equal(openDirectPlan(s,p,q,contract,T,{A_USDT:q}),undefined);
  const t=s.positions[0]!;assert.equal(t.side,'SHORT');assert.equal(t.unified!.returnLogic!.moveSide,t.side);
  assert.equal(t.entryContext!.winnerPlan!.intent,'RANGE');assert.equal(t.stopPrice,r.stop);
  assert.equal(t.unified!.marketRoute!.targetBasis,'ACCEPTED_CENTER');normalizeForward(s,T);
});
test('actual return holding hits its own stop or finite target and never promotes into a trend',()=>{
  for(const [price,reason] of [[103.1,'MARKET_ROUTE_STRUCTURE_EXIT'],[99.9,'RANGE_CENTER_EXIT']] as const){
    const a=active('RANGE'),r=routeMarketCoin(a,'A_USDT',102,T)!,s=account(a),o=opportunity(r),q=quote(102),
      p=researchDirectPlan(s,o,{state:s,now:T,quotes:{A_USDT:q},paths:{},contracts:{A_USDT:contract}});
    assert.equal(openDirectPlan(s,p,q,contract,T,{A_USDT:q}),undefined);
    const next=advanceDirectStrategy({state:s,now:T+2000,quotes:{A_USDT:quote(price,T+2000)},paths:{},contracts:{A_USDT:contract}});
    assert.equal(next.state.positions.length,0);assert.equal(next.state.history[0]!.exitReason,reason);
    assert.equal(next.state.history[0]!.id,s.positions[0]!.id);
  }
});
test('both new branches pass shared LIVE admission and reach a later fresh PAPER book fill with own protection',()=>{
  for(const phase of ['UP','RANGE'] as const){
    const a=active(phase),price=phase==='UP'?104:102,r=routeMarketCoin(a,'A_USDT',price,T)!,s=account(a),o=opportunity(r),
      c={...contract,enableDecimal:false,orderSizeMin:'1',orderSizeMax:'100000'},q={...quote(price),
        bids:[{price:price-.01,size:100000}],asks:[{price:price+.01,size:100000}]},
      p=researchDirectPlan(s,o,{state:s,now:T,quotes:{A_USDT:q},paths:{},contracts:{A_USDT:c}});
    s.paperExecution={version:'live-steps-paper-v1',cutoverAt:T,cancelled:[]};
    assert.equal(openDirectPlan(s,p,q,c,T,{A_USDT:q},undefined,undefined,{prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK',samples:0}),undefined);
    const t=s.positions[0]!;assert.equal(s.balance,1000);assert.notEqual(t.paperOrder!.phase,'FILLED');
    const mirror=buildProportionalMirror({source:t,sourceEquity:1000,equity:1000,available:1000,entryPrice:price,
      quantoMultiplier:c.quantoMultiplier,leverageMax:c.leverageMax,maintenanceRate:c.maintenanceRate,
      openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,now:T,policy:'synthetic',mirrorRatio:1,
      sourceRiskAuthority:true,sizeRules:{enableDecimal:false,orderSizeMin:'1',orderSizeMax:'100000'}});
    assert.equal(isInverseLiveReceipt(mirror.binding.receipt),false);assert.equal(mirror.binding.receipt.marketAuthorityVersion,MARKET_AUTHORITY_VERSION);
    assert.equal(liveProtectionPrice(t),r.stop);assert.equal(mirror.binding.receipt.nativeProtectionPrice,r.stop);
    for(const dt of [2000,4000,6000])advancePaperExecution(s,{A_USDT:{...q,observedAt:T+dt}},{A_USDT:c},T+dt);
    assert.equal(s.positions[0]!.paperOrder!.phase,'FILLED',s.paperExecution.cancelled[0]?.exitReason);
    assert.ok(s.balance<1000);assert.equal(s.positions[0]!.side,r.side);normalizeForward(s,T+6000);
  }
});
test('new branches share entry response; stale epoch and opposing unsettled follower exposure block admission',()=>{
  const a=active('UP'),r=routeMarketCoin(a,'A_USDT',104,T)!,s=account(a),o=opportunity(r),q=quote(),
    p=researchDirectPlan(s,o,{state:s,now:T,quotes:{A_USDT:q},paths:{},contracts:{A_USDT:contract}});
  a.epoch++;assert.match(openDirectPlan(s,p,q,contract,T,{A_USDT:q})! ,/许可/);a.epoch--;
  assert.equal(openDirectPlan(s,p,q,contract,T,{A_USDT:q}),undefined);const t=s.positions[0]!;
  t.symbol='B_USDT';t.unified!.branch='RETURN';delete t.unified!.marketRoute;
  assert.match(openDirectPlan(s,p,q,contract,T+2000,{A_USDT:quote(104,T+2000),B_USDT:quote(104,T+2000)})!,/旧市场分支/);
});
test('confirmed independent route survives an unrelated market epoch but not loss of independence',()=>{
  const a=active('DOWN');a.coins.A_USDT=coin('UP');a.coins.A_USDT!.relation='INDEPENDENT';
  const r=routeMarketCoin(a,'A_USDT',104,T)!,s=account(a),q=quote(),o=opportunity(r),
    p=researchDirectPlan(s,o,{state:s,now:T,quotes:{A_USDT:q},paths:{},contracts:{A_USDT:contract}});
  a.epoch++;assert.equal(openDirectPlan(s,p,q,contract,T,{A_USDT:q}),undefined);
  a.coins.A_USDT!.relation='FOLLOWER';assert.equal(routeStillPermitted(a,r,'A_USDT'),false);
});
test('bounded controller checkpoint preserves episode, account and financial identities; rejects corruption',()=>{
  const s=account(observe()),before=structuredClone(s);s.storage.persistedAt=T;
  const checkpoint=buildForwardProtectionCheckpoint(s);const restored=restoreForwardProtectionCheckpoint(s,checkpoint);
  assert.deepEqual(restored.directStrategy!.marketAuthority,s.directStrategy!.marketAuthority);
  assert.equal(restored.startedAt,before.startedAt);assert.equal(restored.balance,before.balance);
  checkpoint.directMemory!.marketAuthority!.epoch=NaN;
  assert.throws(()=>restoreForwardProtectionCheckpoint(s,checkpoint),/市场许可/);
});
test('cutover retains financial history and manual account generation without a replay',()=>{
  const s=initialForward(T-3600000);s.balance=917;s.fees=23;s.resolved=91;
  const next=advanceDirectStrategy({state:s,now:T,marketAuthority:true,paths:{},quotes:{},contracts:{}});
  assert.equal(next.state.balance,917);assert.equal(next.state.fees,23);assert.equal(next.state.resolved,91);
  assert.equal(next.state.startedAt,s.startedAt);assert.equal(next.state.directStrategy!.marketAuthority!.version,MARKET_AUTHORITY_VERSION);
  assert.equal(next.state.positions.length,0);assert.equal(next.changed,true);
});
