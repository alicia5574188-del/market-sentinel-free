export type MultiTurnUniverseTicker={
  symbol:string;last:number;high24h:number;low24h:number;change24hRate:number;
  volume24hUsd:number;fundingRate:number;openInterest:number;
};
export type MultiTurnUniverseClass="MARKET_AMPLIFIER"|"INDEPENDENT_VOLATILITY";
export type RankedMultiTurnUniverse=MultiTurnUniverseTicker&{
  class:MultiTurnUniverseClass;score:number;range24hRate:number;directionalEfficiency:number;
  marketMove24hRate:number;residual24hRate:number;reason:string;
};

const median=(values:number[])=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return 0;
  return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;
};
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const sgn=(v:number)=>v>0?1:v<0?-1:0;

/**
 * The first-stage Multi-Turn universe is chosen by observed movement, not turnover rank.
 * 1) MARKET_AMPLIFIER: moves with the broad market but with meaningfully larger travel.
 * 2) INDEPENDENT_VOLATILITY: travels far despite a large residual/opposite move versus the broad market.
 *
 * Volume is carried for diagnostics only. Executability remains a later fresh-book/spread/contract check.
 */
export function rankMultiTurnUniverse(rows:MultiTurnUniverseTicker[],limit=30):RankedMultiTurnUniverse[]{
  const valid=rows.filter(r=>r.symbol.endsWith("_USDT")&&r.last>0&&r.high24h>=r.low24h&&r.low24h>0
    &&[r.change24hRate,r.volume24hUsd,r.fundingRate,r.openInterest].every(Number.isFinite));
  if(!valid.length)return[];
  const marketMove=median(valid.map(r=>r.change24hRate));
  const residualScale=Math.max(.012,median(valid.map(r=>Math.abs(r.change24hRate-marketMove))));
  const broadDirection=sgn(marketMove);
  const ranked=valid.map(r=>{
    const range=Math.max(0,(r.high24h-r.low24h)/Math.max(r.last,1e-12));
    const absMove=Math.abs(r.change24hRate);
    const efficiency=clip(absMove/Math.max(range,1e-9));
    const residual=Math.abs(r.change24hRate-marketMove);
    const sameDirection=broadDirection!==0&&sgn(r.change24hRate)===broadDirection;
    const amplification=absMove/Math.max(Math.abs(marketMove),.005);
    const residualMultiple=residual/residualScale;
    const follower=sameDirection
      ? range*(.75+.35*Math.min(4,amplification))*(.70+.30*efficiency)
      : 0;
    const independent=range*(.72+.28*efficiency)*(1+.30*Math.min(4,residualMultiple))
      *((broadDirection!==0&&sgn(r.change24hRate)===-broadDirection)?1.15:1);
    const useFollower=sameDirection&&amplification>=1.15&&follower>=independent*.90;
    const kind:MultiTurnUniverseClass=useFollower?"MARKET_AMPLIFIER":"INDEPENDENT_VOLATILITY";
    const score=Math.max(follower,independent);
    const reason=useFollower
      ? `跟随市场${marketMove>=0?"上涨":"下跌"}且24h振幅${(range*100).toFixed(1)}%，净移动放大${amplification.toFixed(1)}×`
      : `独立高波动：24h振幅${(range*100).toFixed(1)}%，相对市场残差${(residual*100).toFixed(1)}%`;
    return {...r,class:kind,score,range24hRate:range,directionalEfficiency:efficiency,
      marketMove24hRate:marketMove,residual24hRate:residual,reason};
  }).filter(r=>r.range24hRate>=.025||Math.abs(r.change24hRate)>=.02)
    .sort((a,b)=>b.score-a.score||b.range24hRate-a.range24hRate||a.symbol.localeCompare(b.symbol));
  return ranked.slice(0,Math.max(1,Math.floor(limit)));
}


export type AnchorOpportunityUniverseRow=MultiTurnUniverseTicker&{
  selectionSource:"LOCKED_ANCHOR"|"ACTIVITY"|"EXPLORATION";
  activityScore:number;
  range24hRate:number;
  liquidityFloorUsd:number;
};

/**
 * Cheap outer selector for the winding-anchor engine.
 * It does NOT predict direction and does NOT revive the retired volatility strategy.
 * Turnover is only an executability floor. Actual anchor/entry qualification still
 * happens later from 5m/15m/30m/1h candles.
 *
 * Slots:
 * - confirmed current anchor opportunities stay in the scan set while still liquid;
 * - most remaining slots go to markets with enough observable price travel;
 * - a small rotating exploration sleeve samples the rest of the liquid Gate universe.
 */
export function selectAnchorOpportunityUniverse(input:{
  rows:MultiTurnUniverseTicker[];
  limit?:number;
  lockedSymbols?:Iterable<string>;
  currentSymbols?:Iterable<string>;
  rotationSeed?:number;
  explorationSlots?:number;
}):AnchorOpportunityUniverseRow[]{
  const limit=Math.max(1,Math.floor(input.limit??30));
  const valid=input.rows.filter(r=>r.symbol.endsWith("_USDT")&&r.last>0&&r.high24h>=r.low24h&&r.low24h>0
    &&r.volume24hUsd>0&&[r.change24hRate,r.volume24hUsd,r.fundingRate,r.openInterest].every(Number.isFinite));
  if(!valid.length)return[];
  const liquidityFloorUsd=100_000;
  const liquid=valid.filter(r=>r.volume24hUsd>=liquidityFloorUsd);
  if(!liquid.length)return[];
  const bySymbol=new Map(liquid.map(r=>[r.symbol,r]));
  const current=new Set(input.currentSymbols??[]);
  const scored=liquid.map(row=>{
    const range24hRate=Math.max(0,(row.high24h-row.low24h)/Math.max(row.last,1e-12));
    const travel=clip(range24hRate/.08);
    const netMove=clip(Math.abs(row.change24hRate)/.05);
    const activityScore=.72*travel+.28*netMove+(current.has(row.symbol)?.025:0);
    return{row,range24hRate,activityScore};
  });
  const selected:AnchorOpportunityUniverseRow[]=[];
  const used=new Set<string>();
  const push=(symbol:string,source:AnchorOpportunityUniverseRow["selectionSource"])=>{
    if(used.has(symbol)||selected.length>=limit)return;
    const row=bySymbol.get(symbol),score=scored.find(x=>x.row.symbol===symbol);if(!row||!score)return;
    used.add(symbol);selected.push({...row,selectionSource:source,activityScore:score.activityScore,
      range24hRate:score.range24hRate,liquidityFloorUsd});
  };

  for(const symbol of input.lockedSymbols??[])push(symbol,"LOCKED_ANCHOR");

  const explorationSlots=Math.min(Math.max(0,Math.floor(input.explorationSlots??6)),Math.max(0,limit-selected.length));
  const activitySlots=Math.max(0,limit-selected.length-explorationSlots);
  const activity=[...scored].filter(x=>!used.has(x.row.symbol))
    .sort((a,b)=>b.activityScore-a.activityScore||b.range24hRate-a.range24hRate
      ||Math.abs(b.row.change24hRate)-Math.abs(a.row.change24hRate)||a.row.symbol.localeCompare(b.row.symbol));
  for(const x of activity.slice(0,activitySlots))push(x.row.symbol,"ACTIVITY");

  const remaining=activity.filter(x=>!used.has(x.row.symbol)).sort((a,b)=>a.row.symbol.localeCompare(b.row.symbol));
  if(remaining.length&&explorationSlots){
    const start=((Math.floor(input.rotationSeed??0)*explorationSlots)%remaining.length+remaining.length)%remaining.length;
    for(let i=0;i<explorationSlots&&selected.length<limit;i++)push(remaining[(start+i)%remaining.length].row.symbol,"EXPLORATION");
  }
  for(const x of activity)push(x.row.symbol,"ACTIVITY");
  return selected.slice(0,limit);
}

export type RegionLifecycleUniverseRow=MultiTurnUniverseTicker&{
  selectionSource:"LOCKED_REGION"|"RESIDENT"|"EXPLORATION";
  activityScore:number;
  range24hRate:number;
  liquidityFloorUsd:number;
};

/**
 * Outer 5m region scanner.
 * - Region/position symbols keep their path while still liquid.
 * - Resident slots prefer observable travel, not turnover rank.
 * - Exploration rotates through the rest of the liquid Gate USDT-perp surface.
 * Turnover is only a fixed executability floor; no direction is inferred here.
 */
export function selectRegionLifecycleUniverse(input:{
  rows:MultiTurnUniverseTicker[];
  limit?:number;
  lockedSymbols?:Iterable<string>;
  currentSymbols?:Iterable<string>;
  rotationSeed?:number;
  explorationSlots?:number;
}):RegionLifecycleUniverseRow[]{
  const limit=Math.max(1,Math.floor(input.limit??60));
  const valid=input.rows.filter(r=>r.symbol.endsWith("_USDT")&&r.last>0&&r.high24h>=r.low24h&&r.low24h>0
    &&r.volume24hUsd>0&&[r.change24hRate,r.volume24hUsd,r.fundingRate,r.openInterest].every(Number.isFinite));
  if(!valid.length)return[];
  const liquidityFloorUsd=100_000;
  const liquid=valid.filter(r=>r.volume24hUsd>=liquidityFloorUsd);
  if(!liquid.length)return[];
  const current=new Set(input.currentSymbols??[]);
  const scored=liquid.map(row=>{
    const range24hRate=Math.max(0,(row.high24h-row.low24h)/Math.max(row.last,1e-12));
    const travel=clip(range24hRate/.08),netMove=clip(Math.abs(row.change24hRate)/.05);
    return{row,range24hRate,activityScore:.70*travel+.30*netMove+(current.has(row.symbol)?.04:0)};
  });
  const bySymbol=new Map(scored.map(x=>[x.row.symbol,x]));
  const selected:RegionLifecycleUniverseRow[]=[],used=new Set<string>();
  const push=(symbol:string,source:RegionLifecycleUniverseRow["selectionSource"])=>{
    if(used.has(symbol)||selected.length>=limit)return;
    const x=bySymbol.get(symbol);if(!x)return;
    used.add(symbol);selected.push({...x.row,selectionSource:source,activityScore:x.activityScore,
      range24hRate:x.range24hRate,liquidityFloorUsd});
  };

  for(const symbol of input.lockedSymbols??[])push(symbol,"LOCKED_REGION");

  const explorationSlots=Math.min(Math.max(0,Math.floor(input.explorationSlots??18)),Math.max(0,limit-selected.length));
  const residentSlots=Math.max(0,limit-selected.length-explorationSlots);
  const activity=[...scored].filter(x=>!used.has(x.row.symbol))
    .sort((a,b)=>b.activityScore-a.activityScore||b.range24hRate-a.range24hRate
      ||Math.abs(b.row.change24hRate)-Math.abs(a.row.change24hRate)||a.row.symbol.localeCompare(b.row.symbol));
  for(const x of activity.slice(0,residentSlots))push(x.row.symbol,"RESIDENT");

  const remaining=activity.filter(x=>!used.has(x.row.symbol)).sort((a,b)=>a.row.symbol.localeCompare(b.row.symbol));
  if(remaining.length&&explorationSlots){
    const start=((Math.floor(input.rotationSeed??0)*explorationSlots)%remaining.length+remaining.length)%remaining.length;
    for(let i=0;i<explorationSlots&&selected.length<limit;i++)push(remaining[(start+i)%remaining.length]!.row.symbol,"EXPLORATION");
  }
  for(const x of activity)push(x.row.symbol,"RESIDENT");
  return selected.slice(0,limit);
}

