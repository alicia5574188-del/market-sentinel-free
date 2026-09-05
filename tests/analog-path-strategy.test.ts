import assert from 'node:assert/strict';
import test from 'node:test';
import {analogRiskAllocation,buildAnalogCandidate,planAnalogEntry,replayAnalogPath,historicalDirection,evaluateAnalogPosition} from '../lib/analog-path-strategy.ts';
import {loadHourFeed,type MinuteCache} from '../lib/scalp-feed.ts';
import type {HistoricalForecast} from '../lib/historical-forecast.ts';
import {validateDirectMarketEntry} from '../lib/direct-market-entry.ts';
const now=Date.UTC(2026,8,5,12,30);
const candles=()=>Array.from({length:400},(_,i)=>({time:(now-(400-i)*300000)/1000,open:100,close:100,high:100.05,low:99.95,volume:100}));
function forecast(short=false,delayed=false):HistoricalForecast {
 const episodes=Array.from({length:10},(_,j)=>({weight:1,from:now-(j+3)*86400000,bars:Array.from({length:12},(_,i)=>{
  let closePct=j<8?(delayed&&i<3?-.5+i*.04:(i+1)*.1):-(i+1)*.1;
  const openPct=i===0?0:closePct-.05;let highPct=Math.max(openPct,closePct)+.03,lowPct=Math.min(openPct,closePct)-.03;
  if(short){closePct=-closePct;[highPct,lowPct]=[-lowPct,-highPct];}
  return {openPct:short?-openPct:openPct,closePct,highPct,lowPct};
 })}));
 return {model:'historical-analog-v1',state:'READY',reason:'fixture',signalAt:now,historyFrom:now-86400000,historyTo:now,historyBars:1000,windowMinutes:120,horizonMinutes:60,sampleCount:10,effectiveSamples:10,similarity:75,upPct:short?20:80,downPct:short?80:20,neutralPct:0,medianPct:short?-1:1,lowerPct:-1,upperPct:1,side:short?'SHORT':'LONG',netEdgeR:1,stopPct:.3,targetPct:.5,costBps:12,eventContext:'fixture',path:[],matches:[],episodes};
}
function candidate(f=forecast(),extra:Partial<Parameters<typeof buildAnalogCandidate>[0]>={}){return buildAnalogCandidate({symbol:'ETH_USDT',candles:candles(),btcCandles:[],now,price:100,volumeUsd:1e9,volumeRank:1,costBps:12,forecast:f,...extra});}
test('historical overall direction can open without trend, volume recovery or pullback signals',()=>{
 for(const short of [false,true]){const c=candidate(forecast(short));assert.equal(c.decision,short?'SHORT':'LONG',JSON.stringify(c.counterEvidence));assert.equal(c.maxHoldingMinutes,60);assert.equal(c.setup,'ANALOG_PATH');assert.equal(validateDirectMarketEntry(c,{symbol:c.symbol,price:100,observedAt:now+1000},now+1000).allowed,true);}
});
test('sparse or stale history cannot be replaced by a different strategy',()=>{
 const f=forecast();assert.equal(candidate({...f,state:'INSUFFICIENT',sampleCount:4}).decision,'WAIT');
 assert.equal(historicalDirection({...f,signalAt:now-300000},now).side,'WAIT');
 assert.equal(candidate({...f,episodes:f.episodes!.map((e,i)=>i<5?e:{...e,bars:e.bars.map(b=>({openPct:0,closePct:-Math.abs(b.closePct),highPct:.01,lowPct:-Math.abs(b.highPct)}))}),medianPct:0}).decision,'WAIT');
});
test('the candidate follows the first tradable swing instead of the later endpoint',()=>{
 const f=forecast(false,true);
 assert.equal(historicalDirection(f,now).side,'SHORT','the first downward swing remains the direction authority despite a higher endpoint');
});
test('a stop touched before a later profitable endpoint is counted as a stop; limit fills cannot claim earlier highs',()=>{
 const episode={weight:1,from:0,bars:[{openPct:0,lowPct:-1,highPct:2,closePct:1}]};
 assert.equal(replayAnalogPath(episode,'LONG',0,.5,.6,.12).exit,'STOP');
 assert.notEqual(replayAnalogPath({...episode,bars:[{openPct:0,lowPct:-.3,highPct:2,closePct:0}]},'LONG',.2,.5,.6,.12).exit,'TARGET');
});
test('no unfinished price input, no excessive historical stop and no expiry bypass',()=>{
 const f=forecast(),c=candidate(f);const cs=candles();assert.deepEqual(candidate(f,{candles:[...cs,{...cs.at(-1)!,time:now/1000,close:300,high:300}]}),c);
 assert.equal(planAnalogEntry({...f,episodes:f.episodes!.map(e=>({...e,bars:e.bars.map(b=>({...b,lowPct:-5}))}))},'LONG',.1,100,now),null);
 assert.equal(validateDirectMarketEntry(c,{symbol:c.symbol,price:100,observedAt:now+300000},now+300000).allowed,false);
});
test('small initial noise is tolerated; fast loss, stalled trade and the one-hour deadline exit',()=>{
 const base={side:'LONG' as const,entryPrice:100,initialStopPrice:99,currentStopPrice:99,entryAt:now-5*60000,currentPrice:99.9,observedAt:now,roundTripCostBps:12,candles:[{time:(now-300000)/1000,open:100,close:99.9,high:100,low:99.9,volume:1}],confirmationPrice:99.5};
 assert.equal(evaluateAnalogPosition(base).action,'HOLD');
 assert.equal(evaluateAnalogPosition({...base,entryAt:now-3600000}).action,'EXIT');
 assert.equal(evaluateAnalogPosition({...base,entryAt:now-10*60000,currentPrice:99.7,candles:[{...base.candles[0],close:99.7,low:99.7}]}).action,'EXIT');
 assert.equal(evaluateAnalogPosition({...base,entryAt:now-20*60000,currentPrice:100,candles:[{...base.candles[0],close:100}]}).action,'EXIT');
});
test('an intrabar advance protects the position even after price retreats',()=>{
 const result=evaluateAnalogPosition({side:'LONG',entryPrice:100,initialStopPrice:99,currentStopPrice:99,entryAt:now-10*60000,currentPrice:100.05,observedAt:now,roundTripCostBps:12,candles:[{time:(now-300000)/1000,open:100,close:100.05,high:100.4,low:99.98,volume:1}],confirmationPrice:99.5});
 assert.equal(result.action,'PROTECT');assert.ok(result.proposedStopPrice!>100);
});
test('six coins over twenty-four simulated hours use 1728 core requests, survive restart and honor cooldown',async()=>{
 const map=new Map<string,unknown>();const store={get:async<T>(k:string)=>map.get(k) as T|undefined,put:async<T>(k:string,v:T)=>{map.set(k,v);}};
 let calls=0;const fetcher=async()=>{calls++;return candles().map(c=>({...c,time:c.time+(clock-now)/1000}));};let clock=now;
 for(let i=0;i<1440;i++){clock=now+i*60_000;for(const coin of ['BTC','ETH','SOL','BNB','XRP','DOGE'])await loadHourFeed(store,fetcher,coin,clock);}
 assert.equal(calls,1728);assert.ok((await store.get<MinuteCache>('hour:BTC'))!.rows.length<=400);
 const fail=async()=>{throw Object.assign(new Error('429'),{retryAt:clock+900_000});};
 const first=await loadHourFeed(store,fail,'OTHER',clock);assert.equal(first.retryAt,clock+900_000);
 let retryCalls=0;await loadHourFeed({...store},async()=>{retryCalls++;return[];},'OTHER',clock+300_000);assert.equal(retryCalls,0);
});

test('full one-percent positions consume the three-percent portfolio budget without pre-dividing six symbols',()=>{
 let used=0;
 for(let i=0;i<3;i++){const rate=analogRiskAllocation(1000,used,6-i,false);assert.equal(rate,.01);used+=1000*rate;}
 assert.ok(Math.abs(used-30)<1e-8);assert.equal(analogRiskAllocation(1000,30,3,false),0);
 assert.equal(analogRiskAllocation(1000,0,6,true),analogRiskAllocation(1000,0,6,false)/2);
});

test('majority first swing opens while adverse path ratios remain learning evidence',()=>{
 const f=forecast();f.episodes=Array.from({length:10},(_,j)=>({weight:1,from:j,bars:Array.from({length:12},(_,i)=>j<6
  ?i===0?{openPct:0,lowPct:-.05,highPct:.25,closePct:.1}
   :j<3?{openPct:.1,lowPct:.05,highPct:2,closePct:1.5}:{openPct:.1,lowPct:-.25,highPct:.15,closePct:-.2}
  :{openPct:0,lowPct:-.25,highPct:.01,closePct:-.2})}));
 const plan=planAnalogEntry(f,'LONG',.1,100,now);assert.ok(plan);
 assert.ok(plan.expectedNetR<0);assert.ok(plan.lossPct>35);
 const c=candidate(f);assert.equal(c.decision,'LONG',JSON.stringify(c.counterEvidence));
 assert.equal(validateDirectMarketEntry(c,{symbol:c.symbol,price:100,observedAt:now+1000},now+1000).allowed,true);
});

test('target follows the majority episodes maximum path instead of collapsing to the fee floor',()=>{
 const f=forecast();f.episodes=Array.from({length:10},(_,j)=>({weight:1,from:j,bars:Array.from({length:12},(_,i)=>j<6
  ?{openPct:i*.1,lowPct:-.03,highPct:.3+i*.1,closePct:.2+i*.08}
  :{openPct:-.2,lowPct:-.25,highPct:.02,closePct:-.2})}));
 const plan=planAnalogEntry(f,'LONG',.1,100,now);assert.ok(plan);
 assert.ok(plan.targetPct>.8,`expected the supporting paths' maximum excursion, got ${plan.targetPct}`);
});

test('five independent episodes may enter; four or insufficient effective weight cannot',()=>{
 const base=forecast(),f={...base,sampleCount:5,effectiveSamples:5,episodes:base.episodes!.slice(0,5)};
 assert.equal(candidate(f).decision,'LONG');
 assert.equal(candidate({...f,sampleCount:4,effectiveSamples:4}).decision,'WAIT');
 assert.equal(candidate({...f,effectiveSamples:4.49}).decision,'WAIT');
 assert.equal(candidate({...f,signalAt:now-300000}).decision,'WAIT');
});

test('majority first upward swing remains LONG even when every endpoint and median turn negative',()=>{
 const f=forecast();f.episodes=f.episodes!.map(e=>({...e,bars:e.bars.map((b,i)=>i===11?{openPct:-.8,highPct:-.7,lowPct:-1.1,closePct:-1}:b)}));
 f.medianPct=-1;f.directionUpPct=0;f.directionDownPct=100;
 assert.equal(historicalDirection(f,now).side,'LONG');
 const plan=planAnalogEntry(f,'LONG',.1,100,now);assert.ok(plan);assert.ok(plan.stopPct<1,'post-target plunge must not inflate initial protection');
 assert.equal(candidate(f).decision,'LONG');
});
test('ambiguous two-sided first bars abstain rather than invent a favorable order',()=>{
 const f=forecast();f.episodes=f.episodes!.map(e=>({...e,bars:[{openPct:0,highPct:1,lowPct:-1,closePct:1}]}));
 assert.equal(historicalDirection(f,now).side,'WAIT');
});

test('simple majority is enough for direction; eleven of twenty is not rejected by an extra sixty-percent gate',()=>{
 const f=forecast(),up=f.episodes![0],down=f.episodes![9];
 f.episodes=Array.from({length:20},(_,i)=>({...i<11?up:down,from:i}));f.sampleCount=20;f.effectiveSamples=20;
 assert.equal(historicalDirection(f,now).side,'LONG');
});

test('a more favorable live quote may enter while excessive chasing still waits',()=>{
 const better=candidate(forecast(),{price:99.95});
 assert.equal(better.decision,'LONG');
 assert.ok(better.analogIntent!.stopPct>=.3,'twelve basis-point cost requires at least a 0.30% structural stop');
 assert.equal(validateDirectMarketEntry(better,{symbol:better.symbol,price:99.95,observedAt:now+1000},now+1000).allowed,true);
 const chase=candidate(forecast(),{price:101});
 assert.equal(chase.decision,'WAIT');
});
