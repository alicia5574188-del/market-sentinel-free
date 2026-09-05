import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScalpCandidate, aggregateMinutes, completeMinutes, evaluateScalpPosition, scalpEntryRisk, SCALP_POLICY, resolveScalpExit, correlatedScalpExposure } from '../lib/scalp-strategy.ts';
import { loadMinuteFeed, boundedMap, nextMinuteScan, type MinuteCache } from '../lib/scalp-feed.ts';
import { validateDirectMarketEntry } from '../lib/direct-market-entry.ts';
import { buildHte31PaperPosition, hte31PaperPortfolioBlockReason } from '../lib/hte31-position-sizing.ts';
import { directMarketIndexAdjustedDailyBudget } from '../lib/direct-market-d1-budget.ts';
import type { Hte31Candle } from '../lib/hte31-types.ts';
const now=Date.UTC(2026,8,5,12,30);
function fixture(short=false):Hte31Candle[] {
  const prices=Array.from({length:390},(_,i)=>100+i*.012);
  prices.splice(380,10,104.65,104.72,104.80,104.86,104.91,104.98,104.75,104.55,104.35,104.58);
  return prices.map((close,i)=>{const open=i?prices[i-1]:close-.01; const c={time:(now-(390-i)*60_000)/1000,open,close,high:Math.max(open,close)+.07,low:Math.min(open,close)-.07,volume:i>=386&&i<=388?50:100};
    return short?{...c,open:210-c.open,close:210-c.close,high:210-c.low,low:210-c.high}:c;});
}
function candidate(cs=fixture()) {return buildScalpCandidate({symbol:'ETH_USDT',candles:cs,btcCandles:cs,now,price:completeMinutes(cs,now).at(-1)!.close,volumeUsd:1e9,volumeRank:1,costBps:12});}
test('completed long and short pullbacks can enter immediately without historical analogues',()=>{
  for(const short of [false,true]) {const c=candidate(fixture(short)); assert.equal(c.decision,short?'SHORT':'LONG',JSON.stringify(c.counterEvidence));assert.equal(c.forecast,undefined);assert.equal(c.maxHoldingMinutes,15);
    assert.equal(validateDirectMarketEntry(c,{symbol:c.symbol,price:fixture(short).at(-1)!.close,observedAt:now+1_000},now+1_000).allowed,true);}
});
test('stale, gapped, expensive and chased signals never become orders',()=>{
  const cs=fixture();assert.equal(candidate(cs.filter((_,i)=>i!==370)).decision,'WAIT');
  assert.equal(buildScalpCandidate({symbol:'ETH_USDT',candles:cs,btcCandles:cs,now:now+120_000,price:104.58,volumeUsd:1e9,volumeRank:1,costBps:12}).decision,'WAIT');
  assert.equal(buildScalpCandidate({symbol:'ETH_USDT',candles:cs,btcCandles:cs,now,price:104.58,volumeUsd:1e9,volumeRank:1,costBps:40}).decision,'WAIT');
  const c=candidate();assert.equal(validateDirectMarketEntry(c,{symbol:c.symbol,price:110,observedAt:now+1_000},now+1_000).allowed,false);
  assert.equal(validateDirectMarketEntry(c,{symbol:c.symbol,price:104.58,observedAt:now+60_000},now+60_000).allowed,false);
});
test('future candles do not alter the signal and partial 15m bars cannot confirm direction',()=>{
  const cs=fixture(), future={...cs.at(-1)!,time:now/1000,close:300,high:300};
  assert.deepEqual(candidate([...cs,future]),candidate(cs));
  assert.equal(aggregateMinutes(completeMinutes(cs,now),15).length,26);
  assert.equal(aggregateMinutes(completeMinutes(cs.slice(0,-1),now),15).length,25);
});
test('small fee-inclusive position never exceeds 0.25% or stretches its target',()=>{
  const c=candidate(),entry=104.58;
  const size=buildHte31PaperPosition({side:'LONG',entryPrice:entry,stopLossPrice:c.invalidationPrice!,originalTakeProfit2Price:c.targets[1],accountEquityUsdt:1000,availableMarginUsdt:1000,riskMultiplier:1,riskRate:SCALP_POLICY.riskRate,minimumRiskRate:0,minimumTp2NetProfitUsdt:0,roundTripCostBps:12,liquidityVolumeUsd:1e9,atrPct:.3,dataQuality:1,confidence:90});
  assert.equal(size.accepted,true,size.reason);assert.ok(size.plannedRiskUsdt<=2.50000001);assert.equal(size.tp2Adjusted,false);assert.ok(size.plannedTp2NetProfitUsdt>0);
  assert.match(hte31PaperPortfolioBlockReason({open:[{side:'LONG',riskBudgetUsdt:7}],nextSide:'SHORT',nextRiskUsdt:2.5,accountEquityUsdt:1000,maximumTotalPlannedRiskRate:.0075})??'',/0.75%/);
});
test('quick exit waits for lost confirmation, protects fees and enforces fifteen minutes',()=>{
  const base={side:'LONG' as const,entryPrice:100,initialStopPrice:99,currentStopPrice:99,entryAt:now-4*60_000,currentPrice:99.9,observedAt:now,roundTripCostBps:12,confirmationPrice:100,candles:[{time:(now-60_000)/1000,open:100,high:100.1,low:99.8,close:99.9,volume:1}]};
  assert.equal(evaluateScalpPosition(base).action,'EXIT');
  assert.equal(evaluateScalpPosition({...base,entryAt:now-2*60_000}).action,'HOLD');
  assert.equal(evaluateScalpPosition({...base,currentPrice:100.6}).proposedStopPrice,100.12);
  assert.equal(evaluateScalpPosition({...base,entryAt:now-15*60_000,candles:[],currentPrice:100.3}).action,'EXIT');
  assert.equal(evaluateScalpPosition({...base,candles:[]}).action,'HOLD');
});
test('three-loss cooldown expires; daily halt survives recovery in equity',()=>{
  const base={equity:990,dayOpeningEquity:1000,dayNet:-10,lastClosed:[0,1,2].map(i=>({net:-2,exitAt:now-i*60_000})),now};
  assert.match(scalpEntryRisk(base)??'',/三笔/);assert.equal(scalpEntryRisk({...base,now:now+30*60_000}),null);
  assert.match(scalpEntryRisk({...base,dayNet:-15})??'',/1.5%/);
  assert.match(scalpEntryRisk({...base,dayNet:1,latchedUntil:now+60_000})??'',/已生效/);
});
class Storage {data=new Map<string,unknown>();writes=0;async get<T>(key:string){return this.data.get(key) as T|undefined}async put<T>(key:string,value:T){this.data.set(key,structuredClone(value));this.writes++}}
test('24-hour feed simulation bounds requests, survives restarts and repairs gaps',async()=>{
  const storage=new Storage();let calls=0,maxLimit=0;
  const coins=['BTC','ETH','SOL','BNB','XRP','DOGE'];
  for(let m=0;m<1440;m++) {
    const at=now+m*60_000;
    for(const symbol of coins) {
      const fetcher=async(_s:string,limit:number)=>{calls++;maxLimit=Math.max(maxLimit,limit);return fixture().map(c=>({...c,time:c.time+m*60})).slice(-limit)};
      await loadMinuteFeed(storage,fetcher,symbol,at);
      await loadMinuteFeed(storage,fetcher,symbol,at+1_000); // retry/new isolate shares only durable state
    }
  }
  assert.equal(calls,8640);assert.equal(storage.writes,17280);assert.equal(maxLimit,390);
  for(const symbol of coins)assert.ok((await storage.get<MinuteCache>(`minute:${symbol}`))!.rows.length<=390);
  assert.ok(directMarketIndexAdjustedDailyBudget().positionCheckpointPhysicalRows+60*100<30000);
});
test('rate limiting backs off persistently; healthy peer is not blocked',async()=>{
  const storage=new Storage();let calls=0;
  const failed=async()=>{calls++;throw new Error('429')};
  await loadMinuteFeed(storage,failed,'BTC',now);await loadMinuteFeed(storage,failed,'BTC',now+1_000);assert.equal(calls,1);
  await loadMinuteFeed(storage,failed,'BTC',now+60_000);await loadMinuteFeed(storage,failed,'BTC',now+120_000);assert.equal(calls,2);
  await loadMinuteFeed(storage,async()=>fixture(),'ETH',now);assert.equal((await storage.get<MinuteCache>('minute:ETH'))!.error,null);
  const recovered=await loadMinuteFeed(storage,async()=>fixture().map(c=>({...c,time:c.time+180})),'BTC',now+180_000);assert.equal(recovered.failures,0);
  assert.ok(nextMinuteScan(now+59_999)>now+59_999);
});
test('bounded acquisition isolates failures and limits concurrency to two',async()=>{
  let active=0,peak=0;const results=await boundedMap([1,2,3,4,5,6],2,async n=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;if(n===2)throw new Error('timeout');return n});
  assert.equal(peak,2);assert.equal(results[1].status,'rejected');assert.equal(results[5].status,'fulfilled');
});

test('same-bar stop beats target and a price gap cannot fabricate a stop fill',()=>{
  const base={side:'LONG' as const,stop:99,target:102,price:98,low:97,high:103,timeout:true,decision:null};
  assert.deepEqual(resolveScalpExit(base),{code:'stop_loss',price:98,reason:'结构保护触发，按首个可见价格保守结算'});
  assert.equal(resolveScalpExit({...base,price:95,open:100})?.price,99,'an intrabar stop fills at the stop, not the later close');
  assert.equal(resolveScalpExit({...base,price:100,open:98})?.price,98,'a real opening gap remains conservatively priced');
  assert.equal(resolveScalpExit({...base,price:101,low:100,high:102})?.code,'take_profit');
  assert.equal(resolveScalpExit({...base,price:100,low:100,high:101})?.code,'timeout');
});

test('correlation guards consider inverse-direction exposure and unknown data',()=>{
  assert.equal(correlatedScalpExposure({side:'LONG',correlation:.9},{side:'SHORT',correlation:-.8}),true);
  assert.equal(correlatedScalpExposure({side:'LONG',correlation:.9},{side:'SHORT',correlation:.8}),false);
  assert.equal(correlatedScalpExposure({side:'LONG',correlation:null},{side:'SHORT',correlation:.8}),true);
});
