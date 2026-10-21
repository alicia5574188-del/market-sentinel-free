/**
 * C4 step 4 — wait for the position, then confirm; never chase. A watch lives ≤ 30 minutes: price must come into the
 * playbook's zone, a closed 1m bar must turn back the playbook's way, no opposite fast-lane alert, the book must not lean
 * clearly against it, and ≥ 2 fresh quote samples in the zone. The invalidation sits outside the structure; its width
 * must be 0.6%-2.0% (fast: 0.6%-1.5%) and ≤ 40% of the 10x liquidation distance. Also B5 fast-follow entries.
 */
import {FAST,STEPS,SIZING} from "./config.ts";
import type {LivingTape,MidBar} from "./tape.ts";
import {atr} from "./probes.ts";
import type {Candidate} from "./select.ts";
import type {Playbook,Side} from "./thesis.ts";
import type {Episode} from "./fast-lane.ts";
import {coinMove} from "./fast-lane.ts";
import {isolatedLiquidationPrice,fixedPaperLeverage,maintenanceRateOf} from "../paper-leverage.ts";
import {r6,quantile} from "./util.ts";

export type Watch={id:string;symbol:string;side:Side;playbook:Playbook;probe:string;createdAt:number;expiresAt:number;
  zoneLo:number;zoneHi:number;invalidation:number;ref:number|null;target:number|null;holdMin:number;rank:number;selectScore:number;
  layers:{l1:boolean;l2:boolean;probeSize:boolean;why1:string;why2:string};inZoneSamples:number;lastSampleAt:number;
  zoneSeenAt:number|null;zonePrice:number|null;status:"WAITING"|"READY"|"DONE";reason:string|null;
  /** v2: the live intent read that created the watch (narrative + evidence carried into the trade note) */
  intent?:{state:string;market:string;why:string;ev:string;strength:number;mult?:number}};
const d=(s:Side)=>s==="LONG"?1:-1;
/** Zone + invalidation for a selected candidate (C4 positions). Null = no sensible position. */
export function planPosition(c:Candidate,rows:MidBar[]):{lo:number;hi:number;inv:number;target:number|null}|null{
  if(rows.length<14)return null;
  const A=atr(rows),last=rows.at(-1)!,t=c.trigger,s=d(c.side);if(!(A>0))return null;
  const w=rows.slice(-48);
  switch(c.playbook){
    case "trend-pullback":{
      const up=c.side==="LONG",ext=up?Math.max(...w.map(x=>x.high)):Math.min(...w.map(x=>x.low)),ei=w.findIndex(x=>(up?x.high:x.low)===ext);
      const before=w.slice(0,ei+1),start=up?Math.min(...before.map(x=>x.low)):Math.max(...before.map(x=>x.high)),leg=Math.abs(ext-start);if(!(leg>0))return null;
      const a=ext-s*.62*leg,b=ext-s*.38*leg,pull=t.stop??a;
      return {lo:Math.min(a,b),hi:Math.max(a,b),inv:(up?Math.min(pull,Math.min(a,b)):Math.max(pull,Math.max(a,b)))-s*.1*A,target:ext};
    }
    case "breakout":{
      const lvl=t.ref??last.close;return {lo:lvl-.3*A,hi:lvl+.3*A,inv:lvl-s*.6*A,target:null};
    }
    case "range-revert":{
      const edge=t.ref??last.close;// SHORT at top edge, LONG at bottom edge
      return c.side==="SHORT"?{lo:edge-.3*A,hi:edge+.3*A,inv:edge+.5*A,target:t.target??null}:{lo:edge-.3*A,hi:edge+.3*A,inv:edge-.5*A,target:t.target??null};
    }
    case "extension-fade":case "crowding-fade":{
      const ext=t.ref??last.close;return c.side==="SHORT"?{lo:ext-1*A,hi:ext,inv:ext+.3*A,target:null}:{lo:ext,hi:ext+1*A,inv:ext-.3*A,target:null};
    }
    default:{
      const mid=(last.open+last.close)/2,six=rows.slice(-6);
      const inv=c.side==="LONG"?Math.min(...six.map(x=>x.low))-.1*A:Math.max(...six.map(x=>x.high))+.1*A;
      return c.side==="LONG"?{lo:Math.min(last.low,mid),hi:mid,inv,target:null}:{lo:mid,hi:Math.max(last.high,mid),inv,target:null};
    }
  }
}
/** Stop width rules shared by normal and fast entries. Returns the (possibly widened-to-minimum) stop or a reason. */
export function stopCheck(input:{side:Side;price:number;stop:number;min:number;max:number;leverageMax:number;mmr:number|null;liqSafety:boolean}):
  {ok:true;stop:number;rate:number;liq:number}|{ok:false;reason:string}{
  const s=d(input.side);let stop=input.stop;
  if(!(s*(input.price-stop)>0))return{ok:false,reason:"失效价不在入场价外侧"};
  let rate=Math.abs(input.price-stop)/input.price;
  if(rate<input.min){rate=input.min;stop=input.price*(1-s*rate);}
  if(rate>input.max)return{ok:false,reason:`失效价宽度 ${(rate*100).toFixed(2)}%>${(input.max*100).toFixed(1)}%`};
  const lev=fixedPaperLeverage(input.leverageMax),mmr=maintenanceRateOf(input.mmr??undefined);
  const liq=isolatedLiquidationPrice({entry:input.price,leverage:lev,side:input.side,maintenanceRate:mmr});
  if(input.liqSafety){
    if(input.mmr==null||input.mmr>SIZING.mmrMax)return{ok:false,reason:`维持保证金率 ${input.mmr==null?"未知":(input.mmr*100).toFixed(1)+"%"}>2%`};
    if(liq==null)return{ok:false,reason:"爆仓价算不出"};
    const liqDist=Math.abs(input.price-liq)/input.price;
    if(rate>SIZING.stopLiqFraction*liqDist)return{ok:false,reason:`止损 ${(rate*100).toFixed(2)}% 超过爆仓距离 ${(liqDist*100).toFixed(2)}% 的 40%`};
    if(Math.abs(stop-liq)<SIZING.liqStopMultiple*Math.abs(input.price-stop))return{ok:false,reason:"止损离爆仓价不足止损宽度的 1.5 倍"};
  }
  return {ok:true,stop:r6(stop),rate,liq:liq??NaN};
}
export function newWatch(c:Pick<Candidate,"symbol"|"side"|"playbook"|"probe"|"score"|"rank"|"trigger">,plan:{lo:number;hi:number;inv:number;target:number|null},now:number,holdMin:number,
  layers:Watch["layers"]):Watch{
  return {id:`lw-${Math.floor(now/1000).toString(36)}-${c.symbol.replace(/[^A-Z0-9]/g,"")}-${c.side[0]}`,symbol:c.symbol,side:c.side,playbook:c.playbook,
    probe:c.probe,createdAt:now,expiresAt:now+STEPS.waitPositionMs,zoneLo:r6(plan.lo),zoneHi:r6(plan.hi),invalidation:r6(plan.inv),
    ref:c.trigger.ref??null,target:plan.target,holdMin,rank:c.rank,selectScore:c.score,layers,inZoneSamples:0,lastSampleAt:0,
    zoneSeenAt:null,zonePrice:null,status:"WAITING",reason:null};
}
/** One tick of a watch. READY = layer 3 passed (position + confirmation); the caller sizes and sends the order. */
export function stepWatch(w:Watch,tape:LivingTape,now:number,oppositeAlert:boolean,noChase:boolean):Watch{
  if(w.status!=="WAITING")return w;
  const x={...w},last=tape.last(w.symbol);
  if(now>=w.expiresAt){x.status="DONE";x.reason=w.zoneSeenAt?"到过位置但 30 分钟内没等到确认":"30 分钟内没给位置（不追价）";return x;}
  if(!last||now-last.at>FAST.freshMs){x.reason="等待新鲜报价";return x;}
  const px=last.mid,s=d(w.side);
  if(s*(px-w.invalidation)<=0){x.status="DONE";x.reason="价格先打到了失效价，放弃";return x;}
  const inZone=px>=w.zoneLo&&px<=w.zoneHi;
  if(inZone&&last.at>w.lastSampleAt){x.inZoneSamples++;x.lastSampleAt=last.at;x.zoneSeenAt??=now;x.zonePrice??=px;}
  if(!x.zoneSeenAt){x.reason="等待价格回到位置";return x;}
  const m1=tape.closed1(w.symbol,now),b=m1.at(-1),p=m1.at(-2);
  const turned=!!b&&!!p&&now-(b.time+60)*1000<=70_000&&s*(b.close-b.open)>0&&s*(b.close-p.close)>0;
  const book=tape.meta.get(w.symbol)?.imbalance??0;
  const chaseOk=noChase||(x.zonePrice!=null&&s*(px/x.zonePrice-1)>=.0009);
  if(oppositeAlert){x.reason="快速通道有反方向警报";return x;}
  if(s*book<-.3){x.reason="挂单明显反对";return x;}
  if(x.inZoneSamples<2){x.reason="位置上的新报价样本不足 2 个";return x;}
  if(!turned){x.reason="等 1 分钟线在位置上收回打法方向";return x;}
  if(!chaseOk){x.reason="（第 4 项未启用）等价格再顺着走 0.09%";return x;}
  x.status="READY";x.reason="位置和确认都到了";return x;
}

/** B5 fast-follow candidate pick at/after confirm. */
export type FastPick={symbol:string;side:Side;mode:"PROBE"|"PULLBACK";stop:number;why:string};
export function fastFollowPicks(input:{ep:Episode;tape:LivingTape;now:number;members:string[];already:string[];
  mmr:(s:string)=>number|null;volume:(s:string)=>number;spread:(s:string)=>number|null;z60:number;leadersPreferred:boolean;
  clusterOf:(s:string)=>string;usedClusters:string[]}):{picks:FastPick[];skipped:{symbol:string;why:string}[]}{
  const {ep,tape,now}=input,picks:FastPick[]=[],skipped:{symbol:string;why:string}[]=[];
  const moves=input.members.map(s=>[s,coinMove(tape,ep,s,now)] as const).filter((x):x is readonly [string,number]=>x[1]!=null);
  if(moves.length<10)return{picks,skipped};
  const vs=moves.map(x=>x[1]),lo=quantile(vs,input.leadersPreferred?.80:FAST.pctLow),hi=quantile(vs,input.leadersPreferred?1:FAST.pctHigh);
  const order=[...["ETH_USDT","BTC_USDT"].filter(s=>ep.anchor[s]),...moves.filter(x=>x[1]>=lo&&x[1]<=hi).sort((a,b)=>b[1]-a[1]).map(x=>x[0])];
  const clusters=new Set(input.usedClusters);
  for(const s of order){
    if(input.already.includes(s))continue;
    const why=filterFollow(s,input);if(why){skipped.push({symbol:s,why});continue;}
    const c=input.clusterOf(s);if(clusters.has(c)){skipped.push({symbol:s,why:`相关组 ${c} 已有快速单`});continue;}
    const m=coinMove(tape,ep,s,now),last=tape.last(s);if(m==null||!last)continue;
    const peak=coinPeak(tape,ep,s,now);
    // mode 1: probe right at confirm
    const atConfirm=ep.confirmAt!=null&&now-ep.confirmAt<=4_000;
    if(atConfirm&&ep.retrace<FAST.probeBasketRetrace&&input.z60>=FAST.probeZ60&&peak!=null&&peak-m<=FAST.probeCoinNear){
      const width=Math.min(FAST.stopMax,Math.max(FAST.stopMin,.8*Math.abs(m)));
      picks.push({symbol:s,side:ep.side,mode:"PROBE",stop:r6(last.mid*(1-d(ep.side)*width)),why:`确认即试探：一篮子回撤 ${(ep.retrace*100).toFixed(0)}%，强度 ${input.z60.toFixed(1)}`});
      clusters.add(c);if(picks.length>=1)break;continue;
    }
    // mode 2: first pullback then a new 30s basket extreme
    if(peak!=null&&peak>0){
      const coinRetrace=(peak-m)/peak,low=coinTrough(tape,ep,s,now);
      const pulled=(coinRetrace>=FAST.pullCoinMin&&coinRetrace<=FAST.pullCoinMax)||(ep.maxRetrace>=FAST.pullBasketMin&&ep.maxRetrace<=FAST.pullBasketMax);
      const newExtreme=ep.newExtremeAfterPullbackAt!=null&&now-ep.newExtremeAfterPullbackAt<=FAST.newExtremeMs;
      const reclaimed=low!=null&&m-low>=.5*(peak-low);
      if(pulled&&newExtreme&&reclaimed&&low!=null){
        const anchor=ep.anchor[s]!,lowPrice=anchor*(1+d(ep.side)*low),stop=lowPrice*(1-d(ep.side)*.001);
        picks.push({symbol:s,side:ep.side,mode:"PULLBACK",stop:r6(stop),why:`回调 ${(coinRetrace*100).toFixed(0)}% 后一篮子 30 秒内创新${ep.side==="LONG"?"高":"低"}`});
        clusters.add(c);if(picks.length>=1)break;
      }
    }
  }
  return {picks,skipped};
}
function filterFollow(s:string,input:{mmr:(s:string)=>number|null;volume:(s:string)=>number;spread:(s:string)=>number|null}){
  const mmr=input.mmr(s),vol=input.volume(s),sp=input.spread(s);
  if(mmr==null||mmr>FAST.followMmr)return`维持保证金率 ${mmr==null?"未知":(mmr*100).toFixed(1)+"%"}>2%`;
  if(sp==null||sp>FAST.followSpread)return`价差 ${sp==null?"未知":(sp*1e4).toFixed(1)+"bp"}>6bp`;
  if(vol<FAST.followVolume)return`成交额 ${(vol/1e6).toFixed(0)}M<20M`;
  return null;
}
/** Coin's best signed move since the episode anchor, read from the 2s ring (≤ 11 minutes back). */
function coinPeak(tape:LivingTape,ep:Episode,s:string,now:number){
  const a=ep.anchor[s];if(!a)return null;let best=-Infinity;
  for(let t=Math.max(ep.anchorAt,now-FAST.ringMs+60_000);t<=now;t+=2_000){const p=tape.midAt(s,t);if(p)best=Math.max(best,d(ep.side)*(p.mid/a-1));}
  return Number.isFinite(best)?best:null;
}
function coinTrough(tape:LivingTape,ep:Episode,s:string,now:number){
  const a=ep.anchor[s];if(!a)return null;let peakAt=ep.anchorAt,best=-Infinity;
  for(let t=Math.max(ep.anchorAt,now-FAST.ringMs+60_000);t<=now;t+=2_000){const p=tape.midAt(s,t);if(!p)continue;const v=d(ep.side)*(p.mid/a-1);if(v>best){best=v;peakAt=t;}}
  let low=Infinity;for(let t=peakAt;t<=now;t+=2_000){const p=tape.midAt(s,t);if(p)low=Math.min(low,d(ep.side)*(p.mid/a-1));}
  return Number.isFinite(low)?low:null;
}
