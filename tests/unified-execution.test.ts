import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,normalizeForward,forwardEquity,forwardSummary,closeForwardForReset,type Trade,type Candle,type Quote} from '../lib/forward-relations.ts';
import {applyInverseSourceTrade,newInverseTrial,sourceDecisionState,shadowCapsule,assertInverseTrial} from '../lib/shadow-inverse-ledger.ts';
import {advanceShadowInverse} from '../lib/shadow-inverse.ts';
import {applyUnifiedReference,advanceUnifiedExecution,confirmAcceptance,unifiedReferenceState,UNIFIED_EXECUTION_VERSION} from '../lib/unified-execution.ts';
import {prepareForwardWrite,readForwardStore,prepareForwardProtectionWrite} from '../lib/forward-store.ts';
import {restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {forwardMirrorSources,buildProportionalMirror,mirrorSourceFresh} from '../lib/live-parity.ts';
import {liveProtectionPrice,isInverseLiveReceipt} from '../lib/live-source-policy.ts';
import {buildReviewSnapshot,readReviewArchivePage,mergeReviewArchive} from '../lib/research-snapshot.ts';

const B=300_000,T=1790947200000;
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const quote=(price=100,now=T):Quote=>({bestBid:price,bestAsk:price+.02,observedAt:now,fresh:true,sourceCount:3});
const area={lower:98,upper:102,center:100,formedAt:T-B,balanced:true,basis:'OHLCV_PROXY' as const};
const bar=(at:number,open:number,low:number,high:number,close:number):Candle=>({time:at/1000,open,low,high,close,volume:100});
const up=[bar(T,102.5,102.4,103.2,103),bar(T+B,103,102.8,103.7,103.5)];
const down=[bar(T,97.5,96.8,97.6,97),bar(T+B,97,96.3,97.2,96.5)];
const contracts={TEST_USDT:{quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01}};
function rawTrade(side:Trade['side']='LONG',target:number|null=110):Trade{
  const sign=side==='LONG'?1:-1,stop=100-sign*2,id='source-new';
  return{id,symbol:'TEST_USDT',side,openedAt:T,status:'OPEN',closedAt:null,entryPrice:100,exitPrice:null,quantity:10,contracts:100,
    quantoMultiplier:.1,notional:1000,leverage:10,margin:100,plannedRisk:22,stopPrice:stop,armPrice:100+sign*5,
    favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.7,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,
    relationFailureBars:0,lastRelationBar:0,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    rule:{id,signature:id,parentId:null,version:1,createdAt:T,expiresAt:T+86400000,status:'EXPERIMENTAL',conditions:[],side,
      horizon:180,stopRate:.02,armRate:.001,givebackRate:.001,exitMode:'REACTION_DECAY',samples:0,trainGroups:0,checkGroups:0,
      estimatedNetRate:.05,priorResponse:null,recentResponse:0,standardError:0,reason:'synthetic',mutation:'CREATE',grammar:'market-intelligence-v1',liveEligible:false},
    entryContext:{version:'adaptive-ten-entry-v1',capturedAt:T,timeframe:'5m',side,mode:'RELATIVE',reason:'synthetic',entryScore:90,
      directionStrength:90,spaceScore:90,positionScore:90,executionScore:90,remainingSpaceRate:.1,pullbackRiskRate:.02,edgeRatio:5,
      expectedHoldMinutes:180,marketFit:70,regionId:null,strategyVersion:'market-intelligence-v1',winnerPlan:{version:'winner-preservation-v1',
        intent:'TREND',eventAt:T,initialStop:stop,target,targetArea:null,origin:area,riskGroup:'test',source:'RELATIVE_CORE'}}};
}
function fixture(side:Trade['side']='LONG',target:number|null=110){
  const ref=initialForward(T-10*B);ref.inverseTrial=newInverseTrial(ref,T-4*B,1000);
  const source=sourceDecisionState(ref),t=rawTrade(side,target);
  source.positions.push(t);source.balance-=.7;source.fees+=.7;source.turnover+=1000;
  applyInverseSourceTrade(ref,t,quote(),T);ref.inverseTrial.source=shadowCapsule(source);ref.inverseTrial.lastSourceRevision=source.revision;
  const s=initialForward(ref.startedAt);s.inverseTrial=structuredClone(ref.inverseTrial);
  s.unifiedExecution={version:UNIFIED_EXECUTION_VERSION,cutoverAt:T,reference:shadowCapsule(ref),episodes:{},legacyIds:[],completedConversions:0,droppedEpisodes:0};
  function step(now=T,price=100,rows:Candle[]=[],pressure=1){
    s.extremumRegime.updatedAt=now;
    s.extremumRegime.symbols.TEST_USDT={symbol:'TEST_USDT',watchScore:90,regime:'TREND_UP',stage:'READY',clusterId:'test',correlation:.1,
      beta:1,volatility:.003,dataConfidence:90,actualMove:.03,expectedMove:.01,residual:.02,residualZ:1,residualPersistence:1,
      relativeStrength:.9,longScore:90,shortScore:10,pathLong:.8,pathShort:.2,roomLong:.1,roomShort:.1,sourceCount:3,
      venueAgreement:1,venuePressure:pressure,reasons:[],signalSide:'LONG',signalSince:T,signalBars:3,signalLastBar:now};
    const q=quote(price,now);applyUnifiedReference(s,ref,{now,quotes:{TEST_USDT:q},paths:{TEST_USDT:rows},contracts});
    return q;
  }
  return{s,ref,t,source,step};
}

test('confirmation uses completed bars, full extremes and both directions; gaps and reentry invalidate it',()=>{
  assert.equal(confirmAcceptance({area,epsilon:.02,rows:up,now:T+B,after:T}),null);
  assert.equal(confirmAcceptance({area,epsilon:.02,rows:up,now:T+2*B-1,after:T}),null);
  const a=confirmAcceptance({area,epsilon:.02,rows:up,now:T+2*B,after:T})!;assert.equal(a.side,'LONG');near(a.stop,102.38);
  assert.equal(confirmAcceptance({area,epsilon:.02,rows:down,now:T+2*B,after:T})!.side,'SHORT');
  assert.equal(confirmAcceptance({area,epsilon:.02,rows:[up[0]!,{...up[1]!,time:(T+2*B)/1000}],now:T+3*B,after:T}),null);
  assert.equal(confirmAcceptance({area,epsilon:.02,rows:[...up,bar(T+2*B,103,101,103.1,101.5)],now:T+3*B,after:T}),null);
});
test('retest-resumption requires a completed restart beyond the whole retest high',()=>{
  const rows=[up[0]!,bar(T+B,103,101.95,103.1,102.6),bar(T+2*B,102.6,102.5,103.4,103.2)];
  const a=confirmAcceptance({area,epsilon:.02,rows,now:T+3*B,after:T})!;
  assert.equal(a.path,'RETEST_RESTART');assert.equal(a.bars[0],T+B);near(a.stop,101.93);
});
test('direct return intent pays own side BBO once and preserves frozen reference money',()=>{
  const {s,ref,step}=fixture('SHORT',90),before=JSON.stringify(ref);step();
  const t=s.positions[0]!;assert.equal(t.unified!.branch,'RETURN');assert.equal(t.side,'LONG');near(t.entryPrice,100.02);
  near(t.quantity,10);near(t.entryFee,.5001);near(s.balance,999.4999);near(t.leverage,5);
  assert.equal(JSON.stringify(ref),before);assert.equal(liveProtectionPrice(t),null);assert.ok(t.unified!.entryReason);
  const cash=s.balance;step();near(s.balance,cash);assert.equal(s.positions.length,1);assertInverseTrial(s);
});
test('return-to-continuation charges sunk loss and all switch fees, with a fresh own stop',()=>{
  const {s,ref,step}=fixture();step();const oldId=s.positions[0]!.id,refBefore=JSON.stringify(ref);
  step(T+2*B,103.5,up);const c=s.positions[0]!,old=s.history[0]!;
  assert.equal(old.id,oldId);assert.equal(old.exitReason,'RETURN_ACCEPTANCE_INVALIDATED');assert.equal(c.side,'LONG');assert.equal(c.unified!.branch,'CONTINUATION');
  near(c.entryPrice,103.52);near(c.stopPrice,102.38);near(c.unified!.predecessorNet!,old.netPnl!);
  near(s.balance,1000+old.netPnl!-c.entryFee);near(s.fees,old.entryFee+old.exitFee+c.entryFee);
  assert.equal(JSON.stringify(ref),refBefore);assert.equal(s.unifiedExecution!.completedConversions,1);
  step(T+2*B+2000,103.5,up);assert.equal(s.unifiedExecution!.completedConversions,1);assert.equal(s.positions.length,1);
  step(T+2*B+4000,102.3,up);assert.equal(s.positions.length,0);assert.equal(s.history[0]!.exitReason,'CONTINUATION_STRUCTURE_EXIT');
  near(s.balance,1000+s.history.reduce((n,t)=>n+t.netPnl!,0));
  step(T+2*B+6000,104,up);assert.equal(s.positions.length,0,'same episode must not reopen after a stopped continuation');
});
test('confirmed continuation before a fresh entry does not first manufacture a losing return',()=>{
  const {s,ref,step}=fixture();ref.positions[0]!.inverseCopy!.sourceEntryPlan!.winnerPlan!.origin={...area,formedAt:T-3*B};
  const earlier=up.map(r=>({...r,time:r.time-2*B/1000}));step(T,103.5,earlier);
  assert.equal(s.positions[0]!.unified!.branch,'CONTINUATION');assert.equal(s.history.length,0);assert.equal(s.unifiedExecution!.completedConversions,0);
});
test('market-wide bullish background does not turn individually falling MOVR-like exposure long',()=>{
  const {s,step}=fixture('SHORT',90);step();step(T+2*B,96.5,down,-1);
  assert.equal(s.positions[0]!.side,'SHORT');assert.equal(s.positions[0]!.unified!.branch,'CONTINUATION');
});
test('no new forward trade if current room or fresh data is missing, and old loss remains booked',()=>{
  const {s,step}=fixture('LONG',null);step();step(T+2*B,103.5,up);
  assert.equal(s.positions.length,0);assert.equal(s.history.length,1);assert.ok(s.history[0]!.netPnl!<0);
  assert.match(s.unifiedExecution!.episodes['source-new']!.reason,/缺少/);
  near(s.balance,1000+s.history[0]!.netPnl!);
  const f=fixture();f.step();const cash=f.s.balance;
  applyUnifiedReference(f.s,f.ref,{now:T+2*B,quotes:{TEST_USDT:quote(103.5,T)},paths:{TEST_USDT:up},contracts});
  near(f.s.balance,cash);assert.equal(f.s.history.length,0);assert.equal(f.s.positions[0]!.unified!.branch,'RETURN');
});
test('a large loss / high shadow floating alone cannot authorize a switch',()=>{
  const {s,step}=fixture();step();step(T+1000,115,[],1);
  assert.equal(s.positions[0]!.unified!.branch,'RETURN');assert.equal(s.unifiedExecution!.completedConversions,0);
});
test('same-side accepted movement does not reverse an already aligned return position',()=>{
  const {s,step}=fixture('SHORT',90);step();step(T+2*B,103.5,up,1);
  assert.equal(s.positions[0]!.side,'LONG');assert.equal(s.positions[0]!.unified!.branch,'RETURN');assert.equal(s.history.length,0);
});
test('original end only closes RETURN; CONTINUATION keeps its own life and risk state',()=>{
  const f=fixture();f.step();f.step(T+2*B,103.5,up);
  const mirror=f.ref.positions[0]!;mirror.status='CLOSED';mirror.closedAt=T+2*B+1000;mirror.exitReason='SHADOW_SOURCE_EXIT';
  f.ref.positions=[];f.ref.history=[mirror];f.step(T+2*B+2000,104,up);
  assert.equal(f.s.positions.length,1);assert.equal(f.s.positions[0]!.unified!.branch,'CONTINUATION');
});
test('durable account + protection restore preserve both financial books, new stop, PI and conversion identity',async()=>{
  const {s,step}=fixture();step();step(T+2*B,103.5,up);s.storage.persistedAt=T+2*B;
  const saved=await prepareForwardWrite(null,s,T+2*B,{compact:true}),db=new Map(Object.entries(saved.entries));
  const read={get:async<V>(key:string)=>structuredClone(db.get(key)) as V|undefined};
  const restored=await readForwardStore(read,T+2*B+1);near(restored.balance,s.balance);assertInverseTrial(restored);
  assert.equal(restored.unifiedExecution!.completedConversions,1);assert.equal(restored.positions[0]!.unified!.branch,'CONTINUATION');
  const beforeCash=restored.balance;restored.positions[0]!.favorable=.04;restored.positions[0]!.stopPrice=104;
  restored.positions[0]!.lastPrice=107;restored.positions[0]!.lastQuoteAt=T+2*B+2;
  const overlay=prepareForwardProtectionWrite(restored).entries['forward-relations:v1:protection'];
  const resumed=restoreForwardProtectionCheckpoint(await readForwardStore(read,T+2*B+3),overlay);
  near(resumed.positions[0]!.stopPrice,104);near(resumed.balance,beforeCash);
  assert.deepEqual(resumed.positions[0]!.unified,restored.positions[0]!.unified);
  const snapshot=buildReviewSnapshot({view:forwardSummary(resumed,{TEST_USDT:quote(107,T+2*B+3)},T+2*B+3),exportedAt:T+2*B+3,buildSha:'test',strategyFingerprint:'test'});
  assert.equal(snapshot.research.decisionAccount,'UNIFIED_EXECUTION');assert.ok(snapshot.trades.some(t=>t.unified?.predecessorId));
});
test('native copies use new actual intents, fixed quantity scale, event-only return and structural continuation protection',()=>{
  const f=fixture();f.step();const r=f.s.positions[0]!,sources=forwardMirrorSources(f.s,1000);
  assert.equal(sources.TEST_USDT!.id,r.id);assert.equal(mirrorSourceFresh(r,r.id,T+20*86400000),true);
  const build=(t:Trade)=>buildProportionalMirror({source:t,sourceEquity:1000,equity:300,available:300,entryPrice:t.entryPrice,
    quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,
    now:t.openedAt+1,policy:UNIFIED_EXECUTION_VERSION,mirrorRatio:.3,sourceRiskAuthority:true,sizeRules:{enableDecimal:false,orderSizeMin:'1',orderSizeMax:'100000',marketOrderSizeMax:'100000'}});
  const rb=build(r);assert.equal(rb.binding.receipt.sourceRole,'UNIFIED_PAPER');assert.ok(isInverseLiveReceipt(rb.binding.receipt));near(rb.intent.leverage,5);
  f.step(T+2*B,103.5,up);const c=f.s.positions[0]!,cb=build(c);assert.equal(cb.binding.receipt.sourceRole,'UNIFIED_PAPER');
  assert.equal(isInverseLiveReceipt(cb.binding.receipt),false);near(cb.intent.leverage,5);near(liveProtectionPrice(c)!,c.stopPrice);
});
test('activation is non-destructive and old holdings are not converted during upgrade',()=>{
  const f=fixture(),input={state:f.ref,now:T+1000,quotes:{TEST_USDT:quote(100,T+1000)},paths:{},contracts,allowDataCycle:false};
  const n=advanceUnifiedExecution(input).state;
  assert.equal(n.startedAt,f.ref.startedAt);near(n.balance,f.ref.balance);assert.equal(n.unifiedExecution!.legacyIds[0],f.ref.positions[0]!.id);
  assert.ok(n.positions[0]!.inverseCopy);assert.equal(n.positions[0]!.unified,undefined);assertInverseTrial(normalizeForward(n,T+1001));
  assert.equal(unifiedReferenceState(n).unifiedExecution,undefined);
  const mark=forwardEquity(n,input.quotes,input.now);assert.ok(Number.isFinite(mark.equity));
});

test('loss-making return reduction follows reference once, charges exit notional and then closes honestly',()=>{
  const f=fixture();f.step();const parent=f.s.positions[0]!;
  f.ref.positions[0]!.contracts=60;f.ref.positions[0]!.quantity=6;
  f.step(T+1000,102);assert.equal(parent.contracts,60);assert.equal(parent.realization!.sequence,1);
  const gross=-4*(102.02-100),paid=4*102.02*.0005;
  near(parent.realization!.gross,gross);near(parent.realization!.fees,paid);
  near(f.s.turnover,1000+4*102.02);const cash=f.s.balance;f.step(T+2000,102);near(f.s.balance,cash);
  const ref=f.ref.positions[0]!;ref.status='CLOSED';ref.closedAt=T+3000;ref.exitReason='SHADOW_SOURCE_EXIT';
  f.ref.positions=[];f.ref.history=[ref];f.step(T+4000,101);
  const closed=f.s.history[0]!;near(closed.grossPnl!,gross-6*(101.02-100));near(f.s.balance,1000+closed.netPnl!);
});
test('manual offline reset preserves stale quote time and closes both books as administrative evidence',()=>{
  const f=fixture();f.step();const closed=closeForwardForReset(f.s,{},T+2*B);
  assert.equal(closed.positions.length,0);assert.equal(closed.unifiedExecution!.reference.positions.length,0);
  const t=closed.history[0]!;assert.equal(t.exitReason,'ACCOUNT_RESET');assert.equal(t.lastQuoteAt,T);
  assert.equal(t.exitAudit!.evidence.administrative,true);assert.equal(t.exitAudit!.evidence.quoteFresh,false);
  near(closed.balance,1000+closed.history.reduce((n,t)=>n+(t.netPnl??0),0));assertInverseTrial(closed);
});
test('new financial evidence cannot restore a corrupt size, missing episode or different branch identity',()=>{
  const f=fixture();f.step();let bad=structuredClone(f.s);bad.positions[0]!.quantity++;
  assert.throws(()=>assertInverseTrial(bad),/资金证据/);
  bad=structuredClone(f.s);bad.unifiedExecution!.episodes={};assert.throws(()=>assertInverseTrial(bad),/活动事件/);
});
test('reference archives stay separate from actual orders and restore comparison evidence without inflating actual resolved',async()=>{
  const f=fixture();f.step();const prior=structuredClone(f.s);
  const ended=closeForwardForReset(f.ref,{TEST_USDT:quote(101,T+1000)},T+1000);
  f.s.inverseTrial=ended.inverseTrial;f.s.unifiedExecution!.reference=shadowCapsule(ended);
  const w=await prepareForwardWrite(prior,f.s,T+1000,{compact:true});
  const packets=Object.entries(w.entries).filter(([k])=>k.includes('archive:')).map(([,v])=>v as {trades:Trade[];referenceTrades:Trade[]});
  assert.equal(packets.flatMap(p=>p.referenceTrades).filter(t=>t.status==='CLOSED').length,1);
  assert.equal(packets.flatMap(p=>p.trades).filter(t=>t.status==='CLOSED').length,0);
  for(const [key,value]of Object.entries(w.entries))if(!(value instanceof Uint8Array))assert.ok(Buffer.byteLength(JSON.stringify(value))<120*1024,key);
  const page=await readReviewArchivePage({list:async<V>()=>new Map(Object.entries(w.entries).filter(([k])=>k.includes('archive:'))) as Map<string,V>},f.s.startedAt,T+1000,null);
  assert.equal(page.trades.length,0);assert.equal(page.referenceTrades!.length,1);
  const snapshot=buildReviewSnapshot({view:forwardSummary(f.s,{TEST_USDT:quote(101,T+1000)},T+1000),exportedAt:T+1000,buildSha:'test',strategyFingerprint:'test'});
  mergeReviewArchive(snapshot,page);assert.equal(snapshot.coverage.expectedClosed,0);assert.equal(snapshot.trades.length,1);
  assert.equal(snapshot.inverseExperiment!.accountingScope,'FROZEN_SHADOW_AND_SEPARATE_INVERSE_REFERENCE');
  assert.equal((snapshot.inverseExperiment!.coverage as {complete:boolean}).complete,true);
});

test('ten actual + ten source + ten reference holdings retain their evidence within existing hot/overlay limits',async()=>{
  const ref=initialForward(T-10*B);ref.inverseTrial=newInverseTrial(ref,T-4*B,1000);
  const source=sourceDecisionState(ref),qs:Record<string,Quote>={},paths:Record<string,Candle[]>={},specs:Record<string,typeof contracts.TEST_USDT>={};
  const note='同期跨所压力与区域结构完整证据'.repeat(50);
  for(let i=0;i<10;i++){
    const t=rawTrade();t.id=`source-${i}`;t.symbol=`TEST${i}_USDT`;t.quantity=.5;t.contracts=5;t.notional=50;t.margin=5;t.plannedRisk=1;t.entryFee=.035;
    t.entryContext!.reason=note;t.rule.id=t.id;source.positions.push(t);source.balance-=t.entryFee;source.fees+=t.entryFee;source.turnover+=t.notional;
    qs[t.symbol]=quote();paths[t.symbol]=[];specs[t.symbol]=contracts.TEST_USDT;
    applyInverseSourceTrade(ref,t,qs[t.symbol],T);
  }
  ref.inverseTrial.source=shadowCapsule(source);ref.inverseTrial.lastSourceRevision=source.revision;
  const s=initialForward(ref.startedAt);s.inverseTrial=structuredClone(ref.inverseTrial);
  s.unifiedExecution={version:UNIFIED_EXECUTION_VERSION,cutoverAt:T,reference:shadowCapsule(ref),episodes:{},legacyIds:[],completedConversions:0,droppedEpisodes:0};
  applyUnifiedReference(s,ref,{now:T,quotes:qs,paths,contracts:specs});assert.equal(s.positions.length,10);s.storage.persistedAt=T;
  const w=await prepareForwardWrite(null,s,T,{compact:true});assert.ok(w.compression.rawBytes<4*1024*1024);
  const overlay=prepareForwardProtectionWrite(s);assert.ok(Buffer.byteLength(JSON.stringify(overlay.entries))<120*1024);
  const db=new Map(Object.entries(w.entries)),read=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},T+1);
  const restored=restoreForwardProtectionCheckpoint(read,overlay.entries['forward-relations:v1:protection']);assertInverseTrial(restored);
  assert.equal(restored.positions.length,10);assert.equal(restored.inverseTrial!.source.positions.length,10);
  assert.equal(restored.unifiedExecution!.reference.positions.length,10);assert.equal(restored.inverseTrial!.source.positions[0]!.entryContext!.reason,note);
});

test('holding-outside proof uses adjacent bars and rejects an obsolete cached structure',()=>{
  const rows=[up[0]!,bar(T+B,103,102.8,103.1,102.9),bar(T+2*B,102.9,102.7,103.2,103.1)];
  const a=confirmAcceptance({area,epsilon:.02,rows,now:T+3*B,after:T})!;
  assert.deepEqual(a.bars,[T+B,T+2*B]);near(a.stop,102.78);
  assert.equal(confirmAcceptance({area,epsilon:.02,rows:up,now:T+10*B,after:T}),null);
});

test('a delayed native continuation must recheck current remaining space, rather than inheriting old entry economics',()=>{
  const f=fixture();f.step();f.step(T+2*B,103.5,up);const c=f.s.positions[0]!;
  assert.throws(()=>buildProportionalMirror({source:c,sourceEquity:1000,equity:300,available:300,entryPrice:109.8,
    quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,
    now:T+2*B+1000,policy:UNIFIED_EXECUTION_VERSION,mirrorRatio:.3,sourceRiskAuthority:true,sizeRules:{enableDecimal:false,orderSizeMin:'1'}}),/扣费空间/);
});

test('quote-only observation does not create an extra full financial commit or duplicate the frozen source evaluation',()=>{
  const f=fixture();f.step();f.s.unifiedExecution!.reference=shadowCapsule(f.ref);
  const input={now:T+2000,quotes:{TEST_USDT:{...quote(100,T+2000),bestAsk:100.2}},paths:{},contracts,allowDataCycle:false},
    control=advanceShadowInverse({...input,state:unifiedReferenceState(f.s)}),actual=advanceUnifiedExecution({...input,state:f.s});
  assert.equal(control.changed,false);assert.equal(actual.changed,false);
  assert.deepEqual(actual.state.inverseTrial,control.state.inverseTrial);near(actual.state.balance,f.s.balance);
  assert.equal(actual.state.positions.length,1);near(actual.state.unifiedExecution!.episodes['source-new']!.epsilon,.2);
});
