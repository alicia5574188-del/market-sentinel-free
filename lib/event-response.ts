/** Measured single-coin events. No geometric forecast, companion order or IO. */
import type {CandleLike,MarketSymbolState,QuoteLike} from './market-intelligence-engine.ts';
import type {Trade,Quote} from './forward-relations.ts';
import {specialRows,recentSpecialActivity,type SpecialKind} from './special-move.ts';
import {MARKET_AUTHORITY_VERSION,type MarketRoute} from './market-authority.ts';
export const EVENT_RESPONSE_VERSION='event-response-v1';
export const EVENT_RESEARCH_BYTES=24*1024,EVENT_LIMIT=32,EVENT_TTL=6*3600000;
type Side='LONG'|'SHORT';
export type ResponsePoint={at:number;price:number;step:number;progress:number;peak:number;retained:number;counter:number;recoveryMs:number|null;noise:number};
export type ResponseEvent={id:string;symbol:string;detectedAt:number;anchorAt:number;anchorPrice:number;lastSeenAt:number;
  kind:SpecialKind;score:number;beta:number;correlation:number;marketMove:number|null;residual:number;turnover15:number|null;
  active:boolean;fresh:boolean;side:Side|null;phase:'WATCH'|'CONFIRMING'|'READY'|'EXECUTING'|'HOLDING'|'FAILED'|'LATE'|'DORMANT';
  code:string;reason:string;last?:ResponsePoint;proofAt:number;proofPrice:number;proofBars:number[];attempts:number;failures:number;
  admission?:{at:number;code:string;reason:string;price:number};
  quote?:{firstAt:number;firstPrice:number;lastAt:number;samples:number;peak:number;retained:number};
  tradeId?:string;entry?:{at:number;price:number;progress:number;retained:number;noise:number};
  exit?:{at:number;reason:string;price:number;net:number|null;peak:number;giveback:number};
  outcomes:{minutes:number;dueAt:number;at:number|null;observedAt?:number;price:number|null;move:number|null;status:'PENDING'|'OBSERVED'|'MISSING'}[];
  changes:{at:number;code:string;price:number}[];compacted?:boolean};
export type EventResearch={version:typeof EVENT_RESPONSE_VERSION;startedAt:number;updatedAt:number;events:Record<string,ResponseEvent>;
  marketMove:number|null;bytes:number;capacitySkipped:number;expired:number;coverage:{prices:number;active:number;fresh:number}};
export type ResponseHolding={version:typeof EVENT_RESPONSE_VERSION;eventId:string;entryAt:number;sourceAt:number;peak:number;peakAt:number;
  lastClose:number;lastCloseAt:number;counterSince:number|null;recoveryMs:number|null;failedRecoveries:number;counterProgress:number;
  stage:'LAUNCH'|'ADVANTAGE'|'REVIEW'|'EXIT';reason:string;points:ResponsePoint[]};
const dir=(s:Side)=>s==='LONG'?1:-1;
const median=(a:number[])=>{const b=a.filter(Number.isFinite).sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]!:0;};
const size=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x)).length;
export function boundedEventResearch(s:EventResearch){
  for(const e of Object.values(s.events))if(e.tradeId||e.admission?.code==='NATIVE_ADMISSION'&&(e.quote?.samples??0)>=3)delete e.quote;
  if(size(s)>EVENT_RESEARCH_BYTES-2000)for(const e of Object.values(s.events)){
    e.changes=[];e.reason=e.reason.slice(0,65);
    if(e.admission)e.admission.reason=e.admission.reason.slice(0,55);
    // Closed trades keep authoritative response points in their financial archive.
    if(e.exit)delete e.last;
    e.compacted=true;
  }
  if(size(s)>EVENT_RESEARCH_BYTES-256)for(const e of Object.values(s.events)){
    e.reason=e.reason.slice(0,24);
    if(e.admission)e.admission.reason=e.admission.reason.slice(0,28);
  }
  s.bytes=size(s);s.bytes=size(s);
  if(s.bytes>EVENT_RESEARCH_BYTES)throw new Error('EVENT_RESEARCH_BOUND');
  return s;
}
export function validResponseHolding(m:ResponseHolding){return m?.version===EVENT_RESPONSE_VERSION&&typeof m.eventId==='string'&&!!m.eventId
  &&[m.entryAt,m.sourceAt,m.peak,m.peakAt,m.lastClose,m.lastCloseAt,m.failedRecoveries,m.counterProgress].every(Number.isFinite)
  &&m.entryAt>0&&m.lastClose>0&&m.peak>=0&&m.failedRecoveries>=0&&m.counterProgress>=0
  &&['LAUNCH','ADVANTAGE','REVIEW','EXIT'].includes(m.stage)&&Array.isArray(m.points)&&m.points.length<=4
  &&m.points.every(p=>Object.values(p).every(v=>v===null||Number.isFinite(v))&&p.at>m.entryAt&&p.at<=m.sourceAt&&p.price>0);}
const fresh=(q:QuoteLike|undefined,now:number)=>!!q?.fresh&&q.observedAt<=now&&now-q.observedAt<=10000&&q.bestBid>0&&q.bestAsk>=q.bestBid;
export function responseRows(rows:CandleLike[]|undefined,minutes:CandleLike[]|undefined,now:number){
  const five=specialRows(rows,now),fast=specialRows(minutes,now,60000),venue=five.at(-1)?.volumeVenue;
  const useFast=fast.length>=15&&now-(fast.at(-1)!.time*1000+60000)<=120000&&typeof venue==='string'
    &&fast.slice(-15).every(r=>r.volumeVenue===venue);
  return{rows:useFast?fast:five,step:useFast?60000:300000};
}
export function normalizeEventResearch(value:unknown):EventResearch|undefined{
  const s=value as EventResearch;
  if(!s||s.version!==EVENT_RESPONSE_VERSION||!Number.isFinite(s.updatedAt)||!Number.isFinite(s.startedAt)
    ||s.updatedAt<s.startedAt||!s.events||Object.keys(s.events).length>EVENT_LIMIT||size(s)>EVENT_RESEARCH_BYTES)return;
  for(const [key,e] of Object.entries(s.events))if(!e||e.symbol!==key||!e.id||![e.detectedAt,e.anchorAt,e.anchorPrice,e.lastSeenAt,e.score,e.proofAt,e.proofPrice,e.attempts,e.failures].every(Number.isFinite)
    ||e.anchorPrice<=0||e.detectedAt>s.updatedAt||e.anchorAt>e.detectedAt||e.lastSeenAt>s.updatedAt||e.proofAt>s.updatedAt
    ||!['WATCH','CONFIRMING','READY','EXECUTING','HOLDING','FAILED','LATE','DORMANT'].includes(e.phase)
    ||typeof e.active!=='boolean'||typeof e.fresh!=='boolean'||e.side!==null&&!['LONG','SHORT'].includes(e.side)
    ||!Array.isArray(e.proofBars)||e.proofBars.length>2||e.proofBars.some((v,i)=>!Number.isFinite(v)||v>e.proofAt||i>0&&v<=e.proofBars[i-1]!)
    ||e.quote&&(!Object.values(e.quote).every(Number.isFinite)||e.quote.firstPrice<=0||e.quote.lastAt>s.updatedAt)
    ||!Array.isArray(e.outcomes)||e.outcomes.length!==4||!Array.isArray(e.changes)||e.changes.length>3
    ||e.last&&(!Object.values(e.last).every(v=>v===null||Number.isFinite(v))||e.last.at>s.updatedAt)
    ||e.outcomes.some(o=>![15,30,45,60].includes(o.minutes)||o.dueAt!==e.detectedAt+o.minutes*60000
      ||o.at!==null&&(o.at<o.dueAt||o.at>s.updatedAt)||o.price!==null&&(!Number.isFinite(o.price)||o.price<=0)
      ||o.move!==null&&!Number.isFinite(o.move)))return;
  return structuredClone(s);
}
function change(e:ResponseEvent,code:string,reason:string,at:number,price:number){
  if(code!==e.code)e.changes=[...e.changes,{at,code,price}].slice(-3);
  e.code=code;e.reason=reason;
}
function observeResponse(e:ResponseEvent,rows:CandleLike[],step:number,now:number){
  const last=rows.at(-1),stamp=last?last.time*1000+step:0;
  if(!last||stamp<=e.anchorAt||now-stamp>step*2)return;
  const tail=rows.filter(r=>r.time*1000+step>e.anchorAt),noise=Math.max(.00035,median(rows.slice(-18,-3).map(r=>Math.abs(r.close/r.open-1))));
  const raw=last.close/e.anchorPrice-1,threshold=Math.max(.0028,noise*2.5),side:Side=raw>=0?'LONG':'SHORT',d=dir(e.side??side);
  if(!e.side&&Math.abs(raw)>=threshold){
    e.side=side;e.attempts++;e.phase='CONFIRMING';
  }
  const progress=d*raw,peak=Math.max(0,...tail.map(r=>d*(r.close/e.anchorPrice-1))),retained=peak>0?Math.max(0,progress/peak):0,
    counter=Math.max(0,peak-progress),peakIndex=tail.findLastIndex(r=>d*(r.close/e.anchorPrice-1)>=peak-noise*.1),
    recoveryMs=counter<=noise&&peakIndex>=0?stamp-(tail[peakIndex]!.time*1000+step):null;
  e.last={at:stamp,price:last.close,step,progress,peak,retained,counter,recoveryMs,noise};
  if(e.tradeId)return;
  if(!e.side){e.phase='WATCH';change(e,'RESPONSE_WAIT','异常已记录，尚未产生足够自身推进',now,last.close);return;}
  const two=tail.slice(-2),sameVenue=two.length===2&&two.every(r=>r.volumeVenue===rows.at(-1)!.volumeVenue),
    held=two.length===2&&two.every(r=>d*(r.close/e.anchorPrice-1)>=threshold*.75)&&retained>=.65,
    advancing=two.length===2&&d*(two[1]!.close/two[0]!.close-1)>=-noise*.5;
  if(e.phase==='FAILED')return; // Same failed event cannot silently reset its start.
  if(progress<-noise||peak>=threshold&&progress<Math.max(noise,peak*.25)){
    e.phase='FAILED';e.failures++;change(e,'RESPONSE_FAILED','本次自身启动未保留，记住失败，不重置事件再追单',now,last.close);return;
  }
  // An event discovered after an extended move has no observed early launch.
  const before=rows.filter(r=>r.time*1000+step<=e.anchorAt).slice(-4),priorMove=before.length>=4?d*(before.at(-1)!.close/before[0]!.close-1):0;
  if(priorMove>Math.max(.015,noise*8)||progress>Math.max(.015,noise*8)){
    e.phase='LATE';change(e,'RESPONSE_LATE','已走远，缺少可观察的早期价格优势；本事件不追入',now,last.close);return;
  }
  if(e.proofAt&&now-e.proofAt>12*60000){e.phase='LATE';change(e,'RESPONSE_EXPIRED','早期启动证据已过期；继续研究结果，不用旧信号追入',now,last.close);return;}
  if(sameVenue&&held&&advancing&&e.active&&e.fresh){
    e.phase='READY';if(!e.proofAt){e.proofAt=stamp;e.proofPrice=last.close;e.proofBars=two.map(r=>r.time*1000+step);}
    change(e,'RESPONSE_READY','自身推进已连续保留，核对随后真实盘口与成交成本',now,last.close);
  }else{e.phase='CONFIRMING';change(e,'RESPONSE_CONFIRMING','已有自身推进，等待下一段价格继续保留优势',now,last.close);}
}
export function advanceEventResearch(input:{previous?:EventResearch;now:number;paths:Record<string,CandleLike[]>;minutes?:Record<string,CandleLike[]>;
  quotes:Record<string,QuoteLike>;states:Record<string,MarketSymbolState>;positions?:Trade[];history?:Trade[]}):EventResearch{
  const normalized=normalizeEventResearch(input.previous);
  if(input.previous&&!normalized)throw new Error('事件响应记忆损坏；保留账户，不重建事件起点');
  const s=normalized??{version:EVENT_RESPONSE_VERSION,startedAt:input.now,updatedAt:input.now,events:{},
    marketMove:null,bytes:0,capacitySkipped:0,expired:0,coverage:{prices:0,active:0,fresh:0}};
  if(input.now<s.updatedAt)return s;s.updatedAt=input.now;s.coverage={prices:0,active:0,fresh:0};
  const paths=Object.fromEntries(Object.entries(input.paths).map(([k,v])=>[k,specialRows(v,input.now)])),groups=new Map<string,number[]>();
  for(const [symbol,rows] of Object.entries(paths))if(rows.length>=16&&input.now-(rows.at(-1)!.time*1000+300000)<=600000){
    const q=input.quotes[symbol],price=fresh(q,input.now)?(q!.bestBid+q!.bestAsk)/2:rows.at(-1)!.close,
      key=input.states[symbol]?.clusterId??symbol,g=groups.get(key)??[];g.push(price/rows.at(-7)!.close-1);groups.set(key,g);}
  const marketPrices=[...groups.values()].flat();
  s.marketMove=marketPrices.length>=3?median([...groups.values()].map(median)):null;
  const protectedSymbols=new Set((input.positions??[]).map(t=>t.symbol));
  for(const [symbol,e] of Object.entries(s.events))if(input.now-e.detectedAt>EVENT_TTL&&!protectedSymbols.has(symbol)){
    delete s.events[symbol];s.expired++;
  }
  const candidates=Object.entries(paths).sort(([a],[b])=>(input.states[b]?.watchScore??0)-(input.states[a]?.watchScore??0));
  for(const [symbol,five] of candidates){
    const state=input.states[symbol],q=input.quotes[symbol];if(!state||five.length<16)continue;
    s.coverage.prices++;
    const livePrice=fresh(q,input.now)?(q!.bestBid+q!.bestAsk)/2:five.at(-1)!.close,
      activity=recentSpecialActivity(five),own=livePrice/five.at(-7)!.close-1,short=livePrice/five.at(-4)!.close-1,
      old=s.events[symbol],beta=old?.beta??Math.max(-3,Math.min(3,state.beta)),correlation=old?.correlation??state.correlation,
      expected=s.marketMove==null?0:beta*s.marketMove,residual=own-expected,vol=Math.max(.001,state.volatility*Math.sqrt(6)),
      kind:SpecialKind=s.marketMove!==null&&Math.abs(s.marketMove)>=Math.max(.004,vol*.75)&&Math.abs(own)<Math.abs(s.marketMove)*.3?'ACTIVE_NONRESPONSE':
        s.marketMove!==null&&own*s.marketMove<0&&Math.abs(own)>=Math.max(.003,vol*.6)?'OPPOSITE_MOVE':
        Math.abs(residual)>=Math.max(.004,vol)&&Math.abs(own)>=.004?'RELATIVE_LEADER':
        Math.abs(short)>=Math.max(.006,state.volatility*Math.sqrt(3)*2)&&Math.abs(short)>=Math.abs(own)*.65?'OWN_ACCELERATION':'ORDINARY',
      valid=fresh(q,input.now)&&input.now-(five.at(-1)!.time*1000+300000)<=600000&&(q?.sourceCount??0)>=2&&(q?.disagreementRate??0)<=.008;
    if(activity.active)s.coverage.active++;if(valid)s.coverage.fresh++;
    if(!old&&(!activity.active||!valid||kind==='ORDINARY'))continue;
    const selected=responseRows(five,input.minutes?.[symbol],input.now),last=selected.rows.at(-1)!;
    if(!old&&(Object.keys(s.events).length>=EVENT_LIMIT||size(s)+Object.keys(s.events).length*1000>EVENT_RESEARCH_BYTES-2500)){s.capacitySkipped++;continue;}
    const e=old??{id:`${EVENT_RESPONSE_VERSION}:${symbol}:${input.now}`,symbol,detectedAt:input.now,
      anchorAt:last.time*1000+selected.step,anchorPrice:last.close,lastSeenAt:input.now,kind,score:Math.min(98,60+Math.abs(residual)/vol*8),
      beta,correlation,marketMove:s.marketMove,residual,turnover15:activity.turnover15,active:activity.active,fresh:valid,
      side:null,phase:'WATCH',code:'RESPONSE_WAIT',reason:'异常已记录，等待自身价格响应',proofAt:0,proofPrice:0,proofBars:[],attempts:0,failures:0,
      outcomes:[15,30,45,60].map(minutes=>({minutes,dueAt:input.now+minutes*60000,at:null,price:null,move:null,status:'PENDING' as const})),changes:[] } satisfies ResponseEvent;
    e.lastSeenAt=input.now;e.active=activity.active;e.fresh=valid;e.turnover15=activity.turnover15;
    for(const o of e.outcomes)if(o.status==='PENDING'&&input.now>=o.dueAt){
      if(input.now>o.dueAt+300000){o.status='MISSING';continue;}
      const bar=five.find(r=>r.time*1000+300000>=o.dueAt&&r.time*1000+300000<=o.dueAt+300000);
      if(bar){o.at=bar.time*1000+300000;o.observedAt=input.now;o.price=bar.close;o.move=bar.close/e.anchorPrice-1;o.status='OBSERVED';}
    }
    const trade=(input.positions??[]).find(t=>t.unified?.response?.eventId===e.id),closed=(input.history??[]).find(t=>t.unified?.response?.eventId===e.id);
    if(trade){e.tradeId=trade.id;e.phase=trade.paperOrder?.phase==='FILLED'?'HOLDING':'EXECUTING';}
    if(closed&&!e.exit){const m=closed.unified!.response!;e.exit={at:closed.closedAt!,reason:closed.exitReason??'EXIT',price:closed.exitPrice!,net:closed.netPnl,
      peak:m.peak,giveback:Math.max(0,m.peak-dir(closed.side)*(closed.exitPrice!/closed.entryPrice-1))};e.phase='FAILED';}
    observeResponse(e,selected.rows,selected.step,input.now);
    if(!e.active||!e.fresh)change(e,!e.active?'RESPONSE_ACTIVITY':'RESPONSE_DATA',!e.active?'近期成交不足或未知，继续记录，不开单':'等待本币新鲜同源数据',input.now,last.close);
    s.events[symbol]=e;
  }
  for(const e of Object.values(s.events)){
    for(const o of e.outcomes)if(o.status==='PENDING'&&input.now>o.dueAt+300000)o.status='MISSING';
    if(e.lastSeenAt<input.now){e.fresh=false;if(!e.tradeId)e.phase='DORMANT';}
  }
  // Keep event identities/anchors/outcomes first. Optional explanation changes
  // yield space; no rotating rank is allowed to evict a live event.
  return boundedEventResearch(s);
}
export function eventMarketRoute(s:EventResearch|undefined,symbol:string,price:number,now:number){
  const e=s?.events[symbol],m=e?.last;
  if(!e||e.phase!=='READY'||!e.fresh||!e.active||!m||now-e.lastSeenAt>10000||now-e.proofAt>12*60000||e.tradeId)
    return{route:null,code:e?.code??'RESPONSE_WAIT',reason:e?.reason??'等待活跃异常事件'};
  const d=dir(e.side!),chase=d*(price/e.proofPrice-1),risk=Math.max(.005,Math.min(.025,m.noise*4+m.counter+.0019));
  if(chase>Math.max(.002,m.noise*2)||d*(price/e.anchorPrice-1)<m.peak*.6)
    return{route:null,code:'RESPONSE_EXECUTION_GAP',reason:'真实成交价没有保留原价格优势，等待；不制造新事件追入'};
  // target is a legacy transport receipt of observed proof price, NEVER a
  // forecast or payoff gate. Admission uses retained response plus money risk.
  const route:MarketRoute={version:MARKET_AUTHORITY_VERSION,controllerVersion:EVENT_RESPONSE_VERSION,epoch:1,phase:d>0?'UP':'DOWN',
    branch:'CONTINUATION',relation:'INDEPENDENT',side:e.side!,proofAt:e.proofAt,proofPrice:e.proofPrice,proofBars:e.proofBars,
    stop:price*(1-d*risk),target:e.proofPrice,targetBasis:'MEASURED_RESPONSE',
    reference:{lower:e.anchorPrice*(1-.0001),upper:e.anchorPrice*(1+.0001),center:e.anchorPrice,formedAt:e.anchorAt,balanced:false,basis:'OHLCV_PROXY'},
    eventId:e.id,observedProgress:m.progress,responseAnchor:e.anchorPrice,responsePeak:m.peak,responseNoise:m.noise,reason:e.reason};
  return{route,code:'RESPONSE_READY',reason:e.reason};
}
export function confirmEventQuote(e:ResponseEvent,q:Quote,now:number){
  if(e.phase!=='READY'||!e.side||!fresh(q,now)||q.entryReady!==true||!e.last||(q.sourceCount??0)<2||(q.disagreementRate??0)>.008)return false;
  const price=e.side==='LONG'?q.bestAsk:q.bestBid,d=dir(e.side),cost=.0019+(q.bestAsk-q.bestBid)/price;
  if(e.quote&&q.observedAt-e.quote.lastAt>10000)delete e.quote;
  if(!e.quote)e.quote={firstAt:now,firstPrice:price,lastAt:q.observedAt,samples:1,peak:0,retained:1};
  else if(q.observedAt>e.quote.lastAt){const advance=d*(price/e.quote.firstPrice-1);e.quote.peak=Math.max(e.quote.peak,advance);
    e.quote.retained=e.quote.peak>0?advance/e.quote.peak:advance>=-e.last.noise*.5?1:0;e.quote.lastAt=q.observedAt;e.quote.samples++;}
  const liveProgress=d*(price/e.anchorPrice-1),intact=liveProgress>=Math.max(cost*1.5,e.last.peak*.6)
    &&e.quote.retained>=.6&&d*(price/e.proofPrice-1)<=Math.max(.002,e.last.noise*2);
  return intact&&e.quote.samples>=3&&now-e.quote.firstAt>=4000;
}
/** Same response admission at the PAPER and owner/member LIVE submission price. */
export function responseEntryExecutable(t:Trade,price:number,now:number){
  const r=t.unified?.marketRoute,m=t.unified?.response;
  if(!r||r.controllerVersion!==EVENT_RESPONSE_VERSION||!m||!validResponseHolding(m)||m.eventId!==r.eventId
    ||r.side!==t.side||!r.proofPrice||!r.responseAnchor||!r.responsePeak||!r.responseNoise
    ||![price,r.proofAt,r.observedProgress,r.responseAnchor,r.responsePeak,r.responseNoise].every(Number.isFinite)
    ||price<=0||r.proofAt>now||now-r.proofAt>12*60000)return false;
  const d=dir(t.side),advance=d*(price/r.responseAnchor-1),chase=d*(price/r.proofPrice-1);
  return advance>=Math.max(.0019*1.5,r.responsePeak*.6)&&chase<=Math.max(.002,r.responseNoise*2);
}
export function eventHoldingDecision(t:Trade,q:Quote,now:number,rows:CandleLike[],minutes?:CandleLike[]){
  const old=t.unified!.response!,m=structuredClone(old),d=dir(t.side),px=t.side==='LONG'?q.bestBid:q.bestAsk,
    rate=d*(px/t.entryPrice-1),cost=.0019+(q.bestAsk-q.bestBid)/px;
  let stop=t.stopPrice,exit:string|null=null;
  if(!fresh(q,now))return{memory:m,stop,exit,reason:'等待新鲜执行盘口；保留原保护'};
  if(d*(px-stop)<=0)exit='RESPONSE_RISK_STOP';
  const selected=responseRows(rows,minutes,now),completed=selected.rows.filter(r=>r.time*1000+selected.step>m.lastCloseAt&&r.time*1000+selected.step>m.entryAt);
  for(const r of completed){const at=r.time*1000+selected.step,noise=Math.max(.00035,median(selected.rows.filter(p=>p.time<r.time).slice(-15).map(p=>Math.abs(p.close/p.open-1)))),
      current=d*(r.close/t.entryPrice-1),counter=Math.max(0,m.peak-current),opposing=d*(r.close/m.lastClose-1)<-noise*.5;
    if(current>m.peak){m.peak=current;m.peakAt=at;}
    if(m.counterSince&&current>=m.peak-noise){m.recoveryMs=at-m.counterSince;m.counterSince=null;m.failedRecoveries=0;m.counterProgress=0;}
    else if(counter>noise){if(!m.counterSince)m.counterSince=at;
      if(opposing){m.failedRecoveries++;m.counterProgress+=Math.abs(r.close/m.lastClose-1);}
      else if(current>d*(m.lastClose/t.entryPrice-1)+noise*.5)m.failedRecoveries=Math.max(0,m.failedRecoveries-1);}
    const earned=m.peak>Math.max(cost*2,noise*3),badRecovery=m.failedRecoveries>=2&&m.counterSince!==null&&at-m.counterSince>=selected.step;
    if(!earned&&badRecovery&&current<-Math.max(cost,noise*1.5))exit??='RESPONSE_LAUNCH_FAILED';
    if(earned&&badRecovery&&m.counterProgress>=Math.max(noise*2,m.peak*.3)&&current<Math.max(cost,m.peak*.45))exit??='RESPONSE_ADVANTAGE_LOST';
    m.stage=exit?'EXIT':earned?badRecovery?'REVIEW':'ADVANTAGE':'LAUNCH';
    m.sourceAt=at;m.lastCloseAt=at;m.lastClose=r.close;
    m.points=[...m.points,{at,price:r.close,step:selected.step,progress:current,peak:m.peak,
      retained:m.peak>0?Math.max(0,current/m.peak):0,counter,recoveryMs:m.recoveryMs,noise}].slice(-4);
  }
  if(rate>m.peak){m.peak=rate;m.peakAt=q.observedAt;}
  // A substantial observed advantage earns catastrophic giveback insurance,
  // independent of the old initial-R gate. Ordinary pullbacks stay with runner.
  const noise=m.points.at(-1)?.noise??.001;
  if(m.peak>Math.max(cost*3,noise*6)){
    const floor=Math.max(cost,m.peak*.30),candidate=t.entryPrice*(1+d*floor);
    stop=d>0?Math.max(stop,candidate):Math.min(stop,candidate);
    if(d*(px-stop)<=0)exit??='RESPONSE_EARNED_FLOOR';
  }
  m.reason=exit==='RESPONSE_LAUNCH_FAILED'?'启动后连续恢复失败，提前结束失败尝试':exit==='RESPONSE_ADVANTAGE_LOST'?'反向价格持续推进，原优势未恢复，兑现剩余收益':
    exit?'触及既定风险或已赚优势保护':m.stage==='ADVANTAGE'?'已赚出价格优势；正常回落继续持有，观察能否恢复':m.stage==='REVIEW'?'回落后恢复变弱，等待实际反向推进确认':'启动观察中；尚未连续确认失败';
  if(exit)m.stage='EXIT';return{memory:m,stop,exit,reason:m.reason};
}
