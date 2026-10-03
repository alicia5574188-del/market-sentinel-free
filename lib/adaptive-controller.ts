/** Causal execution decisions from the same research contract. No money,
 * orders, requests, timers, synthetic liquidity or opposite-side shortcut. */
import {marketRouteDecision,MARKET_AUTHORITY_VERSION,type MarketAuthority,type MarketRoute} from './market-authority.ts';
import {researchHolding,type ResearchEpisode,type HoldingResearch} from './episode-research.ts';
import type {CandleLike} from './market-intelligence-engine.ts';
import type {Trade,Quote} from './forward-relations.ts';
export const ADAPTIVE_CONTROLLER_VERSION='adaptive-causal-v1';
export type AdaptiveHolding={version:typeof ADAPTIVE_CONTROLLER_VERSION;adoptedAt:number;holdingSupport:number;
  holdingSupportAt:number;peakNetPnl:number|null;premise:HoldingResearch['premise'];sourceAt:number;signal:HoldingResearch['signal'];reason:string};
const dir=(s:'LONG'|'SHORT')=>s==='LONG'?1:-1;
function completed(rows:CandleLike[]|undefined,now:number,step:number){
  const unique=new Map<number,CandleLike>();
  for(const r of rows??[])if([r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)&&r.low>0&&r.volume>=0
    &&r.low<=Math.min(r.open,r.close)&&r.high>=Math.max(r.open,r.close)&&r.time*1000+step<=now)unique.set(r.time,r);
  const out=[...unique.values()].sort((a,b)=>a.time-b.time).slice(-4);
  return out.every((r,i)=>!i||(r.time-out[i-1]!.time)*1000===step)?out:[];
}
export function adaptiveMarketRoute(a:MarketAuthority,r:ResearchEpisode|undefined,symbol:string,price:number,now:number,
  minutes?:CandleLike[],paths?:CandleLike[]):{route:MarketRoute|null;code:string;reason:string}{
  const block=(code:string,reason:string)=>({route:null,code,reason}),p=a.coins[symbol];
  if(!a.fresh||!p||!r?.fresh||r.sourceAt>now||now-r.sourceAt>600000)
    return block('ADAPTIVE_COVERAGE','等待本币完整新鲜研究证据');
  const base=marketRouteDecision(a,symbol,price,now);
  if(base.route?.branch==='CONTINUATION'){
    if(r.side!==base.route.side||!['ADVANCING','PULLBACK'].includes(r.phase))
      return block('ADAPTIVE_CONTINUATION_UNPROVEN','本段持续承接或恢复结果尚未确认');
    const route:MarketRoute={...base.route,stop:r.holdingSupport,controllerVersion:ADAPTIVE_CONTROLLER_VERSION,
      reason:`持续推进与持仓承接成立；${base.route.reason}`};
    const risk=dir(route.side)*(price-route.stop),room=dir(route.side)*(route.target-price),cost=price*.0019;
    if(!(risk>0)||risk/price>.035||(room-cost)/(risk+cost)<1.35)
      return block('ADAPTIVE_HOLDING_LOCATION','距离稳定承接过远或扣费空间不足，等待有效回踩');
    return{route,code:'ADAPTIVE_CONTINUATION',reason:route.reason};
  }
  const h=r.hypotheses.return;
  if(!h.side||h.stage==='UNCONFIRMED'||!h.target||!r.reference.balanced)
    return base.route?block('ADAPTIVE_RETURN_UNPROVEN','等待真实离开失败及稳定回归目标'):base;
  const d=dir(h.side),common=a.phase==='UP'?'LONG':a.phase==='DOWN'?'SHORT':null;
  if(common&&common!==h.side&&p.relation!=='INDEPENDENT')
    return block('ADAPTIVE_SUSTAINED_TREND','持续共同趋势尚被接受，本币未证明独立反向，不逆势回归');
  if(p.side&&p.side!==h.side&&(p.phase==='UP'||p.phase==='DOWN')&&!p.failed
    &&r.phase!=='RECOVERY_FAILED')return block('ADAPTIVE_OWN_TREND','本币推进尚未失败，不能凭伸展反向');
  const fast=completed(minutes,now,60000),slow=completed(paths,now,300000),
    rs=fast.length>=3&&now-(fast.at(-1)!.time*1000+60000)<=120000?fast:slow,
    last=rs.at(-1),prior=rs.at(-2),epsilon=Math.max(price*.0001,p.atr*(rs===fast?.05:.10));
  if(!last||!prior||now-(last.time*1000+(rs===fast?60000:300000))>600000
    ||d*(last.close-prior.close)<=epsilon||d*(price-prior.close)<-epsilon)
    return block('ADAPTIVE_RETURN_RESPONSE','失败已观察到，等待实际回归方向继续响应');
  const stop=h.stage==='FAILED_DEPARTURE'?p.extreme:r.frontier+d*-epsilon,
    proofAt=h.stage==='FAILED_DEPARTURE'?h.basisAt:r.failedPriceAt??0,
    proofPrice=h.stage==='FAILED_DEPARTURE'?p.rejectedPrice:r.failedPrice??0,
    risk=d*(price-stop),room=d*(h.target-price),cost=price*.0019;
  if(proofAt<=0||proofAt>now||now-proofAt>600000||!(proofPrice>0)||!(stop>0)||risk<=0||risk/price>.035
    ||room-cost<cost*2||(room-cost)/(risk+cost)<1.35)return block('ADAPTIVE_RETURN_LOCATION','真实回归目标的剩余空间或失败极值风险不合格');
  const route:MarketRoute={version:MARKET_AUTHORITY_VERSION,controllerVersion:ADAPTIVE_CONTROLLER_VERSION,
    epoch:a.epoch,phase:'RANGE',relation:p.relation==='INDEPENDENT'?'INDEPENDENT':'LOCAL',branch:'RETURN',
    side:h.side,proofAt,proofPrice,stop,target:h.target,targetBasis:'ACCEPTED_CENTER',reference:{...p.reference,...structuredClone(r.reference)},
    reason:`${h.stage==='FAILED_TREND'?'旧推进承接破坏且恢复失败':'真实离开失败'}，回归方向继续响应；目标为已接受重心`};
  return{route,code:'ADAPTIVE_RETURN',reason:route.reason};
}
export function adaptiveHoldingDecision(t:Trade,q:Quote,now:number,paths:CandleLike[],minutes:CandleLike[]|undefined,
  authority:MarketAuthority,previous?:HoldingResearch){
  const memory=t.unified?.adaptive,seed=previous??researchHolding(t,undefined,{paths,minutes,quote:q,now}),
    old=memory?{...seed,holdingSupport:memory.holdingSupport,holdingSupportAt:memory.holdingSupportAt,
      peakNetPnl:memory.peakNetPnl,premise:memory.premise}:previous,
    observed=researchHolding(t,old,{paths,minutes,quote:q,now}),d=dir(t.side),px=t.side==='LONG'?q.bestBid:q.bestAsk,
    coin=authority.coins[t.symbol],route=t.unified!.marketRoute!,oppositeProof=authority.fresh&&coin?.dataReady
      &&coin.proofAt>t.openedAt&&coin.proofAt<=now&&coin.lastAt<=now&&now-coin.lastAt<=600000
      &&coin.side!==t.side&&((coin.phase==='UP'&&coin.side==='LONG')||(coin.phase==='DOWN'&&coin.side==='SHORT'))&&!coin.failed;
  const next:AdaptiveHolding={version:ADAPTIVE_CONTROLLER_VERSION,adoptedAt:memory?.adoptedAt??now,
    holdingSupport:observed.holdingSupport,holdingSupportAt:observed.holdingSupportAt,peakNetPnl:observed.peakNetPnl,
    premise:observed.premise,sourceAt:observed.sourceAt,signal:observed.signal,reason:observed.reason};
  if(!q.fresh||q.observedAt>now||now-q.observedAt>10000||!Number.isFinite(q.bestBid)||!Number.isFinite(q.bestAsk)
    ||q.bestBid<=0||q.bestAsk<q.bestBid)
    return{memory:next,observed,stop:t.stopPrice,exit:null,reason:'等待本币新鲜执行报价，保留原保护'};
  let stop=t.stopPrice,exit:string|null=null,reason=observed.reason;
  if(d*(px-stop)<=0){exit='ADAPTIVE_HARD_PROTECTION';reason='实际价格触及既定保护，按真实成交退出';}
  else if(route.branch==='RETURN'&&d*(px-route.target)>=0){exit='ADAPTIVE_RETURN_COMPLETE';reason='实际价格到达已接受回归重心，兑现本次回归';}
  else if(observed.fresh&&oppositeProof){exit='ADAPTIVE_OWN_OPPOSITE_CONFIRMED';reason='本币确认了新的反向持续承接，旧持仓依据结束';}
  else if(observed.fresh&&observed.signal==='EXIT_CANDIDATE'){exit='ADAPTIVE_RECOVERY_FAILED';reason=observed.reason;}
  else if(observed.fresh){
    // The research anchor is a completed-price premise, not an intrabar hard
    // trigger. Keep the existing loss boundary; earned-profit defense below
    // may tighten it, while completed anchor loss needs a recovery verdict.
    if(observed.signal==='PROTECT_CANDIDATE'&&observed.peakNetPnl!=null&&observed.netPnl!=null){
      const floor=observed.peakNetPnl*.60;
      if(observed.netPnl<=floor){exit='ADAPTIVE_EARNED_PROFIT_EXIT';reason='明显盈利后实际反压及回吐已越过保护边界，兑现当前可成交收益';}
      else{
        const candidate=px+d*(floor-observed.netPnl)/(t.quantity*(1-d*.0005));
        if(d*(candidate-stop)>0&&d*(px-candidate)>q.bestAsk-q.bestBid){stop=candidate;reason='明显盈利后的实际反压触发保护，保留已取得净利润并继续观察推进';}
      }
    }
  }
  return{memory:next,observed,stop,exit,reason};
}
