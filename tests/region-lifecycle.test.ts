import test from "node:test";
import assert from "node:assert/strict";
import { REGION_BAR_MS, REGION_LIFECYCLE_VERSION, REGION_MIGRATION_SIGNAL_TTL_BARS, REGION_SIGNAL_TTL_BARS, consumeRegionBoundary, evaluateRegionLifecycle, findLatestMatureRegion, type RegionCandle } from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-22T00:00:00Z")/1000;
const bar=(i:number,close:number,prev=close):RegionCandle=>({
  time:START+i*300,open:prev,close,
  high:Math.max(prev,close)*1.0015,low:Math.min(prev,close)*.9985,volume:1000+i,
});
const region=(center=100,count=30,start=0)=>{
  const rows:RegionCandle[]=[];let prev=center;
  for(let i=0;i<count;i++){
    const close=center*(1+.0032*Math.sin(i*Math.PI/2));
    rows.push({...bar(start+i,close,prev),high:Math.max(prev,close)*1.0018,low:Math.min(prev,close)*.9982});prev=close;
  }
  return rows;
};
const nowFor=(rows:RegionCandle[])=>(rows.at(-1)!.time+300)*1000+1;

test("latest mature 5m winding region is found without direction scoring",()=>{
  const rows=region(),zone=findLatestMatureRegion({symbol:"BTC_USDT",rows,now:nowFor(rows),costRate:.0022});
  assert.ok(zone);assert.equal(zone!.symbol,"BTC_USDT");assert.ok(zone!.lower<100&&zone!.upper>100);
  assert.ok(zone!.crossings>=3);assert.ok(zone!.touchesUpper>=2);assert.ok(zone!.touchesLower>=2);
});

test("cold reconstruction restores an already accepted/detached region but never backfills an old trade",()=>{
  const base=region(),zone=findLatestMatureRegion({symbol:"BTC_USDT",rows:base,now:nowFor(base),costRate:.0022});
  assert.ok(zone);
  let prev=base.at(-1)!.close;
  const rows=[...base];
  for(const close of[zone!.upper+zone!.width*.25,zone!.upper+zone!.width*.72]){
    rows.push(bar(rows.length,close,prev));prev=close;
  }
  const result=evaluateRegionLifecycle({symbol:"BTC_USDT",rows,now:nowFor(rows),costRate:.0022});
  assert.equal(result.state.version,REGION_LIFECYCLE_VERSION);
  assert.equal(result.state.zone?.id,zone!.id);
  assert.equal(result.state.status,"DETACHED_UP");
  assert.equal(result.signals.length,0,"historical reconstruction must never create a catch-up entry");
});

test("two completed closes outside the same boundary create one migration event",()=>{
  const base=region(),first=evaluateRegionLifecycle({symbol:"BTC_USDT",rows:base,now:nowFor(base),costRate:.0022});
  assert.ok(first.state.zone);const z=first.state.zone!;
  const rows=[...base];let prev=rows.at(-1)!.close;
  for(const close of[z.upper+z.width*.18,z.upper+z.width*.28]){rows.push(bar(rows.length,close,prev));prev=close;}
  const next=evaluateRegionLifecycle({symbol:"BTC_USDT",rows,prior:first.state,now:nowFor(rows),costRate:.0022});
  assert.equal(next.state.status,"ACCEPTED_UP");assert.equal(next.signals.length,1);
  assert.equal(next.signals[0]!.kind,"MIGRATION");assert.equal(next.signals[0]!.side,"LONG");
  assert.equal(next.signals[0]!.boundary,"UPPER");
});

test("migration event remains valid longer than rejection so a near-boundary retest can execute",()=>{
  const base=region(),first=evaluateRegionLifecycle({symbol:"BTC_USDT",rows:base,now:nowFor(base),costRate:.0022});
  const z=first.state.zone!,rows=[...base];let prev=rows.at(-1)!.close;
  for(const close of[z.upper+z.width*.18,z.upper+z.width*.28]){rows.push(bar(rows.length,close,prev));prev=close;}
  const next=evaluateRegionLifecycle({symbol:"BTC_USDT",rows,prior:first.state,now:nowFor(rows),costRate:.0022});
  assert.equal(next.signals.length,1);
  assert.equal(next.signals[0]!.expiresAt-next.signals[0]!.completedAt,REGION_MIGRATION_SIGNAL_TTL_BARS*REGION_BAR_MS);
  assert.ok(REGION_MIGRATION_SIGNAL_TTL_BARS>REGION_SIGNAL_TTL_BARS);
});

test("an outside probe that is rejected back inside creates a center-reversion event",()=>{
  const base=region(),first=evaluateRegionLifecycle({symbol:"ETH_USDT",rows:base,now:nowFor(base),costRate:.0022});
  const z=first.state.zone!;assert.ok(z);
  const rows=[...base];let prev=rows.at(-1)!.close;
  rows.push(bar(rows.length,z.upper+z.width*.22,prev));prev=rows.at(-1)!.close;
  rows.push(bar(rows.length,z.upper-z.width*.25,prev));
  const next=evaluateRegionLifecycle({symbol:"ETH_USDT",rows,prior:first.state,now:nowFor(rows),costRate:.0022});
  assert.equal(next.state.status,"IN_REGION");assert.equal(next.signals.length,1);
  assert.equal(next.signals[0]!.kind,"REJECTION");assert.equal(next.signals[0]!.side,"SHORT");
  assert.equal(next.signals[0]!.targetPrice,z.center);
  assert.ok(next.signals[0]!.stopPrice>z.upper);
});

test("a completed event cannot fire twice after its boundary has been consumed",()=>{
  const base=region(),first=evaluateRegionLifecycle({symbol:"SOL_USDT",rows:base,now:nowFor(base),costRate:.0022});
  const z=first.state.zone!,rows=[...base];let prev=rows.at(-1)!.close;
  rows.push(bar(rows.length,z.upper+z.width*.18,prev));prev=rows.at(-1)!.close;
  rows.push(bar(rows.length,z.upper+z.width*.25,prev));
  const event=evaluateRegionLifecycle({symbol:"SOL_USDT",rows,prior:first.state,now:nowFor(rows),costRate:.0022});
  assert.equal(event.signals.length,1);
  const consumed=consumeRegionBoundary(event.state,"UPPER",event.signals[0]!.completedAt);
  const same=evaluateRegionLifecycle({symbol:"SOL_USDT",rows,prior:consumed,now:nowFor(rows)+1000,costRate:.0022});
  assert.equal(same.signals.length,0);
});

test("a distinct later winding region replaces the old one instead of stretching old boundaries",()=>{
  const base=region(),first=evaluateRegionLifecycle({symbol:"AAVE_USDT",rows:base,now:nowFor(base),costRate:.0022});
  const old=first.state.zone!;assert.ok(old);
  const rows=[...base];let prev=rows.at(-1)!.close;
  for(let i=0;i<8;i++){const close=101.2+i*.20;rows.push(bar(rows.length,close,prev));prev=close;}
  const high=region(103.5,30,rows.length);
  const shifted=high.map((x,i)=>({...x,open:i?high[i-1]!.close:prev,high:Math.max(i?high[i-1]!.close:prev,x.close)*1.0018,low:Math.min(i?high[i-1]!.close:prev,x.close)*.9982}));
  rows.push(...shifted);
  const next=evaluateRegionLifecycle({symbol:"AAVE_USDT",rows,prior:first.state,now:nowFor(rows),costRate:.0022});
  assert.ok(next.state.zone);assert.notEqual(next.state.zone!.id,old.id);
  assert.ok(next.state.zone!.center>old.center+old.width);
});
