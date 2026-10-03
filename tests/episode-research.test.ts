import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceEpisodeResearch,normalizeEpisodeResearch,EPISODE_RESEARCH_BYTES} from '../lib/episode-research.ts';
import {initialMarketAuthority,type CoinEpisode} from '../lib/market-authority.ts';
import type {CandleLike,MarketSymbolState,QuoteLike} from '../lib/market-intelligence-engine.ts';
import {initialForward,normalizeForward,type Trade} from '../lib/forward-relations.ts';
import {migrateDirectStrategy} from '../lib/direct-strategy.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint,forwardProtectionChanged} from '../lib/forward-protection-checkpoint.ts';
import {buildReviewSnapshot} from '../lib/research-snapshot.ts';
const T=1791000000000,account=T-7200000;
const bar=(at:number,price:number):CandleLike=>({time:at/1000,open:price,high:price+.1,low:price-.1,close:price,volume:100});
const slow=Array.from({length:24},(_,i)=>bar(T-(24-i)*300000,100));
const minutes=(prices:number[])=>prices.map((p,i)=>bar(T-(prices.length-i)*60000,p));
const quote=(price=104):QuoteLike=>({bestBid:price,bestAsk:price+.01,observedAt:T,fresh:true});
const state={symbol:'A_USDT',clusterId:'group-A',dataConfidence:90,sourceCount:3} as MarketSymbolState;
function coin():CoinEpisode{return{reference:{lower:98,upper:102,center:100,formedAt:T-3600000,balanced:true,basis:'OHLCV_PROXY'},
  lastAt:T,phase:'UP',side:'LONG',dataReady:true,proofAt:T-900000,stop:99,eventPrice:103,atr:1,warning:false,failed:false,
  rejected:null,rejectedAt:0,rejectedPrice:0,extreme:0,upperFailed:false,lowerFailed:false,independentBars:0,independentAt:0,relation:'FOLLOWER',reason:'proof'};}
function input(){const authority=initialMarketAuthority(T-3600000);authority.fresh=true;authority.coins.A_USDT=coin();authority.cohort=['A_USDT'];
  return{now:T,accountStartedAt:account,authority,states:{A_USDT:state},paths:{A_USDT:slow},minutePaths:{A_USDT:minutes([104,104.3,104.6])},
    quotes:{A_USDT:quote(104.6)},positions:[] as Trade[],history:[] as Trade[]};}
function trade():Trade{return{id:'held',symbol:'A_USDT',side:'LONG',status:'OPEN',openedAt:T-600000,closedAt:null,
  entryPrice:100,quantity:10,contracts:10,quantoMultiplier:1,notional:1000,leverage:5,margin:200,plannedRisk:11,
  stopPrice:103.8,lastPrice:104.6,lastQuoteAt:T,entryFee:.5,exitFee:0,favorable:.05,adverse:0,
  unified:{initialStop:99},review:{peakNetPnl:49},paperOrder:{phase:'FILLED',requestedContracts:100,signalPrice:100}} as unknown as Trade;}
test('completed 15/30/45/60 windows expose actual move and path, not independent votes',()=>{
  const i=input(),s=advanceEpisodeResearch(i),r=s.symbols.A_USDT!;
  assert.deepEqual(r.windows.map(w=>w.minutes),[15,30,45,60]);assert.ok(r.windows.every(w=>w.move===0&&w.efficiency===0));
  assert.equal(r.phase,'ADVANCING');assert.equal(s.breadth.groups,1);assert.equal(s.breadth.up,1);
});
test('fast entry stop cannot ratchet the holding anchor or turn a normal pullback into failure',()=>{
  const i=input(),first=advanceEpisodeResearch(i);i.authority.coins.A_USDT!.stop=104.2;i.authority.coins.A_USDT!.failed=true;
  i.now+=60000;i.quotes.A_USDT={...quote(104),observedAt:i.now};i.minutePaths.A_USDT=minutes([104.5,104.3,104]).map(r=>({...r,time:r.time+60}));
  const next=advanceEpisodeResearch({...i,previous:first}),r=next.symbols.A_USDT!;
  assert.equal(r.holdingSupport,99);assert.equal(r.phase,'PULLBACK');assert.equal(r.entrySupport,99);
  assert.equal(r.hypotheses.continuation.stage,'PULLBACK');assert.equal(r.hypotheses.return.stage,'UNCONFIRMED');
});
test('completed support loss plus failed recovery invalidates old direction but does not invent a reverse trend',()=>{
  const i=input();i.minutePaths.A_USDT=minutes([99.1,98.5,98.1]);i.quotes.A_USDT=quote(98.1);
  const r=advanceEpisodeResearch(i).symbols.A_USDT!;assert.equal(r.phase,'RECOVERY_FAILED');
  assert.equal(r.side,'LONG');assert.equal(r.failedSide,'LONG');assert.equal(r.hypotheses.continuation.stage,'INVALIDATED');
  assert.equal(r.hypotheses.return.stage,'FAILED_TREND');assert.equal(r.hypotheses.return.target,null);
});
test('range hypothesis requires genuine two-sided failed departures and a fresh directional return target',()=>{
  const i=input(),p=i.authority.coins.A_USDT!;p.phase='RANGE';p.side=null;p.upperFailed=true;p.lowerFailed=true;p.rejected='SHORT';p.rejectedAt=T-60000;
  i.quotes.A_USDT=quote(101);const r=advanceEpisodeResearch(i).symbols.A_USDT!;
  assert.equal(r.phase,'ROTATION');assert.equal(r.hypotheses.return.stage,'FAILED_DEPARTURE');assert.equal(r.hypotheses.return.target,100);
  p.rejectedAt=T+60000;assert.equal(advanceEpisodeResearch(i).symbols.A_USDT!.hypotheses.return.stage,'UNCONFIRMED');
});
test('future bars, duplicate ticks and source gaps cannot fabricate transitions or full-window coverage',()=>{
  const i=input(),first=advanceEpisodeResearch(i);i.minutePaths.A_USDT.push(bar(T+60000,50));
  const repeat=advanceEpisodeResearch({...i,previous:first,now:T+1000});assert.deepEqual(repeat.symbols.A_USDT!.changes,first.symbols.A_USDT!.changes);
  i.paths.A_USDT=[...slow.slice(0,-3),slow.at(-1)!];const r=advanceEpisodeResearch(i).symbols.A_USDT!;
  assert.ok(r.windows.every(w=>w.move===null));assert.equal(r.fresh,false);
});
test('stale quotes preserve evidence without creating a new recovery claim',()=>{
  const i=input(),first=advanceEpisodeResearch(i);i.minutePaths.A_USDT=minutes([98.5,98.2,98]);i.quotes.A_USDT={...quote(98),fresh:false};
  const r=advanceEpisodeResearch({...i,previous:first,now:T+60000}).symbols.A_USDT!;
  assert.equal(r.phase,'ADVANCING');assert.equal(r.fresh,false);assert.equal(r.sourceAt,first.symbols.A_USDT!.sourceAt);
});
test('a single reclaim cannot revive failed research; two retained closes and renewed progress can',()=>{
  const i=input();i.minutePaths.A_USDT=minutes([99.1,98.5,98.1]);i.quotes.A_USDT=quote(98.1);i.positions=[trade()];
  const failed=advanceEpisodeResearch(i);
  i.now+=60000;i.minutePaths.A_USDT=minutes([98.5,98.1,99.3]).map(r=>({...r,time:r.time+60}));
  i.quotes.A_USDT={...quote(99.3),observedAt:i.now};
  const recovering=advanceEpisodeResearch({...i,previous:failed});
  assert.equal(recovering.symbols.A_USDT!.phase,'RECOVERY_BUILDING');assert.equal(recovering.holdings[0]!.signal,'REVIEW');
  i.now+=60000;i.minutePaths.A_USDT=minutes([98.1,99.3,99.6]).map(r=>({...r,time:r.time+120}));
  i.quotes.A_USDT={...quote(99.6),observedAt:i.now};
  const restored=advanceEpisodeResearch({...i,previous:recovering});
  assert.equal(restored.symbols.A_USDT!.phase,'ADVANCING');assert.equal(restored.holdings[0]!.premise,'INTACT');
  assert.deepEqual(restored.transitions.slice(-3).map(t=>t.to),['RECOVERY_FAILED','RECOVERY_BUILDING','ADVANCING']);
});
test('episode replacement retains causal transition receipts and cannot reuse pre-proof prices',()=>{
  const i=input(),first=advanceEpisodeResearch(i);i.authority.coins.A_USDT!.reference.formedAt+=60000;
  i.authority.coins.A_USDT!.proofAt=T;i.minutePaths.A_USDT=minutes([98.5,98.2,98]).map(r=>({...r,time:r.time-60}));
  const next=advanceEpisodeResearch({...i,previous:first});
  assert.equal(next.symbols.A_USDT!.phase,'UNCONFIRMED');assert.equal(next.transitions.length,2);
  assert.equal(next.transitions[1]!.from,'ADVANCING');assert.notEqual(next.transitions[0]!.episodeId,next.transitions[1]!.episodeId);
});
test('earned profit deterioration is visible despite positive relative rank and execution stop coupling',()=>{
  const i=input(),t=trade();i.positions=[t];i.minutePaths.A_USDT=minutes([104,103,102]);i.quotes.A_USDT=quote(102);
  const before=JSON.stringify(t),s=advanceEpisodeResearch(i),h=s.holdings[0]!;
  assert.equal(h.holdingSupport,99);assert.equal(h.executionStop,103.8);assert.equal(h.premise,'PULLBACK');
  assert.equal(h.signal,'PROTECT_CANDIDATE');assert.ok(h.giveback!>25);assert.equal(h.fillRatio,.1);
  assert.equal(h.plannedNotional,10000);assert.equal(h.actualNotional,1000);assert.equal(JSON.stringify(t),before);
});
test('slow-starting intact positions are not killed by age or modest profit noise',()=>{
  const i=input(),t=trade();t.review!.peakNetPnl=2;t.openedAt=T-1800000;i.positions=[t];i.minutePaths.A_USDT=minutes([100.05,100.02,100.01]);i.quotes.A_USDT=quote(100.01);
  const h=advanceEpisodeResearch(i).holdings[0]!;assert.equal(h.signal,'HOLD');assert.equal(h.premise,'INTACT');
});
test('newly opened positions cannot inherit pre-entry bar failure as a holding verdict',()=>{
  const i=input(),t=trade();t.openedAt=T;i.positions=[t];i.minutePaths.A_USDT=minutes([98.5,98.2,98]);
  assert.equal(advanceEpisodeResearch(i).holdings[0]!.premise,'UNOBSERVED');
});
test('one correlated group cannot be counted as several independent pieces of market breadth',()=>{
  const i=input();for(const symbol of ['B_USDT','C_USDT']){i.authority.coins[symbol]=coin();i.states[symbol]={...state,symbol};i.paths[symbol]=slow;i.minutePaths[symbol]=i.minutePaths.A_USDT;i.quotes[symbol]=quote();}
  const s=advanceEpisodeResearch(i);assert.equal(s.breadth.groups,1);assert.equal(s.breadth.up,1);
});
test('downtrend and failed short recovery use the same actual-price contract',()=>{
  const i=input(),p=i.authority.coins.A_USDT!;p.side='SHORT';p.phase='DOWN';p.stop=101;p.eventPrice=97;
  i.minutePaths.A_USDT=minutes([96,95,94]);i.quotes.A_USDT=quote(94);
  assert.equal(advanceEpisodeResearch(i).symbols.A_USDT!.phase,'ADVANCING');
  i.minutePaths.A_USDT=minutes([101.3,101.6,102]);i.quotes.A_USDT=quote(102);
  const r=advanceEpisodeResearch(i).symbols.A_USDT!;assert.equal(r.phase,'RECOVERY_FAILED');assert.equal(r.hypotheses.return.side,'LONG');
});
test('snapshot exposes the exact observational state without changing account aggregates',()=>{
  const research=advanceEpisodeResearch(input()),view={startedAt:account,resolved:0,balance:1000,equity:1000,positions:[],history:[],
    directStrategy:{episodeResearch:research},marketIntelligence:{updatedAt:T}};
  const snap=buildReviewSnapshot({view,exportedAt:T,buildSha:'test',strategyFingerprint:'test'});
  assert.deepEqual(snap.research.episodeResearch,research);assert.equal(snap.account.equity,1000);assert.equal(snap.trades.length,0);
});
test('later post-close prices cannot rewrite a closed holding verdict or source time',()=>{
  const i=input(),t={...trade(),status:'CLOSED' as const,closedAt:T-60000,exitPrice:101,netPnl:9};i.history=[t];
  const first=advanceEpisodeResearch(i),h=first.holdings[0]!;assert.equal(h.signal,'CLOSED');assert.ok(h.sourceAt<=t.closedAt);
  const changed=advanceEpisodeResearch({...i,previous:first,now:T+60000,minutePaths:{A_USDT:minutes([120,90,50])},quotes:{A_USDT:quote(50)}});
  assert.deepEqual(changed.holdings[0],h);
});
test('restart preserves research anchors and corruption yields without blocking financial restoration',()=>{
  const i=input(),research=advanceEpisodeResearch(i),s=initialForward(account);migrateDirectStrategy(s,account);
  s.storage.persistedAt=T-10000;s.directStrategy!.marketAuthority=i.authority;s.directStrategy!.episodeResearch=research;
  const c=buildForwardProtectionCheckpoint(s),restored=restoreForwardProtectionCheckpoint(s,JSON.parse(JSON.stringify(c)));
  assert.deepEqual(restored.directStrategy!.episodeResearch,research);assert.deepEqual(normalizeForward(s,T).directStrategy!.episodeResearch,research);
  const bad=JSON.parse(JSON.stringify(c));bad.directMemory.episodeResearch.holdings=[{sourceAt:'corrupt'}];
  assert.doesNotThrow(()=>restoreForwardProtectionCheckpoint(s,bad));assert.equal(normalizeEpisodeResearch({version:'bad'}),undefined);
});
test('research-only changes never request a protection write or alter money and source decisions',()=>{
  const i=input(),s=initialForward(account);migrateDirectStrategy(s,account);s.directStrategy!.marketAuthority=i.authority;
  const next=structuredClone(s);next.directStrategy!.episodeResearch=advanceEpisodeResearch(i);
  assert.equal(forwardProtectionChanged(s,next),false);delete next.directStrategy!.episodeResearch;assert.deepEqual(next,s);
});
test('optional research yields checkpoint space to financial protection without removing financial fields',()=>{
  const i=input(),s=initialForward(account);migrateDirectStrategy(s,account);s.directStrategy!.marketAuthority=i.authority;
  s.positions=[trade()];s.positions[0]!.unified!.holdReason='';
  const emptyBytes=new TextEncoder().encode(JSON.stringify(buildForwardProtectionCheckpoint(s))).length;
  s.positions[0]!.unified!.holdReason='x'.repeat(112*1024-emptyBytes-500);
  const baseline=buildForwardProtectionCheckpoint(s);s.directStrategy!.episodeResearch=advanceEpisodeResearch(i);
  const c=buildForwardProtectionCheckpoint(s);assert.equal(c.directMemory!.episodeResearch,undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(c)),JSON.parse(JSON.stringify(baseline)));assert.ok(s.directStrategy!.episodeResearch);
});
test('account reset isolates trade evidence while preserving the ongoing market episode',()=>{
  const i=input(),t=trade();i.positions=[t];const first=advanceEpisodeResearch(i);
  const next=advanceEpisodeResearch({...i,previous:first,accountStartedAt:T+1,now:T+1000,positions:[],history:[{...t,status:'CLOSED',closedAt:T}]});
  assert.equal(next.holdings.length,0);assert.equal(next.symbols.A_USDT!.id,first.symbols.A_USDT!.id);
  assert.equal(next.symbols.A_USDT!.observedSince,first.symbols.A_USDT!.observedSince);
});
test('long-running rotating universe stays within fixed rows and bytes',()=>{
  const i=input();let s=advanceEpisodeResearch(i);
  for(let n=0;n<90;n++){
    const a=initialMarketAuthority(T),states:Record<string,MarketSymbolState>={},paths:Record<string,CandleLike[]>={},qs:Record<string,QuoteLike>={};
    for(let k=0;k<45;k++){const symbol=`C${n}_${k}_USDT`;a.coins[symbol]=coin();states[symbol]={...state,symbol,clusterId:`g${k}`};paths[symbol]=slow;qs[symbol]=quote();}
    s=advanceEpisodeResearch({...i,previous:s,authority:a,states,paths,quotes:qs});
    assert.ok(Object.keys(s.symbols).length<=30);assert.ok(new TextEncoder().encode(JSON.stringify(s)).length<=EPISODE_RESEARCH_BYTES);
  }
  assert.ok(s.droppedSymbols>0);assert.ok(normalizeEpisodeResearch(s));
});
