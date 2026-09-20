/** Portfolio market-state layer.
 * It does not create signals or reverse positions. It only classifies broad
 * completed-5m behaviour, keeps directional candidates available, and supplies
 * portfolio risk budgets so trend, transition and range regimes are handled
 * differently without replacing Forward's learned rules.
 */
export const MARKET_STATE_VERSION = "portfolio-market-state-v1";
export type MarketMode = "UNKNOWN"|"TREND_LONG"|"TREND_SHORT"|"TRANSITION"|"NEUTRAL";
export type MarketSide = "LONG"|"SHORT";
export type MarketState = {
  version:typeof MARKET_STATE_VERSION;
  mode:MarketMode;
  rawMode:MarketMode;
  observedAt:number;
  since:number;
  markets:number;
  confirmations:number;
  candidateMode:MarketMode|null;
  candidateBars:number;
  breadth15:number;
  breadth30:number;
  breadth60:number;
  median15:number;
  median30:number;
  median60:number;
  medianFiveMinuteMove:number;
  pathEfficiency30:number;
  flipRate30:number;
  reason:string;
};
export type MarketRiskBudget = {
  totalRate:number;
  longRate:number;
  shortRate:number;
  netDirectionalRate:number;
  drawdownRate:number;
  reason:string;
};
type CandleLike={time:number;close:number};
const finite=(v:number)=>Number.isFinite(v);
const median=(v:number[])=>{
  const a=v.filter(finite).sort((x,y)=>x-y);if(!a.length)return 0;
  const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;
};
const share=(v:number[],fn:(x:number)=>boolean)=>v.length?v.filter(fn).length/v.length:0;
const sign=(v:number)=>v>0?1:v<0?-1:0;
const opposite=(a:MarketMode,b:MarketMode)=>(a==="TREND_LONG"&&b==="TREND_SHORT")||(a==="TREND_SHORT"&&b==="TREND_LONG");

function rawState(paths:Record<string,CandleLike[]>,now:number){
  const rows=Object.values(paths).flatMap(source=>{
    const a=source.filter(r=>finite(r.time)&&finite(r.close)&&r.close>0&&r.time*1000+300_000<=now).slice(-13);
    if(a.length<13)return[];
    const completedAt=a.at(-1)!.time*1000+300_000;
    if(now-completedAt>180_000)return[];
    const closes=a.map(r=>r.close),steps=closes.slice(1).map((v,i)=>v/closes[i]-1);
    const last=closes.at(-1)!;
    const r15=last/closes[closes.length-4]-1,r30=last/closes[closes.length-7]-1,r60=last/closes[0]-1;
    const path=steps.slice(-6),travel=path.reduce((n,v)=>n+Math.abs(v),0);
    const efficiency=travel>0?Math.abs(r30)/travel:0;
    const dirs=path.map(sign).filter(Boolean),flips=dirs.slice(1).reduce((n,v,i)=>n+Number(v!==dirs[i]),0);
    return[{r15,r30,r60,efficiency,flipRate:dirs.length>1?flips/(dirs.length-1):0,base:median(steps.map(Math.abs))}];
  });
  if(rows.length<8)return{mode:"UNKNOWN" as MarketMode,rows,base:.0005,b15:0,b30:0,b60:0,m15:0,m30:0,m60:0,eff:0,flip:0};
  const r15=rows.map(r=>r.r15),r30=rows.map(r=>r.r30),r60=rows.map(r=>r.r60);
  const base=Math.max(.0005,median(rows.map(r=>r.base)));
  const b15=share(r15,v=>v>0),b30=share(r30,v=>v>0),b60=share(r60,v=>v>0);
  const m15=median(r15),m30=median(r30),m60=median(r60),eff=median(rows.map(r=>r.efficiency)),flip=median(rows.map(r=>r.flipRate));
  const longTrend=b30>=.64&&b60>=.60&&m30>=base*1.8&&m60>=base*2.4&&eff>=.40&&flip<=.60;
  const shortTrend=b30<=.36&&b60<=.40&&m30<=-base*1.8&&m60<=-base*2.4&&eff>=.40&&flip<=.60;
  const neutral=(eff<=.34||flip>=.62)&&b30>=.32&&b30<=.68&&Math.abs(m30)<=base*2.2;
  const mode:MarketMode=longTrend?"TREND_LONG":shortTrend?"TREND_SHORT":neutral?"NEUTRAL":"TRANSITION";
  return{mode,rows,base,b15,b30,b60,m15,m30,m60,eff,flip};
}

export function updateMarketState(paths:Record<string,CandleLike[]>,previous:MarketState|null|undefined,now:number):MarketState {
  const r=rawState(paths,now),raw=r.mode;
  if(raw==="UNKNOWN"){
    return previous?{...previous,rawMode:"UNKNOWN",observedAt:now,markets:r.rows.length,
      reason:`市场状态样本不足（${r.rows.length}个新鲜市场），保留上一状态但不据此创造方向信号。`}
      :{version:MARKET_STATE_VERSION,mode:"UNKNOWN",rawMode:"UNKNOWN",observedAt:now,since:now,markets:r.rows.length,
        confirmations:0,candidateMode:null,candidateBars:0,breadth15:0,breadth30:0,breadth60:0,median15:0,median30:0,median60:0,
        medianFiveMinuteMove:r.base,pathEfficiency30:0,flipRate30:0,reason:"市场状态样本不足；沿用原始风险边界。"};
  }
  const prev=previous?.version===MARKET_STATE_VERSION?previous:null;
  let mode=prev?.mode??"UNKNOWN",candidateMode:MarketMode|null=null,candidateBars=0,confirmations=prev?.confirmations??0,since=prev?.since??now;
  if(prev&&raw===prev.mode){mode=prev.mode;confirmations=Math.min(99,confirmations+1);}
  else{
    candidateMode=prev?.candidateMode===raw?raw:raw;
    candidateBars=prev?.candidateMode===raw?(prev.candidateBars+1):1;
    const threshold=prev&&opposite(prev.mode,raw)?3:2;
    if(candidateBars>=threshold){mode=raw;since=now;confirmations=candidateBars;candidateMode=null;candidateBars=0;}
    else if(prev&&opposite(prev.mode,raw)){mode="TRANSITION";since=prev.mode==="TRANSITION"?prev.since:now;confirmations=1;}
  }
  const name={UNKNOWN:"未知",TREND_LONG:"趋势多",TREND_SHORT:"趋势空",TRANSITION:"转折过渡",NEUTRAL:"震荡中性"}[mode];
  return{version:MARKET_STATE_VERSION,mode,rawMode:raw,observedAt:now,since,markets:r.rows.length,confirmations,candidateMode,candidateBars,
    breadth15:r.b15,breadth30:r.b30,breadth60:r.b60,median15:r.m15,median30:r.m30,median60:r.m60,
    medianFiveMinuteMove:r.base,pathEfficiency30:r.eff,flipRate30:r.flip,
    reason:`${name}：30分钟上涨广度${Math.round(r.b30*100)}%，60分钟上涨广度${Math.round(r.b60*100)}%，30分钟路径效率${r.eff.toFixed(2)}，翻转率${r.flip.toFixed(2)}；状态只调风险，不强制开多或开空。`};
}

export function marketRiskBudget(state:MarketState|null|undefined,equity:number,peakEquity:number):MarketRiskBudget {
  const mode=state?.mode??"UNKNOWN";
  let totalRate=.10,longRate=.065,shortRate=.065,netDirectionalRate=.10;
  if(mode==="TREND_LONG"){totalRate=.075;longRate=.065;shortRate=.015;netDirectionalRate=.065;}
  else if(mode==="TREND_SHORT"){totalRate=.075;longRate=.015;shortRate=.065;netDirectionalRate=.065;}
  else if(mode==="TRANSITION"){totalRate=.06;longRate=.045;shortRate=.045;netDirectionalRate=.03;}
  else if(mode==="NEUTRAL"){totalRate=.05;longRate=.03;shortRate=.03;netDirectionalRate=.02;}
  const drawdownRate=equity>0&&peakEquity>0?Math.max(0,1-equity/peakEquity):0;
  if((mode==="TRANSITION"||mode==="NEUTRAL")&&drawdownRate>=.02){
    const p=drawdownRate>=.04?.01:.005;
    totalRate=Math.max(.04,totalRate-p);longRate=Math.max(.025,longRate-p);shortRate=Math.max(.025,shortRate-p);
    netDirectionalRate=Math.max(.015,netDirectionalRate-p/2);
  }
  return{totalRate,longRate,shortRate,netDirectionalRate,drawdownRate,
    reason:`${mode}风险预算：总风险≤${(totalRate*100).toFixed(1)}%，多≤${(longRate*100).toFixed(1)}%，空≤${(shortRate*100).toFixed(1)}%，净方向≤${(netDirectionalRate*100).toFixed(1)}%。`};
}

export function sideRiskHeadroom(side:MarketSide,longRisk:number,shortRisk:number,equity:number,budget:MarketRiskBudget){
  const sideCap=equity*(side==="LONG"?budget.longRate:budget.shortRate);
  const same=side==="LONG"?longRisk:shortRisk;
  const totalCap=Math.max(0,equity*budget.totalRate-longRisk-shortRisk);
  const net=longRisk-shortRisk,netCap=equity*budget.netDirectionalRate;
  const netHeadroom=side==="LONG"?Math.max(0,netCap-net):Math.max(0,netCap+net);
  return Math.max(0,Math.min(sideCap-same,totalCap,netHeadroom));
}

export function selectDirectionalCandidates<T extends {side:MarketSide;evidence:{family:string}}>(shared:T[],baseLimit=2){
  const kept=new Set<string>(),base:T[]=[];
  for(const c of shared){if(kept.has(c.evidence.family))continue;kept.add(c.evidence.family);base.push(c);if(base.length>=baseLimit)break;}
  if(base.length&&new Set(base.map(c=>c.side)).size===1){
    const side=base[0].side,oppositeCandidate=shared.find(c=>c.side!==side&&!kept.has(c.evidence.family));
    if(oppositeCandidate){base.push(oppositeCandidate);kept.add(oppositeCandidate.evidence.family);}
  }
  return base;
}
