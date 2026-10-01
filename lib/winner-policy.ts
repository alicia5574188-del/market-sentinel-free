/** Owner-approved 2026-10-01: independent trend discovery with finite range plans.
 * Candle areas are price-reaction proxies, never observed resting liquidity.
 * Pure and bounded: no requests, account resets, clocks or exchange mutations.
 */
import type {CandleLike, MarketSymbolState, QuoteLike} from './market-intelligence-engine.ts';
export const WINNER_POLICY_VERSION='winner-preservation-v1';
export type WinnerIntent='TREND'|'RANGE';
export type ReactionArea={lower:number;upper:number;center:number;formedAt:number;balanced:boolean;basis:'OHLCV_PROXY'};
export type WinnerPlan={version:typeof WINNER_POLICY_VERSION;intent:WinnerIntent;eventAt:number;
  initialStop:number;target:number|null;targetArea:ReactionArea|null;origin:ReactionArea|null;
  riskGroup:string;source:'RELATIVE_CORE'|'EDGE_REJECTION';};
export type WinnerManagement={version:typeof WINNER_POLICY_VERSION;protectedStop:number;peakNetRate:number;
  lastBarAt:number;obstacleSince:number|null;obstacleBars:number;lastTrimEvent:number|null;trimCount:number;
  promotedAt:number|null;targetLevel?:number|null;targetEstablishedAt?:number;phase:'BUILDING'|'EXPANDING'|'OBSTACLE'|'PROTECTED'|'EXIT';reason:string;};
const clamp=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const average=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const median=(xs:number[])=>{const a=[...xs].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]!:0;};
const sign=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
export function closedFiveMinutes(rows:CandleLike[]|undefined,now:number){
  const unique=new Map<number,CandleLike>();
  for(const r of rows??[])if([r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)&&r.time>0&&r.low>0
    &&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.volume>=0&&r.time*1000+300000<=now)unique.set(r.time,r);
  return [...unique.values()].sort((a,b)=>a.time-b.time).slice(-120);
}
function center(rows:CandleLike[]){const weights=rows.map(r=>Math.max(0,r.volume)),total=weights.reduce((a,b)=>a+b,0);
  return total>0?rows.reduce((n,r,i)=>n+(r.high+r.low+r.close)/3*weights[i]!,0)/total:average(rows.map(r=>r.close));}
/** Define the reference BEFORE the most recent three bars. Full wick extremes
 * remain boundaries; a newly rejected excursion cannot expand its own range. */
export function reactionGeometry(rowsIn:CandleLike[]|undefined,now:number){
  const rows=closedFiveMinutes(rowsIn,now),base=rows.slice(-15,-3),recent=rows.slice(-3);
  if(base.length<12)return{area:null,rows,atr:0,rejection:null} as const;
  const lower=Math.min(...base.map(r=>r.low)),upper=Math.max(...base.map(r=>r.high)),width=upper-lower,
    atr=Math.max(base.at(-1)!.close*.0005,median(base.map(r=>r.high-r.low))),mid=center(base),
    traveled=base.slice(1).reduce((n,r,i)=>n+Math.abs(r.close-base[i]!.close),0),
    efficiency=Math.abs(base.at(-1)!.close-base[0]!.close)/Math.max(traveled,1e-12),
    drift=Math.abs(center(base.slice(0,6))-center(base.slice(6))),
    upperVisits=base.filter(r=>r.high>=upper-width*.20).length,
    lowerVisits=base.filter(r=>r.low<=lower+width*.20).length,
    balanced=width>=atr*2&&efficiency<=.32&&drift<=width*.22&&upperVisits>=2&&lowerVisits>=2,
    area:ReactionArea={lower,upper,center:mid,formedAt:(base.at(-1)!.time*1000)+300000,balanced,basis:'OHLCV_PROXY'};
  let rejection:{side:'LONG'|'SHORT';at:number;extreme:number}|null=null;
  if(balanced)for(let i=0;i<recent.length-1;i++){
    const r=recent[i]!,after=recent.slice(i+1),last=after.at(-1)!;
    if(r.low<lower&&r.close>lower&&last.close>r.close&&after.every(x=>x.low>=r.low)&&last.close<mid)
      rejection={side:'LONG',at:(r.time*1000)+300000,extreme:r.low};
    if(r.high>upper&&r.close<upper&&last.close<r.close&&after.every(x=>x.high<=r.high)&&last.close>mid)
      rejection={side:'SHORT',at:(r.time*1000)+300000,extreme:r.high};
  }
  return{area,rows,atr,rejection};
}
export function trendCore(input:{state:MarketSymbolState;side:'LONG'|'SHORT';price:number;cost:number;majorScore:number;shortScore:number;quote?:QuoteLike}){
  const s=input.state,d=sign(input.side),score=input.side==='LONG'?s.longScore:s.shortScore,
    pullback=Math.max(.0035,s.volatility*2*1.25),stopRate=clamp(pullback*1.18,.0055,.028),
    room=input.side==='LONG'?s.roomLong:s.roomShort,
    // Preserve the old proposal scale for ranking, label it as an estimate.
    gross=Math.max(stopRate*1.55,room+Math.abs(s.residual)*.65),net=Math.max(0,gross-input.cost),edge=net/pullback,
    execution=clamp(55+10*Math.min(4,s.sourceCount)+20*s.venueAgreement-20*Math.min(.01,input.quote?.disagreementRate??0)/.01,0,100),
    quality=score*.62+Math.min(100,edge*35)*.18+s.dataConfidence*.12+execution*.08,
    exceptional=quality>=88&&edge>=1.60&&s.residualPersistence>=.99&&Math.abs(s.residualZ)>=1.10&&s.sourceCount>=3,
    absoluteProgress=d*s.actualMove>0,
    eligible=quality>=72&&edge>=1.30&&s.dataConfidence>=65&&s.sourceCount>=2&&s.residualPersistence>=.66
      &&d*s.residualZ>=.25&&absoluteProgress&&(s.signalBars>=2||exceptional),
    mode=d*input.majorScore<-.08?'REVERSAL' as const:d*input.shortScore>.10?'CONTINUATION' as const:'RELATIVE' as const;
  return{eligible,quality,score,pullback,stopRate,gross,net,edge,execution,mode,exceptional};
}
/** New-entry geometry only. No region is required to retain trend authority.
 * A known obstacle caps the CURRENT leg estimate, never forces a holding exit. */
export function selectWinnerOpportunity(input:{state:MarketSymbolState;price:number;rows:CandleLike[]|undefined;now:number;
  majorScore:number;shortScore:number;cost?:number;quote?:QuoteLike}){
  const s=input.state,side=s.longScore>=s.shortScore?'LONG' as const:'SHORT' as const,d=sign(side),cost=input.cost??.0019,
    core=trendCore({...input,side,cost}),geometry=reactionGeometry(input.rows,input.now),a=geometry.area,
    directional=input.price>0&&d*s.actualMove>0,
    obstacle=a&&(side==='LONG'?a.upper>input.price:a.lower<input.price)?(side==='LONG'?a.upper:a.lower):null,
    obstacleDistance=obstacle==null?null:d*(obstacle/input.price-1),
    // An overlapping broad proxy alone is not a hard barrier. Require historical
    // two-sided balance, and treat an unbalanced area's edge as context only.
    hardObstacle=a?.balanced&&obstacleDistance!=null&&obstacleDistance<core.gross?obstacle:null,
    gross=hardObstacle==null?core.gross:Math.max(0,d*(hardObstacle/input.price-1)),net=Math.max(0,gross-cost),
    stop=input.price*(1-d*core.stopRate),edge=net/core.pullback,
    ownEntryValid=core.eligible&&directional&&net>cost*1.4&&edge>=1.25,
    trend:WinnerPlan={version:WINNER_POLICY_VERSION,intent:'TREND',eventAt:s.signalSince,initialStop:stop,
      target:hardObstacle,targetArea:hardObstacle==null?null:a,origin:a,riskGroup:`${s.clusterId}:${side}:TREND`,source:'RELATIVE_CORE'};
  if(ownEntryValid)return{side,plan:trend,...core,eligible:true,gross,net,edge,quality:core.quality,stopRate:core.stopRate,
    reason:'持续相对优势与标的自身推进成立；价格反应区辅助位置，不再要求突破整个大区域。'};
  const rejected=geometry.rejection;
  if(rejected&&a){
    const rd=sign(rejected.side),stopPrice=rejected.extreme-rd*geometry.atr*.25,
      stopRate=rd*(input.price-stopPrice)/input.price,targetRate=rd*(a.center/input.price-1),
      netRate=targetRate-cost,rr=netRate/Math.max(stopRate+cost,1e-9),
      score=rejected.side==='LONG'?s.longScore:s.shortScore,
      valid=input.price>a.lower&&input.price<a.upper&&rd*(input.price/a.center-1)<0&&stopRate>=.004&&stopRate<=.028
        &&netRate>=cost*2&&rr>=1.25&&s.dataConfidence>=65&&s.sourceCount>=2&&score>=55,
      plan:WinnerPlan={version:WINNER_POLICY_VERSION,intent:'RANGE',eventAt:rejected.at,initialStop:stopPrice,target:a.center,targetArea:a,
        origin:a,riskGroup:`${s.clusterId}:${rejected.side}:RANGE`,source:'EDGE_REJECTION'};
    return{side:rejected.side,plan,eligible:valid,score,pullback:stopRate,stopRate,gross:Math.max(0,targetRate),net:Math.max(0,netRate),
      edge:rr,execution:core.execution,quality:clamp(score*.6+30+Math.min(10,rr*3),0,100),mode:'RELATIVE' as const,exceptional:false,
      reason:valid?'稳定量价重心外的离开尝试失败，后续价格确认回归；只计算回到重心的有限空间。':'边缘回归尚无足够的成本后空间或有效失败边界，继续寻找其他机会。'};
  }
  return{side,plan:trend,...core,eligible:false,gross,net,edge,
    reason:core.eligible?'持续优势仍在，但当前一段空间不足，等待回调后的有效位置。':'独立优势或标的自身推进尚未完整，继续观察，不因区域标签制造交易。'};
}
export function advanceWinnerManagement(input:{side:'LONG'|'SHORT';price:number;entryPrice:number;openedAt:number;now:number;
  plan:WinnerPlan;previous?:WinnerManagement;currentStop?:number;rows:CandleLike[]|undefined;cost:number;remainingFraction:number;
  concernFamilies:string[];supportFamilies:string[];positionExit:boolean;trendEligible:boolean}){
  const d=sign(input.side),p=input.plan,cost=input.cost,signed=d*(input.price/input.entryPrice-1),
    originalRisk=Math.abs(p.initialStop/input.entryPrice-1),rows=closedFiveMinutes(input.rows,input.now),
    barAt=rows.length?(rows.at(-1)!.time*1000)+300000:0,
    prev=input.previous,peak=Math.max(prev?.peakNetRate??0,signed-cost),
    m:WinnerManagement=prev?{...prev}:{version:WINNER_POLICY_VERSION,protectedStop:p.initialStop,peakNetRate:0,lastBarAt:0,
      obstacleSince:null,obstacleBars:0,lastTrimEvent:null,trimCount:0,promotedAt:null,targetLevel:p.target,targetEstablishedAt:input.openedAt,phase:'BUILDING',reason:''};
  m.peakNetRate=peak;
  // A newer compact stop checkpoint must never be loosened on restoration.
  if(input.currentStop!=null&&Number.isFinite(input.currentStop)&&input.currentStop>0&&d*(input.currentStop-m.protectedStop)>0)
    m.protectedStop=input.currentStop;
  const effectiveTrend=p.intent==='TREND'||m.promotedAt!=null;
  if(d*(input.price-m.protectedStop)<=0){m.phase='EXIT';m.reason='价格触及此前已经建立的有效保护位置';
    return{state:m,action:'EXIT' as const,fraction:0,reason:'WINNER_STRUCTURE_EXIT'};}
  if(p.intent==='RANGE'&&!effectiveTrend&&p.target!=null&&d*(input.price-p.target)>=0){
    if(input.trendEligible){m.promotedAt=input.now;m.targetLevel=null;m.phase='EXPANDING';m.reason='回归到达重心后自身持续推进，原仓位升级为趋势；风险不放大';}
    else{m.phase='EXIT';m.reason='有限回归目标已经到达，未出现新的持续推进';return{state:m,action:'EXIT' as const,fraction:0,reason:'RANGE_CENTER_EXIT'};}
  }
  if(input.positionExit){m.phase='EXIT';m.reason='持仓原始依据与新的持续反证确认失效';
    return{state:m,action:'EXIT' as const,fraction:0,reason:'WINNER_THESIS_EXIT'};}
  // A later balanced reaction area may become the next obstacle; it never
  // rewrites the immutable entry geometry. Clear an accepted former obstacle.
  if(barAt>m.lastBarAt&&(effectiveTrend||m.promotedAt!=null)){
    const geometry=reactionGeometry(input.rows,input.now),area=geometry.area;
    if(m.targetLevel!=null&&rows.slice(-2).length===2&&rows.slice(-2).every(r=>d*(r.close-m.targetLevel!)>input.price*cost)){
      m.targetLevel=null;m.obstacleSince=null;m.obstacleBars=0;
    }
    if(m.targetLevel==null&&area?.balanced&&area.formedAt>Math.max(input.openedAt,m.targetEstablishedAt??0)){
      const level=input.side==='LONG'?area.upper:area.lower;
      if(d*(level-input.price)>0){m.targetLevel=level;m.targetEstablishedAt=area.formedAt;}
    }
  }
  const meaningful=peak>=Math.max(cost*4,originalRisk*1.10),last=rows.at(-1),prior=rows.at(-2),
    nearTarget=m.targetLevel!=null&&d*(m.targetLevel-input.price)/input.price<=Math.max(cost,originalRisk*.35),
    stalled=!!last&&!!prior&&(d*(last.close/prior.close-1)<=0)&&
      (input.side==='LONG'?last.high<=prior.high*(1+cost*.15):last.low>=prior.low*(1-cost*.15)),
    weakening=stalled&&(input.concernFamilies.includes('PATH')||input.concernFamilies.includes('RELATIVE')||input.concernFamilies.includes('STRUCTURE')),
    obstacle=meaningful&&nearTarget&&weakening;
  if(barAt>m.lastBarAt&&barAt<=input.now){
    if(obstacle){if(m.obstacleSince==null){m.obstacleSince=input.now;m.obstacleBars=0;}
      else if(barAt>m.obstacleSince&&last!.time*1000>=input.openedAt)m.obstacleBars++;}
    else if(input.trendEligible&&!stalled){m.obstacleSince=null;m.obstacleBars=0;}
    m.lastBarAt=barAt;
    // Only confirmed post-entry swing points may tighten a structure stop.
    if(meaningful)for(let i=1;i<rows.length-1;i++){
      const r=rows[i]!,before=rows[i-1]!,after=rows[i+1]!;
      if(r.time*1000<input.openedAt)continue;
      const pivot=input.side==='LONG'?r.low<=before.low&&r.low<=after.low&&after.close>r.close:
        r.high>=before.high&&r.high>=after.high&&after.close<r.close;
      if(!pivot)continue;
      const atr=median(rows.slice(Math.max(0,i-6),i+2).map(x=>x.high-x.low)),
        level=(input.side==='LONG'?r.low:r.high)-d*Math.max(atr*.40,input.entryPrice*cost*.40),
        levelRate=d*(level/input.entryPrice-1);
      if(levelRate>cost&&d*(level-m.protectedStop)>0&&d*(input.price-level)>input.price*cost*.5)m.protectedStop=level;
    }
  }
  // Wide, discrete earned profit plateaus. Not a per-tick peak-percentage trail.
  const earned=[2,3,5,8,13,21].filter(r=>peak>=r*originalRisk).at(-1);
  if(earned!=null){const floor=cost+Math.max(0,earned-2)*originalRisk,level=input.entryPrice*(1+d*floor);
    if(d*(level-m.protectedStop)>0&&d*(input.price-level)>input.price*cost*.5)m.protectedStop=level;}
  const structuralGiveback=Math.max(cost,d*(input.price-m.protectedStop)/input.entryPrice),
    permittedGiveback=peak*.35,keep=clamp(permittedGiveback/structuralGiveback,0,1),
    minKeep=Math.min(1,.35/Math.max(input.remainingFraction,1e-9)),fraction=1-Math.max(minKeep,keep);
  if(obstacle&&m.obstacleBars>=1&&m.obstacleSince!==m.lastTrimEvent&&m.trimCount<2&&signed>cost*3&&fraction>=.15){
    m.phase='OBSTACLE';m.reason='目标附近新完成K线仍显示受阻：兑现部分利润，保留有效结构与趋势仓';
    // Mutation occurs only AFTER a real PAPER reduction passes lot/accounting checks.
    return{state:m,action:'REDUCE' as const,fraction:Math.min(.65,fraction),reason:'WINNER_OBSTACLE_REDUCTION'};
  }
  m.phase=obstacle?'OBSTACLE':d*(m.protectedStop/input.entryPrice-1)>cost?'PROTECTED':meaningful?'EXPANDING':'BUILDING';
  m.reason=obstacle?'目标附近推进受阻，等待新的有效价格确认':'保留趋势持仓；已有成本优势不由重新入场评分否决';
  return{state:m,action:'HOLD' as const,fraction:0,reason:m.reason};
}
