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
