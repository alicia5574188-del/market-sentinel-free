import test from "node:test";
import assert from "node:assert/strict";
import { rankMultiTurnUniverse, type MultiTurnUniverseTicker } from "../lib/multi-turn-universe.ts";

const row=(symbol:string,change:number,range:number,volume=1_000_000):MultiTurnUniverseTicker=>{
  const last=100,low=100-range*50,high=100+range*50;
  return{symbol,last,low24h:low,high24h:high,change24hRate:change,volume24hUsd:volume,fundingRate:0,openInterest:1};
};

test("universe ranking favors high-volatility market amplifiers over high-volume quiet coins",()=>{
  const rows=[
    row("QUIET_USDT",.01,.015,5_000_000_000),
    row("BASE1_USDT",.04,.05),
    row("BASE2_USDT",.035,.045),
    row("AMP_USDT",.18,.24,50_000),
    row("IND_USDT",-.14,.22,40_000),
  ];
  const ranked=rankMultiTurnUniverse(rows,3);
  assert.ok(ranked.some(x=>x.symbol==="AMP_USDT"));
  assert.ok(ranked.some(x=>x.symbol==="IND_USDT"));
  assert.equal(ranked.some(x=>x.symbol==="QUIET_USDT"),false);
  assert.equal(ranked.find(x=>x.symbol==="AMP_USDT")?.class,"MARKET_AMPLIFIER");
  assert.equal(ranked.find(x=>x.symbol==="IND_USDT")?.class,"INDEPENDENT_VOLATILITY");
});

test("turnover is not a ranking input",()=>{
  const base=[row("A_USDT",.10,.18,1),row("B_USDT",.10,.18,9_000_000_000),row("C_USDT",.03,.04,5_000_000)];
  const ranked=rankMultiTurnUniverse(base,3);
  assert.equal(ranked.find(x=>x.symbol==="A_USDT")?.score,ranked.find(x=>x.symbol==="B_USDT")?.score);
});

test("quiet contracts can be omitted even if liquid",()=>{
  const ranked=rankMultiTurnUniverse([row("QUIET_USDT",.002,.01,10_000_000_000),row("MOVE_USDT",.08,.12,10_000)],30);
  assert.deepEqual(ranked.map(x=>x.symbol),["MOVE_USDT"]);
});


test("dynamic anchor pool keeps confirmed anchor symbols and does not rank by turnover",async()=>{
  const {selectAnchorOpportunityUniverse}=await import("../lib/multi-turn-universe.ts");
  const rows=[
    row("LOCKED_USDT",.01,.035,200_000),
    row("QUIET_WHALE_USDT",.001,.008,8_000_000_000),
    ...Array.from({length:40},(_,i)=>row(`MOVE${String(i).padStart(2,"0")}_USDT`,.01+(i%5)*.006,.035+(i%9)*.006,300_000+i*10_000)),
  ];
  const selected=selectAnchorOpportunityUniverse({rows,limit:30,lockedSymbols:["LOCKED_USDT"],rotationSeed:0});
  assert.equal(selected.length,30);
  assert.equal(selected[0].symbol,"LOCKED_USDT");
  assert.equal(selected[0].selectionSource,"LOCKED_ANCHOR");
  assert.equal(selected.some(x=>x.symbol==="QUIET_WHALE_USDT"),false);
});

test("dynamic anchor pool rotates exploration slots across the wider liquid universe",async()=>{
  const {selectAnchorOpportunityUniverse}=await import("../lib/multi-turn-universe.ts");
  const rows=Array.from({length:70},(_,i)=>row(`C${String(i).padStart(2,"0")}_USDT`,.01+(i%4)*.004,.03+(i%10)*.004,500_000+i*1_000));
  const a=selectAnchorOpportunityUniverse({rows,limit:30,rotationSeed:0,explorationSlots:6});
  const b=selectAnchorOpportunityUniverse({rows,limit:30,rotationSeed:1,explorationSlots:6});
  const ae=new Set(a.filter(x=>x.selectionSource==="EXPLORATION").map(x=>x.symbol));
  const be=new Set(b.filter(x=>x.selectionSource==="EXPLORATION").map(x=>x.symbol));
  assert.equal(a.length,30);assert.equal(b.length,30);
  assert.ok([...ae].some(x=>!be.has(x)));
});

test("turnover is only a liquidity floor in the new selector",async()=>{
  const {selectAnchorOpportunityUniverse}=await import("../lib/multi-turn-universe.ts");
  const rows=[
    row("A_USDT",.04,.08,300_000),
    row("B_USDT",.04,.08,3_000_000_000),
    ...Array.from({length:35},(_,i)=>row(`F${i}_USDT`,.02,.04,400_000+i*1_000)),
  ];
  const selected=selectAnchorOpportunityUniverse({rows,limit:30,rotationSeed:0});
  const a=selected.find(x=>x.symbol==="A_USDT"),b=selected.find(x=>x.symbol==="B_USDT");
  assert.ok(a&&b);assert.equal(a!.activityScore,b!.activityScore);
});


test("region lifecycle universe expands completed-5m scanning to 60 while retaining mature-region symbols",async()=>{
  const {selectRegionLifecycleUniverse}=await import("../lib/multi-turn-universe.ts");
  const rows=[
    row("LOCKED_REGION_USDT",.002,.02,250_000),
    ...Array.from({length:90},(_,i)=>row(`R${String(i).padStart(2,"0")}_USDT`,.006+(i%7)*.004,.025+(i%11)*.005,300_000+i*2_000)),
  ];
  const selected=selectRegionLifecycleUniverse({rows,limit:60,lockedSymbols:["LOCKED_REGION_USDT"],rotationSeed:0,explorationSlots:18});
  assert.equal(selected.length,60);
  assert.equal(selected[0].symbol,"LOCKED_REGION_USDT");
  assert.equal(selected[0].selectionSource,"LOCKED_REGION");
});

test("region lifecycle exploration rotates across the wider liquid surface without enlarging realtime authority",async()=>{
  const {selectRegionLifecycleUniverse}=await import("../lib/multi-turn-universe.ts");
  const rows=Array.from({length:100},(_,i)=>row(`X${String(i).padStart(3,"0")}_USDT`,.008+(i%5)*.003,.03+(i%13)*.004,500_000+i*1_000));
  const a=selectRegionLifecycleUniverse({rows,limit:60,rotationSeed:0,explorationSlots:18});
  const b=selectRegionLifecycleUniverse({rows,limit:60,rotationSeed:1,explorationSlots:18});
  assert.equal(a.length,60);assert.equal(b.length,60);
  assert.equal(a.filter(x=>x.selectionSource==="EXPLORATION").length,18);
  assert.equal(b.filter(x=>x.selectionSource==="EXPLORATION").length,18);
  const ae=new Set(a.filter(x=>x.selectionSource==="EXPLORATION").map(x=>x.symbol));
  const be=new Set(b.filter(x=>x.selectionSource==="EXPLORATION").map(x=>x.symbol));
  assert.ok([...ae].some(x=>!be.has(x)));
});

test("turnover remains only a fixed liquidity floor for the region scanner",async()=>{
  const {selectRegionLifecycleUniverse}=await import("../lib/multi-turn-universe.ts");
  const rows=[
    row("LOWVOL_USDT",.03,.07,150_000),
    row("WHALE_USDT",.03,.07,9_000_000_000),
    row("TOO_THIN_USDT",.20,.30,99_999),
    ...Array.from({length:70},(_,i)=>row(`L${i}_USDT`,.015,.045,200_000+i*1_000)),
  ];
  const selected=selectRegionLifecycleUniverse({rows,limit:60,rotationSeed:0,explorationSlots:18});
  const a=selected.find(x=>x.symbol==="LOWVOL_USDT"),b=selected.find(x=>x.symbol==="WHALE_USDT");
  assert.ok(a&&b);assert.equal(a!.activityScore,b!.activityScore);
  assert.equal(selected.some(x=>x.symbol==="TOO_THIN_USDT"),false);
});
