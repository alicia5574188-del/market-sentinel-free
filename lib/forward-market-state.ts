/** Portfolio market-state layer.
 * It does not create signals or reverse positions. It only classifies broad
 * completed-5m behaviour, keeps directional candidates available, and supplies
 * portfolio risk budgets so trend, transition and range regimes are handled
 * differently without replacing Forward's learned rules.
 */
export const MARKET_STATE_VERSION = "portfolio-market-state-v1";
export const TURN_FORECAST_VERSION = "turn-ahead-v1";
export type MarketMode = "UNKNOWN"|"TREND_LONG"|"TREND_SHORT"|"TRANSITION"|"NEUTRAL";
export type MarketSide = "LONG"|"SHORT";
export type MarketState = {
  version:typeof MARKET_STATE_VERSION;
  mode:MarketMode;
  rawMode:MarketMode;
  observedAt:number;
  completedBarAt?:number;
  since:number;
  markets:number;
  confirmations:number;
  candidateMode:MarketMode|null;
  candidateBars:number;
  candidateRequiredBars?:number;
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
export type TurnPhase = "UNKNOWN"|"CLEAR"|"PULLBACK"|"REVERSAL_RISK";
export type TurnForecast = {
  version:typeof TURN_FORECAST_VERSION;
  phase:TurnPhase;
  rawPhase:TurnPhase;
  threatenedSide:MarketSide|null;
  rawThreatenedSide:MarketSide|null;
  observedAt:number;
  completedBarAt?:number;
  lastFreshPhase?:Exclude<TurnPhase,"UNKNOWN">;
  reversalConfirmed?:boolean;
  since:number;
  markets:number;
  fresh:boolean;
  confirmations:number;
  candidateSide:MarketSide|null;
  candidateBars:number;
  clearBars:number;
  pressure:number;
  breadth15:number;
  breadth30:number;
  breadth60:number;
  median15:number;
  median30:number;
  median60:number;
  median15Acceleration:number;
  medianFiveMinuteMove:number;
  reason:string;
};
export type MarketRiskBudget = {
  totalRate:number;
  longRate:number;
  shortRate:number;
  netDirectionalRate:number;
  drawdownRate:number;
  allocationScale:number;
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
const clamp01=(v:number)=>Math.min(1,Math.max(0,v));
const FIVE_MINUTES=300_000;

// One common, completed time window. Never sort, interpolate or silently bridge
// malformed candles: thirteen ten-minute closes are not a sixty-minute path.
function marketRows(paths:Record<string,CandleLike[]>,now:number){
  const completedBarAt=Math.floor(now/FIVE_MINUTES)*FIVE_MINUTES;
  const rows=Object.values(paths).flatMap(source=>{
    const a=source.filter(r=>r.time*1000+FIVE_MINUTES<=now).slice(-13);
    if(a.length!==13||now-completedBarAt>180_000)return[];
    if(a.some((r,i)=>!finite(r.time)||!finite(r.close)||r.close<=0||r.time%300!==0
      ||(i>0&&r.time-a[i-1].time!==300)))return[];
    if(a.at(-1)!.time*1000+FIVE_MINUTES!==completedBarAt)return[];
    const closes=a.map(r=>r.close),steps=closes.slice(1).map((v,i)=>v/closes[i]-1),last=closes.at(-1)!;
    const r15=last/closes[9]-1,r30=last/closes[6]-1,r60=last/closes[0]-1;
    const prior15=closes[9]/closes[6]-1;
    const path=steps.slice(-6),travel=path.reduce((n,v)=>n+Math.abs(v),0);
    const dirs=path.map(sign).filter(Boolean),flips=dirs.slice(1).reduce<number>((n,v,i)=>n+Number(v!==dirs[i]),0);
    return[{r15,r30,r60,accel15:r15-prior15,efficiency:travel>0?Math.abs(r30)/travel:0,
      flipRate:dirs.length>1?flips/(dirs.length-1):0,base:median(steps.map(Math.abs))}];
  });
  return{rows,completedBarAt};
}

function rawState(paths:Record<string,CandleLike[]>,now:number){
  const {rows,completedBarAt}=marketRows(paths,now);
  if(rows.length<8)return{mode:"UNKNOWN" as MarketMode,rows,completedBarAt,base:.0005,b15:0,b30:0,b60:0,m15:0,m30:0,m60:0,eff:0,flip:0};
  const r15=rows.map(r=>r.r15),r30=rows.map(r=>r.r30),r60=rows.map(r=>r.r60);
  const base=Math.max(.0005,median(rows.map(r=>r.base)));
  const b15=share(r15,v=>v>0),b30=share(r30,v=>v>0),b60=share(r60,v=>v>0);
  const m15=median(r15),m30=median(r30),m60=median(r60),eff=median(rows.map(r=>r.efficiency)),flip=median(rows.map(r=>r.flipRate));
  const longTrend=b30>=.64&&b60>=.60&&m30>=base*1.8&&m60>=base*2.4&&eff>=.40&&flip<=.60;
  const shortTrend=b30<=.36&&b60<=.40&&m30<=-base*1.8&&m60<=-base*2.4&&eff>=.40&&flip<=.60;
  // Synchronized oscillation can have one-sided tiny compounded returns even
  // though its travel is almost entirely back-and-forth; breadth alone is not trend.
  const neutral=(eff<=.34||flip>=.62)&&Math.abs(m30)<=base*2.2;
  const mode:MarketMode=longTrend?"TREND_LONG":shortTrend?"TREND_SHORT":neutral?"NEUTRAL":"TRANSITION";
  return{mode,rows,completedBarAt,base,b15,b30,b60,m15,m30,m60,eff,flip};
}


function rawTurnForecast(paths:Record<string,CandleLike[]>,now:number){
  const state=rawState(paths,now),{rows,base,b15,b30,b60,m15,m30,m60}=state;
  if(rows.length<8)return{...state,fresh:false,phase:"UNKNOWN" as TurnPhase,side:null as MarketSide|null,pressure:0,accel:0};
  const accel=median(rows.map(r=>r.accel15));
  const longContext=b60>=.60&&m60>=base*1.5;
  const shortContext=b60<=.40&&m60<=-base*1.5;
  const down15=b15<=.42&&m15<=-base*.20;
  const up15=b15>=.58&&m15>=base*.20;
  const down30=b30<=.52||m30<=0;
  const up30=b30>=.48||m30>=0;
  let phase:TurnPhase="CLEAR",side:MarketSide|null=null,pressure=0;
  if(longContext&&down15){
    side="LONG";
    const breadthPressure=clamp01((.50-b15)/.30),movePressure=clamp01(-m15/(base*1.5));
    const accelPressure=clamp01(-accel/(base*1.5)),midPressure=clamp01((.58-b30)/.30);
    pressure=.35*breadthPressure+.30*movePressure+.20*accelPressure+.15*midPressure;
    phase=(b15<=.35&&m15<=-base*.45&&down30)?"REVERSAL_RISK":"PULLBACK";
  }else if(shortContext&&up15){
    side="SHORT";
    const breadthPressure=clamp01((b15-.50)/.30),movePressure=clamp01(m15/(base*1.5));
    const accelPressure=clamp01(accel/(base*1.5)),midPressure=clamp01((b30-.42)/.30);
    pressure=.35*breadthPressure+.30*movePressure+.20*accelPressure+.15*midPressure;
    phase=(b15>=.65&&m15>=base*.45&&up30)?"REVERSAL_RISK":"PULLBACK";
  }
  return{...state,fresh:true,phase,side,pressure,accel};
}

export function updateTurnForecast(paths:Record<string,CandleLike[]>,previous:TurnForecast|null|undefined,now:number):TurnForecast {
  const r=rawTurnForecast(paths,now),prev=previous?.version===TURN_FORECAST_VERSION?previous:null;
  const priorPhase=prev?.phase==="UNKNOWN"?(prev.lastFreshPhase??"CLEAR"):(prev?.phase??"CLEAR");
  const priorBar=prev?.completedBarAt??(prev?Math.floor(prev.observedAt/FIVE_MINUTES)*FIVE_MINUTES:0);
  const consecutive=!!prev?.fresh&&r.completedBarAt===priorBar+FIVE_MINUTES;
  const clear=(reason:string):TurnForecast=>({version:TURN_FORECAST_VERSION,phase:"CLEAR",rawPhase:r.phase,threatenedSide:null,
    rawThreatenedSide:r.side,observedAt:now,completedBarAt:r.completedBarAt,since:now,markets:r.rows.length,fresh:r.fresh,confirmations:0,
    lastFreshPhase:"CLEAR",reversalConfirmed:false,
    candidateSide:null,candidateBars:0,clearBars:0,pressure:r.pressure,breadth15:r.b15,breadth30:r.b30,breadth60:r.b60,
    median15:r.m15,median30:r.m30,median60:r.m60,median15Acceleration:r.accel,medianFiveMinuteMove:r.base,reason});
  if(!r.fresh)return{...(prev??clear("")),phase:"UNKNOWN",rawPhase:"UNKNOWN",rawThreatenedSide:null,
    observedAt:now,markets:r.rows.length,fresh:false,lastFreshPhase:priorPhase,
    clearBars:0,candidateSide:null,candidateBars:0,
    reason:`转折预警数据未知（${r.rows.length}个同步完整市场）；保留已有受威胁方向的新增风险限制，不据缺失数据削减持仓、确认恢复或反向。`};
  if(prev?.fresh&&r.completedBarAt===priorBar)return{...prev,observedAt:now};
  const hold=(phase:Exclude<TurnPhase,"UNKNOWN">,reason:string):TurnForecast=>({...clear(reason),phase,lastFreshPhase:phase,
    threatenedSide:prev!.threatenedSide,since:prev!.since,confirmations:prev!.confirmations,
    reversalConfirmed:prev!.reversalConfirmed??false});
  if(r.phase==="CLEAR"||!r.side){
    if(prev?.threatenedSide&&priorPhase!=="CLEAR"){
      const long=prev.threatenedSide==="LONG";
      const adverse=long?r.b15<=.42&&r.m15<=-r.base*.20:r.b15>=.58&&r.m15>=r.base*.20;
      const reversed=r.mode===(long?"TREND_SHORT":"TREND_LONG");
      if(adverse&&r.mode!=="NEUTRAL")return{...hold(reversed||priorPhase==="REVERSAL_RISK"?"REVERSAL_RISK":"PULLBACK",
        reversed?"较长周期也已转为反向趋势：这是反转确认而非原方向恢复；继续限制受威胁方向加仓，独立反方向机会仍由原规则决定。"
          :"原趋势背景虽已消退，短周期仍在逆向运行；尚非恢复，不重新增加受威胁方向风险。"),
        reversalConfirmed:reversed||!!prev.reversalConfirmed,confirmations:consecutive?Math.min(99,prev.confirmations+1):1};
      const recovered=long?r.b15>=.58&&r.m15>=r.base*.20&&r.b30>=.48&&r.m30>=0
        :r.b15<=.42&&r.m15<=-r.base*.20&&r.b30<=.52&&r.m30<=0;
      if(!recovered&&r.mode!=="NEUTRAL")return hold(priorPhase,"逆向压力暂时缓和，但原方向恢复或震荡中性尚未确认；不把背景消失当成预警解除。");
      const bars=consecutive?(prev.clearBars??0)+1:1;
      if(bars<2)return{...hold(priorPhase,"已观察到恢复或震荡中性，需连续2根不同的完成5分钟K线确认，避免一根反弹后立刻追回原方向。"),clearBars:bars};
      return clear(r.mode==="NEUTRAL"?"连续2根完成K线确认震荡中性，解除单方向预警；双向独立规则保留，继续使用中性风险预算。"
        :"连续2根完成K线确认原方向恢复，解除本层预警；不强制开仓或反手。");
    }
    return clear("短中长周期未形成明确反向背离；不额外干预现有规则。");
  }
  if(prev?.threatenedSide&&priorPhase!=="CLEAR"&&prev.threatenedSide!==r.side){
    const bars=consecutive&&prev.candidateSide===r.side?prev.candidateBars+1:1;
    if(bars<2)return{...hold(priorPhase,"预警方向正在切换，保留原限制直至第二根完成K线确认；不在一次回调中来回解除或反手。"),
      candidateSide:r.side,candidateBars:bars};
  }
  const same=prev?.threatenedSide===r.side&&priorPhase!=="CLEAR";
  const confirmations=same&&consecutive?Math.min(99,(prev?.confirmations??0)+1):1;
  const phase=r.phase==="REVERSAL_RISK"&&confirmations>=2?"REVERSAL_RISK" as const:"PULLBACK" as const;
  const since=same?prev!.since:now;
  const sideName=r.side==="LONG"?"多":"空",shortName=r.side==="LONG"?"下":"上";
  const label=phase==="REVERSAL_RISK"?"反转风险升高":"趋势中途回调预警";
  return{version:TURN_FORECAST_VERSION,phase,rawPhase:r.phase,threatenedSide:r.side,rawThreatenedSide:r.side,
    observedAt:now,completedBarAt:r.completedBarAt,lastFreshPhase:phase,reversalConfirmed:false,
    since,markets:r.rows.length,fresh:true,confirmations,candidateSide:null,candidateBars:0,clearBars:0,
    pressure:r.pressure,breadth15:r.b15,breadth30:r.b30,breadth60:r.b60,median15:r.m15,median30:r.m30,median60:r.m60,
    median15Acceleration:r.accel,medianFiveMinuteMove:r.base,
    reason:`${label}：60分钟背景仍偏${r.side==="LONG"?"多":"空"}，但15分钟已有广泛向${shortName}背离（15分钟上涨广度${Math.round(r.b15*100)}%，中位变化${(r.m15*100).toFixed(2)}%）。先压低${sideName}向新增风险，不把预警直接当成反手信号。`};
}

export function turnForecastEntryGuard(forecast:TurnForecast|null|undefined,side:MarketSide,horizon:number,state:MarketState|null|undefined){
  if(!forecast||forecast.phase==="CLEAR"||!forecast.threatenedSide)return null;
  if(side===forecast.threatenedSide)
    return forecast.fresh?"转折预警生效：短周期广度已逆着当前主方向，暂不增加受威胁方向风险；等待预警解除或市场重新确认。"
      :"转折预警数据未知：此前受威胁方向尚未确认恢复，暂不增加该方向风险；不因缺数据关闭持仓或强制反手。";
  const confirmed=state?.rawMode!=="UNKNOWN"&&state?.mode===(side==="LONG"?"TREND_LONG":"TREND_SHORT");
  if(horizon>60&&!confirmed)
    return "转折预警阶段的反向180分钟规则等待大周期确认；仅允许15/60分钟独立反向机会，避免回调末端追空/追多。";
  return null;
}

export function updateMarketState(paths:Record<string,CandleLike[]>,previous:MarketState|null|undefined,now:number):MarketState {
  const r=rawState(paths,now),raw=r.mode;
  if(raw==="UNKNOWN"){
    return previous?{...previous,rawMode:"UNKNOWN",observedAt:now,markets:r.rows.length,
      candidateMode:null,candidateBars:0,candidateRequiredBars:undefined,
      reason:`市场状态样本不足（${r.rows.length}个新鲜市场），保留上一状态但不据此创造方向信号。`}
      :{version:MARKET_STATE_VERSION,mode:"UNKNOWN",rawMode:"UNKNOWN",observedAt:now,since:now,markets:r.rows.length,
        confirmations:0,candidateMode:null,candidateBars:0,breadth15:0,breadth30:0,breadth60:0,median15:0,median30:0,median60:0,
        medianFiveMinuteMove:r.base,pathEfficiency30:0,flipRate30:0,reason:"市场状态样本不足；沿用原始风险边界。"};
  }
  const prev=previous?.version===MARKET_STATE_VERSION?previous:null;
  const priorBar=prev?.completedBarAt??(prev?Math.floor(prev.observedAt/FIVE_MINUTES)*FIVE_MINUTES:0);
  if(prev&&prev.rawMode!=="UNKNOWN"&&r.completedBarAt===priorBar)return{...prev,observedAt:now};
  const consecutive=!!prev&&prev.rawMode!=="UNKNOWN"&&r.completedBarAt===priorBar+FIVE_MINUTES;
  let mode=prev?.mode??"UNKNOWN",candidateMode:MarketMode|null=null,candidateBars=0,candidateRequiredBars:number|undefined,
    confirmations=prev?.confirmations??0,since=prev?.since??now;
  if(prev&&raw===prev.mode){mode=prev.mode;confirmations=Math.min(99,confirmations+1);}
  else{
    candidateMode=prev?.candidateMode===raw?raw:raw;
    candidateBars=consecutive&&prev?.candidateMode===raw?(prev.candidateBars+1):1;
    const threshold=consecutive&&prev?.candidateMode===raw&&prev.candidateRequiredBars?prev.candidateRequiredBars
      :prev&&opposite(prev.mode,raw)?3:2;
    candidateRequiredBars=threshold;
    if(candidateBars>=threshold){mode=raw;since=now;confirmations=candidateBars;candidateMode=null;candidateBars=0;candidateRequiredBars=undefined;}
    else if(prev&&opposite(prev.mode,raw)){mode="TRANSITION";since=prev.mode==="TRANSITION"?prev.since:now;confirmations=1;}
  }
  const name={UNKNOWN:"未知",TREND_LONG:"趋势多",TREND_SHORT:"趋势空",TRANSITION:"转折过渡",NEUTRAL:"震荡中性"}[mode];
  return{version:MARKET_STATE_VERSION,mode,rawMode:raw,observedAt:now,completedBarAt:r.completedBarAt,since,markets:r.rows.length,confirmations,candidateMode,candidateBars,candidateRequiredBars,
    breadth15:r.b15,breadth30:r.b30,breadth60:r.b60,median15:r.m15,median30:r.m30,median60:r.m60,
    medianFiveMinuteMove:r.base,pathEfficiency30:r.eff,flipRate30:r.flip,
    reason:`${name}：30分钟上涨广度${Math.round(r.b30*100)}%，60分钟上涨广度${Math.round(r.b60*100)}%，30分钟路径效率${r.eff.toFixed(2)}，翻转率${r.flip.toFixed(2)}；状态只调风险，不强制开多或开空。`};
}

export function marketRiskBudget(state:MarketState|null|undefined,equity:number,peakEquity:number,forecast?:TurnForecast|null):MarketRiskBudget {
  const mode=state?.mode??"UNKNOWN";
  let totalRate=.10,longRate=.065,shortRate=.065,netDirectionalRate=.10;
  if(mode==="TREND_LONG"){totalRate=.075;longRate=.065;shortRate=.015;netDirectionalRate=.065;}
  else if(mode==="TREND_SHORT"){totalRate=.075;longRate=.015;shortRate=.065;netDirectionalRate=.065;}
  else if(mode==="TRANSITION"){totalRate=.06;longRate=.045;shortRate=.045;netDirectionalRate=.03;}
  else if(mode==="NEUTRAL"){totalRate=.05;longRate=.03;shortRate=.03;netDirectionalRate=.02;}
  const drawdownRate=equity>0&&peakEquity>0?Math.max(0,1-equity/peakEquity):0;
  // Drawdown changes NEW allocation size instead of silently becoming a trading
  // pause. Existing portfolio caps remain state-driven so a losing period does
  // not recursively squeeze every candidate to zero.
  const allocationScale=drawdownRate>=.08?.55:drawdownRate>=.04?.70:drawdownRate>=.02?.85:1;

  // Entry budgets retain the last known warning through missing observations.
  // Existing-position reducers pass only a fresh forecast, so UNKNOWN is never
  // new authority to liquidate a holding.
  const effectivePhase=forecast?.phase==="UNKNOWN"?forecast.lastFreshPhase:forecast?.phase;
  const activeForecast=!!forecast?.threatenedSide&&(effectivePhase==="PULLBACK"||effectivePhase==="REVERSAL_RISK");
  if(activeForecast&&forecast){
    const threatenedLong=forecast.threatenedSide==="LONG";
    if(effectivePhase==="REVERSAL_RISK"){
      totalRate=Math.min(totalRate,.05);netDirectionalRate=Math.min(netDirectionalRate,.015);
      if(threatenedLong){longRate=Math.min(longRate,.02);shortRate=Math.max(shortRate,.03);}
      else{shortRate=Math.min(shortRate,.02);longRate=Math.max(longRate,.03);}
    }else{
      // Pullback is intentionally continuous: mild pressure does not collapse
      // the portfolio into the same tiny budget as a confirmed reversal risk.
      const p=Math.max(.20,Math.min(1,forecast.pressure));
      totalRate=Math.min(totalRate,.075-.015*p);
      netDirectionalRate=Math.min(netDirectionalRate,.045-.015*p);
      const threatenedCap=.05-.02*p,oppositeFloor=.02+.01*p;
      if(threatenedLong){longRate=Math.min(longRate,threatenedCap);shortRate=Math.max(shortRate,oppositeFloor);}
      else{shortRate=Math.min(shortRate,threatenedCap);longRate=Math.max(longRate,oppositeFloor);}
    }
  }
  const forecastNote=activeForecast?`；${forecast?.fresh?"转折预警":"数据未知，保留上次预警"}${effectivePhase==="REVERSAL_RISK"?"升级":"生效"}，受威胁方向${forecast?.threatenedSide==="LONG"?"多":"空"}`:"";
  return{totalRate,longRate,shortRate,netDirectionalRate,drawdownRate,allocationScale,
    reason:`${mode}风险预算：总风险≤${(totalRate*100).toFixed(1)}%，多≤${(longRate*100).toFixed(1)}%，空≤${(shortRate*100).toFixed(1)}%，净方向≤${(netDirectionalRate*100).toFixed(1)}%；新开仓分配系数${(allocationScale*100).toFixed(0)}%${forecastNote}。`};
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
