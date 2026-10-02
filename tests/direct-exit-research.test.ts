import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,type Trade,type Quote} from '../lib/forward-relations.ts';
import {captureTradeReviews} from '../lib/review-trace.ts';
import {captureDirectExitResearch,trimDirectExitHistory,withoutDirectExitResearch,directExecutionTradeProjection,directExitResearchView,
  DIRECT_EXIT_RESEARCH_BYTES,DIRECT_EXIT_RESEARCH_POINTS,boundedDirectExitResearch} from '../lib/direct-exit-research.ts';
import {prepareForwardWrite,readForwardStore,prepareForwardProtectionWrite,FORWARD_PROTECTION_STORAGE} from '../lib/forward-store.ts';
import {restoreForwardProtectionCheckpoint,forwardProtectionChanged,buildForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {buildReviewSnapshot,mergeReviewArchive} from '../lib/research-snapshot.ts';
const T=1790956800000;
const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
const q=(p:number,at:number):Quote=>({bestBid:p,bestAsk:p+.05,observedAt:at,fresh:true,entryReady:true,sourceCount:3});
function fixture(side:'LONG'|'SHORT'='LONG'){
  const s=initialForward(T);s.storage.persistedAt=T;
  const t={id:'actual',symbol:'TEST_USDT',side,status:'OPEN',openedAt:T,closedAt:null,entryPrice:100,exitPrice:null,
    quantity:10,contracts:100,quantoMultiplier:.1,notional:1000,leverage:5,margin:200,plannedRisk:20,stopPrice:side==='LONG'?98:102,
    armPrice:110,favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.5,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,rule:{id:'r',signature:'r',conditions:[],side,reason:'actual'},
    execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,unified:{version:'dual-thesis-v2',branch:'CONTINUATION',
      sourceId:'actual',referenceId:'actual',entryReason:'local confirmed trend',holdReason:'结构未失效，继续观察',exitCondition:'structure fails',
      lastDecisionAt:T,lastBarAt:T,region:null,epsilon:.05,confirmation:null,initialStop:98,referenceContracts:100,
      decision:'HOLD',explanationEvents:[]}} as Trade;
  s.positions=[t];return{s,t};
}
function observe(f:ReturnType<typeof fixture>,p:number,at:number){f.t.lastPrice=p;f.t.lastQuoteAt=at;
  captureDirectExitResearch(f.s,f.t,q(p,at),at,at===T);return f.t.directExitResearch!;}
test('actual gross threshold is strict and own BBO costs/side never change finance or protection flags',()=>{
  for(const side of ['LONG','SHORT'] as const){const f=fixture(side);observe(f,100,T);
    observe(f,side==='LONG'?99:101,T+2000);assert.equal(f.t.directExitResearch!.firstLoss10At,null);
    f.t.lastPrice=side==='LONG'?98.8:101.2;f.t.lastQuoteAt=T+4000;
    const before=structuredClone(f.s),r=observe(f,f.t.lastPrice,T+4000),p=r.points.find(p=>p.at===r.firstLoss10At)!;
    assert.ok(Math.abs(p.floating+12)<1e-8);assert.ok(Math.abs(p.exitNet!-(side==='LONG'?-12.994:-13.50625))<1e-8);
    assert.deepEqual({...f.t,directExitResearch:undefined},{...before.positions[0],directExitResearch:undefined});
    assert.equal(forwardProtectionChanged(before,f.s),false);
  }
});
test('recovery winners remain controls, evidence/confirmation facts and terminal actual fees survive',()=>{
  const f=fixture();observe(f,100,T);observe(f,98.8,T+2000);observe(f,97,T+4000);
  f.t.unified!.researchObservation={checkedAt:T+6000,confirmation:{side:'SHORT',at:T+6000,bars:[T,T+300000],path:'HOLD_OUTSIDE',stop:100,boundary:98,epsilon:.05},flowConfirmed:true};
  observe(f,99.6,T+6000);observe(f,99.9,T+8000);observe(f,100.2,T+10000);
  Object.assign(f.t,{status:'CLOSED',closedAt:T+12000,exitPrice:101,netPnl:9,exitFee:.505,exitReason:'STRUCTURE_EXIT'});
  f.s.positions=[];f.s.history=[f.t];captureDirectExitResearch(f.s,f.t,q(101,T+12000),T+12000,false);
  const r=f.t.directExitResearch!,v=directExitResearchView([f.t]);assert.equal(r.finalNet,9);
  assert.equal(r.recoveryMask,7);assert.ok(r.worstFloating<-29.99);assert.deepEqual(v.recoveredWinningControls,['actual']);
  assert.ok(r.points.some(p=>p.flowConfirmed&&p.confirmationBars.length===2));
  const terminal=r.points.find(p=>p.kind.includes('terminal'))!;assert.equal(terminal.exitNet,9);assert.equal(terminal.paidFees,1.005);
  assert.ok(bytes(r)<=DIRECT_EXIT_RESEARCH_BYTES);assert.ok(r.points.length<=DIRECT_EXIT_RESEARCH_POINTS);
});
test('partial realization is counted once; migrated/late observation does not invent a first crossing',()=>{
  const f=fixture();f.t.quantity=5;f.t.contracts=50;f.t.notional=500;
  f.t.realization={version:'partial-realization-v1',initialQuantity:10,initialContracts:100,initialNotional:1000,initialMargin:200,
    initialRisk:20,initialEntryFee:.5,gross:4,fees:.25,funding:0,sequence:1,fills:[]};
  f.t.unified!.migratedAt=T;const r=observe(f,97,T+60000),p=r.points[0];
  assert.equal(r.fromEntry,false);assert.equal(r.migrated,true);assert.equal(r.firstLoss10At,T+60000);
  assert.equal(p.exitNet,3.75-15-.5-.2425);assert.equal(p.paidFees,.75);
});
test('stale BBO never creates a loss crossing and malformed optional records recover without aborting review',()=>{
  const f=fixture();f.t.lastPrice=95;captureDirectExitResearch(f.s,f.t,{...q(95,T),fresh:false},T+2000,false);
  assert.equal(f.t.directExitResearch,undefined);
  f.t.directExitResearch={bad:true} as never;captureTradeReviews(structuredClone(f.s),f.s,T+4000,'synthetic','synthetic',{TEST_USDT:q(95,T+4000)});
  assert.ok(f.t.review);assert.ok(boundedDirectExitResearch(f.t.directExitResearch));
});
test('10 concurrent positions over 10000 observations stay bounded; 240 hot settlements retain only eight traces',()=>{
  const f=fixture();f.s.positions=Array.from({length:10},(_,i)=>({...structuredClone(f.t),id:`actual-${i}`}));
  for(let i=0;i<10000;i++)for(const t of f.s.positions){t.lastPrice=98+Math.sin(i/20);t.lastQuoteAt=T+i*2000;
    t.unified!.holdReason=`${'继续观察'.repeat(100)}${i}`;captureDirectExitResearch(f.s,t,q(t.lastPrice,t.lastQuoteAt),t.lastQuoteAt,i===0);}
  for(const t of f.s.positions){assert.ok(bytes(t.directExitResearch)<=4096);assert.ok(t.directExitResearch!.points.length<=8);}
  assert.ok(bytes(f.s.positions.map(t=>t.directExitResearch))<=10*4096+11);
  f.s.history=Array.from({length:240},(_,i)=>({...structuredClone(f.s.positions[0]),id:`closed-${i}`,status:'CLOSED',closedAt:T+100000+i}));
  trimDirectExitHistory(f.s,T+9999999);assert.equal(f.s.history.filter(t=>t.directExitResearch).length,8);
  assert.equal(f.s.history.filter(t=>t.directExitResearchOmitted).length,232);
});
test('newly closed burst is retained for its existing archive; checkpoints restore and member projection removes only research',async()=>{
  const f=fixture();observe(f,98,T+2000);
  const c=prepareForwardProtectionWrite(f.s).entries[FORWARD_PROTECTION_STORAGE],restored=restoreForwardProtectionCheckpoint(f.s,c);
  assert.deepEqual(restored.positions[0].directExitResearch,f.t.directExitResearch);
  const projection=directExecutionTradeProjection(f.t);assert.equal(projection.directExitResearch,undefined);assert.equal(projection.contracts,100);
  assert.deepEqual(directExecutionTradeProjection(projection),projection);assert.ok(f.t.directExitResearch);
  f.s.history=Array.from({length:20},(_,i)=>({...structuredClone(f.t),id:`closed-${i}`,status:'CLOSED',closedAt:i<10?T+4000:T}));
  trimDirectExitHistory(f.s,T+4000);assert.equal(f.s.history.filter(t=>t.directExitResearch).length,18);
  const saved=await prepareForwardWrite(null,f.s,T+5000,{compact:true});
  const state=await readForwardStore({get:async(k:string)=>saved.entries[k]},T+5000);
  assert.equal(state!.history.filter(t=>t.directExitResearch).length,8);
});
test('optional checkpoint pressure yields before essential protection; old financial fields stay identical',()=>{
  const f=fixture();observe(f,98,T+2000);f.t.unified!.holdReason='x'.repeat(120*1024-1600);
  const withResearch=buildForwardProtectionCheckpoint(f.s),base=buildForwardProtectionCheckpoint({...f.s,positions:[withoutDirectExitResearch(f.t)]});
  assert.ok(bytes(withResearch)>120*1024);assert.ok(bytes(base)<=120*1024);
  const saved=prepareForwardProtectionWrite(f.s).entries[FORWARD_PROTECTION_STORAGE];
  assert.ok(bytes(saved)<=120*1024);assert.equal(saved.positions[0].directExitResearch,undefined);
  assert.equal(saved.positions[0].directExitResearchOmitted,true);assert.equal(saved.positions[0].stopPrice,f.t.stopPrice);
});
test('read-only snapshot hydrates omitted closed diagnostics from archive without rewriting financial outcomes',()=>{
  const f=fixture();observe(f,98,T+2000);Object.assign(f.t,{status:'CLOSED',closedAt:T+4000,netPnl:-21,exitPrice:98});
  f.s.positions=[];f.s.history=[withoutDirectExitResearch(f.t)];f.s.resolved=1;
  const v={...f.s,equity:979,floating:0,netPnl:-21};const snapshot=buildReviewSnapshot({view:v,runtime:{},journal:null,exportedAt:T+5000,buildSha:'synthetic',strategyFingerprint:'synthetic'});
  assert.equal(snapshot.summary.directExitArchiveMissing,1);
  mergeReviewArchive(snapshot,{accountStartedAt:T,asOf:T+5000,trades:[f.t],recordsRead:1,nextCursor:null,exhausted:true});
  assert.equal(snapshot.summary.directExitArchiveMissing,0);assert.equal(snapshot.trades[0].netPnl,-21);
  assert.ok(snapshot.research.directExitResearch);assert.ok(snapshot.trades[0].directExitResearch);
});
test('optional diagnostics do not create extra archive shards even near the per-value ceiling',async()=>{
  let exercised=false;
  for(const kb of [107,108,109,110]){
    const f=fixture();for(let i=0;i<12;i++)observe(f,98+Math.sin(i),T+i*2000);
    f.t.rule.reason='x'.repeat(kb*1024);f.s.events=[{id:'event-1',at:T,kind:'EXIT',subject:f.t.id,reason:'synthetic'}];
    f.s.revision=1;const plain={...f.s,positions:f.s.positions.map(withoutDirectExitResearch)};
    let base;try{base=await prepareForwardWrite(null,plain,T+30000,{compact:true});}catch{continue;}
    const rich=await prepareForwardWrite(null,f.s,T+30000,{compact:true}),archives=(w:typeof rich)=>Object.entries(w.entries).filter(([k])=>k.includes(':archive:'));
    assert.equal(archives(rich).length,archives(base).length);
    for(const [,packet] of archives(rich)){assert.ok(bytes(packet)<=112*1024);
      if((packet as {trades:Trade[]}).trades.some(t=>t.directExitResearchOmitted))exercised=true;}
  }
  assert.equal(exercised,true,'at least one near-cap archive must yield diagnostic bytes');
});
