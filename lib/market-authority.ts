/** Single causal branch authority. Uses existing completed venue candles only;
 * no requests, timers, historical outcomes, wallets or synthetic candles. */
import {closedFiveMinutes,reactionGeometry,type ReactionArea} from './winner-policy.ts';
import type {CandleLike,MarketSymbolState} from './market-intelligence-engine.ts';
export const MARKET_AUTHORITY_VERSION='market-regime-authority-v1';
export type MarketPhase='HANDOFF'|'RANGE'|'UP'|'DOWN';
type Side='LONG'|'SHORT';
export type MarketRoute={version:typeof MARKET_AUTHORITY_VERSION;epoch:number;phase:MarketPhase;
  proofPath?:'HOLD_OUTSIDE'|'RETEST_RESTART';proofBars?:number[];
  relation:'FOLLOWER'|'INDEPENDENT';branch:'RETURN'|'CONTINUATION';side:Side;proofAt:number;
  stop:number;target:number;targetBasis:'ACCEPTED_CENTER'|'OBSERVED_OBSTACLE'|'VOLATILITY_ESTIMATE';
  reference:ReactionArea;reason:string};
export type CoinEpisode={reference:ReactionArea;lastAt:number;phase:MarketPhase;side:Side|null;
  acceptancePath?:'HOLD_OUTSIDE'|'RETEST_RESTART';acceptanceBars?:number[];
  proofAt:number;stop:number;eventPrice:number;atr:number;warning:boolean;failed:boolean;
  rejected:Side|null;rejectedAt:number;rejectedPrice:number;extreme:number;upperFailed:boolean;lowerFailed:boolean;
  independentBars:number;independentAt:number;relation:'FOLLOWER'|'INDEPENDENT';reason:string};
export type MarketAuthority={version:typeof MARKET_AUTHORITY_VERSION;epoch:number;phase:MarketPhase;
  since:number;checkedAt:number;fresh:boolean;warning:boolean;reason:string;
  groups:number;up:number;down:number;range:number;coverage:number;cohort:string[];
  coins:Record<string,CoinEpisode>;events:{at:number;from:MarketPhase;to:MarketPhase;reason:string}[]};
const dir=(s:Side)=>s==='LONG'?1:-1;
const end=(r:CandleLike,ms=300000)=>r.time*1000+ms;
function contiguousTail(rows:CandleLike[],seconds:number){let start=0;for(let i=1;i<rows.length;i++)
  if(rows[i]!.time-rows[i-1]!.time!==seconds)start=i;return rows.slice(start);}
function closedMinutes(rows:CandleLike[]|undefined,now:number){
  const unique=new Map<number,CandleLike>();
  for(const r of rows??[])if([r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)
    &&r.time>0&&r.low>0&&r.low<=Math.min(r.open,r.close)&&r.high>=Math.max(r.open,r.close)
    &&r.volume>=0&&end(r,60000)<=now)unique.set(r.time,r);
  return contiguousTail([...unique.values()].sort((a,b)=>a.time-b.time).slice(-30),60);
}
export function initialMarketAuthority(now:number):MarketAuthority{return{version:MARKET_AUTHORITY_VERSION,
  epoch:1,phase:'HANDOFF',since:now,checkedAt:now,fresh:false,warning:false,reason:'等待完整市场结构',
  groups:0,up:0,down:0,range:0,coverage:0,cohort:[],coins:{},events:[]};}
/** Freeze BEFORE the departure. Candidate IDs never reset a reference.
 * Advance that reference only after the prior episode is invalidated. */
function observeCoin(previous:CoinEpisode|undefined,rows:CandleLike[],minutes:CandleLike[],now:number):CoinEpisode|undefined{
  const geometry=reactionGeometry(rows,now),last=rows.at(-1);
  if(!geometry.area||!last||now-end(last)>600000)return previous;
  const start=!previous||previous.failed&&end(last)>previous.lastAt&&geometry.area.formedAt>previous.proofAt;
  const p:CoinEpisode=start?{reference:structuredClone(geometry.area),lastAt:0,phase:'HANDOFF',side:null,
    proofAt:0,stop:0,eventPrice:last.close,atr:geometry.atr,warning:false,failed:false,rejected:null,rejectedAt:0,rejectedPrice:0,
    extreme:0,upperFailed:false,lowerFailed:false,independentBars:previous?.independentBars??0,
    independentAt:previous?.independentAt??0,relation:previous?.relation??'FOLLOWER',reason:'离开与反压结果未确认'}:structuredClone(previous!);
  const ref=p.reference,atr=Math.max(geometry.atr,last.close*.0005),eps=atr*.15;
  // Official 1m bars may accelerate proof against the SAME frozen 5m reference.
  // Need three completed minute bars, never quote-built candles or repeated ticks.
  const fast=minutes.length>=15&&now-end(minutes.at(-1)!,60000)<=120000;
  const structural=fast?minutes:rows,ms=fast?60000:300000,tail=structural.filter(r=>end(r,ms)>ref.formedAt).slice(-6);
  const final=tail.at(-1),stamp=final?end(final,ms):end(last);
  if(!final||stamp<=p.lastAt)return p;
  p.lastAt=stamp;p.atr=atr;p.warning=false;
  if(p.side&&!p.failed){
    const d=dir(p.side),recent=tail.slice(-3),bad=recent.slice(-2).filter(r=>d*(r.close-p.stop)<-eps);
    // Broken accepted support AND failed recovery. One wick only warns.
    if(bad.length===2&&d*(recent.at(-1)!.close-recent.at(-2)!.close)<=eps){
      p.failed=true;p.phase='HANDOFF';p.reason='接受支撑破坏，后续恢复未收回；旧趋势结束';return p;
    }
    const progress=d*(final.close-p.eventPrice),peak=d>0?Math.max(...tail.map(r=>r.high)):Math.min(...tail.map(r=>r.low));
    p.warning=d*(final.close-peak)<-atr*.8||progress<=0||bad.length>0;
    // Only a completed counter move followed by renewed progress may raise support.
    if(recent.length===3&&d*(recent[1]!.close-recent[0]!.close)<0
      &&d*(recent[2]!.close-recent[0]!.close)>eps){
      const pivot=d>0?Math.min(recent[0]!.low,recent[1]!.low)-eps:Math.max(recent[0]!.high,recent[1]!.high)+eps;
      if(d*(pivot-p.stop)>0){p.stop=pivot;p.proofAt=stamp;p.eventPrice=final.close;
        p.acceptancePath='RETEST_RESTART';p.acceptanceBars=recent.map(r=>end(r,ms));}
    }
    p.reason=p.warning?'推进保留变弱，保护持仓并暂停追单；尚未确认换向':'反压未破坏接受支撑，趋势继续';return p;
  }
  p.rejected=null;
  for(let i=0;i<tail.length-1;i++){
    const r=tail[i]!,n=tail[i+1]!;
    if(ref.balanced&&r.high>ref.upper+eps&&r.close<ref.upper&&n.close<r.close&&n.high<=r.high){
      p.upperFailed=true;p.rejected='SHORT';p.rejectedAt=end(n,ms);p.rejectedPrice=n.close;p.extreme=r.high+eps;
    }
    if(ref.balanced&&r.low<ref.lower-eps&&r.close>ref.lower&&n.close>r.close&&n.low>=r.low){
      p.lowerFailed=true;p.rejected='LONG';p.rejectedAt=end(n,ms);p.rejectedPrice=n.close;p.extreme=r.low-eps;
    }
  }
  // Within an already accepted range: impulse, counter move, restart fails,
  // then the counter base breaks. A merely slower impulse is not a failure.
  if(p.phase==='RANGE'&&tail.length>=4){
    const [push,counter,restart,confirm]=tail.slice(-4),up=push!.close>push!.open&&counter!.close<push!.close,
      down=push!.close<push!.open&&counter!.close>push!.close;
    if(up&&restart!.high<=push!.high+eps&&restart!.close<counter!.close
      &&confirm!.close<counter!.low&&confirm!.close>ref.center){
      p.rejected='SHORT';p.rejectedAt=end(confirm!,ms);p.rejectedPrice=confirm!.close;p.extreme=Math.max(push!.high,restart!.high)+eps;
    }
    if(down&&restart!.low>=push!.low-eps&&restart!.close>counter!.close
      &&confirm!.close>counter!.high&&confirm!.close<ref.center){
      p.rejected='LONG';p.rejectedAt=end(confirm!,ms);p.rejectedPrice=confirm!.close;p.extreme=Math.min(push!.low,restart!.low)-eps;
    }
  }
  for(const side of ['LONG','SHORT'] as const){
    const d=dir(side),boundary=d>0?ref.upper:ref.lower;
    const recent=tail.slice(-3);
    if(recent.length<3)continue;
    const outside=recent.every(r=>d*(r.close-boundary)>eps),
      progressed=d*(recent[2]!.close-recent[0]!.close)>eps,
      accepted=outside&&progressed&&recent.slice(1).every(r=>d*(r.close-r.open)>=-atr*.4),
      retest=d*(recent[0]!.close-boundary)>eps&&d*(recent[1]!.close-boundary)>-eps
        &&d*(recent[1]!.close-recent[0]!.close)<0&&d*(recent[2]!.close-recent[0]!.close)>eps;
    if(accepted||retest){
      p.side=side;p.phase=d>0?'UP':'DOWN';p.proofAt=stamp;p.eventPrice=final.close;p.failed=false;
      p.acceptancePath=retest?'RETEST_RESTART':'HOLD_OUTSIDE';p.acceptanceBars=recent.map(r=>end(r,ms));
      p.stop=d>0?Math.min(...recent.map(r=>r.low))-eps:Math.max(...recent.map(r=>r.high))+eps;
      p.reason=retest?'离开后反压未收回，重新推进':'连续收盘在参考区外，反压未夺回接受区';return p;
    }
  }
  // A trendless moment is not range permission. Two-sided attempts must fail.
  if(ref.balanced&&p.upperFailed&&p.lowerFailed&&final.close>ref.lower&&final.close<ref.upper){
    p.phase='RANGE';p.proofAt=Math.max(p.proofAt,stamp);p.reason='双向离开尝试失败，价格重新接受原稳定重心';
  }
  return p;
}
export function advanceMarketAuthority(input:{previous?:MarketAuthority;now:number;ready:boolean;
  protectedSymbols?:string[];
  symbols:string[];states:Record<string,MarketSymbolState>;paths:Record<string,CandleLike[]>;
  minutePaths?:Record<string,CandleLike[]>;quotes:Record<string,{observedAt:number;fresh:boolean}>}):MarketAuthority{
  const a=input.previous?structuredClone(input.previous):initialMarketAuthority(input.now);
  a.checkedAt=input.now;a.fresh=false;
  if(!input.ready){a.reason='市场覆盖恢复中，保留已有状态，暂停新增';return a;}
  const selected=[...new Set(input.symbols)].slice(0,30);
  // Freeze the electorate during a trend so rotating the scan cannot vote it away.
  if(!a.cohort.length||a.phase==='HANDOFF'||a.phase==='RANGE'){
    const representatives=selected.filter(s=>s==='BTC_USDT'||s==='ETH_USDT'),groups=new Set(representatives.map(s=>input.states[s]?.clusterId??s));
    for(const s of selected){const group=input.states[s]?.clusterId??s;
      if(!groups.has(group)){representatives.push(s);groups.add(group);}if(representatives.length>=8)break;}
    a.cohort=[...new Set([...representatives,...selected])].slice(0,8);
  }
  const members=[...new Set([...(input.protectedSymbols??[]),...a.cohort,...selected])].slice(0,30),coins:Record<string,CoinEpisode>={};
  const grouped=new Map<string,CoinEpisode[]>();
  for(const symbol of members){
    const rows=contiguousTail(closedFiveMinutes(input.paths[symbol],input.now),300),q=input.quotes[symbol],state=input.states[symbol];
    const p=observeCoin(a.coins[symbol],rows,closedMinutes(input.minutePaths?.[symbol],input.now),input.now);
    if(!p)continue;coins[symbol]=p;
    const fresh=!!q?.fresh&&q.observedAt<=input.now&&input.now-q.observedAt<=10000
      &&rows.length>=15&&input.now-end(rows.at(-1)!)<=600000&&!!state&&state.dataConfidence>=60&&state.sourceCount>=2;
    if(!fresh)continue;
    // Permission to detach requires sustained residual beyond normal noise AND
    // own completed structure. Amplitude or a DIVERGENT label alone cannot detach.
    if(end(rows.at(-1)!)>p.independentAt){
      const ownStructure=p.side!==null?dir(p.side)*state.residual>0:p.phase==='RANGE'&&p.upperFailed&&p.lowerFailed
        &&Math.abs(state.actualMove)<Math.max(.003,state.volatility*2)
        &&Math.abs(state.expectedMove)>Math.max(.004,state.volatility*2);
      const independent=ownStructure&&Math.abs(state.residualZ)>=1.5&&state.residualPersistence>=.75
        &&Math.abs(state.residual)>Math.max(.002,state.volatility*1.5)
        &&state.correlation<.55;
      p.independentBars=independent?Math.min(3,p.independentBars+1):0;p.independentAt=end(rows.at(-1)!);
      p.relation=p.independentBars>=3?'INDEPENDENT':'FOLLOWER';
    }
    if(!a.cohort.includes(symbol)||p.relation==='INDEPENDENT')continue;
    const key=state.clusterId||symbol,group=grouped.get(key)??[];group.push(p);grouped.set(key,group);
  }
  a.coins=coins;
  const groups=[...grouped.values()],votes=groups.map(ps=>({
    up:ps.filter(p=>p.phase==='UP'&&!p.failed).length/ps.length,
    down:ps.filter(p=>p.phase==='DOWN'&&!p.failed).length/ps.length,
    range:ps.filter(p=>p.phase==='RANGE').length/ps.length,
    failed:ps.filter(p=>p.failed||p.phase==='HANDOFF').length/ps.length,
    warn:ps.filter(p=>p.warning).length/ps.length}));
  const fraction=(key:'up'|'down'|'range'|'failed'|'warn')=>votes.length?votes.reduce((n,v)=>n+v[key],0)/votes.length:0;
  a.groups=groups.length;a.coverage=groups.reduce((n,g)=>n+g.length,0);a.up=fraction('up');a.down=fraction('down');a.range=fraction('range');
  const commonFactor=groups.length===1&&a.coverage>=6
    &&Math.max(a.up,a.down,a.range)>=.80;
  // In a highly synchronous market all followers may form one correlation
  // cluster. Broad agreement in that common factor is usable, but is reported
  // as one group rather than invented independent confirmations.
  a.fresh=a.coverage>=Math.max(3,Math.ceil(a.cohort.length*.6))&&(a.groups>=2||commonFactor);
  if(!a.fresh){a.reason='新鲜代表组覆盖不足，保留市场判断并暂停新增';return a;}
  a.warning=(a.phase==='UP'?a.up:a.phase==='DOWN'?a.down:1)<.60||fraction('warn')>=.40;
  const desired:MarketPhase=a.up>=.65?'UP':a.down>=.65?'DOWN':a.range>=.65?'RANGE':'HANDOFF';
  const old=a.phase;
  // Opposite/range votes cannot directly flip an accepted trend. A common
  // support failure first revokes its authority. The next episode earns entry.
  if(old==='UP'||old==='DOWN'){
    const support=old==='UP'?a.up:a.down;
    if(support<.40&&fraction('failed')+(old==='UP'?a.down:a.up)>=.60)a.phase='HANDOFF';
  }else a.phase=desired;
  a.reason=a.phase==='UP'?'多数独立代表组确认上涨接受：跟随币只许上涨延续':
    a.phase==='DOWN'?'多数独立代表组确认下跌接受：跟随币只许下跌延续':
    a.phase==='RANGE'?'多数代表组确认双向失败：跟随币只许失败回归':'旧状态已失效，新方向或双向回归尚未共同确认，等待';
  if(old!==a.phase){a.epoch++;a.since=input.now;a.events.unshift({at:input.now,from:old,to:a.phase,reason:a.reason});a.events=a.events.slice(0,8);}
  return a;
}
export function routeMarketCoin(a:MarketAuthority,symbol:string,price:number,now:number):MarketRoute|null{
  const p=a.coins[symbol];if(!a.fresh||!p||p.failed||p.lastAt>now||now-p.lastAt>600000||!(price>0))return null;
  if(p.relation==='FOLLOWER'&&a.warning)return null;
  const phase=p.relation==='INDEPENDENT'?p.phase:a.phase;
  if(phase==='HANDOFF')return null;
  let side:Side,branch:MarketRoute['branch'],proofAt:number,stop:number,target:number,basis:MarketRoute['targetBasis'];
  if(phase==='RANGE'){
    if(!p.reference.balanced||!p.rejected||now-p.rejectedAt>600000)return null;
    side=p.rejected;branch='RETURN';proofAt=p.rejectedAt;stop=p.extreme;target=p.reference.center;basis='ACCEPTED_CENTER';
  }else{
    side=phase==='UP'?'LONG':'SHORT';if(p.side!==side||p.warning||p.phase!==phase)return null;
    branch='CONTINUATION';proofAt=p.proofAt;stop=p.stop;
    // A leg estimate is finite and labelled; it is never called observed liquidity.
    target=p.eventPrice+dir(side)*Math.max(p.atr*4,Math.abs(p.eventPrice-stop)*2.2);basis='VOLATILITY_ESTIMATE';
    if(dir(side)*(price-p.eventPrice)>p.atr*.75)return null;
  }
  const risk=dir(side)*(price-stop),room=dir(side)*(target-price),cost=price*.0019;
  if(!(stop>0&&target>0)||risk<=0||risk/price>.035||room-cost<cost*2||(room-cost)/(risk+cost)<1.35)return null;
  return{version:MARKET_AUTHORITY_VERSION,epoch:a.epoch,phase,relation:p.relation,branch,side,proofAt,stop,target,targetBasis:basis,
    ...(branch==='CONTINUATION'?{proofPath:p.acceptancePath,proofBars:p.acceptanceBars}:{}),
    reference:structuredClone(p.reference),reason:`${p.relation==='FOLLOWER'?'跟随统一市场':'独立残差与结构持续确认'}；${p.reason}；${branch==='RETURN'?'失败后回到稳定重心':'按本币承接位置延续'}`};
}
export function routeStillPermitted(a:MarketAuthority,r:MarketRoute,symbol:string){
  const p=a.coins[symbol];if(!a.fresh||!p||p.failed)return false;
  const phase=p.relation==='INDEPENDENT'?p.phase:a.phase;
  return phase===r.phase&&(r.branch==='RETURN'?phase==='RANGE':phase===(r.side==='LONG'?'UP':'DOWN'));
}
export function validMarketAuthority(a:MarketAuthority){return a?.version===MARKET_AUTHORITY_VERSION
  &&['HANDOFF','RANGE','UP','DOWN'].includes(a.phase)&&Number.isSafeInteger(a.epoch)&&a.epoch>0
  &&a.cohort.length<=30&&Object.keys(a.coins).length<=30&&a.events.length<=8
  &&[a.since,a.checkedAt,a.groups,a.up,a.down,a.range,a.coverage].every(Number.isFinite)
  &&Object.values(a.coins).every(p=>[p.lastAt,p.proofAt,p.stop,p.eventPrice,p.atr,p.independentAt,p.independentBars,
    p.reference.lower,p.reference.upper,p.reference.center,p.reference.formedAt].every(Number.isFinite)
    &&p.reference.lower>0&&p.reference.upper>p.reference.lower&&p.independentBars<=3);}
export function validMarketRoute(r:MarketRoute){return r?.version===MARKET_AUTHORITY_VERSION
  &&Number.isSafeInteger(r.epoch)&&r.epoch>0&&['RANGE','UP','DOWN'].includes(r.phase)
  &&['FOLLOWER','INDEPENDENT'].includes(r.relation)&&['RETURN','CONTINUATION'].includes(r.branch)
  &&['LONG','SHORT'].includes(r.side)&&[r.proofAt,r.stop,r.target,r.reference?.lower,r.reference?.upper,
    r.reference?.center,r.reference?.formedAt].every(Number.isFinite)&&r.stop>0&&r.target>0
  &&r.reference.lower>0&&r.reference.upper>r.reference.lower
  &&(r.branch==='RETURN'?r.phase==='RANGE'&&r.reference.balanced:r.phase===(r.side==='LONG'?'UP':'DOWN'));}
