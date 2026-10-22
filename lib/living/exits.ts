/**
 * C5 step 5 (thesis exits) and B4 fast-lane protection. Both only produce actions; forward-relations applies them before
 * its existing exits (liquidation first, then these, then dynamic hold / giveback / structure stop as before).
 */
import {FAST,STEPS} from "./config.ts";
import type {LivingTape} from "./tape.ts";
import type {Episode,FastEvent} from "./fast-lane.ts";
import {episodeLevel} from "./fast-lane.ts";
import type {ProbeScore,ProbeId} from "./probes.ts";
import type {Thesis,Playbook} from "./thesis.ts";
import {thesisSupports,PLAYBOOK_PROBE} from "./thesis.ts";
import type {LivingTradeAction,LivingNote} from "./directive.ts";
import {r6} from "./util.ts";

export type PositionView={id:string;symbol:string;side:"LONG"|"SHORT";entryPrice:number;stopPrice:number;liquidationPrice:number|null;
  openedAt:number;favorable:number;adverse?:number;guard:number|null;living?:LivingNote;price:number|null};
const d=(s:"LONG"|"SHORT")=>s==="LONG"?1:-1;
/** B4: protection actions for one fast-lane step. `scale` halves the tightening when B7 says protection cost money (not the liq guard). */
export function fastProtection(input:{positions:PositionView[];ep:Episode|null;events:FastEvent[];tape:LivingTape;now:number;scale:number;
  peaks:Map<string,number>}):LivingTradeAction[]{
  const {ep,tape,now}=input,out:LivingTradeAction[]=[];if(!ep)return out;
  const alertNow=input.events.some(e=>e.type==="ALERT"&&e.episodeId===ep.id),confirmNow=input.events.some(e=>e.type==="CONFIRM"&&e.episodeId===ep.id);
  const b60=Math.abs(tape.ret("__basket__",now,60)??0);void b60;
  const basket60=(()=>{const xs:number[]=[];for(const s of Object.keys(ep.anchor)){const r=tape.ret(s,now,60);if(r!=null)xs.push(r);}xs.sort((a,b)=>a-b);return xs.length?xs[xs.length>>1]!:0;})();
  for(const p of input.positions){
    if(p.price==null)continue;
    const px=p.price,s=d(p.side),signed=s*(px/p.entryPrice-1);
    if(p.side!==ep.side){
      const r60=tape.ret(p.symbol,now,60);
      const follows=r60!=null&&Math.sign(r60)===d(ep.side)&&Math.abs(r60)>FAST.coinFollowFraction*Math.abs(basket60);
      if(!follows)continue;
      if(alertNow){
        const liqDist=p.liquidationPrice?Math.abs(px-p.liquidationPrice)/px:Infinity;
        if(liqDist<Math.max(FAST.liqMoveMultiple*Math.abs(r60!),FAST.liqMinDistance)){
          out.push({tradeId:p.id,action:"EXIT",code:"LIVING_FAST_LIQ_GUARD",reason:`集体异动警报：离爆仓 ${(liqDist*100).toFixed(2)}%，不到 2.5 倍 60 秒波动或 1.5%，直接平`,
            detail:{episode:ep.id,liqDist:r6(liqDist),r60:r6(r60!)}});continue;
        }
        if(p.living?.bh)continue;// burst-leader-v1: only its own stop and the liquidation guard
        const stop=p.guard!=null?(s>0?Math.max(p.stopPrice,p.guard):Math.min(p.stopPrice,p.guard)):p.stopPrice;
        const remaining=s*(px-stop)/px;
        if(remaining>FAST.tightenMin){
          const keep=Math.max(FAST.tightenMin,remaining*(1-FAST.tightenFraction*input.scale)),next=r6(px*(1-s*keep));
          if(s*(next-stop)>0)out.push({tradeId:p.id,action:"GUARD",stop:next,code:"LIVING_FAST_TIGHTEN",
            reason:`集体异动警报：止损收紧到剩余距离的 ${(keep/remaining*100).toFixed(0)}%（${(keep*100).toFixed(2)}%）`,detail:{episode:ep.id,before:r6(stop),after:next}});
        }
      }
      if(confirmNow&&!p.living?.bh){
        const stop=p.guard!=null?(s>0?Math.max(p.stopPrice,p.guard):Math.min(p.stopPrice,p.guard)):p.stopPrice,remaining=s*(px-stop)/px;
        if(signed<0||remaining>FAST.confirmMaxRemaining){
          out.push({tradeId:p.id,action:"EXIT",code:"LIVING_FAST_CONFIRM_EXIT",reason:`集体异动确认：${signed<0?"这笔在亏":"剩余止损距离 "+(remaining*100).toFixed(2)+"%>0.6%"}，平掉`,
            detail:{episode:ep.id,signed:r6(signed),remaining:r6(remaining)}});
        }else{
          const be=r6(p.entryPrice*(1+s*STEPS.cost));
          if(s*(be-stop)>0&&s*(px-be)>0)out.push({tradeId:p.id,action:"GUARD",stop:be,code:"LIVING_FAST_BREAKEVEN",reason:"集体异动确认：这笔在赚，止损拉到保本加手续费",detail:{episode:ep.id}});
        }
      }
    }else if(!p.living?.bh){
      const peak=Math.max(input.peaks.get(p.id)??0,signed);input.peaks.set(p.id,peak);
      if(peak>=FAST.withMoveArm&&signed<=peak*(1-FAST.withMoveGiveback))
        out.push({tradeId:p.id,action:"EXIT",code:"LIVING_FAST_GIVEBACK",reason:`顺着这波的单：这一段最高浮盈 ${(peak*100).toFixed(2)}%，回吐 40% 就走`,detail:{episode:ep.id,peak:r6(peak),signed:r6(signed)}});
    }
  }
  return out;
}
/** v2: a price-only burst that flow did not back (SURGE) is not an alert; only positions near liquidation react. */
export function surgeGuard(input:{positions:PositionView[];events:FastEvent[];tape:LivingTape;now:number}):LivingTradeAction[]{
  const out:LivingTradeAction[]=[];
  for(const e of input.events){if(e.type!=="SURGE")continue;
    for(const p of input.positions){
      if(p.price==null||p.side===e.side||!p.liquidationPrice)continue;
      const r60=input.tape.ret(p.symbol,input.now,60);if(r60==null||Math.sign(r60)!==d(e.side))continue;
      const liqDist=Math.abs(p.price-p.liquidationPrice)/p.price;
      if(liqDist<Math.max(FAST.liqMoveMultiple*Math.abs(r60),FAST.liqMinDistance))
        out.push({tradeId:p.id,action:"EXIT",code:"LIVING_FAST_LIQ_GUARD",reason:`全市场急动（资金没跟，不算警报），但离爆仓只有 ${(liqDist*100).toFixed(2)}%，直接平`,detail:{surge:e.episodeId,liqDist:r6(liqDist)}});
    }}
  return out;
}
/** C5 thesis exits for trades the living layer opened. `probe` = live score of the trade's playbook probe. */
export function thesisExits(input:{positions:PositionView[];thesis:Thesis|null;scores:Record<ProbeId,ProbeScore>;tape:LivingTape;now:number;
  episode:Episode|null;handedOff:Set<string>;lastEnd:{id:string;end:string;at:number}|null;
  /** v2: the live market intent still backs this side (handoff instead of exit when an episode ends) */
  intentSupports?:(side:"LONG"|"SHORT")=>boolean}):LivingTradeAction[]{
  const out:LivingTradeAction[]=[];
  for(const p of input.positions){
    const n=p.living;if(!n||p.price==null)continue;
    const s=d(p.side),signed=s*(p.price/p.entryPrice-1),ageMin=(input.now-p.openedAt)/60_000;
    if(n.bh)continue;// burst-leader-v1: the burst hold owns this trade's exits (no FAKE / EXHAUST / 10-minute exits)
    if(n.k==="F"&&!input.handedOff.has(p.id)){
      const ep=input.episode;
      if(input.lastEnd&&input.lastEnd.id===n.ep&&input.lastEnd.end==="FAKE"){out.push({tradeId:p.id,action:"EXIT",code:"LIVING_FAST_FAKE",reason:"这一段判成假动作，快速单平掉"});continue;}
      if(ageMin>=FAST.timeExitMs/60_000&&p.favorable<FAST.timeExitMin){out.push({tradeId:p.id,action:"EXIT",code:"LIVING_FAST_TIME",reason:"快速单 10 分钟内没走出 +0.5%，平掉"});continue;}
      if((!ep||ep.id!==n.ep)&&input.lastEnd&&input.lastEnd.id===n.ep){
        // the episode ended (EXHAUST/TIMEOUT/REVERSED): hand off if step 2 agrees, else exit
        if(input.intentSupports?input.intentSupports(p.side):(thesisSupports(input.thesis,"momentum",p.side)||(input.thesis?.side===p.side&&input.thesis.structure!=="RANGE")))
          out.push({tradeId:p.id,action:"HANDOFF",code:"LIVING_FAST_HANDOFF",reason:"这一段走完，市场资金意图还支持这个方向，交给正常流程继续拿"});
        else out.push({tradeId:p.id,action:"EXIT",code:"LIVING_FAST_EXHAUST",reason:"这一段走完，市场资金意图不再支持这个方向，平掉"});
      }
      continue;
    }
    if(n.k!=="N"||n.v==="living-v2")continue;// v2 normal trades: intent.holdCheck decides hold / exit
    const pb=n.pb as Playbook,score=input.scores[PLAYBOOK_PROBE[pb]];
    const flipped=!!input.thesis?.side&&input.thesis.side!==p.side&&(pb!=="extension-fade"&&pb!=="crowding-fade"&&pb!=="range-revert");
    if(score&&((score.score<=0&&score.t<=STEPS.exitUnrewardedT)||flipped)){
      if(signed>STEPS.cost){
        const be=r6(p.entryPrice*(1+s*STEPS.cost)),stop=p.guard??p.stopPrice;
        if(s*(be-stop)>0)out.push({tradeId:p.id,action:"GUARD",stop:be,code:"LIVING_THESIS_BREAKEVEN",reason:flipped?"市场判断翻了，浮盈单止损拉到保本加手续费":"市场不再奖励这种做法，浮盈单止损拉到保本加手续费"});
      }else{out.push({tradeId:p.id,action:"EXIT",code:flipped?"LIVING_THESIS_FLIP":"LIVING_THESIS_UNREWARDED",reason:flipped?"市场判断翻了，浮亏单平掉":`市场不再奖励这种做法（奖励分 ${(score.score*100).toFixed(2)}%，t ${score.t.toFixed(1)}），浮亏单平掉`});continue;}
    }
    // coin not cooperating, on closed 5m mid bars
    const bars=input.tape.closed5(p.symbol,input.now),last=bars.at(-1);
    if(last&&n.ref!=null&&(last.time+300)*1000>p.openedAt){
      const broke=pb==="breakout"?ageMin<=30&&s*(last.close-n.ref)<0
        :pb==="range-revert"?s*(last.close-n.ref)<0&&Math.abs(last.close-n.ref)/n.ref>.0005
        :pb==="trend-pullback"?s*(last.close-n.ref)<0
        :pb==="extension-fade"||pb==="crowding-fade"?s*(n.ref-(s>0?last.low:last.high))>0
        :false;
      if(broke){out.push({tradeId:p.id,action:"EXIT",code:"LIVING_THESIS_STRUCTURE",reason:pb==="breakout"?"突破单 30 分钟内又收回区间":pb==="range-revert"?"区间单收盘破了边缘":pb==="trend-pullback"?"回调单跌破回调低点":"反转单又创了新的极值"});continue;}
    }
    if(ageMin>=STEPS.holdOverrun*n.hold&&!thesisSupports(input.thesis,pb,p.side))
      out.push({tradeId:p.id,action:"EXIT",code:"LIVING_THESIS_TIMEOUT",reason:`拿到计划时长 ${n.hold} 分钟的 1.5 倍，判断没有重新确认`});
  }
  return out;
}
export const basketLevelOf=episodeLevel;
