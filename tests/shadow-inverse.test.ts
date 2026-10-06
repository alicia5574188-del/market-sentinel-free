import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {initialForward,normalizeForward,closeForwardForReset,resetForwardAccountPreservingLearning,forwardSummary,type Trade,type ForwardState,type Quote} from '../lib/forward-relations.ts';
import {advanceForward as frozenAdvance} from '../lib/shadow-baseline/forward-relations.ts';
import {SHADOW_BASELINE_BUILD,SHADOW_INVERSE_VERSION,newInverseTrial,sourceDecisionState,shadowCapsule,
  applyInverseSourceTrade,applyInverseSoftLossExits,inverseTrialSummary,markInversePositions,assertInverseTrade,assertInverseTrial,inverseId,migrateInverseSamePrice,alignComparisonSourceFees,recordInverseCurve,MIRROR_ACCOUNTING_MODE} from '../lib/shadow-inverse-ledger.ts';
import {advanceShadowInverse} from '../lib/shadow-inverse.ts';
import {INVERSE_FEE_POLICY,INVERSE_COST,LIVE_EXECUTION_GAP_RATE,LIVE_EXECUTION_GAP_POLICY} from '../lib/inverse-fee.ts';
import {realizeTradeSlice,assertTradeRealization} from '../lib/trade-realization.ts';
import {prepareForwardWrite,readForwardStore,prepareForwardProtectionWrite} from '../lib/forward-store.ts';
import {restoreForwardProtectionCheckpoint,buildForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {forwardMirrorSources} from '../lib/live-parity.ts';
import {buildReviewSnapshot} from '../lib/research-snapshot.ts';

const T=1790832000000,B=300_000;
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
const quote=(bid=100,ask=bid,at=T):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,entryReady:true,sourceCount:4});
function trade(id='source-1',side:'LONG'|'SHORT'='LONG',at=T,entry=100):Trade{
  const stop=entry*(side==='LONG'?.98:1.02),quantity=10,contracts=100;
  return{id,symbol:'TEST_USDT',side,openedAt:at,closedAt:null,status:'OPEN',entryPrice:entry,exitPrice:null,
    quantity,contracts,quantoMultiplier:.1,notional:quantity*entry,leverage:10,margin:quantity*entry/10,plannedRisk:22,
    stopPrice:stop,armPrice:entry*(side==='LONG'?1.05:.95),favorable:0,adverse:0,lastPrice:entry,lastQuoteAt:at,
    entryFee:quantity*entry*.0007,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:at,
    execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    rule:{id,signature:'synthetic',parentId:null,version:1,createdAt:at,expiresAt:at+86400000,status:'EXPERIMENTAL',conditions:[],side,horizon:180,
      stopRate:.02,armRate:.001,givebackRate:.001,exitMode:'REACTION_DECAY',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:.05,
      priorResponse:null,recentResponse:0,standardError:0,reason:'synthetic source',mutation:'CREATE',grammar:'market-intelligence-v1',liveEligible:false},
    entryContext:{version:'adaptive-ten-entry-v1',capturedAt:at,timeframe:'5m',side,mode:'RELATIVE',reserve:false,reason:'synthetic source',
      entryScore:90,directionStrength:90,spaceScore:90,positionScore:90,executionScore:100,remainingSpaceRate:.05,pullbackRiskRate:.02,edgeRatio:2.5,
      expectedHoldMinutes:180,marketFit:70,regionId:null,portfolioRiskCharge:22,strategyVersion:'market-intelligence-v1',tradePlan:'WINNER_TREND',
      winnerPlan:{version:'winner-preservation-v1',intent:'TREND',eventAt:at,initialStop:stop,target:null,targetArea:null,origin:null,riskGroup:'test:'+side,source:'RELATIVE_CORE'}}};
}
function sourceOpen(s:ForwardState,t:Trade){s.positions.push(t);s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=t.notional;
  s.events.unshift({id:`a${s.startedAt}-${++s.revision}`,at:t.openedAt,kind:'ENTRY',subject:t.id,reason:'synthetic entry'});}
function fixture(side:'LONG'|'SHORT'='LONG',spread=0){
  const s=initialForward(T-B);s.inverseTrial=newInverseTrial(s,T,1000);const source=structuredClone(sourceDecisionState(s)),q=quote(100,100+spread),t=trade('source-1',side,T,side==='LONG'?q.bestAsk:q.bestBid);
  sourceOpen(source,t);applyInverseSourceTrade(s,t,q,T);s.inverseTrial.source=shadowCapsule(source);s.inverseTrial.lastSourceRevision=source.revision;
  return{s,source,t};
}
function sourceClose(s:ForwardState,t:Trade,price:number,now:number){
  const gross=(t.side==='LONG'?1:-1)*t.quantity*(price-t.entryPrice),fee=t.quantity*price*.0007,
    funding=t.notional*.0002*(now-t.openedAt)/86400000,r=t.realization;
  Object.assign(t,{status:'CLOSED',closedAt:now,exitPrice:price,exitReason:'WINNER_THESIS_EXIT',lastPrice:price,lastQuoteAt:now,
    grossPnl:gross+(r?.gross??0),exitFee:fee+(r?.fees??0),fundingAllowance:funding+(r?.funding??0)});
  t.netPnl=t.grossPnl!-t.entryFee-t.exitFee-t.fundingAllowance;
  t.exitAudit={trigger:'WINNER_THESIS_EXIT',at:now,evidence:{quoteAt:now}};
  s.balance+=gross-fee-funding;s.grossPnl+=gross;s.fees+=fee;s.fundingAllowance+=funding;s.resolved++;if(t.netPnl>0)s.wins++;
  s.positions=s.positions.filter(x=>x.id!==t.id);s.history.unshift(t);
  s.events.unshift({id:`a${s.startedAt}-${++s.revision}`,at:now,kind:'EXIT',subject:t.id,reason:'synthetic exit'});
  if(r)Object.assign(t,{quantity:r.initialQuantity,contracts:r.initialContracts,notional:r.initialNotional,margin:r.initialMargin,plannedRisk:r.initialRisk});
}
function retainSource(s:ForwardState,source:ForwardState){s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;}
function legacyOpenFee(s:ForwardState){
  const t=s.positions.find(t=>t.inverseCopy)!,f=t.inverseCopy!.fills[0]!;
  const legacy=f.quantity*f.sourcePrice*.0007,feeDelta=legacy-f.fee,sourceDelta=legacy-f.sourceFee;
  f.fee=legacy;f.sourceFee=legacy;delete f.feeRate;delete f.feePolicy;delete f.sourceFeeRate;delete f.sourceFeePolicy;delete f.frozenSourceFee;
  t.entryFee=legacy;s.balance-=feeDelta;s.fees+=feeDelta;s.inverseTrial!.totals.fees+=feeDelta;s.inverseTrial!.totals.sourceFees+=sourceDelta;
  s.inverseTrial!.totals.feeSavings=(s.inverseTrial!.totals.feeSavings??0)+sourceDelta-feeDelta;
}


test('legacy opposite-BBO pair is reconciled once to the exact shadow entry price without resetting the account',()=>{
  const {s}=fixture('LONG',0);legacyOpenFee(s);const m=s.positions[0]!,trial=s.inverseTrial!,f=m.inverseCopy!.fills[0]!;
  // Recreate the old implementation artifact: source entered 100 while inverse used 99.9.
  trial.accountingMode=undefined;trial.reconciledAt=undefined;f.price=99.9;f.fee=99.9*10*.0007;m.entryPrice=99.9;m.entryFee=f.fee;
  trial.totals.fees=f.fee;trial.totals.gross=0;trial.totals.funding=0;trial.totals.spreadDrag=0;
  s.balance+=.7-f.fee;s.fees+=f.fee-.7;s.turnover+=10*(99.9-100);
  const beforeStarted=s.startedAt;assert.equal(migrateInverseSamePrice(s,T+1),true);assert.equal(migrateInverseSamePrice(s,T+2),false);
  assert.equal(s.startedAt,beforeStarted);assert.equal(trial.accountingMode,MIRROR_ACCOUNTING_MODE);near(m.entryPrice,100);near(m.entryFee,.7);
  near(trial.totals.fees,trial.totals.sourceFees);near(trial.totals.gross,-trial.totals.sourceGross);near(trial.totals.funding,0);
  assertInverseTrial(s);
});

test('source provenance reconstructs exact published 2b4fd60f plus only the authorized allocation hook',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../lib/shadow-baseline/manifest.json',import.meta.url),'utf8'));
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');assert.equal(manifest.sourceBuild,SHADOW_BASELINE_BUILD);
  for(const f of manifest.files){const code=readFileSync(new URL('../'+f.path,import.meta.url),'utf8');assert.equal(hash(code),f.vendoredSha256);
    let original=code;for(const edit of f.authorizedEdits??[]){assert.ok(original.includes(edit.after));original=original.replace(edit.after,edit.before);}
    original=original.replace(/(from\s+["'])\.\.\//g,'$1./');assert.equal(hash(original),f.originalSha256);}
  for(const [file,digest]of Object.entries(manifest.shared))assert.equal(hash(readFileSync(new URL('../'+file,import.meta.url),'utf8')),digest,file);
});
test('cutover preserves original account and history, excludes old positions from new pairs',()=>{
  const s=initialForward(T-B);s.balance=921;s.resolved=23;s.positions=[trade('old','LONG',T-1000)];const before=JSON.stringify(s);
  const v=newInverseTrial(s,T,921);assert.equal(JSON.stringify(s),before);assert.equal(v.source.balance,921);assert.equal(v.source.resolved,23);
  s.inverseTrial=v;applyInverseSourceTrade(s,s.positions[0],undefined,T);assert.equal(s.positions.length,1);assert.equal(v.totals.opened,0);
});
for(const side of ['LONG','SHORT'] as const)test(side+' uses the exact shadow price, same size and opposite direction, paying only own filled fees',()=>{
  const {s,source,t}=fixture(side,.1),m=s.positions[0]!,at=T+60000,q=quote(97,97.1,at);
  assert.notEqual(m.side,t.side);near(m.quantity,t.quantity);near(m.entryPrice,t.entryPrice);near(m.entryFee,t.notional*.0005);
  near(t.entryFee,t.notional*.0007);assert.equal(m.inverseCopy!.fills[0]!.feePolicy,INVERSE_FEE_POLICY);
  near(s.balance,1000-m.entryFee);sourceClose(source,t,side==='LONG'?q.bestBid:q.bestAsk,at);
  applyInverseSourceTrade(s,t,q,at);retainSource(s,source);assertInverseTrial(s);const closed=s.history[0]!;
  near(closed.exitPrice!,t.exitPrice!);near(closed.grossPnl!,-t.grossPnl!);near(closed.fundingAllowance,0);
  near(closed.netPnl!,closed.grossPnl!-closed.entryFee-closed.exitFee);
  near(s.balance,1000+closed.netPnl!);assert.equal(s.resolved,1);assert.equal(s.inverseTrial!.totals.closed,1);
  const unchanged=JSON.stringify(s);applyInverseSourceTrade(s,t,q,at);assert.equal(JSON.stringify(s),unchanged);
  near(inverseTrialSummary(s,{},at)!.settledAttributionResidual,0);
});
test('same-price gross inversion is exact and comparison net is changed only by each side fee',()=>{
  for(const price of [90,105,100]){const {s,source,t}=fixture();sourceClose(source,t,price,T+60000);applyInverseSourceTrade(s,t,quote(price,price,T+60000),T+60000);retainSource(s,source);
    const m=s.history[0]!;near(m.grossPnl!,-t.grossPnl!);near(m.entryFee,t.notional*.0005);near(m.exitFee,t.quantity*price*.0005);near(m.fundingAllowance,0);
    near(m.netPnl!,m.grossPnl!-m.entryFee-m.exitFee);
    const summary=inverseTrialSummary(s,{},T+60000)!;near(summary.theoreticalSamePriceEquity,summary.inverseEquity);
    near(summary.paidCost!.reconciliation.grossMirrorResidual!,0);near(summary.paidCost!.reconciliation.netSum!,-summary.paidCost!.reconciliation.paidFees);}
});
test('legacy 7bp entry restores unchanged, then new 5bp exit and its receipt survive a second restart',async()=>{
  const {s,source,t}=fixture();legacyOpenFee(s);s.storage.persistedAt=T;
  const before=structuredClone(s),normalized=normalizeForward(structuredClone(s),T+1);
  assert.equal(migrateInverseSamePrice(normalized,T+1),false);
  near(normalized.balance,before.balance);near(normalized.fees,.7);
  assert.deepEqual(normalized.inverseTrial!.curve,before.inverseTrial!.curve);
  assert.deepEqual(normalized.inverseTrial!.source,before.inverseTrial!.source);
  assert.deepEqual(normalized.positions[0]!.inverseCopy,before.positions[0]!.inverseCopy);
  const write=await prepareForwardWrite(null,normalized,T,{compact:true}),db=new Map(Object.entries(write.entries)),
    reader={get:async<V>(key:string)=>structuredClone(db.get(key)) as V|undefined};
  const restored=await readForwardStore(reader,T+1);near(restored.fees,.7);near(restored.balance,999.3);
  const at=T+60000;sourceClose(source,t,97,at);applyInverseSourceTrade(restored,t,quote(97,97,at),at);retainSource(restored,source);
  const m=restored.history[0]!,fills=m.inverseCopy!.fills;near(fills[0]!.fee,.7);assert.equal(fills[0]!.feePolicy,undefined);
  near(fills[1]!.fee,.485);assert.equal(fills[1]!.feePolicy,INVERSE_FEE_POLICY);near(fills[1]!.feeRate!,.0005);
  near(m.netPnl!,28.815);near(restored.balance,1028.815);near(restored.fees,1.185);
  near(restored.inverseTrial!.totals.feeSavings!,0);assertInverseTrial(restored);
  const summary=inverseTrialSummary(restored,{},at)!;near(summary.inverseFees,1.185);near(summary.paidCost!.inverse.fees,1.185);
  near(summary.paidCost!.reconciliation.netSum!,-summary.paidCost!.reconciliation.paidFees);
  const snapshot=buildReviewSnapshot({view:forwardSummary(restored,{},at),exportedAt:at,buildSha:'fee-test',strategyFingerprint:'fee-fp'});
  assert.equal(forwardSummary(restored,{},at).cost.feeRate,.0005);
  assert.equal(forwardSummary(initialForward(T),{},T).cost.feeRate,.0007);
  assert.equal((snapshot.account.cost as {feeRate:number}).feeRate,.0005);
  near(Number(snapshot.account.balance),restored.balance);near(snapshot.trades[0]!.entryFee,.7);near(snapshot.trades[0]!.exitFee,.485);
  assert.equal(snapshot.trades[0]!.inverseCopy!.fills[1]!.feePolicy,INVERSE_FEE_POLICY);
  const saved=await prepareForwardWrite(normalized,restored,at,{compact:true});for(const [k,v]of Object.entries(saved.entries))db.set(k,v);
  const restarted=await readForwardStore(reader,at+1),prior=JSON.stringify(restarted);
  applyInverseSourceTrade(restarted,t,quote(97,97,at),at);assert.equal(JSON.stringify(restarted),prior);
  near(restarted.fees,1.185);assertInverseTrial(restarted);
});
test('old entry plus new partial exits pays each actual notional once with source decisions unchanged',()=>{
  const {s,source,t}=fixture();legacyOpenFee(s);
  const at=T+60000,r=realizeTradeSlice({trade:t,price:105,now:at,quoteAt:at,fraction:.4,feeRate:.0007,
    fundingPerDay:.0002,minContracts:1,reason:'frozen source'})!;
  source.balance+=r.credit;source.grossPnl+=r.gross;source.fees+=r.fee;source.fundingAllowance+=r.funding;
  const sourceBefore=structuredClone(source);applyInverseSourceTrade(s,t,quote(105,105,at),at);assert.deepEqual(source,sourceBefore);
  retainSource(s,source);near(s.positions[0]!.realization!.fees,4*105*.0005);assertTradeRealization(s.positions[0]!);
  sourceClose(source,t,108,T+120000);applyInverseSourceTrade(s,t,quote(108,108,T+120000),T+120000);retainSource(s,source);
  const m=s.history[0]!,fees=.7+4*105*.0005+6*108*.0005;
  near(m.entryFee,.7);near(m.exitFee,fees-.7);near(s.fees,fees);near(m.netPnl!,-68-fees);
  near(s.balance,1000+m.netPnl!);assertInverseTrial(s);assertTradeRealization(m);
});
test('invalid fee stamps, altered totals and lost accounting mode reject without rewriting booked fees',()=>{
  for(const stamp of [{feeRate:.0007,feePolicy:INVERSE_FEE_POLICY},{feeRate:INVERSE_COST.feeRate,feePolicy:undefined}]){
    const {s}=fixture();Object.assign(s.positions[0]!.inverseCopy!.fills[0]!,stamp);
    const before=JSON.stringify(s);assert.throws(()=>assertInverseTrade(s.positions[0]!),/费率/);assert.equal(JSON.stringify(s),before);
  }
  const {s}=fixture();s.inverseTrial!.totals.feeSavings=1;assert.throws(()=>assertInverseTrial(s),/金融状态/);
  const {s:lost}=fixture();lost.inverseTrial!.accountingMode=undefined;const before=JSON.stringify(lost);
  assert.throws(()=>migrateInverseSamePrice(lost,T+1),/禁止.*改写/);assert.equal(JSON.stringify(lost),before);
});
test('source profitable partial exits are mirrored even when the inverse loses; parent counts once',()=>{
  const {s,source,t}=fixture('LONG',.1);
  for(const [at,price,fraction]of [[T+60000,105,.4],[T+120000,106,.4]]){
    const q=quote(price,price+.1,at),r=realizeTradeSlice({trade:t,price:q.bestBid,now:at,quoteAt:at,fraction,feeRate:.0007,fundingPerDay:.0002,minContracts:1,reason:'source protection'})!;
    assert.ok(r);source.balance+=r.credit;source.grossPnl+=r.gross;source.fees+=r.fee;source.fundingAllowance+=r.funding;
    applyInverseSourceTrade(s,t,q,at);retainSource(s,source);assertInverseTrial(s);assertTradeRealization(s.positions[0]!);
    assert.ok(s.positions[0]!.realization!.gross<0);assert.equal(s.resolved,0);near(s.positions[0]!.quantity,t.quantity);
    const unchanged=s.balance;applyInverseSourceTrade(s,t,q,at);near(s.balance,unchanged);
  }
  const at=T+180000;sourceClose(source,t,108,at);applyInverseSourceTrade(s,t,quote(108,108.1,at),at);retainSource(s,source);
  const m=s.history[0]!;assert.equal(m.inverseCopy!.fills.length,4);assert.equal(s.resolved,1);assert.equal(m.quantity,10);assert.equal(m.contracts,100);
  near(m.netPnl!,m.inverseCopy!.fills.reduce((n,f)=>n+f.gross-f.fee-f.funding,0));near(s.balance,1000+m.netPnl!);assertTradeRealization(m);assertInverseTrial(s);
});
test('neither source stop movement nor large inverse loss can independently exit or resize the mirror',()=>{
  const {s,source,t}=fixture();t.stopPrice=120;applyInverseSourceTrade(s,t,quote(130,130,T+2000),T+2000);retainSource(s,source);
  markInversePositions(s,{TEST_USDT:quote(130,130,T+2000)},T+2000);
  assert.equal(applyInverseSoftLossExits(s,T+2000),false);
  assert.equal(s.positions.length,1);assert.equal(s.positions[0]!.quantity,10);
  assert.equal(s.positions[0]!.inverseCopy!.sourceStopPrice,120);assert.ok(inverseTrialSummary(s,{TEST_USDT:quote(130,130,T+2000)},T+2000)!.inverseNet<0);
});
test('inverse balance, histories and outcome counters cannot leak into source decision state',()=>{
  const {s}=fixture(),before=JSON.stringify(sourceDecisionState(s));s.balance=123456;s.history=[trade('foreign')];s.wins=666;s.resolved=888;
  s.winnerRisk={};s.environmentPerformance={version:s.environmentPerformance.version,cells:[]} as typeof s.environmentPerformance;
  assert.equal(JSON.stringify(sourceDecisionState(s)),before);
});
test('frozen source and isolated wrapper produce identical next source lifecycle and execute a paired stop',()=>{
  const {s}=fixture(),at=T+60000,q=quote(97,97.1,at),base={now:at,quotes:{TEST_USDT:q},paths:{},contracts:{},allowDataCycle:false};
  const expected=frozenAdvance({...base,state:sourceDecisionState(s)}),actual=advanceShadowInverse({...base,state:s});
  near(actual.state.inverseTrial!.source.balance,expected.state.balance);assert.equal(actual.state.inverseTrial!.source.resolved,expected.state.resolved);
  assert.deepEqual(actual.state.inverseTrial!.source.positions.map(t=>[t.id,t.contracts]),expected.state.positions.map(t=>[t.id,t.contracts]));
  assert.equal(actual.state.history[0]!.inverseCopy!.sourceId,'source-1');assert.equal(actual.state.history[0]!.side,'SHORT');
  assert.equal(s.positions.length,1,'original committed object untouched');assertInverseTrial(actual.state);
});
test('inverse creation needs only the committed shadow fill price; market BBO cannot alter it and retrospective fills remain forbidden',()=>{
  for(const q of [undefined,{...quote(90,120),fresh:false},quote(80,130,T-10001),quote(70,140,T+1)]){
    const s=initialForward(T-B);s.inverseTrial=newInverseTrial(s,T,1000);const t=trade();
    applyInverseSourceTrade(s,t,q as Quote|undefined,T);assert.equal(s.positions.length,1);near(s.positions[0]!.entryPrice,t.entryPrice);
  }
  const s=initialForward(T-B);s.inverseTrial=newInverseTrial(s,T,1000);assert.throws(()=>applyInverseSourceTrade(s,trade(),undefined,T+1),/历史成交/);
});
test('reset explicitly closes both books administratively, including saved-mark offline maintenance',()=>{
  for(const quotes of [{TEST_USDT:quote(101,101.1,T+60000)},{}]){const {s}=fixture();
    const closed=closeForwardForReset(s,quotes,T+60000);assert.equal(closed.positions.length,0);assert.equal(closed.inverseTrial!.source.positions.length,0);
    assert.equal(closed.history[0]!.exitReason,'ACCOUNT_RESET');assert.ok(closed.history[0]!.inverseCopy!.fills.at(-1)!.administrative);
    assertInverseTrial(closed);normalizeForward(closed,T+60001);const next=resetForwardAccountPreservingLearning(s,T+60001);
    assert.equal(next.balance,1000);assert.equal(next.inverseTrial,undefined);assert.equal(s.positions.length,1);
  }
});
test('an inconsistent partial realization blocks a normal load and can be dropped only for an explicit reset',async()=>{
  const s=initialForward(T-B);s.storage.persistedAt=T;sourceOpen(s,trade('later-1'));
  const base=normalizeForward(structuredClone(s),T+1);
  const write=await prepareForwardWrite(null,base,T,{compact:true}),db=new Map(Object.entries(write.entries)),
    reader={get:async<V>(key:string)=>structuredClone(db.get(key)) as V|undefined};
  const headKey=[...db.keys()].find(k=>k.endsWith('head'))!;
  const head=db.get(headKey) as {inline:Uint8Array;sha256:string;rawLength:number;encoding?:string};
  const {gunzipSync,gzipSync}=await import('node:zlib');
  const raw=Buffer.from(gunzipSync(head.inline));
  const parsed=JSON.parse(raw.toString('utf8')) as ForwardState;
  const open=parsed.positions[0]!;
  open.realization={version:'partial-realization-v1',initialQuantity:open.quantity,initialContracts:open.contracts,
    initialNotional:open.notional,initialMargin:open.margin,initialRisk:open.plannedRisk,initialEntryFee:open.entryFee,
    gross:1,fees:0,funding:0,sequence:1,fills:[{sequence:1,at:T,quoteAt:T,price:open.entryPrice,contracts:1,
      quantity:1,gross:1,fee:0,funding:0,reason:'later system'}]};
  const nextRaw=Buffer.from(JSON.stringify(parsed)),packed=gzipSync(nextRaw);
  db.set(headKey,{...head,inline:packed,length:packed.length,rawLength:nextRaw.length,sha256:createHash('sha256').update(packed).digest('hex')});
  await assert.rejects(()=>readForwardStore(reader,T+1),/部分兑现账本与剩余仓位不一致/);
  const recovered=await readForwardStore(reader,T+1,{dropRealization:true});
  assert.equal(recovered.positions[0]!.realization,undefined);
  const closed=closeForwardForReset(recovered,{},T+60000),next=resetForwardAccountPreservingLearning(recovered,T+60000);
  assert.equal(closed.positions.length,0);assert.equal(next.balance,1000);assert.equal(next.initialEquity,1000);
});
test('financial tampering, lost source counterpart and duplicate lifecycle fail closed',()=>{
  const {s}=fixture();for(const mutate of [(x:ForwardState)=>x.positions[0]!.quantity++,
    (x:ForwardState)=>x.positions[0]!.inverseCopy!.fills[0]!.fee++,
    (x:ForwardState)=>{x.inverseTrial!.source.positions=[];},
    (x:ForwardState)=>{x.inverseTrial!.source.balance=NaN;}]){
    const c=structuredClone(s);mutate(c);assert.throws(()=>normalizeForward(c,T+1));}
});
test('owner-authorized inverse PAPER is the new LIVE source; legacy rows drain without new exposure',()=>{
  const {s}=fixture();assert.equal(forwardMirrorSources(s,1000).TEST_USDT!.id,'iv-source-1');
  const old=trade('legacy','LONG',T-60000);s.positions.push(old);const exported=forwardMirrorSources(s,1000);
  assert.equal(exported.TEST_USDT!.id,'iv-source-1');assert.equal(exported.TEST_USDT!.side,'SHORT');
  assert.equal(s.positions[0]!.inverseCopy!.liveExecution,'PAPER_ONLY','PAPER receipts are not fabricated exchange fills');
});
test('review snapshot pairs actual/source receipts, excludes old account results and needs no fictional PI assessment',()=>{
  const {s,source,t}=fixture();sourceClose(source,t,97,T+60000);applyInverseSourceTrade(s,t,quote(97,97,T+60000),T+60000);retainSource(s,source);
  const view=forwardSummary(s,{},T+60000),snapshot=buildReviewSnapshot({view,exportedAt:T+60000,buildSha:'trial-build',strategyFingerprint:'trial-fp'});
  assert.equal(snapshot.summary.positionAssessmentMissing,0);assert.equal(snapshot.summary.exitTraceMissing,0);
  assert.equal((snapshot.inverseExperiment!.pairs as unknown[]).length,1);assert.equal(snapshot.inverseExperiment!.sourceBuild,SHADOW_BASELINE_BUILD);
  assert.equal(snapshot.trades[0]!.inverseCopy!.sourceId,t.id);near(Number(snapshot.account.balance),s.balance);
});
test('paged restart restores source and inverse amounts, then a repeated event remains idempotent',async()=>{
  const {s,source,t}=fixture('SHORT',.1);s.storage.persistedAt=T;
  const prepared=await prepareForwardWrite(null,s,T,{compact:true}),db=new Map(Object.entries(prepared.entries));
  const restored=await readForwardStore({get:async<V>(key:string)=>structuredClone(db.get(key)) as V|undefined},T+1);
  near(restored.balance,s.balance);near(restored.inverseTrial!.source.balance,source.balance);assertInverseTrial(restored);
  const at=T+60000;sourceClose(source,t,102,at);applyInverseSourceTrade(restored,t,quote(101.9,102,at),at);retainSource(restored,source);
  const balance=restored.balance;applyInverseSourceTrade(restored,t,quote(101.9,102,at),at);near(restored.balance,balance);assertInverseTrial(restored);
});
test('protection checkpoint restores source stops independently of opposite-side display geometry',()=>{
  const {s}=fixture();s.storage.persistedAt=T;const later=structuredClone(s),source=later.inverseTrial!.source.positions[0]!;
  source.stopPrice=101;source.favorable=.05;source.lastQuoteAt=T+5000;source.lastPrice=105;
  later.positions[0]!.stopPrice=101;later.positions[0]!.inverseCopy!.sourceStopPrice=101;later.lastQuoteCycleAt=T+5000;
  const c=buildForwardProtectionCheckpoint(later),restored=restoreForwardProtectionCheckpoint(s,c);
  assert.equal(restored.inverseTrial!.source.positions[0]!.stopPrice,101);assert.equal(restored.positions[0]!.inverseCopy!.sourceStopPrice,101);
  const bad=structuredClone(c);bad.shadow!.positions[0]!.stopPrice=90;assert.throws(()=>restoreForwardProtectionCheckpoint(s,bad));
  assertInverseTrial(restored);
});
test('ten shadow positions and ten draining legacy positions fit the existing 112KiB checkpoint',async()=>{
  const s=initialForward(T-B);s.positions=Array.from({length:10},(_,i)=>({...trade('old'+i,'LONG',T-1000),symbol:'OLD'+i+'_USDT'}));
  s.inverseTrial=newInverseTrial(s,T,1000);const source=structuredClone(sourceDecisionState(s));source.positions=[];
  for(let i=0;i<10;i++){const t={...trade('new'+i,'LONG',T),symbol:'NEW'+i+'_USDT'};sourceOpen(source,t);applyInverseSourceTrade(s,t,quote(),T);}
  retainSource(s,source);assertInverseTrial(s);s.storage.persistedAt=T;
  const checkpoint=prepareForwardProtectionWrite(s);assert.ok(Buffer.byteLength(JSON.stringify(checkpoint))<112*1024);
  const write=await prepareForwardWrite(null,s,T,{compact:true});assert.ok(write.writes<40);
  assert.equal(s.positions.length,20);assert.equal(s.inverseTrial.source.positions.length,10);
});
test('each new entry has one deterministic pairing ID, no historical reconstruction',()=>{
  assert.equal(inverseId('a'),'iv-a');assert.equal(SHADOW_INVERSE_VERSION,'shadow-inverse-v1');
  const {s,t}=fixture();const before=s.balance;applyInverseSourceTrade(s,t,undefined,T);near(s.balance,before);assert.equal(s.positions.length,1);
});
test('full frozen discovery and realtime response pipeline creates one inverse, with no wallet feedback',()=>{
  const candles=(step:number)=>{let p=100;return Array.from({length:72},(_,i)=>{const o=p;p*=1+step+Math.sin(i/5)*.00003;
    return{time:(T-(72-i)*B)/1000,open:o,close:p,low:Math.min(o,p)*.9995,high:Math.max(o,p)*1.0005,volume:1000+i};});};
  const paths={BTC_USDT:candles(.0010),ETH_USDT:candles(.0018),SOL_USDT:candles(.0009)};
  for(let i=56;i<72;i++)for(const k of ['open','close','high','low'] as const)paths.ETH_USDT[i]![k]*=1+(i-55)*.0008;
  const contracts=Object.fromEntries(Object.keys(paths).map(k=>[k,{quantoMultiplier:.01,minContracts:1,leverageMax:10,maintenanceRate:.005}]));
  let s=initialForward(T-2*B);
  for(let n=0;n<40;n++){
    const now=T+n*2000,quotes=Object.fromEntries(Object.entries(paths).map(([k,r])=>{const p=r.at(-1)!.close*(1+n*.00009);
      return[k,{...quote(p*.99995,p*1.00005,now),disagreementRate:.00008,sourceBreadth:.75,directionalAgreement:.9,
        medianShortMove:.0005,bookImbalance:.4,bidLiquidityChange:.2,askLiquidityChange:-.2,liquiditySourceCount:3}];}));
    const input={state:s,now,paths,quotes,contracts,entrySymbols:Object.keys(paths),allowDataCycle:n===0};
    const expected=frozenAdvance({...input,state:sourceDecisionState(s)});s=advanceShadowInverse(input).state;
    near(s.inverseTrial!.source.balance,expected.state.balance);assert.equal(s.inverseTrial!.source.resolved,expected.state.resolved);
    assert.deepEqual(s.inverseTrial!.source.positions.map(t=>[t.id,t.side,t.quantity,t.stopPrice]),expected.state.positions.map(t=>[t.id,t.side,t.quantity,t.stopPrice]));
    if(n===3)s.balance+=50000; // Test-only perturbation; must not resize source entries.
    if(s.inverseTrial!.totals.opened){const source=s.inverseTrial!.source.positions[0]!,actual=s.positions[0]!;
      assert.equal(actual.inverseCopy!.sourceId,source.id);assert.notEqual(actual.side,source.side);near(actual.quantity,source.quantity);
      assert.equal(actual.openedAt,source.openedAt);assertInverseTrial(s);return;}
  }
  assert.fail('synthetic confirmed source opportunity never produced a paired inverse');
});

test('fixed1000 allocation creates equal new source quantities with honest700/1000/1500 U wallets',()=>{
  const quantities:number[]=[];
  for(const wallet of [700,1000,1500]){
  const candles=(step:number)=>{let p=100;return Array.from({length:72},(_,i)=>{const o=p;p*=1+step+Math.sin(i/5)*.00003;
    return{time:(T-(72-i)*B)/1000,open:o,close:p,low:Math.min(o,p)*.9995,high:Math.max(o,p)*1.0005,volume:1000+i};});};
  const paths={BTC_USDT:candles(.0010),ETH_USDT:candles(.0018),SOL_USDT:candles(.0009)};
  for(let i=56;i<72;i++)for(const k of ['open','close','high','low'] as const)paths.ETH_USDT[i]![k]*=1+(i-55)*.0008;
  const contracts=Object.fromEntries(Object.keys(paths).map(k=>[k,{quantoMultiplier:.01,minContracts:1,leverageMax:10,maintenanceRate:.005}]));
  let s=initialForward(T-2*B);s.balance=wallet;
  for(let n=0;n<40;n++){
    const now=T+n*2000,quotes=Object.fromEntries(Object.entries(paths).map(([k,r])=>{const p=r.at(-1)!.close*(1+n*.00009);
      return[k,{...quote(p*.99995,p*1.00005,now),disagreementRate:.00008,sourceBreadth:.75,directionalAgreement:.9,
        medianShortMove:.0005,bookImbalance:.4,bidLiquidityChange:.2,askLiquidityChange:-.2,liquiditySourceCount:3}];}));
    const input={state:s,now,paths,quotes,contracts,entrySymbols:Object.keys(paths),allowDataCycle:n===0};
    const expected=frozenAdvance({...input,state:sourceDecisionState(s),allocationEquity:1000});s=advanceShadowInverse(input).state;
    near(s.inverseTrial!.source.balance,expected.state.balance);assert.equal(s.inverseTrial!.source.resolved,expected.state.resolved);
    assert.deepEqual(s.inverseTrial!.source.positions.map(t=>[t.id,t.side,t.quantity,t.stopPrice]),expected.state.positions.map(t=>[t.id,t.side,t.quantity,t.stopPrice]));
    if(n===3)s.balance+=50000; // Test-only perturbation; must not resize source entries.
    if(s.inverseTrial!.totals.opened){const source=s.inverseTrial!.source.positions[0]!,actual=s.positions[0]!;
      assert.equal(actual.inverseCopy!.sourceId,source.id);assert.notEqual(actual.side,source.side);near(actual.quantity,source.quantity);
      assert.equal(actual.openedAt,source.openedAt);assertInverseTrial(s);
      near(s.inverseTrial!.source.balance,wallet-source.entryFee);
      quantities.push(source.quantity);break;}
  }
    assert.equal(quantities.length,[700,1000,1500].indexOf(wallet)+1);
  }
  assert.equal(new Set(quantities).size,1);
});

test('rich dual-ledger drain fits storage without losing active evidence or source outcome inputs',async()=>{
  const rich=(id:string,at:number)=>{const t=trade(id,'LONG',at),text='持仓优势变化与跨所流动性细节'.repeat(35);
    Object.assign(t.entryContext!,{reason:text,thesisSummary:text,invalidationSummary:text,entryResidual:.08,thesisId:id});
    t.positionIntelligence={version:'position-intelligence-v1',updatedAt:T,decision:'REVIEW',phase:'DECAYING',reviewSince:T-B,
      reviewBars:2,lastCompletedBar:T,entryAdvantage:88,currentAdvantage:67,advantageChange:-21,remainingSpaceRate:.012,
      expectedPullbackRate:.009,continuationRatio:1.33,holdValueScore:49,exitValueScore:51,dataConfidence:91,counterfactualNewEntry:false,
      supportFamilies:['RELATIVE','FLOW'],concernFamilies:['PATH','STRUCTURE'],assessments:['RELATIVE','PATH','FLOW','STRUCTURE','MARKET'].map(f=>({
        family:f as 'PATH',stance:'CONCERN' as const,severity:.6,summary:text})),reasons:[text,text],concerns:[text,text],summary:text};return t;};
  const s=initialForward(T-100*B);s.positions=Array.from({length:10},(_,i)=>rich('old'+i,T-B));
  s.history=Array.from({length:240},(_,i)=>({...rich('history'+i,T-2*B-i*1000),status:'CLOSED' as const,closedAt:T-B-i*1000,
    exitPrice:99,grossPnl:-10,netPnl:-11.393,exitFee:.693,exitReason:'WINNER_THESIS_EXIT'}));s.resolved=240;
  s.inverseTrial=newInverseTrial(s,T,1000);const source=structuredClone(sourceDecisionState(s));source.positions=[];
  for(let i=0;i<10;i++){const t=rich('new'+i,T);t.symbol='NEW'+i+'_USDT';sourceOpen(source,t);applyInverseSourceTrade(s,t,quote(),T);}
  retainSource(s,source);s.storage.persistedAt=T;const write=await prepareForwardWrite(null,s,T,{compact:true});
  assert.ok(write.compression.rawBytes<1024*1024);const db=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},T+1);
  assertInverseTrial(restored);near(restored.inverseTrial!.source.balance,source.balance);assert.equal(restored.positions.length,20);
  assert.equal(restored.inverseTrial!.source.positions[0]!.positionIntelligence!.summary,source.positions[0]!.positionIntelligence!.summary);
  assert.equal(restored.inverseTrial!.source.history[0]!.entryContext!.entryResidual,.08);assert.equal(restored.inverseTrial!.source.history[0]!.netPnl,-11.393);
  assert.ok(Buffer.byteLength(JSON.stringify(prepareForwardProtectionWrite(s)))<112*1024);
});

test('paired logical JSON above the old single-account cap roundtrips through bounded compressed chunks',async()=>{
  const {s}=fixture();s.storage.persistedAt=T;
  // Deterministic high-entropy active text exercises real external
  // chunks, not a tiny compressed run of repeated padding. No user data.
  const payload=Array.from({length:18000},(_,i)=>createHash('sha256').update('active-evidence-'+i).digest('hex')).join('');
  s.positions[0]!.rule.reason=payload;
  s.inverseTrial!.source.positions[0]!.rule.reason=payload;
  const before=structuredClone(s),write=await prepareForwardWrite(before,s,T,{compact:true});
  assert.ok(write.compression.rawBytes>2*1024*1024);
  assert.equal(write.compression.accountBudgetBytes,4*1024*1024);
  assert.ok(write.compression.storedBytes<=2*1024*1024);
  assert.ok(write.compression.chunks>0);
  const headKey='forward-relations:v1:head',head=write.entries[headKey] as {accountMode?:string;inline?:Uint8Array};
  assert.equal(head.accountMode,'shadow-inverse-v1');
  for(const value of Object.values(write.entries))if(value instanceof Uint8Array)assert.ok(value.byteLength<=112*1024);
  const db=new Map(Object.entries(write.entries)),reader={get:async<T>(k:string)=>structuredClone(db.get(k)) as T|undefined};
  const restored=await readForwardStore(reader,T+1);
  near(restored.balance,s.balance);near(restored.inverseTrial!.source.balance,s.inverseTrial!.source.balance);
  assert.equal(restored.positions[0]!.quantity,s.positions[0]!.quantity);
  assert.equal(restored.inverseTrial!.source.positions[0]!.quantity,s.inverseTrial!.source.positions[0]!.quantity);
  assert.deepEqual(restored.positions[0]!.inverseCopy,s.positions[0]!.inverseCopy);
  assert.equal(restored.positions[0]!.rule.reason,payload);
  assert.equal(restored.inverseTrial!.source.positions[0]!.rule.reason,payload);
  assertInverseTrial(restored);
  // Old or unknown heads may not silently obtain the larger envelope.
  const valid=structuredClone(db.get(headKey)) as Record<string,unknown>;
  db.set(headKey,{...valid,accountMode:undefined});await assert.rejects(()=>readForwardStore(reader,T+1),/预算/);
  db.set(headKey,{...valid,accountMode:'arbitrary'});await assert.rejects(()=>readForwardStore(reader,T+1),/模式/);
});
test('a single account retains its old raw limit and oversized paired accounts fail before publication',async()=>{
  const single=initialForward(T-B);single.latestReason='x'.repeat(1100*1024);
  await assert.rejects(()=>prepareForwardWrite(structuredClone(single),single,T,{compact:true}),/账户预算/);
  const {s}=fixture();s.positions[0]!.rule.reason='x'.repeat(4200*1024);
  await assert.rejects(()=>prepareForwardWrite(structuredClone(s),s,T,{compact:true}),/账户预算/);
});
test('declared paired storage requires an actual matching dual ledger after verified decoding',async()=>{
  const s=initialForward(T-B),write=await prepareForwardWrite(null,s,T,{compact:true}),key='forward-relations:v1:head';
  const db=new Map(Object.entries(write.entries));db.set(key,{...(db.get(key) as object),accountMode:'shadow-inverse-v1'});
  await assert.rejects(()=>readForwardStore({get:async<T>(k:string)=>structuredClone(db.get(k)) as T|undefined},T+1),/配对账本不一致/);
});
test('new comparison fills book both legs at 5bp and keep the frozen 7bp receipt',()=>{
  const {s,t}=fixture(),f=s.positions[0]!.inverseCopy!.fills[0]!;
  near(f.fee,t.notional*.0005);near(f.sourceFee,t.notional*.0005);near(f.frozenSourceFee!,t.notional*.0007);
  near(t.entryFee,t.notional*.0007);near(s.positions[0]!.entryFee,t.notional*.0005);
  near(s.balance,1000-s.positions[0]!.entryFee);near(s.inverseTrial!.totals.feeSavings!,0);assertInverseTrial(s);
});
test('a stored 7bp source column is aligned to 5bp without touching inverse cash',()=>{
  const {s}=fixture(),f=s.positions[0]!.inverseCopy!.fills[0]!,before=s.balance;
  f.sourceFee=f.quantity*f.sourcePrice*.0007;delete f.sourceFeeRate;delete f.sourceFeePolicy;delete f.frozenSourceFee;
  s.inverseTrial!.totals.sourceFees=f.sourceFee;s.inverseTrial!.totals.feeSavings=f.sourceFee-f.fee;
  assert.equal(alignComparisonSourceFees(s),true);assert.equal(alignComparisonSourceFees(s),false);
  near(s.balance,before);near(f.sourceFee,f.fee);near(f.frozenSourceFee!,f.quantity*f.sourcePrice*.0007);
  near(s.inverseTrial!.totals.sourceFees,s.inverseTrial!.totals.fees);near(s.inverseTrial!.totals.feeSavings!,0);
  assertInverseTrial(s);
});
test('1U reversals record peak and trough times and a restart keeps them',async()=>{
  const {s}=fixture();
  const sample=(at:number,price:number)=>{
    const src=s.inverseTrial!.source.positions[0]!;src.lastPrice=price;src.lastQuoteAt=at;recordInverseCurve(s,{},at);
  };
  sample(T+60_000,100);sample(T+120_000,100.2);sample(T+180_000,100);sample(T+240_000,100.05);
  const early=s.inverseTrial!.swings??[];
  assert.equal(early.filter(x=>x.book==='source'&&x.kind==='PEAK').length,1);
  assert.equal(early.filter(x=>x.book==='inverse'&&x.kind==='TROUGH').length,1);
  assert.equal(early.filter(x=>x.book==='source'&&x.kind==='TROUGH').length,0);
  sample(T+300_000,99.8);sample(T+360_000,100.05);
  const swings=s.inverseTrial!.swings??[];
  const sourceTrough=swings.filter(x=>x.book==='source'&&x.kind==='TROUGH').at(-1)!;
  const inversePeak=swings.filter(x=>x.book==='inverse'&&x.kind==='PEAK').at(-1)!;
  assert.equal(sourceTrough.at,T+300_000);assert.equal(inversePeak.at,T+300_000);
  near(sourceTrough.equity,997.5);near(inversePeak.equity,1001.5);
  assert.equal(inverseTrialSummary(s,{},T+360_000)!.swings.length,swings.length);
  s.storage.persistedAt=T;const write=await prepareForwardWrite(null,s,T+360_000,{compact:true});
  const restored=await readForwardStore({get:async<V>(k:string)=>structuredClone(new Map(Object.entries(write.entries)).get(k)) as V|undefined},T+360_001);
  assert.deepEqual(restored.inverseTrial!.swings,swings);assertInverseTrial(restored);
});
test('a soft source hold cuts only the inverse once floating gross is worse than 5U',()=>{
  const intel=(phase:'DECAYING'|'BUILDING',hold:number,continuation:number,concerns:('FLOW')[])=>({
    version:'test',updatedAt:T+60_000,decision:phase==='DECAYING'?'REVIEW':'HOLD',phase,reviewSince:null,reviewBars:0,lastCompletedBar:T,
    entryAdvantage:0,currentAdvantage:0,advantageChange:0,remainingSpaceRate:.01,expectedPullbackRate:.01,continuationRatio:continuation,
    holdValueScore:hold,exitValueScore:100-hold,dataConfidence:80,counterfactualNewEntry:false,supportFamilies:[],concernFamilies:concerns,
    assessments:[],reasons:[],concerns:[],summary:'test'}) as NonNullable<Trade['positionIntelligence']>;
  const arm=(soft:boolean,price:number)=>{
    const pack=fixture('LONG'),now=T+60_000;
    pack.t.lastPrice=price;pack.t.lastQuoteAt=now;pack.t.positionIntelligence=intel(soft?'DECAYING':'BUILDING',soft?70:96,soft?1.1:1.8,soft?['FLOW']:[]);
    retainSource(pack.s,pack.source);
    const inv=pack.s.positions[0]!;inv.lastPrice=price;inv.lastQuoteAt=now;
    return {pack,now,inv,cut:applyInverseSoftLossExits(pack.s,now)};
  };
  const firm=arm(false,101);
  assert.equal(firm.cut,false);assert.equal(firm.inv.status,'OPEN');assertInverseTrial(firm.pack.s);
  const shallow=arm(true,100.5);
  assert.equal(shallow.cut,false);assert.equal(shallow.inv.status,'OPEN');
  const {pack,now,inv,cut}=arm(true,101);
  assert.equal(cut,true);assert.equal(inv.status,'CLOSED');assert.equal(inv.exitReason,'INVERSE_SOFT_LOSS_EXIT');
  assert.equal(pack.s.positions.length,0);assert.equal(pack.source.positions.length,1);
  near(inv.netPnl!,-10-inv.entryFee-10*101*.0005);near(pack.s.balance,1000-inv.entryFee-10.505);
  assert.equal(applyInverseSoftLossExits(pack.s,now+1),false);
  const summary=inverseTrialSummary(pack.s,{TEST_USDT:quote(101,101,now)},now)!;
  near(summary.inverseNet,inv.netPnl!);near(summary.sourceNet,9.5);
  sourceClose(pack.source,pack.t,102,now+60_000);retainSource(pack.s,pack.source);
  const net=inv.netPnl;applyInverseSourceTrade(pack.s,pack.t,quote(102,102,now+60_000),now+60_000);
  near(inv.netPnl!,net!);assert.equal(inv.inverseCopy!.detachedSourceClosed,true);assert.equal(inv.inverseCopy!.sourceExitReason,'WINNER_THESIS_EXIT');
  near(pack.s.inverseTrial!.totals.detachedSourceGross!,20);assertInverseTrial(pack.s);
  assert.equal(summary.independentDecisions,false);
});

test('live cost estimate applies the measured 6bp gap to traded notional without changing paper books',()=>{
  const {s,source,t}=fixture('LONG');
  sourceClose(source,t,110,T+60_000);retainSource(s,source);
  applyInverseSourceTrade(s,t,quote(110,110,T+60_000),T+60_000);
  const summary=inverseTrialSummary(s,{TEST_USDT:quote(110,110,T+60_000)},T+60_000)!;
  const est=summary.liveCostEstimate;
  assert.equal(est.policy,LIVE_EXECUTION_GAP_POLICY);assert.equal(est.gapRate,LIVE_EXECUTION_GAP_RATE);
  const traded=s.inverseTrial!.totals.fees/INVERSE_COST.feeRate;
  near(est.tradedNotional,traded);near(est.executionGap,traded*LIVE_EXECUTION_GAP_RATE);
  near(est.estimatedNet,summary.inverseNet-est.executionGap);
  assert.ok(est.estimatedNet<summary.inverseNet);
  assertInverseTrial(s);
});
