/** Observations and paired hypotheses only. This module cannot authorize trades,
 * change protection, size orders, schedule work or write storage. */
import type {CandleLike,QuoteLike,MarketSymbolState} from './market-intelligence-engine.ts';
import type {MarketAuthority,CoinEpisode} from './market-authority.ts';
import type {Trade} from './forward-relations.ts';
import {realizedNetPnl,remainingOpenNetPnl,initialTradeNotional} from './trade-realization.ts';
export const EPISODE_RESEARCH_VERSION='causal-episode-research-v1';
export const EPISODE_RESEARCH_BYTES=48*1024;
type Side='LONG'|'SHORT';
export type EpisodePhase='UNCONFIRMED'|'ROTATION'|'ADVANCING'|'PULLBACK'|'SUPPORT_BROKEN'|'RECOVERY_FAILED'|'RECOVERY_BUILDING';
type Change={at:number;sourceAt:number;phase:EpisodePhase};
type Window={minutes:15|30|45|60;bars:number;move:number|null;efficiency:number|null;sourceAt:number};
export type ResearchEpisode={symbol:string;group:string;id:string;side:Side|null;phase:EpisodePhase;since:number;
  observedSince:number;sourceAt:number;quoteAt:number;fresh:boolean;minuteEvidence:boolean;
  entryProofAt:number;entrySupport:number;holdingSupport:number;holdingSupportAt:number;frontier:number;
  reference:{lower:number;upper:number;center:number;formedAt:number;balanced:boolean};
  failedSide:Side|null;failedAt:number;reason:string;nextEvidence:string;windows:Window[];changes:Change[];droppedChanges:number;
  hypotheses:{continuation:{side:Side|null;stage:'ACCEPTED'|'PULLBACK'|'INVALIDATED'|'UNCONFIRMED';basisAt:number};
    return:{side:Side|null;stage:'FAILED_DEPARTURE'|'FAILED_TREND'|'UNCONFIRMED';basisAt:number;target:number|null}}};
export type HoldingResearch={tradeId:string;symbol:string;side:Side;observedSince:number;fromEntry:boolean;
  sourceAt:number;quoteAt:number;fresh:boolean;status:'PENDING'|'OPEN'|'CLOSED';
  initialSupport:number;holdingSupport:number;holdingSupportAt:number;executionStop:number;
  premise:'UNOBSERVED'|'INTACT'|'PULLBACK'|'SUPPORT_BROKEN'|'RECOVERY_FAILED'|'RECOVERY_BUILDING';
  netPnl:number|null;peakNetPnl:number|null;giveback:number|null;fillRatio:number|null;
  plannedNotional:number|null;actualNotional:number;
  signal:'OBSERVE'|'HOLD'|'REVIEW'|'PROTECT_CANDIDATE'|'EXIT_CANDIDATE'|'CLOSED';reason:string};
export type EpisodeResearch={version:typeof EPISODE_RESEARCH_VERSION;mode:'OBSERVATIONAL';startedAt:number;updatedAt:number;
  accountStartedAt:number;symbols:Record<string,ResearchEpisode>;holdings:HoldingResearch[];
  transitions:{symbol:string;episodeId:string;at:number;sourceAt:number;from:EpisodePhase|null;to:EpisodePhase;side:Side|null;support:number}[];
  droppedTransitions:number;
  breadth:{groups:number;up:number;down:number;rotation:number;stressed:number;missing:number};
  summary:string;droppedSymbols:number;droppedHoldings:number;bytes:number};
const d=(side:Side)=>side==='LONG'?1:-1;
const bytes=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x)).length;
const end=(r:CandleLike,step:number)=>r.time*1000+step;
function rows(input:CandleLike[]|undefined,now:number,step:number){
  const unique=new Map<number,CandleLike>();
  for(const r of input??[])if([r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)
    &&r.time>0&&r.open>0&&r.close>0&&r.low>0&&r.low<=Math.min(r.open,r.close)
    &&r.high>=Math.max(r.open,r.close)&&r.volume>=0&&end(r,step)<=now)unique.set(r.time,r);
  const out=[...unique.values()].sort((a,b)=>a.time-b.time).slice(-30);
  let start=0;for(let i=1;i<out.length;i++)if((out[i]!.time-out[i-1]!.time)*1000!==step)start=i;
  return out.slice(start);
}
function quoteFresh(q:QuoteLike|undefined,now:number){return !!q?.fresh&&q.observedAt<=now&&now-q.observedAt<=10000
  &&Number.isFinite(q.bestBid)&&Number.isFinite(q.bestAsk)&&q.bestBid>0&&q.bestAsk>=q.bestBid;}
function windows(rs:CandleLike[]):Window[]{return([15,30,45,60] as const).map(minutes=>{
  const n=minutes/5,tail=rs.slice(-(n+1)),enough=tail.length===n+1,
    distance=tail.slice(1).reduce((s,r,i)=>s+Math.abs(r.close-tail[i]!.close),0),
    move=enough?tail.at(-1)!.close/tail[0]!.close-1:null;
  return{minutes,bars:Math.max(0,tail.length-1),move,efficiency:enough?(distance?Math.abs(tail.at(-1)!.close-tail[0]!.close)/distance:0):null,
    sourceAt:tail.length?end(tail.at(-1)!,300000):0};});}
/** Holding support advances only after a completed 5m counter move and renewed
 * progress. The 1m entry proof and its later stops never silently replace it. */
function holdingPivot(side:Side,support:number,at:number,after:number,rs:CandleLike[],price:number,epsilon:number){
  let level=support,stamp=at;
  for(let i=1;i<rs.length-1;i++){
    const before=rs[i-1]!,r=rs[i]!,next=rs[i+1]!;
    if(r.time*1000<after||end(next,300000)<=stamp)continue;
    const pivot=side==='LONG'?r.low<=before.low&&r.low<=next.low&&next.close>r.close+epsilon:
      r.high>=before.high&&r.high>=next.high&&next.close<r.close-epsilon;
    const candidate=(side==='LONG'?r.low:r.high)-d(side)*epsilon;
    if(pivot&&d(side)*(candidate-level)>0&&d(side)*(price-candidate)>epsilon){level=candidate;stamp=end(next,300000);}
  }
  return{level,at:stamp};
}
function premise(side:Side,support:number,rs:CandleLike[],epsilon:number):HoldingResearch['premise']{
  const last=rs.at(-1),prior=rs.at(-2);if(!last||!(support>0))return'UNOBSERVED';
  const sign=d(side),below=sign*(last.close-support)<-epsilon;
  if(below&&prior&&sign*(prior.close-support)<-epsilon
    &&sign*(last.close-prior.close)<=epsilon)return'RECOVERY_FAILED';
  if(below)return'SUPPORT_BROKEN';
  if(prior&&sign*(last.close-prior.close)<-epsilon)return'PULLBACK';
  return'INTACT';
}
function recovered(side:Side,support:number,rs:CandleLike[],epsilon:number){
  const a=rs.at(-2),b=rs.at(-1);return !!a&&!!b&&d(side)*(a.close-support)>epsilon
    &&d(side)*(b.close-support)>epsilon&&d(side)*(b.close-a.close)>epsilon;
}
const reasons:Record<EpisodePhase,[string,string]>={
  UNCONFIRMED:['尚未确认持续方向或稳定回归','观察离开后能否保留优势，或失败后回到已接受重心'],
  ROTATION:['双向离开失败，价格重新接受原重心','观察本次边缘离开是否失败；单次突破不能确认趋势'],
  ADVANCING:['已确认离开，当前承接仍被保留','观察下一次反压是否守住持仓承接并重新推进'],
  PULLBACK:['价格回撤，持仓承接尚未破坏','观察回撤后的恢复；回撤本身不证明换向'],
  SUPPORT_BROKEN:['完成的价格证据已越过持仓承接','观察能否收回承接；相对排名不能抵消实际破坏'],
  RECOVERY_FAILED:['承接破坏后，后续完成价格未恢复','旧延续依据失效；反方向仍须取得自己的承接证明'],
  RECOVERY_BUILDING:['价格已收回承接，恢复证据尚未完整','等待连续保留承接并重新推进，不能用单根收回恢复旧许可'],
};
function observe(symbol:string,p:CoinEpisode,old:ResearchEpisode|undefined,rs:CandleLike[],fast:CandleLike[],
  q:QuoteLike|undefined,state:MarketSymbolState|undefined,now:number):ResearchEpisode{
  const side=p.phase==='RANGE'?null:p.side,
    id=`${symbol}:${p.reference.formedAt}:${side??'RANGE'}`,
    same=old?.id===id,minute=fast.length>=3&&now-end(fast.at(-1)!,60000)<=120000,
    structural=minute?fast:rs,step=minute?60000:300000,sourceAt=structural.length?end(structural.at(-1)!,step):0,
    fresh=quoteFresh(q,now)&&p.dataReady===true&&!!state&&state.dataConfidence>=60&&state.sourceCount>=2
      &&rs.length>=13&&now-end(rs.at(-1)!,300000)<=600000,
    r:ResearchEpisode=same?structuredClone(old):{symbol,group:state?.clusterId??symbol,id,side,phase:'UNCONFIRMED',since:now,
      observedSince:now,sourceAt:0,quoteAt:0,fresh:false,minuteEvidence:minute,entryProofAt:p.proofAt,
      entrySupport:p.stop,holdingSupport:p.stop,holdingSupportAt:p.proofAt,frontier:p.eventPrice,
      reference:{...p.reference},failedSide:null,failedAt:0,reason:reasons.UNCONFIRMED[0],nextEvidence:reasons.UNCONFIRMED[1],
      windows:[],changes:[],droppedChanges:0,hypotheses:{continuation:{side:null,stage:'UNCONFIRMED',basisAt:0},
        return:{side:null,stage:'UNCONFIRMED',basisAt:0,target:null}}};
  r.fresh=fresh;r.quoteAt=q?.observedAt??0;r.group=state?.clusterId??r.group;r.windows=windows(rs);
  // Stale/future/repeated ticks cannot create a transition or a new proof.
  if(!fresh||sourceAt<=r.sourceAt)return r;
  const previousPhase=r.phase;r.sourceAt=sourceAt;r.minuteEvidence=minute;
  if(side&&p.proofAt>0&&p.proofAt<=sourceAt){
    const epsilon=Math.max(p.atr*.15,(q!.bestAsk-q!.bestBid)/2),price=(q!.bestBid+q!.bestAsk)/2,
      pivot=holdingPivot(side,r.holdingSupport,r.holdingSupportAt,r.entryProofAt,rs,price,epsilon);
    r.holdingSupport=pivot.level;r.holdingSupportAt=pivot.at;
    const eligible=structural.filter(x=>end(x,step)>r.entryProofAt),current=premise(side,r.holdingSupport,eligible,epsilon);
    r.phase=current==='UNOBSERVED'?'UNCONFIRMED':current==='INTACT'?'ADVANCING':current;
    if(['SUPPORT_BROKEN','RECOVERY_FAILED','RECOVERY_BUILDING'].includes(previousPhase)
      &&(current==='INTACT'||current==='PULLBACK')&&!recovered(side,r.holdingSupport,eligible,epsilon))r.phase='RECOVERY_BUILDING';
    const tail=structural.filter(x=>end(x,step)>=r.entryProofAt),extreme=side==='LONG'?
      Math.max(r.frontier,...tail.map(x=>x.high)):Math.min(r.frontier,...tail.map(x=>x.low));
    r.frontier=extreme;
    if(r.phase==='RECOVERY_FAILED'){r.failedSide=side;r.failedAt||=sourceAt;}
  }else if(p.phase==='RANGE'&&p.reference.balanced&&p.upperFailed&&p.lowerFailed)r.phase='ROTATION';
  else r.phase='UNCONFIRMED';
  const failedDeparture=p.rejected&&p.rejectedAt<=sourceAt&&now-p.rejectedAt<=600000&&p.reference.balanced,
    failedTrend=r.phase==='RECOVERY_FAILED'&&side;
  const returnSide:Side|null=failedDeparture?p.rejected:failedTrend?(side==='LONG'?'SHORT':'LONG'):null;
  r.hypotheses={continuation:{side,stage:r.phase==='ADVANCING'?'ACCEPTED':r.phase==='PULLBACK'?'PULLBACK':
    r.phase==='RECOVERY_FAILED'||r.phase==='SUPPORT_BROKEN'?'INVALIDATED':'UNCONFIRMED',basisAt:r.entryProofAt},
    return:{side:returnSide,
      stage:failedDeparture?'FAILED_DEPARTURE':failedTrend?'FAILED_TREND':'UNCONFIRMED',basisAt:failedDeparture?p.rejectedAt:failedTrend?sourceAt:0,
      target:returnSide&&r.reference.balanced&&d(returnSide)*(r.reference.center-(q!.bestAsk+q!.bestBid)/2)>0?r.reference.center:null}};
  [r.reason,r.nextEvidence]=reasons[r.phase];
  if(previousPhase!==r.phase||!r.changes.length){r.since=now;r.changes.push({at:now,sourceAt,phase:r.phase});}
  while(r.changes.length>4){r.changes.splice(1,1);r.droppedChanges++;}
  return r;
}
function observeHolding(t:Trade,old:HoldingResearch|undefined,rs:CandleLike[],fast:CandleLike[],q:QuoteLike|undefined,now:number):HoldingResearch{
  // A closed order's evidence stops at its actual close. Later market prices
  // cannot rewrite that order's holding verdict or suggest a historical fill.
  if(t.status==='CLOSED'){
    if(old?.status==='CLOSED')return{...old,netPnl:t.netPnl??old.netPnl};
    rs=rs.filter(r=>end(r,300000)<=(t.closedAt??0));fast=fast.filter(r=>end(r,60000)<=(t.closedAt??0));
  }
  const initial=t.unified?.initialStop??t.entryContext?.winnerPlan?.initialStop??t.stopPrice,
    o=t.paperOrder,pending=!!o&&o.phase!=='FILLED',closed=t.status==='CLOSED',
    structural=fast.length>=3&&now-end(fast.at(-1)!,60000)<=120000?fast:rs,
    step=structural===fast?60000:300000,sourceAt=structural.length?end(structural.at(-1)!,step):0,
    fresh=!closed&&quoteFresh(q,now)&&sourceAt>0&&now-sourceAt<=(step===60000?120000:600000),
    px=closed?(t.exitPrice??t.lastPrice):fresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice,
    ranges=rs.slice(-6).map(r=>r.high-r.low).sort((a,b)=>a-b),
    epsilon=Math.max((ranges[Math.floor(ranges.length/2)]??px*.001)*.15,fresh?(q!.bestAsk-q!.bestBid)/2:0),
    pivot=fresh?holdingPivot(t.side,old?.holdingSupport??initial,old?.holdingSupportAt??t.openedAt,t.openedAt,rs,px,epsilon):
      {level:old?.holdingSupport??initial,at:old?.holdingSupportAt??t.openedAt},
    net=closed?t.netPnl??null:fresh&&!pending?realizedNetPnl(t)+remainingOpenNetPnl(t,px):old?.netPnl??null,
    // Recorded trade peaks are adopted with explicit observedSince/fromEntry,
    // never invented past transition times or hypothetical executable fills.
    peak=net==null?old?.peakNetPnl??t.review?.peakNetPnl??null:
      Math.max(net,old?.peakNetPnl??net,t.review?.peakNetPnl??net),
    giveback=net!=null&&peak!=null&&peak>0?Math.max(0,peak-net):null,
    eligible=structural.filter(r=>end(r,step)>t.openedAt),raw=fresh&&sourceAt>0&&!pending?premise(t.side,pivot.level,eligible,epsilon):old?.premise??'UNOBSERVED',
    current=fresh&&old&&['SUPPORT_BROKEN','RECOVERY_FAILED','RECOVERY_BUILDING'].includes(old.premise)
      &&(raw==='INTACT'||raw==='PULLBACK')&&!recovered(t.side,pivot.level,eligible,epsilon)?'RECOVERY_BUILDING':raw,
    originalNotional=initialTradeNotional(t),risk=Math.abs(initial/t.entryPrice-1)*originalNotional,
    meaningful=peak!=null&&peak>=Math.max(originalNotional*.001*4,risk*1.1),
    counter=structural.at(-1)&&structural.at(-2)&&d(t.side)*(structural.at(-1)!.close-structural.at(-2)!.close)<-epsilon,
    protect=fresh&&meaningful&&giveback!=null&&peak!=null&&giveback>=peak*.35
      &&(current==='RECOVERY_FAILED'||current==='SUPPORT_BROKEN'||!!counter),
    signal:HoldingResearch['signal']=closed?'CLOSED':!fresh||pending?'OBSERVE':current==='RECOVERY_FAILED'?'EXIT_CANDIDATE':
      protect?'PROTECT_CANDIDATE':current==='SUPPORT_BROKEN'||current==='RECOVERY_BUILDING'?'REVIEW':'HOLD',
    reason=closed?'实际订单已平仓，保留最终结算':pending?'尚未成交，不能把提交视为持仓收益':!fresh?'报价失鲜，保留上次观察':
      signal==='EXIT_CANDIDATE'?'实际承接破坏且恢复失败，旧持仓依据需退出评估':
      signal==='PROTECT_CANDIDATE'?'已取得明显净利润，完成的反压伴随利润回吐，需保护评估':
      signal==='REVIEW'?'实际承接曾被完成价格破坏，等待完整恢复结果':
      current==='PULLBACK'?'正常回撤仍在持仓承接内，保留持仓假设':'实际价格仍保留持仓承接';
  return{tradeId:t.id,symbol:t.symbol,side:t.side,observedSince:old?.observedSince??now,fromEntry:old?.fromEntry??t.openedAt===now,
    sourceAt,quoteAt:closed?t.lastQuoteAt:q?.observedAt??0,fresh,status:closed?'CLOSED':pending?'PENDING':'OPEN',initialSupport:initial,
    holdingSupport:pivot.level,holdingSupportAt:pivot.at,executionStop:t.stopPrice,premise:current,netPnl:net,
    peakNetPnl:peak,giveback,plannedNotional:o?o.requestedContracts*t.quantoMultiplier*o.signalPrice:null,
    actualNotional:originalNotional,fillRatio:o?.requestedContracts?Math.min(1,(t.realization?.initialContracts??t.contracts)/o.requestedContracts):null,
    signal,reason};
}
export function initialEpisodeResearch(now:number,accountStartedAt:number):EpisodeResearch{return{version:EPISODE_RESEARCH_VERSION,
  mode:'OBSERVATIONAL',startedAt:now,updatedAt:now,accountStartedAt,symbols:{},holdings:[],transitions:[],droppedTransitions:0,breadth:{groups:0,up:0,down:0,rotation:0,stressed:0,missing:0},
  summary:'等待持续价格证据',droppedSymbols:0,droppedHoldings:0,bytes:0};}
/** Invalid optional diagnostics are discarded, never an account-load failure. */
export function normalizeEpisodeResearch(value:unknown):EpisodeResearch|undefined{
  try{const v=value as EpisodeResearch;
    if(v?.version!==EPISODE_RESEARCH_VERSION||v.mode!=='OBSERVATIONAL'||!Number.isFinite(v.startedAt)
      ||!Number.isFinite(v.updatedAt)||!Number.isFinite(v.accountStartedAt)||!v.symbols||!Array.isArray(v.holdings)
      ||Object.keys(v.symbols).length>30||v.holdings.length>18||!Array.isArray(v.transitions)||v.transitions.length>24
      ||!Number.isFinite(v.droppedTransitions)||bytes(v)>EPISODE_RESEARCH_BYTES)return;
    if(v.transitions.some(t=>!t||!reasons[t.to]||(t.from!==null&&!reasons[t.from])
      ||![t.at,t.sourceAt,t.support].every(Number.isFinite)))return;
    if(Object.values(v.symbols).some(r=>!r||!reasons[r.phase]||!Array.isArray(r.changes)||r.changes.length>4
      ||!Array.isArray(r.windows)||r.windows.length!==4||!r.hypotheses
      ||![r.sourceAt,r.holdingSupport,r.entryProofAt,r.reference?.lower,r.reference?.upper,r.reference?.center].every(Number.isFinite)))return;
    if(v.holdings.some(r=>!r||!['PENDING','OPEN','CLOSED'].includes(r.status)
      ||!['LONG','SHORT'].includes(r.side)||!['UNOBSERVED','INTACT','PULLBACK','SUPPORT_BROKEN','RECOVERY_FAILED','RECOVERY_BUILDING'].includes(r.premise)
      ||!['OBSERVE','HOLD','REVIEW','PROTECT_CANDIDATE','EXIT_CANDIDATE','CLOSED'].includes(r.signal)
      ||![r.observedSince,r.sourceAt,r.initialSupport,r.holdingSupport,r.executionStop,r.actualNotional].every(Number.isFinite)
      ||[r.netPnl,r.peakNetPnl,r.giveback,r.fillRatio].some(n=>n!==null&&!Number.isFinite(n))))return;
    return structuredClone(v);
  }catch{return;}
}
export function advanceEpisodeResearch(input:{previous?:EpisodeResearch;now:number;accountStartedAt:number;
  authority:MarketAuthority;states:Record<string,MarketSymbolState>;paths:Record<string,CandleLike[]>;
  minutePaths?:Record<string,CandleLike[]>;quotes:Record<string,QuoteLike>;positions:Trade[];history:Trade[]}):EpisodeResearch{
  const s=normalizeEpisodeResearch(input.previous)??initialEpisodeResearch(input.now,input.accountStartedAt);
  if(input.now<s.updatedAt)return s;
  const old=s.symbols;s.symbols={};s.updatedAt=input.now;
  const all=[...new Set([...input.positions.map(t=>t.symbol),...input.authority.cohort,...Object.keys(input.authority.coins)])];
  s.droppedSymbols+=Math.max(0,all.length-30);
  for(const symbol of all.slice(0,30)){
    const p=input.authority.coins[symbol];if(!p)continue;
    s.symbols[symbol]=observe(symbol,p,old[symbol],rows(input.paths[symbol],input.now,300000),
      rows(input.minutePaths?.[symbol],input.now,60000),input.quotes[symbol],input.states[symbol],input.now);
    const r=s.symbols[symbol]!;
    if(r.fresh&&r.sourceAt>0&&(r.id!==old[symbol]?.id||r.phase!==old[symbol]?.phase)){
      s.transitions.push({symbol,episodeId:r.id,at:input.now,sourceAt:r.sourceAt,from:old[symbol]?.phase??null,
        to:r.phase,side:r.side,support:r.holdingSupport});
      if(s.transitions.length>24){s.transitions.shift();s.droppedTransitions++;}
    }
  }
  const previousHoldings=s.accountStartedAt===input.accountStartedAt?s.holdings:[];s.accountStartedAt=input.accountStartedAt;
  const active=input.positions.filter(t=>t.openedAt>=input.accountStartedAt).slice(0,10),closed=input.history.filter(t=>t.closedAt&&t.openedAt>=input.accountStartedAt)
    .sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,8),trades=[...active,...closed];
  s.droppedHoldings+=Math.max(0,input.positions.length-active.length);
  s.holdings=trades.map(t=>observeHolding(t,previousHoldings.find(r=>r.tradeId===t.id),rows(input.paths[t.symbol],input.now,300000),
    rows(input.minutePaths?.[t.symbol],input.now,60000),input.quotes[t.symbol],input.now));
  const groups=new Map<string,ResearchEpisode[]>();
  for(const p of Object.values(s.symbols)){const group=groups.get(p.group)??[];group.push(p);groups.set(p.group,group);}
  const breadth={groups:groups.size,up:0,down:0,rotation:0,stressed:0,missing:0};
  for(const group of groups.values()){
    const total=group.length;for(const p of group){if(!p.fresh){breadth.missing+=1/total;continue;}
      if(p.phase==='ADVANCING'||p.phase==='PULLBACK'){if(p.side==='LONG')breadth.up+=1/total;else if(p.side==='SHORT')breadth.down+=1/total;}
      if(p.phase==='ROTATION')breadth.rotation+=1/total;
      if(p.phase==='SUPPORT_BROKEN'||p.phase==='RECOVERY_FAILED'||p.phase==='RECOVERY_BUILDING')breadth.stressed+=1/total;}
  }
  s.breadth=breadth;
  s.summary=`${breadth.groups}个相关组；上涨承接 ${breadth.up.toFixed(1)}、下跌承接 ${breadth.down.toFixed(1)}、双向回归 ${breadth.rotation.toFixed(1)}、承接受损 ${breadth.stressed.toFixed(1)}。`;
  // Fixed bound. Remove optional old closed diagnostics and older transitions
  // first; observation failure must never ask the financial lane for more space.
  while(bytes(s)>EPISODE_RESEARCH_BYTES&&s.holdings.some(h=>h.status==='CLOSED')){s.holdings.splice(s.holdings.map(h=>h.status).lastIndexOf('CLOSED'),1);s.droppedHoldings++;}
  while(bytes(s)>EPISODE_RESEARCH_BYTES&&s.transitions.length){s.transitions.shift();s.droppedTransitions++;}
  if(bytes(s)>EPISODE_RESEARCH_BYTES)for(const p of Object.values(s.symbols)){p.droppedChanges+=p.changes.length-1;p.changes=p.changes.slice(-1);}
  const protectedSymbols=new Set(active.map(t=>t.symbol));
  while(bytes(s)>EPISODE_RESEARCH_BYTES){const symbol=Object.keys(s.symbols).reverse().find(k=>!protectedSymbols.has(k));
    if(!symbol)break;delete s.symbols[symbol];s.droppedSymbols++;}
  if(bytes(s)>EPISODE_RESEARCH_BYTES)throw new Error('OPTIONAL_EPISODE_RESEARCH_BOUND');
  s.bytes=bytes(s);s.bytes=bytes(s);
  if(s.bytes>EPISODE_RESEARCH_BYTES)throw new Error('OPTIONAL_EPISODE_RESEARCH_BOUND');
  return s;
}
