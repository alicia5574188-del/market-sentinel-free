import assert from 'node:assert/strict';
import test from 'node:test';
import {equityGaps, equityMinuteStep, EQ_FILL_MAX_MIN, sampleEquity, type EquityMinute} from '../lib/equity-minutes.ts';

const T=1_792_310_160_000;
const mark=(now:number,balance=1000)=>sampleEquity({now,balance,initial:1000,liveEquity:null,positions:[],quotes:{},symbols:[]});

test('clock-minute sampling never skips a minute when ticks drift (the old 60 s throttle did)',()=>{
  // ticks every 5-7 s, irregular
  const ticks:number[]=[];for(let t=T+3_000,i=0;t<T+180*60_000;i++)ticks.push(t+=5_000+(i*1_337%2_000));
  let oldLast=0;const oldTs=new Set<number>();
  for(const now of ticks){if(now-oldLast<60_000)continue;oldLast=now;oldTs.add(mark(now).ts);}
  let last:number|null=null;const rows:EquityMinute[]=[];
  for(const now of ticks){const minute=Math.floor(now/60_000)*60_000;if(last!=null&&minute<=last)continue;rows.push(...equityMinuteStep(last,mark(now)));last=minute;}
  assert.ok(equityGaps([...oldTs].sort((a,b)=>a-b).map(ts=>({...mark(ts),ts}))).length>0,'old throttle skipped minutes');
  assert.deepEqual(equityGaps(rows),[]);
  assert.equal(rows.filter(r=>r.filled).length,0,'every minute had a real tick');
});

test('a stalled minute is filled from the next real mark and flagged; long stalls and restarts stay gaps',()=>{
  const first=mark(T);
  assert.deepEqual(equityMinuteStep(null,first),[first],'fresh process: no fill');
  assert.deepEqual(equityMinuteStep(T,mark(T+30_000)),[],'same minute');
  const next=mark(T+3*60_000+5_000,1001);
  const rows=equityMinuteStep(T,next);
  assert.deepEqual(rows.map(r=>[(r.ts-T)/60_000,r.filled??false,r.equity]),[[1,true,1001],[2,true,1001],[3,false,1001]]);
  const long=equityMinuteStep(T,mark(T+(EQ_FILL_MAX_MIN+2)*60_000));
  assert.equal(long.length,1,'longer than the fill limit: left as a gap');
  assert.deepEqual(equityGaps([first,...long]),[{after:T,before:T+(EQ_FILL_MAX_MIN+2)*60_000,missing_min:EQ_FILL_MAX_MIN+1}]);
});
