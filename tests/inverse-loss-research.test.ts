import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,type ForwardState,type Trade,type Quote} from '../lib/forward-relations.ts';
import {newInverseTrial,sourceDecisionState,shadowCapsule,applyInverseSourceTrade,markInversePositions} from '../lib/shadow-inverse-ledger.ts';
import {captureTradeReviews} from '../lib/review-trace.ts';
import {captureInverseLossResearch,inverseLossResearchView,INVERSE_LOSS_RESEARCH_BYTES,INVERSE_LOSS_RESEARCH_POINTS} from '../lib/inverse-loss-research.ts';
import {prepareForwardWrite,readForwardStore} from '../lib/forward-store.ts';
import {buildReviewSnapshot,mergeReviewArchive,readReviewArchivePage,collectReviewSnapshot} from '../lib/research-snapshot.ts';
import type {PositionIntelligenceState} from '../lib/position-intelligence-engine.ts';

const T=1790907600000;
const quote=(p:number,at:number):Quote=>({bestBid:p,bestAsk:p+.05,observedAt:at,fresh:true,entryReady:true,sourceCount:3,
  bookImbalance:.3,bidLiquidityChange:.2,askLiquidityChange:-.1});
const pi=(at:number,decision='HOLD'):PositionIntelligenceState=>({updatedAt:at,decision,phase:'HEALTHY',holdValueScore:82,
  continuationRatio:1.8,advantageChange:12,dataConfidence:90,reviewBars:1,lastCompletedBar:T,supportFamilies:['RELATIVE','PATH','STRUCTURE'],
  concernFamilies:['FLOW'],assessments:[{family:'RELATIVE',stance:'SUPPORT',severity:.8},{family:'FLOW',stance:'CONCERN',severity:.4}],exitBasis:null} as PositionIntelligenceState);
function fixture(side:'LONG'|'SHORT'='LONG'){
  const s=initialForward(T-300000);s.inverseTrial=newInverseTrial(s,T,1000);
  const source=sourceDecisionState(s),t={id:'source',symbol:'TEST_USDT',side,status:'OPEN',openedAt:T,closedAt:null,
    entryPrice:100,exitPrice:null,quantity:10,contracts:100,quantoMultiplier:.1,notional:1000,leverage:10,margin:100,plannedRisk:20,
    stopPrice:side==='LONG'?98:102,armPrice:110,favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.7,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,rule:{id:'r',signature:'r',conditions:[],side:'LONG',reason:'source'},
    execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,positionIntelligence:pi(T)} as Trade;
  source.positions=[t];source.balance-=t.entryFee;source.fees+=t.entryFee;source.turnover+=t.notional;
  applyInverseSourceTrade(s,t,quote(100,T),T);s.inverseTrial.source=shadowCapsule(source);
  return s;
}
function observe(s:ForwardState,p:number,at:number){
  const t=s.inverseTrial!.source.positions[0];t.lastPrice=p;t.lastQuoteAt=at;t.positionIntelligence=pi(at);
  markInversePositions(s,{TEST_USDT:quote(p,at)},at);
  captureInverseLossResearch(s,s.positions[0],t,quote(p,at),at);
  return s.positions[0].inverseCopy!.lossResearch!;
}
function close(s:ForwardState,p:number,at:number){
  const src=s.inverseTrial!.source,t=src.positions[0],gross=(t.side==='LONG'?1:-1)*10*(p-100),fee=10*p*.0007,funding=1000*.0002*(at-T)/86400000;
  Object.assign(t,{status:'CLOSED',closedAt:at,exitPrice:p,lastPrice:p,lastQuoteAt:at,grossPnl:gross,exitFee:fee,
    fundingAllowance:funding,netPnl:gross-t.entryFee-fee-funding,exitReason:'WINNER_STRUCTURE_EXIT',positionIntelligence:pi(at),
    exitAudit:{trigger:'WINNER_STRUCTURE_EXIT',at,evidence:{quoteAt:at}}});
  src.positions=src.positions.filter(x=>x.id!==t.id);src.history.unshift(t);src.balance+=gross-fee-funding;src.grossPnl+=gross;src.fees+=fee;src.fundingAllowance+=funding;src.resolved++;
  applyInverseSourceTrade(s,t,quote(p,at),at);
  captureInverseLossResearch(s,s.history[0],t,quote(p,at),at);
  return s.history[0];
}
const bytes=(r:unknown)=>new TextEncoder().encode(JSON.stringify(r)).length;
const strip=(s:ForwardState)=>{const n=structuredClone(s);for(const t of [...n.positions,...n.history])if(t.inverseCopy)delete t.inverseCopy.lossResearch;return n;};

test('strict gross loss crossing, fee-correct hypothetical exit and independent executable BBO are recorded without financial changes',()=>{
  const s=fixture();observe(s,100,T);observe(s,101,T+60000);
  assert.equal(s.positions[0].inverseCopy!.lossResearch!.anchors.firstLoss10,undefined,'exactly -10 is not over10');
  const before=strip(s),sourceBefore=structuredClone(s.inverseTrial!.source);
  // Mark is financial-engine work; capture itself may change only loss metadata.
  const st=s.inverseTrial!.source.positions[0];st.lastPrice=101.2;st.lastQuoteAt=T+120000;st.positionIntelligence=pi(T+120000);
  markInversePositions(s,{},T+120000);const marked=strip(s);
  captureInverseLossResearch(s,s.positions[0],st,quote(101.2,T+120000),T+120000);
  assert.deepEqual(strip(s),marked);assert.deepEqual(s.inverseTrial!.source,marked.inverseTrial!.source);
  const r=s.positions[0].inverseCopy!.lossResearch!,p=r.points.find(x=>x.at===r.anchors.firstLoss10)!;
  assert.equal(r.fromEntry,true);assert.equal(p.grossFloating,-12);assert.equal(p.paperExitNet,-13.006);
  assert.equal(p.estimatedExitFee,.506);assert.equal(p.executablePrice,101.25);assert.equal(p.executableExitNet,-13.50625);
  assert.equal(p.sourceEvidence!.decision,'HOLD');assert.deepEqual(p.sourceEvidence!.support,['RELATIVE','PATH','STRUCTURE']);
  assert.equal(p.inverseEvidence.alignedBook,-.3);assert.equal(p.inverseEvidence.alignedLiquidity,-.15);
  assert.equal(r.automaticExit,false);assert.ok(r.preLossWindow.length>=2);assert.equal(before.balance,s.balance);assert.equal(sourceBefore.balance,s.inverseTrial!.source.balance);
});

test('recovery, renewed deterioration and actual close preserve causal events and expose hindsight extrema separately',()=>{
  const s=fixture();observe(s,100,T);observe(s,101.2,T+60000);observe(s,102.5,T+120000);
  observe(s,100.2,T+180000);observe(s,103,T+240000);const t=close(s,102,T+300000),r=t.inverseCopy!.lossResearch!;
  assert.equal(r.anchors.firstLoss10,T+60000);assert.equal(r.anchors.worstLoss,T+240000);
  assert.equal(r.anchors.bestAfterLoss10,T+180000);assert.equal(r.anchors.firstRecovery5,T+180000);
  assert.equal(r.anchors.firstRecovery2,T+180000);assert.equal(r.anchors.terminal,T+300000);
  const view=inverseLossResearchView([t]);assert.equal(view.coverage.closedDeepLossRecords,1);
  const best=view.comparisons[0].candidates.find(x=>x.name==='bestAfterLoss10')!;
  assert.equal(best.hindsightExtremum,true);assert.ok(best.improvement!>17);
  assert.ok(view.comparisons[0].candidates.every(c=>c.at<t.closedAt!));
  assert.equal(r.points.find(p=>p.status==='CLOSED')!.paperExitNet,t.netPnl);
});

test('legacy high MAE, stale/future/invalid quotes and finalized history never manufacture a causal threshold time',()=>{
  const s=fixture(),t=s.positions[0];t.adverse=.04;
  observe(s,100,T+60000);const r=t.inverseCopy!.lossResearch!;
  assert.equal(r.fromEntry,false);assert.equal(r.legacyDeepLossBeforeObservation,true);assert.equal(r.inheritedGrossMae,40);
  assert.equal(r.anchors.firstLoss10,undefined);
  const src=s.inverseTrial!.source.positions[0],before=structuredClone(r);
  for(const q of [{...quote(105,T+60000),fresh:false},quote(105,T+130000),{...quote(105,T+120000),bestAsk:104}])
    captureInverseLossResearch(s,t,src,q,T+120000);
  assert.deepEqual(t.inverseCopy!.lossResearch,before);
  const end=close(s,101,T+180000),endBefore=structuredClone(end.inverseCopy!.lossResearch);
  captureInverseLossResearch(s,end,src,quote(106,T+240000),T+240000);
  assert.deepEqual(end.inverseCopy!.lossResearch,endBefore);
});

test('per-order storage stays bounded during long alternating paths and missing source assessments stay unknown',()=>{
  const s=fixture();observe(s,100,T);
  for(let i=1;i<=1200;i++)observe(s,100+(i%3===0?.1:i%3===1?2:4),T+i*60000);
  const r=s.positions[0].inverseCopy!.lossResearch!;
  assert.ok(r.points.length<=INVERSE_LOSS_RESEARCH_POINTS);assert.ok(bytes(r)<=INVERSE_LOSS_RESEARCH_BYTES);
  assert.ok(r.droppedPoints>1000);assert.equal(r.anchors.firstLoss10,T+60000);
  assert.ok(r.points.some(p=>p.at===r.anchors.worstLoss));assert.ok(r.points.some(p=>p.at===r.anchors.bestAfterLoss10));
  const src=s.inverseTrial!.source.positions[0];delete src.positionIntelligence;
  const at=T+1201*60000;src.lastQuoteAt=at;markInversePositions(s,{},at);
  captureInverseLossResearch(s,s.positions[0],src,quote(src.lastPrice,at),at);
  assert.equal(s.positions[0].inverseCopy!.lossResearch!.points.at(-1)!.sourceEvidence,null);
});

test('source trims use remaining quantity and previously paid fees exactly once in hypothetical full-parent exits',()=>{
  const s=fixture(),t=s.positions[0],copy=t.inverseCopy!;
  copy.fills.push({sequence:1,kind:'REDUCE',sourceAt:T+1000,appliedAt:T+1000,sourceQuoteAt:T+1000,quoteAt:T+1000,
    sourcePrice:102,price:102,quantity:4,contracts:40,sourceGross:8,gross:-8,sourceFee:.2856,fee:.204,sourceFunding:0,funding:0,spreadDrag:0});
  t.quantity=6;t.contracts=60;t.notional=600;
  observe(s,103,T+60000);const p=t.inverseCopy!.lossResearch!.points[0];
  assert.equal(p.remainingQuantity,6);assert.equal(p.grossFloating,-18);assert.equal(p.paperExitNet,-27.013);
});

test('inverse LONG recovering to a final profit remains a control and discarded first events are not recreated',()=>{
  const s=fixture('SHORT');observe(s,100,T);let r=observe(s,98,T+60000);
  assert.equal(s.positions[0].side,'LONG');assert.equal(r.points.find(p=>p.at===r.anchors.firstLoss10)!.paperExitNet,-20.99);
  observe(s,99.9,T+120000);r=s.positions[0].inverseCopy!.lossResearch!;
  assert.equal(r.anchors.firstRecovery2,T+120000);delete r.anchors.firstRecovery2;r.droppedAnchors.push('firstRecovery2');
  observe(s,100.1,T+180000);assert.equal(r.anchors.firstRecovery2,undefined);
  const t=close(s,101,T+240000),v=inverseLossResearchView([t]);
  assert.ok(t.netPnl!>0);assert.equal(v.coverage.recoveryWinnerControls,1);assert.equal(v.coverage.closedDeepLossRecords,1);
  assert.ok(v.comparisons[0].candidates.find(p=>p.name==='firstLoss10')!.improvement!<0);
});

test('existing review capture is observational for source and ledger, and the normal archive restores research even without hot reviews',async()=>{
  const s=fixture(),before=structuredClone(s),empty=structuredClone(s);empty.positions=[];
  captureTradeReviews(empty,s,T,'build','strategy',{TEST_USDT:quote(100,T)});
  const n=strip(s);delete n.positions[0].review;assert.deepEqual(n,before);
  observe(s,102,T+60000);const prior=structuredClone(s),t=close(s,101,T+120000);
  const prepared=await prepareForwardWrite(prior,s,T+120000,{compact:true});
  const data=new Map(Object.entries(prepared.entries)),storage={get:async<TValue>(key:string)=>data.get(key) as TValue|undefined,
    list:async<TValue>()=>new Map([...data].filter(([k])=>k.startsWith('forward-relations:v1:archive:'))) as Map<string,TValue>};
  const restored=await readForwardStore(storage,T+120001);assert.deepEqual(restored!.history[0].inverseCopy!.lossResearch,t.inverseCopy!.lossResearch);
  const page=await readReviewArchivePage(storage,s.startedAt,T+120000,null);assert.ok(page.trades[0].inverseCopy!.lossResearch);
  const view={startedAt:s.startedAt,resolved:1,positions:[],history:[{...t,inverseCopy:{...t.inverseCopy!,lossResearch:undefined}}]};
  const snapshot=buildReviewSnapshot({view,exportedAt:T+120000,buildSha:'build',strategyFingerprint:'strategy'});
  mergeReviewArchive(snapshot,page);
  assert.deepEqual(snapshot.trades[0].inverseCopy!.lossResearch,t.inverseCopy!.lossResearch);
  assert.equal((snapshot.research.inverseLossExit as ReturnType<typeof inverseLossResearchView>).coverage.deepLossRecords,1);
  assert.equal((snapshot.research.inverseLossExit as ReturnType<typeof inverseLossResearchView>).comparisons[0].finalNet,t.netPnl);
  assert.ok(prepared.writes>0);assert.ok(Object.values(prepared.entries).every(v=>v instanceof Uint8Array||bytes(v)<=120*1024));
});

test('thirty rich inverse orders closing together shard losslessly inside existing per-value and financial reservations',async()=>{
  const s=fixture();observe(s,100,T);
  for(let i=1;i<=200;i++)observe(s,100+(i%3===0?.1:i%3===1?2:4),T+i*60000);
  const rich=structuredClone(s.positions[0].inverseCopy!.lossResearch!),src=s.inverseTrial!.source,template=structuredClone(src.positions[0]);
  for(let i=1;i<30;i++){
    const t={...structuredClone(template),id:`source-${i}`,lastPrice:100,lastQuoteAt:T,positionIntelligence:pi(T)};
    src.positions.push(t);src.balance-=t.entryFee;src.fees+=t.entryFee;src.turnover+=t.notional;
    applyInverseSourceTrade(s,t,quote(100,T),T);
  }
  for(const t of s.positions){t.inverseCopy!.lossResearch={...structuredClone(rich),sourceId:t.inverseCopy!.sourceId};}
  const before=structuredClone(s),at=T+201*60000;
  while(src.positions.length)close(s,102,at);
  const prepared=await prepareForwardWrite(before,s,at,{compact:true}),data=new Map(Object.entries(prepared.entries));
  assert.equal(prepared.writes,Object.keys(prepared.entries).length);
  const archives=[...data].filter(([key])=>key.startsWith('forward-relations:v1:archive:'));
  assert.ok(archives.length>1);assert.ok(archives.every(([,v])=>bytes(v)<=112*1024));
  const rows=archives.flatMap(([,v])=>(v as {trades:Trade[]}).trades);
  assert.equal(rows.length,30);assert.equal(new Set(rows.map(t=>t.id)).size,30);
  assert.ok(rows.every(t=>t.inverseCopy!.lossResearch!.anchors.firstLoss10===T+60000));
  const restored=await readForwardStore({get:async<TValue>(key:string)=>data.get(key) as TValue|undefined},at+1);
  assert.equal(restored!.resolved,30);assert.equal(restored!.balance,s.balance);
  assert.ok(restored!.history.every(t=>t.inverseCopy?.lossResearch));
  assert.ok(restored!.positions.length===0);assert.ok(restored!.inverseTrial!.source.positions.length===0);
});

test('hot pressure yields research before financial/source history and one-click export retrieves complete closed traces',async()=>{
  const s=fixture();observe(s,100,T);
  for(let i=1;i<=100;i++)observe(s,100+(i%3===0?.1:i%3===1?2:4),T+i*60000);
  const rich=structuredClone(s.positions[0].inverseCopy!.lossResearch!),src=s.inverseTrial!.source,template=structuredClone(src.positions[0]);
  for(let i=1;i<40;i++){
    const t={...structuredClone(template),id:`pressure-${i}`,lastPrice:100,lastQuoteAt:T,positionIntelligence:pi(T)};
    src.positions.push(t);src.balance-=t.entryFee;src.fees+=t.entryFee;src.turnover+=t.notional;applyInverseSourceTrade(s,t,quote(100,T),T);
  }
  for(const t of s.positions)t.inverseCopy!.lossResearch={...structuredClone(rich),sourceId:t.inverseCopy!.sourceId};
  const previous=structuredClone(s),at=T+101*60000;while(src.positions.length)close(s,102,at);
  s.latestReason='x'.repeat(600*1024);const baselineState=strip(s);
  const base=await prepareForwardWrite(previous,baselineState,at,{compact:true}),enriched=await prepareForwardWrite(previous,s,at,{compact:true});
  assert.equal(enriched.compression.droppedHotLossResearch,true);
  for(const k of ['hotHistory','fullHistory','hotEvents','narrativeHistory','evidence'] as const)assert.equal(enriched.compression[k],base.compression[k],k);
  const bdata=new Map(Object.entries(base.entries)),data=new Map(Object.entries(enriched.entries));
  const baseline=await readForwardStore({get:async<TValue>(k:string)=>bdata.get(k) as TValue|undefined},at+1),
    restored=await readForwardStore({get:async<TValue>(k:string)=>data.get(k) as TValue|undefined},at+1);
  assert.deepEqual(restored!.inverseTrial!.source,baseline!.inverseTrial!.source);
  assert.deepEqual(restored!.history.map(t=>t.id),baseline!.history.map(t=>t.id));assert.equal(restored!.balance,baseline!.balance);
  assert.ok(restored!.history.every(t=>t.inverseCopy!.lossResearchHotOmitted));
  const initial=buildReviewSnapshot({view:{startedAt:s.startedAt,resolved:40,positions:[],history:restored!.history},exportedAt:at,buildSha:'b',strategyFingerprint:'p'});
  assert.ok(Number(initial.summary.inverseLossArchiveMissing)>0);
  let calls=0;
  const result=await collectReviewSnapshot((async(url:unknown)=>{calls++;
    if(!String(url).includes('?'))return Response.json(initial);
    const page=await readReviewArchivePage({list:async<TValue>()=>new Map([...data].filter(([k])=>k.startsWith('forward-relations:v1:archive:'))) as Map<string,TValue>},s.startedAt,at,null);
    return Response.json(page);
  }) as typeof fetch);
  assert.equal(calls,2);assert.equal(result.trades.length,40);assert.equal(result.summary.inverseLossArchiveMissing,0);
  assert.ok(result.trades.every(t=>t.inverseCopy!.lossResearch));assert.equal(result.coverage.complete,true);
});

test('an otherwise valid large financial row yields optional research instead of blocking the close commit',async()=>{
  const s=fixture();observe(s,100,T);for(let i=1;i<=100;i++)observe(s,100+(i%2?2:.1),T+i*60000);
  const before=structuredClone(s),at=T+101*60000,t=close(s,102,at);t.rule.reason='r'.repeat(105*1024);
  const prepared=await prepareForwardWrite(before,s,at,{compact:true});
  const rows=Object.entries(prepared.entries).filter(([k])=>k.startsWith('forward-relations:v1:archive:'))
    .flatMap(([,v])=>(v as {trades:Trade[]}).trades);
  assert.equal(rows.length,1);assert.equal(rows[0].netPnl,t.netPnl);assert.equal(rows[0].inverseCopy!.lossResearchHotOmitted,true);
  assert.equal(rows[0].inverseCopy!.lossResearch,undefined);assert.ok(t.inverseCopy!.lossResearch,'in-memory research remains untouched');
  assert.ok(Object.values(prepared.entries).every(v=>v instanceof Uint8Array||bytes(v)<=120*1024));
});
