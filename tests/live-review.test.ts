/* eslint-disable @typescript-eslint/no-explicit-any -- isolated Worker projection tests, no real exchange */
import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
import {buildLiveReview,readLiveReviewPage,compareLiveReview,LIVE_REVIEW_PAGE_ROWS} from '../lib/live-review.ts';
import {buildReviewSnapshot,collectReviewSnapshot,readReviewArchivePage,REVIEW_ARCHIVE_PAGE_ROWS} from '../lib/research-snapshot.ts';
import {createOwnerSession,ownerSessionCookie} from '../lib/owner-auth.ts';
import {issueMemberSession,memberCookie} from '../lib/member-auth.ts';
register('./worker-test-loader.mjs',import.meta.url);
const {MarketStream,MemberExecutor,default:worker}=await import('../worker/index-clean.ts');
const T=1790809800000,ROOT='synthetic-review-root';
const position=(id='a',patch:any={})=>({id,symbol:'AAA_USDT',side:'LONG',status:'CLOSED',entryAt:T+3000,entryPrice:101,
  exitAt:T+20000,exitPrice:109,actualExitPriceVerified:false,exchangeSize:2,
  parity:{sourceId:id,activationAt:T,sourceOpenedAt:T+1000,sourceEntryPrice:100,sourceContractsAtCopy:10,
    copiedAt:T+2000,ratio:.25,sourceNotional:1000,submittedAt:T+2500,submitDelayMs:1500},...patch});
const live=()=>({activation:{enabledAt:T,sourceStartedAt:T-1000,excludedSourceIds:['old']},requestedEnabled:true,
  accountMark:{sessionAt:T,accountUser:'synthetic',at:T+30000,startedAt:T+100,initialEquity:100,equity:106,
    tradingPnl:4,capitalChange:6},positions:{AAA:position()},entries:{AAA:{createdAt:T+2000,mirrorSourceId:'a',status:'FILLED',apiKey:'never-export'}},auditEvents:[]});
const native=()=>buildLiveReview({live:live(),at:T+30000});
const paper=()=>buildReviewSnapshot({view:{startedAt:T-1000,positions:[],history:[],resolved:0},buildSha:null,strategyFingerprint:null,exportedAt:T+30000,
  runtime:{privateLiveReviewAvailable:true}});
test('account/session baseline, native fees and unknown costs remain distinct and inputs are immutable',()=>{
  const l=live(),before=structuredClone(l),r=buildLiveReview({live:l,account:{user:'synthetic',history:{pnl:'20',fee:'-5',fund:'1'}},accountAt:T+30000,at:T+30000});
  assert.equal(r.account.equityChange,6);assert.equal(r.account.capitalMovementResidual,2);
  assert.deepEqual(r.account.cumulativeNativeCashComponents,{pricePnl:20,fees:-5,funding:1});
  assert.equal(r.account.sessionCashComponents,null);assert.equal(r.positions[0].exitPrice,null);assert.equal(r.positions[0].settlement,null);
  assert.doesNotMatch(JSON.stringify(r),/never-export|apiKey/);assert.deepEqual(l,before);
  assert.equal(buildLiveReview({live:l,accountAt:T,at:T+30000}).account.cumulativeNativeCashComponents.fees,null);
  l.accountMark.sessionAt=T-1;assert.equal(buildLiveReview({live:l,at:T+30000}).account.equity,null);
});
test('pre-enable and prior-session carries are excluded; native settlement is assigned by cached identity only',()=>{
  const l:any=live();l.positions.old=position('old',{parity:{activationAt:T-1},entryAt:T+1});
  const r=buildLiveReview({live:l,at:T+30000,cached:[{id:'a',settlement:{version:'gate-close-settlement-v1',pnl:2,fees:-.1,funding:0,exitPrice:103}}]});
  assert.equal(r.positions.length,1);assert.equal(r.retainedCoverage.excludedCarryoverPositions,1);
  assert.equal(r.positions[0].exitPrice,103);assert.equal(r.positions[0].actualExitPriceVerified,true);
  const comparison=compareLiveReview(r,[{id:'a',openedAt:T+1000,closedAt:T+20000,side:'LONG',entryPrice:100,exitPrice:104,netPnl:8},
    {id:'old',openedAt:T-1}],true,T-1000);
  assert.equal(comparison.eligibleIncluded,1);assert.equal(comparison.paired[0].quantityRatio,.2);
  assert.ok(Math.abs(comparison.comparableNetDifference!-.4)<1e-10);
  assert.equal(compareLiveReview(r,[{id:'a',openedAt:T+1000}],true,T+1).eligibleIncluded,0);
});
test('partial reductions do not pose as a comparable full-cycle monetary difference',()=>{
  const l:any=live();l.positions.AAA.sourceReduction={version:'source-reduction-v1'};
  const r=buildLiveReview({live:l,at:T+30000,cached:[{id:'a',settlement:{version:'x',pnl:2}}]});
  const c=compareLiveReview(r,[{id:'a',openedAt:T+1,netPnl:8}],true,T-1000);
  assert.equal(c.comparableNetDifference,null);assert.equal(c.paired[0].lifecycleComparable,false);
});
test('durable close paging reads a fixed number, has an exclusive cursor and isolates session/cutoff',async()=>{
  const packets=Array.from({length:LIVE_REVIEW_PAGE_ROWS+3},(_,i)=>[
    `live-parity:v1:closed:${String(T+i+100).padStart(16,'0')}:p-${i}`,{position:position('p-'+i)}] as const);
  const storage={list:async(o:any)=>{assert.equal(o.limit,LIVE_REVIEW_PAGE_ROWS);return new Map(packets.filter(([k])=>k>=o.start&&k<o.end).reverse().slice(0,o.limit)) as any;}};
  const context={sessionAt:T,asOf:T+30000,accountUser:'synthetic'},a=await readLiveReviewPage(storage,context,null),b=await readLiveReviewPage(storage,context,a.nextCursor);
  assert.equal(a.positions.length,LIVE_REVIEW_PAGE_ROWS);assert.equal(b.positions.length,3);assert.equal(b.exhausted,true);
  assert.equal(new Set([...a.positions,...b.positions].map(p=>p.id)).size,LIVE_REVIEW_PAGE_ROWS+3);
  await assert.rejects(()=>readLiveReviewPage(storage,context,'other'),/INVALID_LIVE_REVIEW_CURSOR/);
});
test('collector keeps PAPER usable on native failure and rejects changed native sessions mid-export',async()=>{
  const r=native();let calls=0;
  const result=await collectReviewSnapshot((async(url:any)=>{calls++;
    if(String(url)==='/api/forward/export')return Response.json(paper());
    if(String(url)==='/api/live/review')return Response.json(r);
    return Response.json({context:{...r.context,sessionAt:T+1},positions:[],exhausted:true,recordsRead:0,nextCursor:null});
  }) as typeof fetch);
  assert.equal(calls,3);assert.equal(result.coverage.complete,true);
  assert.equal(result.liveReview!.coverage.error,'LIVE_REVIEW_CONTEXT_CHANGED');assert.equal(result.liveReview!.coverage.recordsRead,0);
  const failed=await collectReviewSnapshot((async(url:any)=>String(url)==='/api/forward/export'?Response.json(paper()):new Response('',{status:503})) as typeof fetch);
  assert.equal(failed.runtime.liveReviewError,'LIVE_REVIEW_HTTP_503');assert.equal(failed.coverage.complete,true);
});
test('native paging stops after sixteen pages and retains coverage, without background requests',async()=>{
  const r=native();let pages=0;
  const result=await collectReviewSnapshot((async(url:any)=>{
    if(String(url)==='/api/forward/export')return Response.json(paper());
    if(String(url)==='/api/live/review')return Response.json(r);
    pages++;return Response.json({context:r.context,positions:[],exhausted:false,recordsRead:48,nextCursor:'cursor-'+pages});
  }) as typeof fetch);
  assert.equal(pages,16);assert.equal(result.liveReview!.coverage.limitReached,true);assert.equal(result.liveReview!.coverage.recordsRead,768);
});
test('PAPER page deduplicates repeated packets while retaining financial conflicts and bounded reads',async()=>{
  const t:any={id:'a',status:'CLOSED',openedAt:T+1,closedAt:T+5,netPnl:1,exitPrice:2};
  const page=await readReviewArchivePage({list:async(o:any)=>{assert.equal(o.limit,REVIEW_ARCHIVE_PAGE_ROWS);return new Map([
    ['a',{startedAt:T,trades:[t]}],['b',{startedAt:T,trades:[t,{...t,netPnl:2}]}]]) as any;}},T,T+30000,null);
  assert.equal(page.trades.length,1);assert.deepEqual(page.conflictingTradeIds,['a']);
});
test('more than the old 768 packets fit within the fixed page/request limits',async()=>{
  const snapshot=paper();delete snapshot.runtime.privateLiveReviewAvailable;snapshot.coverage.expectedClosed=120;
  const packets=Array.from({length:1200},(_,i)=>[
    `forward-relations:v1:archive:${String(T+i+100).padStart(16,'0')}:${i}`,
    {startedAt:T-1000,trades:[{id:'source-'+Math.floor(i/10),status:'CLOSED',openedAt:T+1,closedAt:T+5,entryPrice:100,exitPrice:101,
      lastQuoteAt:T+5,netPnl:1,entryFee:.1,exitFee:.1,favorable:.01,notional:100,review:{terminal:{assessments:[]}}}]}] as const);
  const storage={list:async(o:any)=>new Map(packets.filter(([k])=>k>=o.start&&k<o.end).reverse().slice(0,o.limit)) as any};let pages=0;
  const result=await collectReviewSnapshot((async(url:any)=>{
    if(!String(url).includes('?'))return Response.json(snapshot);pages++;const q=new URL(String(url),'https://fixture').searchParams;
    return Response.json(await readReviewArchivePage(storage,T-1000,T+30000,q.get('cursor')));
  }) as typeof fetch);
  assert.equal(result.coverage.complete,true);assert.equal(result.trades.length,120);
  assert.equal(result.coverage.archiveRecordsRead,1200);assert.ok(pages<=26);assert.equal(result.coverage.exportLimitReached,false);
});
test('oversized archive page is rejected while preserving the initial ledger and missing counts',async()=>{
  const snapshot=paper();delete snapshot.runtime.privateLiveReviewAvailable;snapshot.coverage.expectedClosed=2;
  const result=await collectReviewSnapshot((async(url:any)=>String(url).includes('?')?Response.json({padding:'x'.repeat(12*1024*1024),
    accountStartedAt:T-1000,asOf:T+30000,trades:[],recordsRead:48,nextCursor:'next',exhausted:false}):Response.json(snapshot)) as typeof fetch);
  assert.equal(result.coverage.exportLimitReached,true);assert.equal(result.coverage.archiveRecordsRead,0);
  assert.equal(result.trades.length,0);assert.equal(result.coverage.missingClosed,2);
});
test('actual owner/member private projection has zero writes/Gate calls and does not grow the checkpoint',async()=>{
  for(const Base of [MarketStream,MemberExecutor]){
    const engine:any=Object.create(Base.prototype);engine.runtime={live:live()};engine.liveHistory=[];
    engine.historyReader={view:()=>({history:[]})};engine.liveRecordEpochAt=()=>T;
    engine.gateLive=()=>{throw new Error('Gate must not be called');};engine.saveCheckpoint=()=>{throw new Error('write forbidden');};
    let reads=0;engine.ctx={storage:{list:async()=>{reads++;return new Map();}}};
    const before=JSON.stringify(engine.runtime);
    const r=await engine.privateLiveReview(new URL('https://fixture/live-review'));assert.equal(r.status,200);assert.equal(reads,0);
    assert.equal((await engine.privateLiveReview(new URL(`https://fixture/live-review?page=closed&session=${T}&account=synthetic&asOf=${T+30000}`))).status,200);
    assert.equal(reads,1);assert.equal(JSON.stringify(engine.runtime),before);
    assert.equal((await engine.privateLiveReview(new URL('https://fixture/live-review?page=closed&session=1'))).status,409);
  }
  const source=readFileSync(new URL('../worker/index-clean.ts',import.meta.url),'utf8');
  const method=source.slice(source.indexOf('protected async privateLiveReview'),source.indexOf('protected async saveCheckpoint'));
  assert.doesNotMatch(method,/\.put\(|gateLive\(|privateLiveHistory\(|ensureAlarm\(|saveCheckpoint\(/);
});
test('HTTP export is authenticated and account query cannot redirect a member to the owner',async()=>{
  let primary=0,member=0;const id='m_'+ 'c'.repeat(32),env:any={OWNER_ACCESS_TOKEN:ROOT,
    MEMBERS:{getByName:()=>({fetch:async()=>Response.json({id,label:'member',version:1,createdAt:T-1})})},
    MEMBER_EXECUTION:{getByName:(name:string)=>{assert.equal(name,`member:${id}`);return {fetch:async(input:string,init:any)=>{member++;assert.equal(init.headers.get('x-verified-member'),id);assert.equal(new URL(input).pathname,'/live-review');return Response.json({member:true});}};}},
    MARKET_STREAM:{getByName:()=>({fetch:async(input:string)=>{primary++;assert.equal(new URL(input).pathname,'/live-review');return Response.json({owner:true});}})}};
  const request=(cookie='')=>new Request('https://fixture/api/live/review?account=owner',{headers:{Cookie:cookie}});
  assert.equal((await worker.fetch(request(),env,{} as never)).status,401);assert.equal(primary+member,0);
  assert.deepEqual(await(await worker.fetch(request(ownerSessionCookie(await createOwnerSession(ROOT))),env,{} as never)).json(),{owner:true});
  assert.deepEqual(await(await worker.fetch(request(memberCookie(await issueMemberSession(ROOT,id,1))),env,{} as never)).json(),{member:true});
  assert.equal(primary,1);assert.equal(member,1);
});

test('execution gap summary reports adverse medians, delays and soft-loss live follow-through',()=>{
  const l:any=live();
  l.positions.BBB=position('b',{symbol:'BBB_USDT',status:'CLOSED',entryPrice:99,exitPrice:95,
    parity:{sourceId:'b',activationAt:T,sourceOpenedAt:T+1000,sourceEntryPrice:100,sourceContractsAtCopy:10,
      copiedAt:T+2000,ratio:.25,sourceNotional:1000,submittedAt:T+2500,submitDelayMs:3000}});
  const r=buildLiveReview({live:l,at:T+30000});
  const c=compareLiveReview(r,[
    {id:'a',openedAt:T+1000,closedAt:T+20000,side:'LONG',entryPrice:100,exitPrice:104,netPnl:8,exitReason:'SHADOW_SOURCE_EXIT'},
    {id:'b',openedAt:T+1000,closedAt:T+20000,side:'LONG',entryPrice:100,exitPrice:96,netPnl:-4,exitReason:'INVERSE_SOFT_LOSS_EXIT'}],true,T-1000);
  const g=c.executionGap;
  assert.equal(g.medianAdverseEntryRate,.01);assert.equal(g.adverseEntryShare,.5);
  assert.equal(g.medianAdverseExitRate,null);assert.equal(g.adverseExitShare,null);
  assert.equal(g.medianSubmitDelayMs,3000);assert.equal(g.medianExitDelayMs,0);
  assert.deepEqual(g.softLossExits,{paper:1,liveFollowedExit:1});
  assert.equal(c.paired[1].paperExitReason,'INVERSE_SOFT_LOSS_EXIT');
});
