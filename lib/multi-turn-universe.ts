export type MultiTurnUniverseTicker={
  symbol:string;last:number;high24h:number;low24h:number;change24hRate:number;
  volume24hUsd:number;executionVolume24hUsd?:number;fundingRate:number;openInterest:number;
  sourceCount?:number;sourceDisagreementRate?:number;
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

export const FORWARD_EXECUTION_VOLUME_FLOOR_USD=1_000_000;
export const forwardExecutionVolume24hUsd=(row:Pick<MultiTurnUniverseTicker,"volume24hUsd"|"executionVolume24hUsd">)=>
  Math.max(0,Number(row.executionVolume24hUsd??row.volume24hUsd));
export function forwardExecutionUniverseEligible(row:MultiTurnUniverseTicker){
  return row.symbol.endsWith("_USDT")&&row.last>0&&row.high24h>=row.low24h&&row.low24h>0
    &&forwardExecutionVolume24hUsd(row)>=FORWARD_EXECUTION_VOLUME_FLOOR_USD;
}

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
  selectionSource:"LOCKED_ANCHOR"|"MARKET_CORE"|"LIQUIDITY"|"ACTIVITY"|"EXPLORATION";
  activityScore:number;
  range24hRate:number;
  liquidityFloorUsd:number;
  liquidityScore?:number;movementScore?:number;dataQualityScore?:number;
};

/**
 * Outer selector for the extremum-regime engine.
 * It never predicts side. The 30-market set balances executable Gate liquidity (40%),
 * usable movement (35%) and independent public-data quality (25%). Existing positions
 * and BTC/ETH/SOL continuity anchors remain resident; a small exploration sleeve prevents
 * the same names from permanently monopolising observation.
 */
export function selectAnchorOpportunityUniverse(input:{
  rows:MultiTurnUniverseTicker[];
  limit?:number;
  lockedSymbols?:Iterable<string>;
  coreSymbols?:Iterable<string>;
  currentSymbols?:Iterable<string>;
  rotationSeed?:number;
  explorationSlots?:number;
  liquiditySlots?:number;
}):AnchorOpportunityUniverseRow[]{
  const limit=Math.max(1,Math.floor(input.limit??30));
  const valid=input.rows.filter(r=>r.symbol.endsWith("_USDT")&&r.last>0&&r.high24h>=r.low24h&&r.low24h>0
    &&[r.change24hRate,r.volume24hUsd,r.executionVolume24hUsd??r.volume24hUsd,r.fundingRate,r.openInterest].every(Number.isFinite));
  if(!valid.length)return[];
  const liquidityFloorUsd=FORWARD_EXECUTION_VOLUME_FLOOR_USD;
  const liquid=valid.filter(forwardExecutionUniverseEligible);
  if(!liquid.length)return[];
  const bySymbol=new Map(liquid.map(r=>[r.symbol,r]));
  const current=new Set(input.currentSymbols??[]);
  const scored=liquid.map(row=>{
    const range24hRate=Math.max(0,(row.high24h-row.low24h)/Math.max(row.last,1e-12)),
      executionVolume=forwardExecutionVolume24hUsd(row),
      liquidityScore=clip((Math.log10(Math.max(executionVolume,1))-6)/3),
      directionalEfficiency=clip(Math.abs(row.change24hRate)/Math.max(range24hRate,.004)),
      travel=clip((range24hRate-.010)/.070),netMove=clip(Math.abs(row.change24hRate)/.045),
      movementScore=.55*travel+.25*netMove+.20*directionalEfficiency,
      sourceCoverage=clip((row.sourceCount??0)/4),
      sourceAgreement=Math.exp(-Math.max(0,row.sourceDisagreementRate??0)/.006),
      dataQualityScore=.65*sourceCoverage+.35*sourceAgreement,
      activityScore=.40*liquidityScore+.35*movementScore+.25*dataQualityScore+(current.has(row.symbol)?.015:0);
    return{row,range24hRate,activityScore,executionVolume,liquidityScore,movementScore,dataQualityScore};
  });
  const selected:AnchorOpportunityUniverseRow[]=[];
  const used=new Set<string>();
  const push=(symbol:string,source:AnchorOpportunityUniverseRow["selectionSource"])=>{
    if(used.has(symbol)||selected.length>=limit)return;
    const row=bySymbol.get(symbol),score=scored.find(x=>x.row.symbol===symbol);if(!row||!score)return;
    used.add(symbol);selected.push({...row,selectionSource:source,activityScore:score.activityScore,
      range24hRate:score.range24hRate,liquidityFloorUsd,liquidityScore:score.liquidityScore,
      movementScore:score.movementScore,dataQualityScore:score.dataQualityScore});
  };

  for(const symbol of input.lockedSymbols??[])push(symbol,"LOCKED_ANCHOR");
  // Stable broad-market anchors keep causal 5m structure before a synchronized
  // move begins. Turnover below is scan continuity only; neither sleeve chooses
  // side nor bypasses the later completed-candle/executable-book policy.
  for(const symbol of input.coreSymbols??[])push(symbol,"MARKET_CORE");

  const liquiditySlots=Math.min(Math.max(0,Math.floor(input.liquiditySlots??0)),Math.max(0,limit-selected.length));
  const liquidLeaders=[...scored].filter(x=>!used.has(x.row.symbol))
    .sort((a,b)=>b.executionVolume-a.executionVolume||b.activityScore-a.activityScore||a.row.symbol.localeCompare(b.row.symbol));
  for(const x of liquidLeaders.slice(0,liquiditySlots))push(x.row.symbol,"LIQUIDITY");

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
