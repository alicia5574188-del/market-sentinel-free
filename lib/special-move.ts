/** Unusual-coin research and own-leg admission. Pure, causal and bounded. */
import type {CandleLike,MarketSymbolState,QuoteLike} from './market-intelligence-engine.ts';
import {reactionGeometry} from './winner-policy.ts';
import {MARKET_AUTHORITY_VERSION,validMarketRoute,type MarketRoute} from './market-authority.ts';
import {forwardExecutionUniverseEligible,type MultiTurnUniverseTicker,type AnchorOpportunityUniverseRow} from './multi-turn-universe.ts';
export const SPECIAL_MOVE_VERSION='special-move-v1';
export const SPECIAL_RESEARCH_BYTES=24*1024, SPECIAL_WATCH_TTL=6*60*60*1000;
export type SpecialKind='ACTIVE_NONRESPONSE'|'RELATIVE_LEADER'|'OPPOSITE_MOVE'|'OWN_ACCELERATION'|'ORDINARY';
export type SpecialWatch={symbol:string;firstSeenAt:number;lastSeenAt:number;observedAt:number;sourceAt:number;
  kind:SpecialKind;score:number;active:boolean;fresh:boolean;correlation:number;beta:number;
  moves:Array<number|null>;marketMoves:Array<number|null>;residual:number;turnover15:number|null;activityRatio:number|null;
  phase:'WATCH'|'READY'|'WAIT_LOCATION'|'DORMANT'|'LOW_ACTIVITY'|'MISSING_DATA';code:string;
  route?:MarketRoute;changes:{at:number;kind:SpecialKind;code:string}[]};
export type SpecialResearch={version:typeof SPECIAL_MOVE_VERSION;startedAt:number;updatedAt:number;watches:Record<string,SpecialWatch>;
  marketMoves:Array<number|null>;dropped:number;bytes:number};
const med=(a:number[])=>{const b=a.filter(Number.isFinite).sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]!:0;};
const d=(s:'LONG'|'SHORT')=>s==='LONG'?1:-1;
const bytes=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x)).length;
const clamp=(x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
export function specialRows(input:CandleLike[]|undefined,now:number,step=300000){
  const unique=new Map<number,CandleLike>();
  for(const r of input??[])if([r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)&&r.time>0
    &&r.open>0&&r.low>0&&r.close>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)
    &&r.volume>=0&&r.time*1000+step<=now)unique.set(r.time,r);
  const all=[...unique.values()].sort((a,b)=>a.time-b.time).slice(-120);let start=0;
  for(let i=1;i<all.length;i++)if((all[i]!.time-all[i-1]!.time)*1000!==step)start=i;
  return all.slice(start);
}
const move=(rs:CandleLike[],n:number)=>rs.length>n?rs.at(-1)!.close/rs.at(-n-1)!.close-1:null;
export function recentSpecialActivity(rs:CandleLike[]){
  const recent=rs.slice(-3),prior=rs.slice(-15,-3),known=(r:CandleLike)=>Number.isFinite(r.turnoverUsd)&&r.turnoverUsd!>=0;
  const same=recent.length===3&&recent.every(known)&&typeof recent[0]?.volumeVenue==='string'
    &&recent[0].volumeVenue.length>0&&new Set(recent.map(r=>r.volumeVenue)).size===1,
    total=same?recent.reduce((n,r)=>n+r.turnoverUsd!,0):null,
    base=prior.length===12&&prior.every(known)&&prior.every(r=>r.volumeVenue===recent[0]?.volumeVenue)
      ?med(prior.map(r=>r.turnoverUsd!)):null,
    ratio=total!=null&&base!=null&&base>0?total/3/base:null,
    active=total!=null&&total>=2500&&recent.every(r=>r.turnoverUsd!>0)&&(ratio==null||ratio>=.25);
  return{turnover15:total,activityRatio:ratio,active};
}
export function normalizeSpecialResearch(value:unknown):SpecialResearch|undefined{
  const s=value as SpecialResearch;
  if(!s||s.version!==SPECIAL_MOVE_VERSION||![s.startedAt,s.updatedAt,s.dropped,s.bytes].every(Number.isFinite)
    ||s.startedAt<=0||s.updatedAt<s.startedAt||!Array.isArray(s.marketMoves)||s.marketMoves.length!==4
    ||s.marketMoves.some(v=>v!==null&&!Number.isFinite(v))
    ||!s.watches||typeof s.watches!=='object'||Array.isArray(s.watches)||Object.keys(s.watches).length>64||bytes(s)>SPECIAL_RESEARCH_BYTES)return;
  for(const [symbol,w] of Object.entries(s.watches))if(!w||typeof w!=='object'||w.symbol!==symbol||![w.firstSeenAt,w.lastSeenAt,w.observedAt,w.sourceAt,w.score,w.correlation,w.beta,w.residual].every(Number.isFinite)
    ||!['ACTIVE_NONRESPONSE','RELATIVE_LEADER','OPPOSITE_MOVE','OWN_ACCELERATION','ORDINARY'].includes(w.kind)
    ||!['WATCH','READY','WAIT_LOCATION','DORMANT','LOW_ACTIVITY','MISSING_DATA'].includes(w.phase)
    ||!Array.isArray(w.moves)||!Array.isArray(w.marketMoves)||w.moves.length!==4||w.marketMoves.length!==4
    ||[...w.moves,...w.marketMoves,w.turnover15,w.activityRatio].some(v=>v!==null&&!Number.isFinite(v))
    ||typeof w.fresh!=='boolean'||typeof w.active!=='boolean'||typeof w.code!=='string'
    ||w.firstSeenAt>w.lastSeenAt||w.lastSeenAt>s.updatedAt||w.sourceAt>w.observedAt||w.observedAt>s.updatedAt
    ||!Array.isArray(w.changes)||w.changes.length>3||w.changes.some(c=>!Number.isFinite(c.at)||c.at>s.updatedAt||typeof c.code!=='string')
    ||w.route&&(!validMarketRoute(w.route)||w.route.controllerVersion!==SPECIAL_MOVE_VERSION||w.route.branch!=='CONTINUATION'
      ||w.route.proofAt>w.observedAt||!Array.isArray(w.route.proofBars)||w.route.proofBars.length!==3
      ||w.route.proofBars.some((at,i,a)=>!Number.isFinite(at)||at>w.route!.proofAt||i>0&&at<=a[i-1]!)))return;
  return structuredClone(s);
}
export function specialDescription(w:SpecialWatch){
  const kind={ACTIVE_NONRESPONSE:'近期成交活跃，却没有响应市场波动',RELATIVE_LEADER:'相对市场明显走强或走弱',
    OPPOSITE_MOVE:'实际方向与市场不同',OWN_ACCELERATION:'自身推进明显加速',ORDINARY:'当前未发现特别表现'}[w.kind];
  const next={SPECIAL_WATCH:'持续观察会补涨、继续不响应，还是开始独自下跌；方向尚未授权',SPECIAL_READY:'自身离开或回踩重启已确认，核对实际入场位置',
    SPECIAL_LOCATION:'当前位置离承接太远或扣费空间不足，等待有效回踩',SPECIAL_COVERAGE:'等待本币连续价格、真实近期成交量与新鲜报价',
    SPECIAL_LOW_ACTIVITY:'近期成交太低或明显萎缩，不把安静当作异常机会',SPECIAL_NO_RESPONSE:'特别表现已记录，等待本币真正启动并保留价格优势',
    SPECIAL_EVENT_ENDED:'旧爆发段已失去承接，等待一段新的有效启动',SPECIAL_EVENT_OLD:'旧启动已超出入场时效，等待新的回踩重启',
    SPECIAL_DORMANT:'暂时离开扫描池，保留原观察时间与证据；当前不授权交易',SPECIAL_ORDINARY:'保留观察，不生成普通回归交易'}[w.code]??w.code;
  return{reason:kind,next};
}
function ownRoute(w:SpecialWatch,rs:CandleLike[],fast:CandleLike[],q:QuoteLike,now:number):{route?:MarketRoute;code:string}{
  const price=(q.bestBid+q.bestAsk)/2,geometry=reactionGeometry(rs,now),ref=geometry.area;
  if(!ref)return{code:'SPECIAL_COVERAGE'};
  const minute=fast.length>=15&&now-(fast.at(-1)!.time*1000+60000)<=120000,
    structural=minute?fast:rs,step=minute?60000:300000,recent=structural.slice(-3),last=recent.at(-1),prior=recent.at(-2),first=recent[0],
    epsilon=Math.max(price*.0002,geometry.atr*.10),stamp=last?last.time*1000+step:0;
  if(!last||!prior||!first||now-stamp>(minute?120000:600000))return{code:'SPECIAL_COVERAGE'};
  const old=w.route;
  const oldRestart=old&&first.time*1000+step>old.proofAt&&d(old.side)*(prior.close-first.close)<-epsilon
    &&d(old.side)*(last.close-first.close)>epsilon;
  if(old&&d(old.side)*(price-old.stop)>0&&d(old.side)*(last.close-old.stop)>-epsilon){
    // The original event cannot turn into a fresh identity on every tick. Only
    // a new completed pullback/restart after its proof can earn another event.
    if(!oldRestart){
      if(now-old.proofAt>12*60000)return{code:'SPECIAL_EVENT_OLD'};
      return location(old,price,epsilon);
    }
  }
  for(const side of ['LONG','SHORT'] as const){
    if(old&&side===old.side&&!oldRestart)continue;
    const sign=d(side),boundary=sign>0?ref.upper:ref.lower,
      retained=sign*(prior.close-boundary)>epsilon&&sign*(last.close-boundary)>epsilon
        &&sign*(last.close-prior.close)>-epsilon&&sign*(last.close-first.close)>epsilon,
      retest=sign*(first.close-boundary)>epsilon&&sign*(prior.close-boundary)>-epsilon
        &&sign*(prior.close-first.close)<-epsilon&&sign*(last.close-first.close)>epsilon;
    if(!(retained||retest)||stamp<=ref.formedAt||old&&stamp<=old.proofAt)continue;
    // A completed retest earns its own support, even when the initial burst
    // left the old 5m reference far behind. First departure remains anchored
    // to that old boundary; never invent a tighter stop merely to chase it.
    const stop=sign>0?Math.min(...(retest?[]:[boundary]),...recent.map(r=>r.low))-epsilon
      :Math.max(...(retest?[]:[boundary]),...recent.map(r=>r.high))+epsilon,
      target=last.close+sign*Math.max(price*.015,geometry.atr*4,Math.abs(last.close-stop)*2.5),
      route:MarketRoute={version:MARKET_AUTHORITY_VERSION,controllerVersion:SPECIAL_MOVE_VERSION,epoch:1,phase:sign>0?'UP':'DOWN',
        relation:'INDEPENDENT',branch:'CONTINUATION',side,proofAt:stamp,proofPrice:last.close,proofPath:retest?'RETEST_RESTART':'HOLD_OUTSIDE',
        proofBars:recent.map(r=>r.time*1000+step),stop,target,targetBasis:'VOLATILITY_ESTIMATE',reference:structuredClone(ref),
        reason:`${specialDescription(w).reason}；${retest?'自身回踩守住后重新推进':'自身离开后连续保留价格优势'}；按实际方向参与爆发段`};
    return location(route,price,epsilon);
  }
  return{code:old?'SPECIAL_EVENT_ENDED':'SPECIAL_NO_RESPONSE'};
}
function location(route:MarketRoute,price:number,epsilon:number){
  const sign=d(route.side),risk=sign*(price-route.stop),room=sign*(route.target-price),cost=price*.0019;
  if(risk<=0||risk/price>.035||room-cost<cost*2||(room-cost)/(risk+cost)<1.35
    ||sign*(price-route.proofPrice!)>Math.max(epsilon*3,Math.abs(route.proofPrice!-route.stop)*.5))return{code:'SPECIAL_LOCATION'};
  return{route,code:'SPECIAL_READY'};
}
export function advanceSpecialResearch(input:{previous?:SpecialResearch;now:number;paths:Record<string,CandleLike[]>;
  minutes?:Record<string,CandleLike[]>;quotes:Record<string,QuoteLike>;states:Record<string,MarketSymbolState>;protectedSymbols?:string[]}):SpecialResearch{
  const s=normalizeSpecialResearch(input.previous)??{version:SPECIAL_MOVE_VERSION,startedAt:input.now,updatedAt:0,watches:{},marketMoves:[null,null,null,null],dropped:0,bytes:0};
  if(input.now<s.updatedAt)return s;s.updatedAt=input.now;
  const paths=Object.fromEntries(Object.entries(input.paths).map(([symbol,rows])=>[symbol,specialRows(rows,input.now)])),groups=new Map<string,Array<Array<number|null>>>();
  for(const [symbol,rows] of Object.entries(paths))if(rows.length>=16&&input.now-(rows.at(-1)!.time*1000+300000)<=600000){
    const group=input.states[symbol]?.clusterId??symbol,list=groups.get(group)??[];list.push([3,6,9,12].map(n=>move(rows,n)));groups.set(group,list);
  }
  const grouped=[...groups.values()].map(list=>[0,1,2,3].map(i=>med(list.flatMap(row=>row[i]==null?[]:[row[i]!]))));
  s.marketMoves=[0,1,2,3].map(i=>grouped.length>=3?med(grouped.map(g=>g[i]!)):null);
  const observed=new Set<string>();
  for(const [symbol,rows] of Object.entries(paths)){
    if(!input.states[symbol])continue;observed.add(symbol);
    const state=input.states[symbol]!,q=input.quotes[symbol],activity=recentSpecialActivity(rows),
      livePrice=q?.fresh&&q.observedAt<=input.now&&input.now-q.observedAt<=10000&&q.bestBid>0&&q.bestAsk>=q.bestBid
        ?(q.bestBid+q.bestAsk)/2:null,
      moves=[3,6,9,12].map(n=>livePrice!=null&&rows.length>n?livePrice/rows.at(-n-1)!.close-1:move(rows,n)),
      own=moves[1]??0,market=s.marketMoves[1],old=s.watches[symbol],
      normalBeta=old&&old.kind!=='ORDINARY'?old.beta:clamp(state.beta,-3,3),normalCorrelation=old&&old.kind!=='ORDINARY'?old.correlation:state.correlation,
      expected=market==null?0:normalBeta*market,residual=own-expected,
      vol=Math.max(.001,state.volatility*Math.sqrt(6)),nonresponse=market!=null&&normalCorrelation>=.45
        &&Math.abs(expected)>=Math.max(.004,vol*.75)&&Math.abs(own)<=Math.abs(expected)*.30,
      opposite=market!=null&&Math.abs(market)>=.003&&own*market<0&&Math.abs(own)>=Math.max(.003,vol*.6),
      leader=Math.abs(residual)>=Math.max(.004,vol)&&Math.abs(own)>=.004,
      acceleration=Math.abs(moves[0]??0)>=Math.max(.006,state.volatility*Math.sqrt(3)*2)
        &&Math.abs(moves[0]??0)>=Math.abs(own)*.65,
      kind:SpecialKind=nonresponse?'ACTIVE_NONRESPONSE':opposite?'OPPOSITE_MOVE':leader?'RELATIVE_LEADER':acceleration?'OWN_ACCELERATION':'ORDINARY',
      sourceAt=rows.length?rows.at(-1)!.time*1000+300000:0,
      fresh=!!q?.fresh&&q.observedAt<=input.now&&input.now-q.observedAt<=10000&&q.bestBid>0&&q.bestAsk>=q.bestBid
        &&rows.length>=16&&sourceAt<=input.now&&input.now-sourceAt<=600000&&(q.sourceCount??0)>=2&&(q.disagreementRate??0)<=.01,
      w:SpecialWatch={symbol,firstSeenAt:old&&input.now-old.firstSeenAt<SPECIAL_WATCH_TTL?old.firstSeenAt:input.now,lastSeenAt:input.now,observedAt:input.now,sourceAt,kind,
        score:kind==='ORDINARY'?0:clamp(60+Math.abs(residual)/vol*8+(activity.activityRatio??1)*3,0,98),
        active:activity.active,fresh,correlation:normalCorrelation,beta:normalBeta,moves,marketMoves:[...s.marketMoves],residual,
        turnover15:activity.turnover15,activityRatio:activity.activityRatio,phase:'WATCH',code:'SPECIAL_WATCH',
        ...(old?.route?{route:structuredClone(old.route)}:{}),changes:old?.changes??[]};
    const remembered=old&&old.kind!=='ORDINARY'&&input.now-old.firstSeenAt<SPECIAL_WATCH_TTL;
    if(!activity.active){w.phase=activity.turnover15==null?'MISSING_DATA':'LOW_ACTIVITY';w.code=activity.turnover15==null?'SPECIAL_COVERAGE':'SPECIAL_LOW_ACTIVITY';}
    else if(!fresh){w.phase='MISSING_DATA';w.code='SPECIAL_COVERAGE';}
    else if(kind==='ORDINARY'&&!remembered){w.code='SPECIAL_ORDINARY';}
    else{
      if(kind==='ORDINARY'&&old){w.kind=old.kind;w.score=Math.max(35,old.score-.05);}
      const decision=ownRoute(w,rows,specialRows(input.minutes?.[symbol],input.now,60000),q!,input.now);
      w.code=decision.code;w.phase=decision.route?'READY':decision.code==='SPECIAL_LOCATION'?'WAIT_LOCATION':'WATCH';
      if(decision.route)w.route=decision.route;
    }
    if(!old||old.kind!==w.kind||old.code!==w.code)w.changes=[...w.changes,{at:input.now,kind:w.kind,code:w.code}].slice(-3);
    s.watches[symbol]=w;
  }
  const protectedSet=new Set(input.protectedSymbols??[]);
  for(const [symbol,w] of Object.entries(s.watches))if(!observed.has(symbol)){
    if(!protectedSet.has(symbol)&&input.now-w.lastSeenAt>SPECIAL_WATCH_TTL){delete s.watches[symbol];s.dropped++;}
    else{w.fresh=false;w.phase='DORMANT';w.code='SPECIAL_DORMANT';}
  }
  const ranked=Object.values(s.watches).sort((a,b)=>Number(protectedSet.has(b.symbol))-Number(protectedSet.has(a.symbol))
    ||Number(b.fresh&&b.active)-Number(a.fresh&&a.active)||b.score-a.score||b.lastSeenAt-a.lastSeenAt);
  s.watches=Object.fromEntries(ranked.slice(0,64).map(w=>[w.symbol,w]));s.dropped+=Math.max(0,ranked.length-64);
  while(bytes(s)>SPECIAL_RESEARCH_BYTES){const key=Object.keys(s.watches).reverse().find(k=>!protectedSet.has(k));if(!key)break;delete s.watches[key];s.dropped++;}
  s.bytes=bytes(s);s.bytes=bytes(s);if(s.bytes>SPECIAL_RESEARCH_BYTES)throw new Error('SPECIAL_RESEARCH_BOUND');return s;
}
export function specialMarketRoute(research:SpecialResearch|undefined,symbol:string,price:number,now:number){
  const w=research?.watches[symbol];
  if(!w||!w.fresh||!w.active||now-w.observedAt>10000||w.observedAt>now||w.phase!=='READY'||!w.route)
    return{route:null,code:w?.code??'SPECIAL_COVERAGE',reason:w?specialDescription(w).next:'等待本币完整的特别行情研究'};
  const result=location(w.route,price,price*.0002);
  return{route:result.route??null,code:result.code,reason:result.route?.reason??'当前位置不具备有效承接与扣费空间'};
}
/** Whole-market light discovery uses existing bulk rows only; unknown recent
 * turnover must be verified by deep research before any order. */
export type SpecialRadarHistory=Map<string,{at:number;price:number}[]>;
/** Minute price snapshots of existing bulk feeds, not OHLC proof or synthetic
 * candles. No interpolation/backfill. Cap1024coins/64points, expire after2h. */
export function observeSpecialRadar(rows:MultiTurnUniverseTicker[],history:SpecialRadarHistory,now:number){
  for(const [symbol,points] of history)if(!points.length||now-points.at(-1)!.at>2*60*60000)history.delete(symbol);
  const out=rows.map(row=>{
    const at=row.observedAt;
    if(!at||at>now||now-at>15000||!(row.last>0)||(row.sourceCount??0)<1)return row;
    const points=history.get(row.symbol)??[],last=points.at(-1);
    if(!last||at>last.at){if(last&&Math.floor(at/60000)===Math.floor(last.at/60000))points[points.length-1]={at,price:row.last};
      else points.push({at,price:row.last});while(points.length>64)points.shift();history.set(row.symbol,points);}
    const window=(minutes:number)=>{
      const anchor=[...points].reverse().find(p=>p.at<=at-minutes*60000);
      const covered=anchor&&points.filter(p=>p.at>=anchor.at);
      return anchor&&at-minutes*60000-anchor.at<=120000&&covered
        &&covered.every((p,i)=>i===0||p.at-covered[i-1]!.at<=120000)?row.last/anchor.price-1:undefined;
    };
    return{...row,move15Rate:window(15),move30Rate:window(30),move60Rate:window(60)};
  });
  while(history.size>1024)history.delete(history.keys().next().value!);return out;
}
export function selectSpecialMoveUniverse(input:{rows:MultiTurnUniverseTicker[];limit:number;lockedSymbols:Iterable<string>;
  research?:SpecialResearch;rotationSeed:number;now:number}):AnchorOpportunityUniverseRow[]{
  const liquid=input.rows.filter(forwardExecutionUniverseEligible),timed=liquid.filter(r=>Number.isFinite(r.move15Rate)),
    useTimed=timed.length>=5,market=med((useTimed?timed:liquid).map(r=>useTimed?r.move15Rate!:r.shortMoveRate??0)),used=new Set<string>(),out:AnchorOpportunityUniverseRow[]=[],
    scored=liquid.map(row=>{const known=!useTimed||Number.isFinite(row.move15Rate),own=useTimed?row.move15Rate??0:row.shortMoveRate??0,residual=known?own-market:0,
      response=known&&Math.abs(market)>=(useTimed?.004:.0004)&&Math.abs(own)<=Math.abs(market)*.25,
      watch=input.research?.watches[row.symbol],remembered=watch?.active&&watch.kind!=='ORDINARY'&&input.now-watch.lastSeenAt<90*60000,
      score=Math.abs(residual)*(useTimed?800:10000)+Math.abs(own)*(useTimed?200:3000)
        +Math.abs(row.shortMoveRate??0)*5000+(response?8:0)+(remembered?6:0)+Math.min(2,Math.log10(Math.max(1,row.volume24hUsd))/5);
      return{row,score,response,remembered};}),push=(symbol:string,source:AnchorOpportunityUniverseRow['selectionSource'])=>{
        const x=scored.find(v=>v.row.symbol===symbol);if(!x||used.has(symbol)||out.length>=input.limit)return;
        used.add(symbol);out.push({...x.row,selectionSource:source,activityScore:x.score,range24hRate:(x.row.high24h-x.row.low24h)/x.row.last,
          liquidityFloorUsd:1_000_000});};
  for(const symbol of input.lockedSymbols)push(symbol,'LOCKED_ANCHOR');
  for(const x of scored.filter(x=>x.remembered).sort((a,b)=>b.score-a.score).slice(0,8))push(x.row.symbol,'RESEARCH_WATCH');
  for(const x of scored.sort((a,b)=>b.score-a.score).slice(0,Math.max(0,input.limit-out.length-4)))push(x.row.symbol,'SPECIAL_RESPONSE');
  const rest=scored.filter(x=>!used.has(x.row.symbol)).sort((a,b)=>a.row.symbol.localeCompare(b.row.symbol));
  const start=rest.length?Math.floor(input.rotationSeed/6)*4%rest.length:0;
  for(let i=0;i<Math.min(4,rest.length);i++)push(rest[(start+i)%rest.length]!.row.symbol,'EXPLORATION');
  for(const x of scored)push(x.row.symbol,'SPECIAL_RESPONSE');return out;
}
