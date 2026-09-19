/** Broad-market transition guard for the forward PAPER account.
 * This layer is deliberately dormant during ordinary markets. It never creates
 * signals, flips direction, changes rule discovery or widens any stop. It only
 * identifies a severe, synchronized completed-5m move against an already
 * concentrated portfolio so the caller can reduce vulnerable exposure.
 */
export const MARKET_TURN_PROTECTION_VERSION = "market-turn-shield-v1";
export const MARKET_TURN_GUARD_MS = 15 * 60_000;
export const MARKET_TURN_TARGET_DIRECTION_RISK_RATE = 0.035;

export type MarketTurnSide = "LONG" | "SHORT";
export type MarketTurnProtection = {
  version: typeof MARKET_TURN_PROTECTION_VERSION;
  threatenedSide: MarketTurnSide;
  detectedAt: number;
  completedBarAt: number;
  until: number;
  markets: number;
  adverseShare: number;
  strongAdverseShare: number;
  medianAdverseMove: number;
  medianAcceleration: number;
  directionalRiskRate: number;
  concentration: number;
  reason: string;
};

type CandleLike = { time: number; open: number; close: number };
type PositionLike = { status: string; side: MarketTurnSide; plannedRisk: number };

const finite=(v:number)=>Number.isFinite(v);
const median=(values:number[])=>{
  const a=values.filter(finite).sort((x,y)=>x-y);
  if(!a.length)return 0;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
};

export function assessMarketTurn(input:{
  paths:Record<string,CandleLike[]>;
  positions:readonly PositionLike[];
  equity:number;
  now:number;
}):MarketTurnProtection|null {
  const open=input.positions.filter(p=>p.status==="OPEN"&&finite(p.plannedRisk)&&p.plannedRisk>0);
  if(open.length<4||!(input.equity>0))return null;
  const longRisk=open.filter(p=>p.side==="LONG").reduce((n,p)=>n+p.plannedRisk,0);
  const shortRisk=open.filter(p=>p.side==="SHORT").reduce((n,p)=>n+p.plannedRisk,0);
  const totalRisk=longRisk+shortRisk;
  if(!(totalRisk>0))return null;
  const threatenedSide:MarketTurnSide=longRisk>=shortRisk?"LONG":"SHORT";
  const directionalRisk=threatenedSide==="LONG"?longRisk:shortRisk;
  const concentration=directionalRisk/totalRisk;
  const directionalRiskRate=directionalRisk/input.equity;
  // A broad-market guard must not affect small or balanced portfolios.
  if(concentration<0.70||directionalRiskRate<0.035)return null;

  const observations=Object.values(input.paths).flatMap(rows=>{
    if(rows.length<8)return[];
    const latest=rows.at(-1)!;
    if(![latest.time,latest.open,latest.close].every(finite)||latest.open<=0||latest.close<=0)return[];
    const completedAt=latest.time*1000+300_000;
    if(completedAt>input.now+1_000||input.now-completedAt>180_000)return[];
    const prior=rows.slice(-7,-1).filter(r=>[r.open,r.close].every(finite)&&r.open>0&&r.close>0);
    if(prior.length<6)return[];
    const move=latest.close/latest.open-1;
    const baseline=Math.max(0.0005,median(prior.map(r=>Math.abs(r.close/r.open-1))));
    const adverse=threatenedSide==="LONG"?-move:move;
    const acceleration=Math.abs(move)/baseline;
    const strong=adverse>=Math.max(0.004,baseline*1.8);
    return[{completedAt,adverse,acceleration,strong}];
  });
  if(observations.length<12)return null;
  const adverseShare=observations.filter(o=>o.adverse>0).length/observations.length;
  const strongAdverseShare=observations.filter(o=>o.strong).length/observations.length;
  const medianAdverseMove=median(observations.map(o=>o.adverse));
  const medianAcceleration=median(observations.map(o=>o.acceleration));
  if(adverseShare<0.75||strongAdverseShare<0.50||medianAdverseMove<0.0045||medianAcceleration<1.6)return null;
  const completedBarAt=Math.max(...observations.map(o=>o.completedAt));
  return {
    version:MARKET_TURN_PROTECTION_VERSION,threatenedSide,detectedAt:input.now,completedBarAt,
    until:input.now+MARKET_TURN_GUARD_MS,markets:observations.length,adverseShare,strongAdverseShare,
    medianAdverseMove,medianAcceleration,directionalRiskRate,concentration,
    reason:`市场转折保护：${observations.length}个新鲜5分钟市场中${Math.round(adverseShare*100)}%逆着${threatenedSide==="LONG"?"多":"空"}向持仓，`
      +`中位逆向波动${(medianAdverseMove*100).toFixed(2)}%，波动加速${medianAcceleration.toFixed(2)}×；仅削减脆弱风险，不自动反手。`,
  };
}
