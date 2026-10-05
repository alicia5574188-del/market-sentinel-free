/** Frozen pre-event geometry and causal plans. Pure: no IO, account controls or sizing. */
import type {CandleLike,QuoteLike} from './market-intelligence-engine.ts';
import type {Trade,Quote} from './forward-relations.ts';
import {specialRows,recentSpecialActivity} from './special-move.ts';
import {MARKET_AUTHORITY_VERSION,type MarketRoute} from './market-authority.ts';
import {selectRangePlans,rankRangeDiscovery,type RangeRank} from './range-scheduler.ts';
export const ANOMALY_RANGE_VERSION='anomaly-range-v1';
export const RANGE_RESEARCH_BYTES=24*1024,RANGE_WINDOW_LIMIT=30,RANGE_MIN_VOLUME_24H_USD=1_000_000,WICK_WATCH_MS=15*60*1000;
type Side='LONG'|'SHORT';
export type RangeKind='EDGE_BREAKOUT'|'EDGE_RETURN'|'INTERNAL_TREND'|'WICK';
export type RangeDiscovery={at:number;scanned:number;shared:number;excluded:number;marketSamples:number;marketMove:number|null;
  anomalies:{symbol:string;detectedAt:number;source:string;sourceCount:number;own:number;residual:number;score:number;kind:string;frozen?:boolean}[];queued:number;loaded:number;
  /** Gate 24h turnover for symbols already under watch. Not persisted. */
  gateVolume?:Record<string,number>};
export type RangeWindow={source:string;start:number;cutoff:number;count:number;ohlc64:string};
export type RangeSwing={price:number;at:number;confirmedAt:number;kind:'HIGH'|'LOW'};
export type RangeEvent={id:string;symbol:string;detectedAt:number;source:string;score:number;own:number;residual:number;anomalyKind:string;
  H:number;L:number;n5:number;E:number;D:number;minutes:number;highAt:number;lowAt:number;direction:'UP'|'DOWN'|'NEUTRAL';swings:RangeSwing[];
  phase:'WATCH'|'CONFIRMING'|'READY'|'EXECUTING'|'HOLDING'|'EXPIRED'|'DONE';reason:string;lastAt:number;price:number;anchorPrice:number;active:boolean;
  upperExtreme:number;lowerExtreme:number;upperTouchedAt:number;lowerTouchedAt:number;
  activity?:{turnover15:number|null;activityRatio:number|null;at:number};
  proof?:{kind:RangeKind;side:Side;fiveAt:number;at:number;price:number;stop:number;target:number;bars:number[];n1:number;bodyBaseline:number;fiveBar:number[];minuteBars:number[][];id:string;wickMultiple?:number;scannedAt?:number};
  consumedAt:number;tradeId?:string;predecessorId?:string;reverseAfter?:number;reverseEligible?:boolean;
  admission?:{at:number;reason:string};exit?:{at:number;reason:string;net:number|null};
  setup?:{kind:RangeKind;side:Side;at:number};rank?:number;
  outcomes:{minutes:number;dueAt:number;at:number|null;price:number|null;move:number|null;status:'PENDING'|'OBSERVED'|'MISSING'}[]};
export type RangeResearch={version:typeof ANOMALY_RANGE_VERSION;startedAt:number;updatedAt:number;events:Record<string,RangeEvent>;bytes:number;capacitySkipped:number;discovery?:RangeDiscovery;error?:string}&RangeLifecycle;
export type RangeOutcomeRecord=Pick<RangeEvent,'id'|'symbol'|'detectedAt'|'source'|'anchorPrice'|'H'|'L'|'direction'|'reason'|'outcomes'>&{parked?:boolean};
export const RANGE_OUTCOME_BYTES=6*1024;
type RangeLifecycle={recent?:RangeOutcomeRecord[];recycled?:number;omittedOutcomes?:number;ranking?:RangeRank[];waiting?:number;rotated?:number};
const terminal=(e:RangeEvent)=>e.phase==='DONE'||e.phase==='EXPIRED';
const planExpired=(e:RangeEvent,now:number)=>now-(e.reverseEligible&&e.reverseAfter?e.reverseAfter:e.detectedAt)>=(e.reverseEligible?1800000:WICK_WATCH_MS);
/** Outcome-only observations yield seats to executable work; holdings never rotate out. */
export function rangeObservationSymbols(s:RangeResearch|undefined,held:string[],anomalies:RangeDiscovery['anomalies'],now:number,limit=RANGE_WINDOW_LIMIT){
  const active=Object.values(s?.events??{}).filter(e=>!terminal(e)&&!planExpired(e,now)).sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity)).map(e=>e.symbol),
    recent=[...Object.values(s?.events??{}).filter(e=>terminal(e)||planExpired(e,now)),...(s?.recent??[])]
      .filter(e=>e.outcomes.some(o=>o.status==='PENDING')).map(e=>e.symbol);
  const pinned=[...new Set([...held,...active])].slice(0,limit),newcomers=anomalies.filter(a=>now-a.detectedAt<WICK_WATCH_MS&&!pinned.includes(a.symbol));
  return [...new Set([...pinned,...rankRangeDiscovery(newcomers,now,Math.max(0,limit-pinned.length)).map(a=>a.symbol),...recent])].slice(0,limit);
}
/** Rotate attempts as well as successes so a failing first batch cannot starve the rest. */
export function fairRangeRefreshBatch(pool:string[],due:string[],attempts:Map<string,number>,now:number,limit:number){
  const resident=new Set(pool);for(const symbol of attempts.keys())if(!resident.has(symbol))attempts.delete(symbol);
  const batch=[...due].sort((a,b)=>(attempts.get(a)??0)-(attempts.get(b)??0)).slice(0,limit);
  for(const symbol of batch)attempts.set(symbol,now);return batch;
}
/** Immutable original OHLC lives once per plan, then on its financial trade. */
export type RangeWindows=Record<string,RangeWindow>;
export type RangeHolding={version:typeof ANOMALY_RANGE_VERSION;eventId:string;kind:RangeKind;H:number;L:number;E:number;D:number;n5:number;
  scale:number;scaleAt:number;source:string;window:RangeWindow;activity?:RangeEvent['activity'];proof:NonNullable<RangeEvent['proof']>;swings:RangeSwing[];
  initialRisk:number;lastBarAt:number;insideAt:number;quoteAt:number;peak:number;peakAt:number;retainedPeak:number;peakSamples:number;
  progressReviewAt:number;stage:'HOLD'|'REVIEW'|'EXIT';reason:string;reverseEligible:boolean;breakoutAt?:number;returnProbeAt?:number;returnBackAt?:number;scannedAt?:number};
const d=(side:Side)=>side==='LONG'?1:-1,median=(a:number[])=>{const b=a.filter(Number.isFinite).sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]!:0;};
const end=(r:CandleLike,ms=300000)=>r.time*1000+ms,bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
export function encodeRangeWindow(rows:CandleLike[],source:string,cutoff:number):RangeWindow{
  const raw=new Uint8Array(rows.length*32),view=new DataView(raw.buffer);
  rows.forEach((r,i)=>[r.open,r.high,r.low,r.close].forEach((v,j)=>view.setFloat64(i*32+j*8,v,true)));
  return{source,start:rows[0]!.time*1000,cutoff,count:rows.length,ohlc64:btoa(String.fromCharCode(...raw))};
}
export function decodeRangeWindow(w:RangeWindow){
  if(!w||!['BYBIT','OKX','KUCOIN','MEXC','HTX'].includes(w.source)||![119,120].includes(w.count)
    ||!Number.isFinite(w.start)||w.start<=0||w.cutoff!==w.start+w.count*300000||w.ohlc64.length>5120)throw new Error('RANGE_WINDOW_INVALID');
  const raw=Uint8Array.from(atob(w.ohlc64),c=>c.charCodeAt(0));if(raw.length!==w.count*32)throw new Error('RANGE_WINDOW_INVALID');
  const view=new DataView(raw.buffer);return Array.from({length:w.count},(_,i)=>{
    const [open,high,low,close]=[0,1,2,3].map(j=>view.getFloat64(i*32+j*8,true));
    if(![open,high,low,close].every(Number.isFinite)||low!<=0||high!<Math.max(open!,close!)||low!>Math.min(open!,close!))throw new Error('RANGE_WINDOW_INVALID');
    return{time:(w.start+i*300000)/1000,open:open!,high:high!,low:low!,close:close!,volume:0,volumeVenue:w.source};
  });
}
const noise=(rows:CandleLike[],tick:number)=>Math.max(2*tick,median(rows.slice(-20).map((r,i,a)=>Math.max(r.high-r.low,i?Math.abs(r.high-a[i-1]!.close):0,i?Math.abs(r.low-a[i-1]!.close):0))));
/** Repeated holes between 5m candles mean the book is too thin to trade. One impulse candle is not enough. */
export function thinFiveTape(rows:CandleLike[],n5:number){
  const recent=rows.slice(-36);if(recent.length<12||!(n5>0))return false;let gaps=0;
  for(let i=1;i<recent.length;i++){const prev=recent[i-1]!,cur=recent[i]!,limit=Math.max(n5,prev.close*.004),
    hole=Math.max(0,cur.low-prev.high,prev.low-cur.high);
    if((cur.time-prev.time)*1000>300000||hole>limit||Math.abs(cur.open-prev.close)>limit*2)gaps++;}
  return gaps>=4&&gaps/(recent.length-1)>=.25;
}
/** A flat zero-sum print is not a traded bar. Gate hides those minutes on the chart and still returns them. */
export const FIVE_BAR_MIN_TURNOVER_USD=1_000;
export function sparseFiveTurnover(rows:CandleLike[],now=Number.POSITIVE_INFINITY){
  const step=300,slots=48,done=rows.filter(r=>Number.isFinite(r.time)&&r.time>0&&r.time*1000+step*1000<=now);
  if(!done.length)return false;
  const byTime=new Map<number,CandleLike>();for(const r of done)byTime.set(r.time,r);
  const last=Math.max(...byTime.keys());let known=0,alive=0,streak=0,maxStreak=0;const dead:boolean[]=[];
  for(let i=slots-1;i>=0;i--){const r=byTime.get(last-i*step),quoted=!!r&&r.turnoverUsd!=null&&Number.isFinite(r.turnoverUsd);
    if(quoted)known++;const quiet=!r||(quoted&&r.turnoverUsd!<FIVE_BAR_MIN_TURNOVER_USD);
    if(quiet){streak++;maxStreak=Math.max(maxStreak,streak);}else{streak=0;alive++;}dead.push(quiet);}
  return known>=12&&(alive/slots<.6||maxStreak>=6||dead.slice(-3).filter(Boolean).length>=2);
}
/** Reversal-confirmed turns, never retrospectively actionable at the extreme. */
export function rangeSwings(rows:CandleLike[],n5:number){
  const swings:RangeSwing[]=[];if(!rows.length)return swings;
  let kind:'HIGH'|'LOW'|null=null,high=rows[0]!,low=rows[0]!;
  for(const r of rows){
    if(kind!=='LOW'&&r.high>=high.high)high=r;if(kind!=='HIGH'&&r.low<=low.low)low=r;
    if(kind!=='LOW'&&high.high-r.close>=1.5*n5){swings.push({kind:'HIGH',price:high.high,at:high.time*1000,confirmedAt:end(r)});kind='LOW';low=r;}
    else if(kind!=='HIGH'&&r.close-low.low>=1.5*n5){swings.push({kind:'LOW',price:low.low,at:low.time*1000,confirmedAt:end(r)});kind='HIGH';high=r;}
  }
  return swings;
}
export function rangeDirection(swings:RangeSwing[],n5:number,now:number):RangeEvent['direction']{
  const lows=swings.filter(s=>s.kind==='LOW').slice(-3),highs=swings.filter(s=>s.kind==='HIGH').slice(-3),
    up=lows.length===3&&lows.every((s,i)=>!i||s.price-lows[i-1]!.price>.5*n5),
    down=highs.length===3&&highs.every((s,i)=>!i||highs[i-1]!.price-s.price>.5*n5);
  if(up&&!down&&now-lows.at(-1)!.confirmedAt<=7200000)return'UP';
  if(down&&!up&&now-highs.at(-1)!.confirmedAt<=7200000)return'DOWN';return'NEUTRAL';
}
export function strongRangeProof(minutes:CandleLike[],fiveAt:number,side:Side,n5:number,tick:number,inside:(price:number)=>boolean){
  const baseline=minutes.filter(r=>end(r,60000)<=fiveAt).slice(-20);if(baseline.length<20)return;
  const n1=noise(baseline,tick),body=median(baseline.map(r=>Math.abs(r.close-r.open))),dir=d(side),
    after=minutes.filter(r=>r.time*1000>=fiveAt),strong=(r:CandleLike)=>r.high>r.low&&dir*(r.close-r.open)>0
      &&Math.abs(r.close-r.open)/(r.high-r.low)>=.55&&Math.abs(r.close-r.open)>=body
      &&(dir>0?r.high-r.close:r.close-r.low)/(r.high-r.low)<=.25;
  for(const count of [2,3]){const a=after.slice(-count);if(a.length!==count||a.some((r,i)=>!inside(r.close)||i>0&&r.time-a[i-1]!.time!==60))continue;
    const s=a.filter(strong);if(count===2&&s.length!==2||count===3&&s.length<2)continue;
        if(count===3&&a.some(r=>!strong(r)&&(Math.abs(r.close-r.open)>n1*.5||dir*(r.close-r.open)<-n1*.25)))continue;
    if(dir*(a.at(-1)!.close-a[0]!.open)<Math.max(n1,.25*n5)||dir*(s.at(-1)!.close-s[0]!.close)<=0)continue;
    return{at:end(a.at(-1)!,60000),price:a.at(-1)!.close,bars:a.map(r=>end(r,60000)),n1,bodyBaseline:body,minuteBars:a.map(r=>[r.time,r.open,r.high,r.low,r.close])};
  }
}
const SWING_LOOKBACK=288;
function puncture(rows:CandleLike[],high:RangeSwing,tick:number){
  const i=rows.findIndex(r=>r.time*1000===high.at);if(i<12)return false;
  const prev=rows.slice(i-12,i),n=noise(prev,tick),limit=Math.max(n,Math.max(2*tick,.2*n)),shelf=Math.max(...prev.map(r=>r.high));
  return high.price-shelf>limit;
}
/** Highest confirmed high and the low before it.
 * A later high replaces that ceiling only while price is still inside the later swing.
 * Once price has left that swing, the ceiling stays the unbroken major high and the floor
 * is the confirmed pullback low after it. */
export function activeSwingRange(rows:CandleLike[],tick:number,price?:number){
  if(rows.length<30)return;
  const n5=noise(rows,tick),swings=rangeSwings(rows,n5),highs=swings.filter(s=>s.kind==='HIGH');
  if(!highs.length||!(n5>0))return;
  const D=Math.max(2*tick,.2*n5),top=highs.reduce((a,b)=>a.price>=b.price?a:b);let high=top,earlier:RangeSwing|undefined;
  for(const s of highs)if(s.at<top.at&&top.price-s.price>D&&(!earlier||s.price>earlier.price))earlier=s;
  const mark=price??rows.at(-1)!.close;
  if(earlier&&puncture(rows,top,tick)&&mark<=earlier.price+D)high=earlier;
  let low=swings.filter(s=>s.kind==='LOW'&&s.at<high.at).at(-1);
  if(!low||!(high.price>low.price))return;
  const floor=low,ceiling=high,room=Math.max(n5,D);
  const downBar=rows.find(r=>r.time*1000>floor.at&&r.close<=floor.price-room);
  const upBar=rows.find(r=>r.time*1000>ceiling.at&&r.close>=ceiling.price+room);
  const downAt=downBar?downBar.time*1000:0,upAt=upBar?upBar.time*1000:0;let rebuilt=false;
  if(downAt&&downAt>=upAt){const nh=highs.filter(h=>h.at>downAt&&h.price<ceiling.price-D).at(-1),nl=nh&&swings.filter(s=>s.kind==='LOW'&&s.at<nh.at).at(-1);
    if(nh&&nl&&nh.price>nl.price&&mark<=nh.price+D&&mark>=nl.price-D){high=nh;low=nl;rebuilt=true;}
    else if(nh){const pull=swings.filter(s=>s.kind==='LOW'&&s.at>ceiling.at).at(-1);
      if(pull&&ceiling.price>pull.price){high=ceiling;low=pull;rebuilt=true;}}}
  else if(upAt){const nl=swings.filter(s=>s.kind==='LOW'&&s.at>upAt&&s.price>floor.price+D).at(-1),nh=nl&&highs.filter(h=>h.at<nl.at).at(-1);
    if(nl&&nh&&nh.price>nl.price){high=nh;low=nl;rebuilt=true;}}
  const H=high.price,L=low.price,E=Math.min(.75*n5,.1*(H-L));
  if(!(H>L&&E>D))return;
  return{H,L,n5,E,D,highAt:high.at,lowAt:low.at,highConfirmed:high.confirmedAt,lowConfirmed:low.confirmedAt,rejected:high!==top,rebuilt};
}
const RANGE_REDRAW_MS=2*60*60*1000;
function outsideBox(bar:CandleLike,box:{H:number;L:number;D:number}){return bar.close>box.H+box.D||bar.close<box.L-box.D;}
/** A broken range stays in force for two hours. After that, the next range is either a return
 * into the old box that formed a new extreme, or a pullback that traded back near the breakout extreme. */
function postBreakRange(old:{H:number;L:number;D:number;n5:number},next:{H:number;L:number;D:number;n5:number;lowAt:number;highAt:number},rows:CandleLike[],mark:number,brokeAt:number){
  const n5=Math.max(old.n5,next.n5),swings=rangeSwings(rows,next.n5);
  if(mark<=old.H+old.D&&mark>=old.L-old.D&&swings.some(s=>s.confirmedAt>brokeAt&&s.price<=old.H&&s.price>=old.L))return true;
  if(!(mark<=next.H+next.D&&mark>=next.L-next.D))return false;
  const breakBar=rows.find(r=>end(r)>=brokeAt&&end(r)<brokeAt+300000),up=!!breakBar&&breakBar.close>old.H;
  if(up){const since=rows.filter(r=>end(r)>=brokeAt),spike=Math.max(...since.map(r=>r.high));
    return next.lowAt+300000>brokeAt&&next.H>=spike-n5&&since.some(r=>r.time*1000>next.lowAt&&r.high>=spike-n5);}
  const since=rows.filter(r=>end(r)>=brokeAt),spike=Math.min(...since.map(r=>r.low));
  return next.highAt+300000>brokeAt&&next.L<=spike+n5&&since.some(r=>r.time*1000>next.highAt&&r.low<=spike+n5);
}
/** The range still being traded.
 * A high is established only after price pulls away and comes back without closing through it.
 * A low printed on the way down is not a floor unless price then returns to that high.
 * A high made after the close already left the prior ceiling is the breakout leg, not a new range. */
export function lastingRange(rows:CandleLike[],tick:number,price?:number){
  const mark=price??rows.at(-1)?.close,proposed=activeSwingRange(rows,tick,mark);
  if(!proposed||mark==null)return proposed?{...proposed,brokeAt:0}:undefined;
  const n5=proposed.n5,D=proposed.D,swings=rangeSwings(rows,n5),highs=swings.filter(s=>s.kind==='HIGH'),lows=swings.filter(s=>s.kind==='LOW');
  const retestBar=(at:number,level:number)=>{let pulled=false;for(const r of rows){if(r.time*1000<=at)continue;
    if(!pulled){if(level-r.low>=n5)pulled=true;continue;}
    if(r.high>=level-n5&&r.high<=level+n5&&r.close<=level+D)return r;}};
  let H=proposed.H,L=proposed.L,highAt=proposed.highAt,lowAt=proposed.lowAt,highConfirmed=proposed.highConfirmed,lowConfirmed=proposed.lowConfirmed,replaced=false;
  if(!retestBar(proposed.highAt,proposed.H)){
    const priorRows=rows.filter(r=>r.time*1000<proposed.highAt),prior=priorRows.length>=30?activeSwingRange(priorRows,tick,priorRows.at(-1)!.close):undefined;
    if(prior&&proposed.H>prior.H+prior.D){const left=rows.find(r=>r.time*1000>prior.highAt&&r.close>prior.H+prior.D);
      if(left&&proposed.highAt>left.time*1000){H=prior.H;L=prior.L;highAt=prior.highAt;lowAt=prior.lowAt;highConfirmed=prior.highConfirmed;lowConfirmed=prior.lowConfirmed;replaced=true;}}
  }
  const cameBack=(after:number,level:number)=>rows.some(r=>r.time*1000>after&&r.high>=level-n5&&r.high<=level+n5&&r.close<=level+D);
  if(lowAt>highAt&&!cameBack(lowAt,H)){
    const returned=lows.filter(s=>s.at>highAt&&s.at<lowAt&&cameBack(s.at,H)).reduce((a,b)=>!a||b.price<a.price?b:a,undefined as RangeSwing|undefined);
    const floor=returned??lows.filter(s=>s.at<highAt).at(-1);
    if(floor&&H>floor.price){L=floor.price;lowAt=floor.at;lowConfirmed=floor.confirmedAt;replaced=true;}
  }
  const qualified=highs.map(h=>({h,back:retestBar(h.at,h.price)})).filter((x):x is {h:RangeSwing;back:CandleLike}=>!!x.back)
    .map(x=>{const between=lows.filter(s=>s.at>x.h.at&&s.at<x.back.time*1000),floor=between.reduce((a,b)=>!a||b.price<a.price?b:a,undefined as RangeSwing|undefined);return floor?{...x,floor}:undefined;})
    .filter((x):x is {h:RangeSwing;back:CandleLike;floor:RangeSwing}=>!!x&&x.h.price-x.floor.price>=3*n5);
  const later=(a:{back:CandleLike},b:{back:CandleLike})=>a.back.time-b.back.time;
  const near=qualified.filter(x=>Math.abs(x.h.price-H)<=n5).sort(later).at(-1),above=qualified.filter(x=>x.h.price>H+n5).sort(later).at(-1);
  if(above&&(!near||above.back.time>near.back.time)&&proposed.highAt>above.back.time*1000){
    H=above.h.price;highAt=above.h.at;highConfirmed=above.h.confirmedAt;L=above.floor.price;lowAt=above.floor.at;lowConfirmed=above.floor.confirmedAt;replaced=true;
  }
  const E=Math.min(.75*n5,.1*(H-L));
  if(!(H>L&&E>D))return{...proposed,brokeAt:0};
  const born=Math.max(highAt,lowAt),breakBar=rows.find(r=>r.time*1000>born&&(r.close>H+D||r.close<L-D)),brokeAt=breakBar?end(breakBar):0;
  if(!replaced&&!brokeAt)return{...proposed,brokeAt:0};
  return{H,L,n5,E,D,highAt,lowAt,highConfirmed,lowConfirmed,rejected:false,rebuilt:false,brokeAt};
}
function rememberSwingPair(existing:RangeSwing[],pair:{H:number;L:number;highAt:number;lowAt:number;highConfirmed:number;lowConfirmed:number}){
  const defining:RangeSwing[]=[{kind:'LOW',price:pair.L,at:pair.lowAt,confirmedAt:Math.max(pair.lowAt,pair.lowConfirmed)},{kind:'HIGH',price:pair.H,at:pair.highAt,confirmedAt:Math.max(pair.highAt,pair.highConfirmed)}];
  const rest=existing.filter(s=>s.at>pair.highAt&&!defining.some(d=>d.kind===s.kind&&s.at===d.at)).sort((a,b)=>b.at-a.at).slice(0,4);
  return [...defining,...rest].sort((a,b)=>a.at-b.at);
}
/** Keep the swing pair that defines H/L. The floor may print after the high once a pullback is confirmed. */
function retainEdgeSwings(existing:RangeSwing[],fresh:RangeSwing[],H:number,L:number,scale:number){
  const px=(p:number)=>p*scale,high=existing.find(s=>s.kind==='HIGH'&&Math.abs(px(s.price)-H)<=H*1e-8),
    low=existing.find(s=>s.kind==='LOW'&&Math.abs(px(s.price)-L)<=L*1e-8);
  if(!high||!low||high.at===low.at)return fresh.slice(-6);
  if(low.at<high.at){if(existing.some(s=>s.kind==='LOW'&&s.at>low.at&&s.at<high.at))return fresh.slice(-6);}
  else if(existing.some(s=>s.kind==='HIGH'&&s.at>high.at&&s.at<low.at&&px(s.price)>H))return fresh.slice(-6);
  const after=Math.max(high.at,low.at);
  const rest=fresh.filter(s=>s.at>after&&!((s.kind===high.kind&&s.at===high.at)||(s.kind===low.kind&&s.at===low.at))).sort((a,b)=>b.at-a.at).slice(0,4);
  return [low,high,...rest].sort((a,b)=>a.at-b.at);
}
function holdingSwingMatches(m:RangeHolding){
  const px=(p:number)=>p*m.scale,high=m.swings.find(s=>s.kind==='HIGH'&&Math.abs(px(s.price)-m.H)<=m.H*1e-8),
    low=m.swings.find(s=>s.kind==='LOW'&&Math.abs(px(s.price)-m.L)<=m.L*1e-8);
  if(!high||!low||high.at===low.at)return false;
  if(low.at<high.at)return !m.swings.some(s=>s.kind==='LOW'&&s.at>low.at&&s.at<high.at);
  return !m.swings.some(s=>s.kind==='HIGH'&&s.at>high.at&&s.at<low.at&&px(s.price)>m.H);
}
function windowGeometry(prior:CandleLike[],tick:number){
  const H=Math.max(...prior.map(r=>r.high)),L=Math.min(...prior.map(r=>r.low)),n5=noise(prior,tick),E=Math.min(.75*n5,.1*(H-L)),D=Math.max(2*tick,.2*n5);
  return{H,L,n5,E,D,highAt:prior.findLast(r=>r.high===H)!.time*1000,lowAt:prior.findLast(r=>r.low===L)!.time*1000};
}
/** The latest range is the balance before a recent extreme, never the extreme itself. */
function inheritedEdge(prior:CandleLike[],tick:number){
  if(prior.length<119)return;
  let highI=0,lowI=0;
  for(let i=1;i<prior.length;i++){if(prior[i]!.high>=prior[highI]!.high)highI=i;if(prior[i]!.low<=prior[lowI]!.low)lowI=i;}
  const recent=prior.length-6;
  for(const i of [highI,lowI].filter((v,n,a)=>v>=recent&&a.indexOf(v)===n).sort((a,b)=>b-a)){
    const base=prior.slice(0,i);if(base.length<30)continue;
    const H=Math.max(...base.map(r=>r.high)),L=Math.min(...base.map(r=>r.low)),n5=noise(base,tick),E=Math.min(.75*n5,.1*(H-L)),D=Math.max(2*tick,.2*n5);
    if(!(H>L&&E>D&&n5>0))continue;
    const bar=prior[i]!,body=bar.close-bar.open,clear=Math.max(D,n5);
    const up=i===highI&&body>=n5&&bar.close>=H+clear,down=i===lowI&&-body>=n5&&bar.close<=L-clear;
    const rejectUp=i===highI&&bar.high>=H&&bar.close<=H-D&&bar.close>=L+D,rejectDown=i===lowI&&bar.low<=L&&bar.close>=L+D&&bar.close<=H-D;
    const kind:RangeKind|undefined=up||down?'EDGE_BREAKOUT':rejectUp||rejectDown?'EDGE_RETURN':undefined;if(!kind)continue;
    const side:Side=up||rejectDown?'LONG':'SHORT',
      stop=kind==='EDGE_BREAKOUT'?side==='LONG'?H-E-D:L+E+D:side==='LONG'?bar.low-D:bar.high+D,
      target=kind==='EDGE_BREAKOUT'?side==='LONG'?bar.high:bar.low:(H+L)/2;
    if(!(stop>0&&target>0))continue;
    return{H,L,n5,E,D,kind,side,event:bar,stop,target,highAt:base.findLast(r=>r.high===H)!.time*1000,lowAt:base.findLast(r=>r.low===L)!.time*1000};
  }
}
function closedMinuteProof(minutes:CandleLike[],eventAt:number,tick:number,now:number,ok:(price:number)=>boolean){
  const a=minutes.filter(r=>r.time*1000>=eventAt&&end(r,60000)<=now).slice(-2);
  if(a.length!==2||a[1]!.time-a[0]!.time!==60||a.some(r=>!ok(r.close)))return;
  const n1=Math.max(tick,median(a.map(r=>Math.max(r.high-r.low,tick))));if(!(n1>0))return;
  return{at:end(a[1]!,60000),price:a[1]!.close,bars:a.map(r=>end(r,60000)),n1,bodyBaseline:median(a.map(r=>Math.abs(r.close-r.open))),minuteBars:a.map(r=>[r.time,r.open,r.high,r.low,r.close])};
}
function rangeGeometryMatches(rows:CandleLike[],H:number,L:number,scale:number){
  const ok=(k:number)=>{const part=rows.slice(0,k);if(part.length<30)return false;const hi=Math.max(...part.map(r=>r.high)),lo=Math.min(...part.map(r=>r.low));
    return Math.abs(hi*scale-H)<=H*1e-10&&Math.abs(lo*scale-L)<=L*1e-10;};
  return ok(rows.length)||rows.some((_,i)=>i>=30&&i<rows.length&&ok(i));
}
function validRangeProof(p:NonNullable<RangeEvent['proof']>,now:number){
  if(p.kind==='WICK')return !!p.id&&['LONG','SHORT'].includes(p.side)&&[p.fiveAt,p.at,p.price,p.stop,p.target,p.bodyBaseline,p.wickMultiple,p.scannedAt].every(Number.isFinite)
    &&p.price>0&&p.stop>0&&p.target>0&&p.bodyBaseline>0&&p.wickMultiple!>=3&&p.wickMultiple!<=5&&p.scannedAt!>0&&p.at===p.fiveAt&&p.at<=now
    &&p.fiveBar.length===5&&p.fiveBar.every(Number.isFinite)&&p.fiveBar[0]!*1000+300000===p.fiveAt
    &&(p.side==='LONG'?p.stop<p.price&&p.target>p.price:p.stop>p.price&&p.target<p.price);
  return !!p.id&&['EDGE_BREAKOUT','EDGE_RETURN','INTERNAL_TREND'].includes(p.kind)&&['LONG','SHORT'].includes(p.side)
    &&[p.fiveAt,p.at,p.price,p.stop,p.target,p.n1,p.bodyBaseline].every(Number.isFinite)&&p.price>0&&p.stop>0&&p.target>0&&p.n1>0&&p.bodyBaseline>=0
    &&p.at<=now&&p.fiveAt<p.at&&Array.isArray(p.bars)&&[2,3].includes(p.bars.length)
    &&p.bars.every((at,i)=>Number.isFinite(at)&&at>=p.fiveAt+60000&&(!i||at-p.bars[i-1]===60000))&&p.at===p.bars.at(-1)
    &&p.fiveBar.length===5&&p.fiveBar.every(Number.isFinite)&&p.fiveBar[0]!*1000+300000===p.fiveAt
    &&p.minuteBars.length===p.bars.length&&p.minuteBars.every((r,i)=>r.length===5&&r.every(Number.isFinite)&&r[0]!*1000+60000===p.bars[i]);
}
function validOutcomes(e:RangeOutcomeRecord,now:number){return Array.isArray(e.outcomes)&&e.outcomes.length===4&&e.outcomes.every((o,i)=>
  o.minutes===[15,30,45,60][i]&&o.dueAt===e.detectedAt+o.minutes*60000&&['PENDING','OBSERVED','MISSING'].includes(o.status)
  &&(o.at===null||Number.isFinite(o.at)&&o.at>=o.dueAt&&o.at<=now)&&(o.price===null||Number.isFinite(o.price)&&o.price>0)
  &&(o.move===null||Number.isFinite(o.move)));}
function observeOutcomes(e:RangeOutcomeRecord,rows:CandleLike[]|undefined,now:number){
  const five=specialRows(rows,now).filter(r=>r.volumeVenue===e.source);
  for(const o of e.outcomes)if(o.status==='PENDING'&&now>=o.dueAt){const r=five.find(r=>end(r)>=o.dueAt&&end(r)<=o.dueAt+300000);
    if(r){o.at=end(r);o.price=r.close;o.move=r.close/e.anchorPrice-1;o.status='OBSERVED';}
    else if(now>o.dueAt+300000)o.status='MISSING';}
}
export function normalizeRangeResearch(value:unknown):RangeResearch|undefined{
  const s=value as RangeResearch;if(!s||s.version!==ANOMALY_RANGE_VERSION||!Number.isFinite(s.updatedAt)||!Number.isFinite(s.startedAt)
    ||s.updatedAt<s.startedAt||!s.events||Object.keys(s.events).length>30||bytes(s)>RANGE_RESEARCH_BYTES)return;
  if(s.recent!==undefined&&(!Array.isArray(s.recent)||s.recent.length>12||bytes(s.recent)>RANGE_OUTCOME_BYTES
    ||s.recent.some(e=>!e||!e.id||!e.symbol||![e.detectedAt,e.anchorPrice,e.H,e.L].every(Number.isFinite)
      ||e.detectedAt>s.updatedAt||e.anchorPrice<=0||e.H<=e.L||e.L<=0||typeof e.reason!=='string'||e.parked!==undefined&&typeof e.parked!=='boolean'
      ||!['UP','DOWN','NEUTRAL'].includes(e.direction)||!['BYBIT','OKX','KUCOIN','MEXC','HTX'].includes(e.source)||!validOutcomes(e,s.updatedAt))))return;
  if([s.recycled,s.omittedOutcomes,s.waiting,s.rotated].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<0)))return;
  if(s.ranking!==undefined&&(!Array.isArray(s.ranking)||s.ranking.length>8||s.ranking.some(r=>!r.symbol||!Number.isFinite(r.score)||!Number.isSafeInteger(r.rank)||r.rank<1||typeof r.reason!=='string'||typeof r.selected!=='boolean')))return;
  for(const [symbol,e] of Object.entries(s.events)){
    if(!e||e.symbol!==symbol||!e.id||![e.H,e.L,e.E,e.D,e.n5,e.detectedAt,e.lastAt,e.price,e.anchorPrice,e.consumedAt].every(Number.isFinite)
      ||e.H<=e.L||e.L<=0||e.n5<=0||e.E<=e.D||e.D<=0||e.anchorPrice<=0||e.consumedAt>s.updatedAt
      ||!['BYBIT','OKX','KUCOIN','MEXC','HTX'].includes(e.source)||!['UP','DOWN','NEUTRAL'].includes(e.direction)
      ||!['WATCH','CONFIRMING','READY','EXECUTING','HOLDING','EXPIRED','DONE'].includes(e.phase)||typeof e.active!=='boolean'||e.detectedAt>s.updatedAt||e.lastAt>s.updatedAt||!Array.isArray(e.swings)||e.swings.length>6
      ||e.swings.some(p=>!['HIGH','LOW'].includes(p.kind)||![p.price,p.at,p.confirmedAt].every(Number.isFinite)||p.price<=0||p.at>p.confirmedAt||p.confirmedAt>s.updatedAt)
      ||!validOutcomes(e,s.updatedAt)||e.proof&&!validRangeProof(e.proof,s.updatedAt)||e.rank!==undefined&&(!Number.isSafeInteger(e.rank)||e.rank<1)
      ||e.setup&&(!['EDGE_BREAKOUT','EDGE_RETURN','INTERNAL_TREND'].includes(e.setup.kind)||!['LONG','SHORT'].includes(e.setup.side)||!Number.isFinite(e.setup.at)||e.setup.at>s.updatedAt))return;
  }return structuredClone(s);
}
export function boundRangeResearch(s:RangeResearch){
  for(const e of Object.values(s.events)){e.reason=e.reason.slice(0,90);if(e.admission)e.admission.reason=e.admission.reason.slice(0,90);}
  trimRangeOutcomes(s);
  // Ranking labels are optional; never crowd out executable causal witnesses.
  while(s.ranking?.length&&bytes(s)>RANGE_RESEARCH_BYTES-256)s.ranking.pop();
  s.bytes=bytes(s);if(s.bytes>RANGE_RESEARCH_BYTES)throw new Error('RANGE_RESEARCH_BOUND');return s;
}
function trimRangeOutcomes(s:RangeResearch,reserve=256){
  const recent=s.recent??[];
  while(recent.length&&(recent.length>12||bytes(recent)>RANGE_OUTCOME_BYTES||bytes(s)>RANGE_RESEARCH_BYTES-reserve)){
    const resolved=recent.findIndex(e=>e.outcomes.every(o=>o.status!=='PENDING')),
      [removed]=recent.splice(resolved>=0?resolved:0,1);
    if(!removed!.parked)s.omittedOutcomes=(s.omittedOutcomes??0)+removed!.outcomes.filter(o=>o.status==='PENDING').length;
  }
}
function recycleRangePlans(s:RangeResearch,windows:RangeWindows,protectedIds:Set<string|undefined>){
  for(const e of Object.values(s.events))if(terminal(e)&&!protectedIds.has(e.id)){
    const {id,symbol,detectedAt,source,anchorPrice,H,L,direction,reason,outcomes}=e;
    (s.recent??=[]).push({id,symbol,detectedAt,source,anchorPrice,H,L,direction,reason:reason.slice(0,90),outcomes});
    delete s.events[symbol];delete windows[id];s.recycled=(s.recycled??0)+1;
  }trimRangeOutcomes(s);
}
function retainRangeOutcome(s:RangeResearch,e:RangeEvent,parked=false){
  const {id,symbol,detectedAt,source,anchorPrice,H,L,direction,reason,outcomes}=e;
  s.recent=(s.recent??[]).filter(r=>r.id!==id);
  s.recent.push({id,symbol,detectedAt,source,anchorPrice,H,L,direction,reason:reason.slice(0,90),outcomes,parked});
}
function seedRangeEvent(a:RangeDiscovery['anomalies'][number],prior:CandleLike[],cutoff:number,tick:number,now:number):RangeEvent|undefined{
  const H=Math.max(...prior.map(r=>r.high)),L=Math.min(...prior.map(r=>r.low)),n5=noise(prior,tick),E=Math.min(.75*n5,.1*(H-L)),D=Math.max(2*tick,.2*n5);
  if(H<=L||E<=D)return;
  const swings=rangeSwings(prior,n5);return{id:`${ANOMALY_RANGE_VERSION}:${a.symbol}:${a.detectedAt}`,symbol:a.symbol,detectedAt:a.detectedAt,source:a.source,
    score:a.score,own:a.own,residual:a.residual,anomalyKind:a.kind,H,L,n5,E,D,minutes:prior.length*5,
    highAt:prior.findLast(r=>r.high===H)!.time*1000,lowAt:prior.findLast(r=>r.low===L)!.time*1000,direction:rangeDirection(swings,n5,now),swings:swings.slice(-6),
    phase:'WATCH',reason:'固定异动前区间，等待完整方向证明',lastAt:cutoff,price:prior.at(-1)!.close,anchorPrice:prior.at(-1)!.close,active:false,
    upperExtreme:H,lowerExtreme:L,upperTouchedAt:0,lowerTouchedAt:0,consumedAt:0,
    outcomes:[15,30,45,60].map(minutes=>({minutes,dueAt:a.detectedAt+minutes*60000,at:null,price:null,move:null,status:'PENDING'}))};
}
export function advanceRangeResearch(input:{previous?:RangeResearch;windows:RangeWindows;now:number;paths:Record<string,CandleLike[]>;
  minutes?:Record<string,CandleLike[]>;quotes:Record<string,QuoteLike>;ticks:Record<string,number>;discovery?:RangeDiscovery;positions:Trade[];history:Trade[]}){
  const s=normalizeRangeResearch(input.previous)??(!input.previous?{version:ANOMALY_RANGE_VERSION,startedAt:input.now,updatedAt:input.now,events:{},bytes:0,capacitySkipped:0}:null);
  if(!s)throw new Error('RANGE_MEMORY_INVALID');if(input.now<s.updatedAt)return s;s.updatedAt=input.now;
  if(input.discovery){const {gateVolume,...rest}=input.discovery;s.discovery={...rest,anomalies:rest.anomalies.slice(0,8)};
    for(const e of Object.values(s.events)){const vol=gateVolume?.[e.symbol];
      if(vol!=null&&vol<RANGE_MIN_VOLUME_24H_USD&&!input.positions.some(t=>t.symbol===e.symbol)){delete e.proof;e.phase='EXPIRED';e.reason='Gate近24小时成交额不足100万，不观察';}}}
  const pending=input.positions.filter(t=>t.paperOrder?.phase!=='FILLED'),protectedIds=new Set(pending.map(t=>t.unified?.anomaly?.eventId).filter(Boolean)),
    previouslySelected=new Set(Object.values(s.events).map(e=>e.id));
  // Filled orders already own immutable geometry and mutable holding protection.
  for(const t of input.positions)if(t.paperOrder?.phase==='FILLED'&&t.unified?.anomaly){const e=s.events[t.symbol];
    if(e?.id===t.unified.anomaly.eventId){retainRangeOutcome(s,e);delete s.events[t.symbol];delete input.windows[e.id];}}
  // Recover an edge reversal from the latest confirmed financial closure, even
  // after the filled order has released its observation seat or after restart.
  const latestClosed=new Map(input.history.filter(t=>t.unified?.anomaly).map(t=>[t.unified!.anomaly!.eventId,t]));
  for(const t of latestClosed.values()){const m=t.unified!.anomaly!;
    if(!m.reverseEligible||!t.closedAt||input.now-t.closedAt>=1800000||input.positions.some(p=>p.symbol===t.symbol)||s.events[t.symbol])continue;
    let prior:CandleLike[];try{prior=decodeRangeWindow(m.window);}catch{continue;}
    const detectedAt=Number(m.eventId.split(':').at(-1)),
      e=seedRangeEvent({symbol:t.symbol,detectedAt,source:m.source,sourceCount:0,own:0,residual:0,score:0,kind:'CONFIRMED_EDGE_EXIT'},prior,m.window.cutoff,input.ticks[t.symbol]??m.D/m.scale/2,input.now);
    if(e&&m.proof){e.id=m.eventId;e.tradeId=t.id;e.predecessorId=t.id;e.reverseAfter=t.closedAt;e.reverseEligible=true;e.consumedAt=m.proof.at;s.events[e.symbol]=e;}}
  for(const e of Object.values(s.events)){
    const a=input.discovery?.anomalies.find(a=>a.symbol===e.symbol&&a.source===e.source);
    if(a){e.own=a.own;e.residual=a.residual;e.score=a.score;}
    if(protectedIds.has(e.id))continue;
    const closed=input.history.findLast(t=>t.unified?.anomaly?.eventId===e.id);
    if(closed&&e.tradeId===closed.id){e.exit={at:closed.closedAt!,reason:closed.exitReason??'EXIT',net:closed.netPnl};
      e.predecessorId=closed.id;e.reverseAfter=closed.closedAt!;e.reverseEligible=!!closed.unified!.anomaly!.reverseEligible;e.phase=e.reverseEligible?'WATCH':'DONE';}
    if(!terminal(e)&&planExpired(e,input.now)){e.phase='EXPIRED';e.reason='观察满3根5分钟，没有新的异动就放开';}
    observeOutcomes(e,input.paths[e.symbol],input.now);
  }
  for(const e of s.recent??[]){observeOutcomes(e,input.paths[e.symbol],input.now);if(input.now-e.detectedAt>=1800000)e.parked=false;}
  const seen=new Set([...Object.values(s.events),...(s.recent??[]).filter(e=>!e.parked)].map(e=>e.id));
  recycleRangePlans(s,input.windows,protectedIds);
  for(const id of Object.keys(input.windows))if(!protectedIds.has(id)&&!Object.values(s.events).some(e=>e.id===id)
    &&input.now-Number(id.split(':').at(-1))>=1800000)delete input.windows[id];
  for(const a of input.discovery?.anomalies??[]){
    const id=`${ANOMALY_RANGE_VERSION}:${a.symbol}:${a.detectedAt}`;
    if(a.detectedAt>input.now||input.now-a.detectedAt>=WICK_WATCH_MS||seen.has(id)||s.events[a.symbol]||input.positions.some(t=>t.symbol===a.symbol))continue;
    if(sparseFiveTurnover(input.paths[a.symbol]??[],input.now))continue;
    const cached=input.windows[id],parked=s.recent?.find(r=>r.id===id&&r.parked);
    if(!cached&&(a.frozen||parked)){s.capacitySkipped++;continue;} // Never redraw a forgotten original range.
    const cutoff=cached?.cutoff??Math.floor(a.detectedAt/300000)*300000,
      five=specialRows(input.paths[a.symbol],input.now,300000,121);
    let prior:CandleLike[]|undefined;
    if(cached){try{prior=decodeRangeWindow(cached);}catch{delete input.windows[id];continue;}}
    else{const rows=five.filter(r=>end(r)<=cutoff).slice(-120),start=rows[0]?rows[0].time*1000:0;
      if(rows.length<119||start+rows.length*300000!==cutoff||rows.some((r,i)=>r.time*1000!==start+i*300000))continue;prior=rows;}
    if(!prior)continue;
    const source=prior.at(-1)!.volumeVenue;
    if(!five.length||prior.length<119||prior.some(r=>r.volumeVenue!==source)||source!==a.source)continue;
    const e=seedRangeEvent(a,prior,cutoff,input.ticks[a.symbol]??prior.at(-1)!.close*1e-6,input.now);if(!e)continue;
    if(!cached&&Object.keys(input.windows).length>=RANGE_WINDOW_LIMIT){
      const victim=Object.keys(input.windows).filter(key=>!protectedIds.has(key)&&!Object.values(s.events).some(e=>e.id===key))
        .sort((x,y)=>Number(x.split(':').at(-1))-Number(y.split(':').at(-1)))[0];
      if(!victim){s.capacitySkipped++;continue;}
      delete input.windows[victim];seen.add(victim);const record=s.recent?.find(r=>r.id===victim);if(record)record.parked=false;
    }
    if(parked)e.outcomes=structuredClone(parked.outcomes);
    input.windows[id]=cached??encodeRangeWindow(prior,source!,cutoff);s.events[a.symbol]=e;
  }
  for(const e of Object.values(s.events)){
    const five=specialRows(input.paths[e.symbol],input.now).filter(r=>r.volumeVenue===e.source),minutes=specialRows(input.minutes?.[e.symbol],input.now,60000).filter(r=>r.volumeVenue===e.source),last=five.at(-1),q=input.quotes[e.symbol];
    const held=input.positions.find(t=>t.unified?.anomaly?.eventId===e.id),closed=input.history.findLast(t=>t.unified?.anomaly?.eventId===e.id);
    if(held){e.tradeId=held.id;e.consumedAt=Math.max(e.consumedAt,held.openedAt);e.phase=held.paperOrder?.phase==='FILLED'?'HOLDING':'EXECUTING';}
    if(closed&&!held&&e.tradeId===closed.id){e.exit={at:closed.closedAt!,reason:closed.exitReason??'EXIT',net:closed.netPnl};
      e.predecessorId=closed.id;e.reverseAfter=closed.closedAt!;e.reverseEligible=!!closed.unified!.anomaly!.reverseEligible;e.phase=e.reverseEligible?'WATCH':'DONE';}
    observeOutcomes(e,input.paths[e.symbol],input.now);
    if(!held&&!terminal(e)&&planExpired(e,input.now)){e.phase='EXPIRED';e.reason='观察满3根5分钟，没有新的异动就放开';}
    if(!held&&terminal(e))continue;
    if(!last||input.now-end(last)>600000){e.active=false;e.reason='同源完成K线缺失，停止新确认';continue;}
    e.price=q?.fresh&&q.priceSource===e.source&&input.now-q.observedAt<=10000?((q.bestBid+q.bestAsk)/2):last.close;const activity=recentSpecialActivity(five);e.active=activity.active;e.activity={turnover15:activity.turnover15,activityRatio:activity.activityRatio,at:end(last)};
    if(held||e.phase==='DONE'||e.phase==='EXPIRED')continue;
    if(sparseFiveTurnover(input.paths[e.symbol]??[],input.now)){delete e.proof;e.phase='EXPIRED';e.reason='5分钟成交断续，单根不足1000美元，不观察';continue;}
    if(thinFiveTape(five,e.n5)){delete e.proof;e.phase='EXPIRED';e.reason='5分钟K线断层，成交太稀，不观察';continue;}
    if(e.proof&&input.now-e.proof.at>120000){delete e.proof;e.phase='WATCH';}
    if(end(last)>e.lastAt){
      const newly=five.filter(r=>end(r)>e.lastAt&&r.time*1000>=Math.floor(e.detectedAt/300000)*300000),reach=Math.max(e.E,e.n5);
      for(const r of newly){if(r.high>=e.H-reach){e.upperTouchedAt=end(r);e.upperExtreme=Math.max(e.upperExtreme,r.high);}
        if(r.low<=e.L+reach){e.lowerTouchedAt=end(r);e.lowerExtreme=Math.min(e.lowerExtreme,r.low);}}
      e.lastAt=end(last);
    }
    const window=input.windows[e.id]??closed?.unified?.anomaly?.window;if(!window){e.reason='原始冻结证据未恢复，停止本计划';continue;}
    let frozen:CandleLike[];
    try{frozen=decodeRangeWindow(window);}catch{if(input.windows[e.id])delete input.windows[e.id];e.phase='EXPIRED';e.reason='冻结窗口对不上，释放观察';continue;}
    const full=[...frozen,...five.filter(r=>r.time*1000>=window.cutoff)],swings=rangeSwings(full,e.n5);e.swings=swings.slice(-6);e.direction=rangeDirection(swings,e.n5,input.now);
    if(e.proof?.kind==='INTERNAL_TREND'&&(e.own*d(e.proof.side)<=0||e.direction!==(e.proof.side==='LONG'?'UP':'DOWN'))){delete e.proof;e.phase='WATCH';}
    const tick=input.ticks[e.symbol]??e.n5/1000,inherited=inheritedEdge(frozen,tick),aligned=!!inherited&&e.own*d(inherited.side)>0;
    let inheritedTaken=false;
    if(inherited&&!aligned){
      const g=windowGeometry(frozen,tick);
      if(e.proof?.fiveAt===end(inherited.event)){delete e.proof;e.phase='WATCH';}
      e.H=g.H;e.L=g.L;e.n5=g.n5;e.E=g.E;e.D=g.D;e.highAt=g.highAt;e.lowAt=g.lowAt;
    }else if(inherited&&aligned){
      inheritedTaken=true;
      e.H=inherited.H;e.L=inherited.L;e.n5=inherited.n5;e.E=inherited.E;e.D=inherited.D;e.highAt=inherited.highAt;e.lowAt=inherited.lowAt;
      e.upperExtreme=inherited.H;e.lowerExtreme=inherited.L;
      const dir=d(inherited.side),edge=inherited.kind==='EDGE_RETURN'?inherited.side==='LONG'?inherited.L:inherited.H:inherited.side==='LONG'?inherited.H:inherited.L,eventAt=end(inherited.event),
        cap=inherited.side==='LONG'?inherited.event.high+inherited.n5:inherited.event.low-inherited.n5,
        zone=(p:number)=>inherited.kind==='EDGE_BREAKOUT'?dir*(p-edge)>inherited.D&&dir*(p-cap)<=0:dir*(p-edge)>inherited.D&&Math.abs(p-edge)<=inherited.E,
        drop=()=>{if(e.proof?.fiveAt===eventAt){delete e.proof;}e.phase='CONFIRMING';};
      if(inherited.kind==='EDGE_BREAKOUT'&&dir*(e.price-cap)>0){drop();e.reason='沿上次边缘事件已越过极值，不追';}
      else if(!zone(e.price)){drop();e.reason='上次边缘事件的位置已经失效';}
      else if(e.proof?.fiveAt===eventAt&&input.now-e.proof.at<=120000&&zone(e.proof.price))e.phase='READY';
      else{
        const proof=closedMinuteProof(minutes,eventAt,tick,input.now,zone);
        if(proof&&proof.at>e.consumedAt&&input.now-proof.at<=120000){
          e.proof={kind:inherited.kind,side:inherited.side,stop:inherited.stop,target:inherited.target,...proof,fiveAt:eventAt,
            fiveBar:[inherited.event.time,inherited.event.open,inherited.event.high,inherited.event.low,inherited.event.close],
            id:`${e.id}:${inherited.kind}:${inherited.side}:${proof.at}`};
          e.phase='READY';e.reason=inherited.kind==='EDGE_BREAKOUT'?'上次突破已选方向，异动同向，不等再破极值':'上次回归已选方向，异动同向，直接沿该方向';
        }else{drop();e.reason='上次事件同向，等待仍在正确一侧的完成小线';}
      }
    }
    const history=specialRows(input.paths[e.symbol],input.now,300000,SWING_LOOKBACK).filter(r=>r.volumeVenue===e.source),
      swing=activeSwingRange(history,tick,e.price),recent=history.slice(-120);
    if(swing&&recent.length>=30){
      const floor=recent.reduce((a,b)=>a.low<=b.low?a:b),ceil=recent.reduce((a,b)=>a.high>=b.high?a:b),
        pullback=floor.time*1000>swing.highAt&&swing.L<floor.low-swing.D,
        plateau=ceil.time*1000>swing.highAt&&swing.H>ceil.high+swing.D,
        brokeReal=!!inherited&&(inherited.side==='LONG'?inherited.event.close>swing.H+swing.D:inherited.event.close<swing.L-swing.D),
        innerShort=inheritedTaken&&pullback&&!!inherited&&inherited.L>swing.L+swing.D&&!(inherited.kind==='EDGE_BREAKOUT'&&inherited.side==='LONG')&&!brokeReal,
        heldRange=lastingRange(history,tick,e.price),breakAge=heldRange?.brokeAt?input.now-heldRange.brokeAt:0,
        outsideSwing=e.price>swing.H+swing.D||e.price<swing.L-swing.D,
        settledNow=!!heldRange?.brokeAt&&breakAge>=RANGE_REDRAW_MS&&postBreakRange(heldRange,swing,history,e.price,heldRange.brokeAt),
        redrawBlocked=!!heldRange?.brokeAt&&!settledNow&&(breakAge<RANGE_REDRAW_MS||outsideSwing),
        blocked=redrawBlocked&&swing.rebuilt&&!swing.rejected;
      if(!blocked&&(swing.rejected||swing.rebuilt)&&(Math.abs(e.H-swing.H)>swing.D||Math.abs(e.L-swing.L)>swing.D)){
        const H=swing.H,L=swing.L,E=Math.min(.75*swing.n5,.1*(H-L)),D=Math.max(2*tick,.2*swing.n5);
        if(H>L&&E>D){e.H=H;e.L=L;e.n5=swing.n5;e.highAt=swing.highAt;e.lowAt=swing.lowAt;e.E=E;e.D=D;
          e.upperExtreme=Math.max(e.upperExtreme,H);e.lowerExtreme=Math.min(e.lowerExtreme,L);
          e.swings=rememberSwingPair(e.swings,{H,L,highAt:swing.highAt,lowAt:swing.lowAt,highConfirmed:swing.highConfirmed,lowConfirmed:swing.lowConfirmed});
          if(e.proof)delete e.proof;inheritedTaken=false;if(e.phase==='READY')e.phase='WATCH';}
      }else if(!redrawBlocked&&(pullback||plateau)&&(!inheritedTaken||innerShort)){
        const H=plateau?swing.H:e.H,L=pullback?swing.L:e.L,highAt=plateau?swing.highAt:e.highAt,lowAt=pullback?swing.lowAt:e.lowAt,
          E=Math.min(.75*e.n5,.1*(H-L)),D=Math.max(2*tick,.2*e.n5);
        if(H>L&&E>D){e.H=H;e.L=L;e.highAt=highAt;e.lowAt=lowAt;e.E=E;e.D=D;
          e.upperExtreme=Math.max(e.upperExtreme,H);e.lowerExtreme=Math.min(e.lowerExtreme,L);
          e.swings=rememberSwingPair(e.swings,{H,L,highAt,lowAt,highConfirmed:plateau?swing.highConfirmed:highAt,lowConfirmed:pullback?swing.lowConfirmed:lowAt});
          if(innerShort){if(e.proof?.fiveAt===end(inherited!.event))delete e.proof;inheritedTaken=false;if(!e.proof)e.phase='WATCH';}
          else if(pullback&&e.proof?.side==='SHORT'&&e.proof.kind==='EDGE_BREAKOUT'){delete e.proof;e.phase='WATCH';}}
      }
      // A high or low printed after the close already left this range is the breakout leg.
      // Put the edges back on the range that was broken. A new box waits until it has settled.
      if(heldRange?.brokeAt&&!settledNow&&!inheritedTaken){
        const sameSwing=Math.abs(heldRange.H-swing.H)<=heldRange.D&&Math.abs(heldRange.L-swing.L)<=heldRange.D;
        const chaseHigh=e.H>heldRange.H+heldRange.D&&e.highAt>=heldRange.brokeAt;
        const chaseLow=!sameSwing&&outsideSwing&&e.L<heldRange.L-heldRange.D&&e.lowAt>=heldRange.brokeAt-300000;
        const heldContains=e.price<=heldRange.H+heldRange.D&&e.price>=heldRange.L-heldRange.D;
        const keepWhileYoung=!sameSwing&&heldContains&&!outsideSwing&&heldRange.H>e.H+heldRange.D&&breakAge<RANGE_REDRAW_MS;
        if((chaseHigh||chaseLow||keepWhileYoung)&&(Math.abs(e.H-heldRange.H)>heldRange.D||Math.abs(e.L-heldRange.L)>heldRange.D)){
          const H=heldRange.H,L=heldRange.L,E=Math.min(.75*heldRange.n5,.1*(H-L)),D=Math.max(2*tick,.2*heldRange.n5);
          if(H>L&&E>D){e.H=H;e.L=L;e.n5=heldRange.n5;e.highAt=heldRange.highAt;e.lowAt=heldRange.lowAt;e.E=E;e.D=D;
            e.swings=rememberSwingPair(e.swings,{H,L,highAt:heldRange.highAt,lowAt:heldRange.lowAt,highConfirmed:heldRange.highConfirmed,lowConfirmed:heldRange.lowConfirmed});
            if(e.proof)delete e.proof;if(e.phase==='READY')e.phase='WATCH';}
        }
      }
      if(redrawBlocked&&outsideSwing&&!inheritedTaken&&breakAge>=RANGE_REDRAW_MS&&heldRange&&(Math.abs(heldRange.H-swing.H)>heldRange.D||Math.abs(heldRange.L-swing.L)>heldRange.D)&&(Math.abs(e.H-heldRange.H)>heldRange.D||Math.abs(e.L-heldRange.L)>heldRange.D)){
        const H=heldRange.H,L=heldRange.L,E=Math.min(.75*heldRange.n5,.1*(H-L)),D=Math.max(2*tick,.2*heldRange.n5);
        if(H>L&&E>D){e.H=H;e.L=L;e.n5=heldRange.n5;e.highAt=heldRange.highAt;e.lowAt=heldRange.lowAt;e.E=E;e.D=D;
          e.swings=rememberSwingPair(e.swings,{H,L,highAt:heldRange.highAt,lowAt:heldRange.lowAt,highConfirmed:heldRange.highConfirmed,lowConfirmed:heldRange.lowConfirmed});
          if(e.proof)delete e.proof;if(e.phase==='READY')e.phase='WATCH';}
      }
    }
    const scanBar=Math.floor(e.detectedAt/300000)*300000;
    const wickBar=five.filter(r=>{const start=r.time*1000,closed=end(r);return closed<=input.now&&closed>e.detectedAt&&start>=scanBar&&closed>e.consumedAt;})
      .map(bar=>({bar,signal:wickSignal(bar)})).find(x=>x.signal&&input.now-end(x.bar)<=120000);
    if(wickBar?.signal){const bar=wickBar.bar,w=wickBar.signal,dir=d(w.side),tp=w.body*w.multiple,closed=end(bar);
      e.proof={kind:'WICK',side:w.side,fiveAt:closed,at:closed,price:bar.close,stop:bar.close-dir*3*tp,target:bar.close+dir*tp,
        bars:[closed],n1:w.body,bodyBaseline:w.body,fiveBar:[bar.time,bar.open,bar.high,bar.low,bar.close],minuteBars:[],wickMultiple:w.multiple,scannedAt:e.detectedAt,
        id:`${e.id}:WICK:${w.side}:${closed}`};
      e.phase='READY';e.reason=w.side==='SHORT'?'上影线长过实体，做空':'下影线长过实体，做多';
    }else if(e.proof?.kind!=='WICK'){if(e.proof)delete e.proof;e.phase='CONFIRMING';e.reason=!e.active?'近期成交不足或未知，继续观察':'等待5分钟k线走完';}
  }
  recycleRangePlans(s,input.windows,protectedIds);
  const selection=selectRangePlans(Object.values(s.events),input.quotes,input.now);
  s.ranking=selection.ranking.slice(0,8);s.waiting=selection.ranking.filter(r=>!r.selected).length;
  for(const r of selection.ranking){const e=s.events[r.symbol]!;e.rank=r.rank;delete e.setup;
    if(!r.selected){retainRangeOutcome(s,e,true);delete s.events[e.symbol];if(previouslySelected.has(e.id))s.rotated=(s.rotated??0)+1;}}
  trimRangeOutcomes(s);
  while(s.ranking?.length&&bytes(s)>RANGE_RESEARCH_BYTES-256)s.ranking.pop();
  for(const t of pending){const e=s.events[t.symbol],m=t.unified?.anomaly;
    if(bytes(s)<=RANGE_RESEARCH_BYTES-256)break;
    // The submitted financial order already owns this exact immutable proof.
    if(e&&m&&e.id===m.eventId&&e.proof?.id===m.proof.id)delete e.proof;
  }
  // Ten is a seat maximum, not permission to exceed the original storage cap.
  for(const r of [...selection.ranking].reverse()){
    if(bytes(s)<=RANGE_RESEARCH_BYTES-256)break;
    const e=s.events[r.symbol];if(!e||protectedIds.has(e.id))continue;
    retainRangeOutcome(s,e,true);delete s.events[e.symbol];r.selected=false;s.waiting++;
    if(previouslySelected.has(e.id))s.rotated=(s.rotated??0)+1;
    trimRangeOutcomes(s);
  }
  const activeIds=new Set(Object.values(s.events).map(e=>e.id));s.recent=s.recent?.filter(e=>!activeIds.has(e.id));
  return boundRangeResearch(s);
}
/** Map only a fresh, pinned same-venue analysis price to a fresh executable Gate quote. */
export function rangeMarketRoute(s:RangeResearch|undefined,symbol:string,price:number,now:number,analysis?:QuoteLike){
  const e=s?.events[symbol],p=e?.proof,fail=(code:string,reason:string)=>({route:null,code,reason});
  if(!e||!p||!['READY','EXECUTING'].includes(e.phase)||!e.active||s?.error)return fail('RANGE_PROOF_WAIT',e?.reason??'等待异动及冻结区间');
  if(!analysis?.fresh||!Number.isFinite(analysis.bestBid)||!Number.isFinite(analysis.bestAsk)||now-analysis.observedAt>10000||analysis.observedAt>now||((analysis.bestBid+analysis.bestAsk)/2)<=0||(analysis.sourceCount??0)<2||analysis.priceSource!==e.source||(analysis.disagreementRate??0)>.008)
    return fail('RANGE_SOURCE_WAIT','等待同源分析价格');
  if(now-p.at>120000||p.at>now||Math.abs(((analysis.bestBid+analysis.bestAsk)/2)-p.price)>e.n5)return fail('RANGE_LATE','证明过期或已偏离一个正常波动');
  const scale=price/((analysis.bestBid+analysis.bestAsk)/2);if(!(scale>.97&&scale<1.03))return fail('RANGE_BASIS','分析与执行价差异常，停止新增');
  if(p.kind==='EDGE_RETURN'&&Math.min(Math.abs(((analysis.bestBid+analysis.bestAsk)/2)-e.H),Math.abs(((analysis.bestBid+analysis.bestAsk)/2)-e.L))>e.n5+Math.max(e.E,e.n5)+e.D)return fail('RANGE_EDGE_LOST','实际入场已离开可回归的边界，不追已经走远的回头');
  const dir=d(p.side);if(dir*(price-p.stop*scale)<=0)return fail('RANGE_STOP','实际失效位已经触发');
  const route:MarketRoute={version:MARKET_AUTHORITY_VERSION,controllerVersion:ANOMALY_RANGE_VERSION,epoch:1,phase:p.kind==='EDGE_RETURN'?'RANGE':p.side==='LONG'?'UP':'DOWN',
    eventId:p.id,relation:'INDEPENDENT',branch:p.kind==='EDGE_RETURN'?'RETURN':'CONTINUATION',side:p.side,proofAt:p.at,proofPrice:p.price*scale,
    proofBars:[p.fiveAt,...p.bars],stop:p.stop*scale,target:p.kind==='EDGE_BREAKOUT'?price:p.target*scale,
    targetBasis:p.kind==='EDGE_BREAKOUT'?'MEASURED_RESPONSE':p.kind==='EDGE_RETURN'?'ACCEPTED_CENTER':'OBSERVED_OBSTACLE',
    reference:{lower:e.L*scale,upper:e.H*scale,center:(e.H+e.L)/2*scale,formedAt:e.detectedAt,balanced:true,basis:'OHLCV_PROXY'},reason:e.reason};
  return{route,code:'RANGE_READY',reason:e.reason,scale};
}
export function makeRangeHolding(e:RangeEvent,w:RangeWindow,price:number,analysis:QuoteLike,now:number):RangeHolding{
  const scale=price/((analysis.bestBid+analysis.bestAsk)/2);return{version:ANOMALY_RANGE_VERSION,eventId:e.id,kind:e.proof!.kind,H:e.H*scale,L:e.L*scale,E:e.E*scale,D:e.D*scale,n5:e.n5*scale,
    scale,scaleAt:analysis.observedAt,source:e.source,activity:e.activity?structuredClone(e.activity):undefined,window:structuredClone(w),proof:structuredClone(e.proof!),swings:structuredClone(e.swings),
    initialRisk:Math.abs(price-e.proof!.stop*scale),lastBarAt:0,insideAt:0,quoteAt:0,peak:0,peakAt:now,retainedPeak:0,peakSamples:0,
    progressReviewAt:now,stage:'HOLD',reason:e.proof!.kind==='WICK'?'影线计划：浮亏不到1倍止盈距离继续拿':'按冻结计划持有，普通回调观察',reverseEligible:false,scannedAt:e.detectedAt};
}
export function validRangeHolding(m:RangeHolding){try{const rows=decodeRangeWindow(m.window);return m.version===ANOMALY_RANGE_VERSION&&!!m.eventId
  &&[m.H,m.L,m.E,m.D,m.n5,m.scale,m.scaleAt,m.initialRisk,m.lastBarAt,m.insideAt,m.quoteAt,m.peak,m.peakAt,m.retainedPeak,m.peakSamples].every(Number.isFinite)
  &&m.H>m.L&&m.L>0&&m.scale>0&&m.initialRisk>0&&m.window.source===m.source&&validRangeProof(m.proof,Math.max(m.scaleAt,m.proof.at))
  &&(m.proof.kind==='WICK'||rangeGeometryMatches(rows,m.H,m.L,m.scale)||holdingSwingMatches(m))
  &&['HOLD','REVIEW','EXIT'].includes(m.stage)&&typeof m.reverseEligible==='boolean'&&m.peakSamples>=0&&m.peakSamples<=3
  &&(m.returnProbeAt===undefined||Number.isFinite(m.returnProbeAt)&&m.returnProbeAt>0)
  &&(m.returnBackAt===undefined||Number.isFinite(m.returnBackAt)&&m.returnProbeAt!==undefined&&m.returnBackAt>=m.returnProbeAt)
  &&(m.breakoutAt===undefined||Number.isFinite(m.breakoutAt)&&m.breakoutAt>=m.proof.fiveAt&&m.breakoutAt<=m.lastBarAt);}catch{return false;}}
export function rangeHoldingDecision(t:Trade,q:Quote,now:number,path:CandleLike[],minutePath:CandleLike[]=[]){
  const m=structuredClone(t.unified!.anomaly!),dir=d(t.side),px=dir>0?q.bestBid:q.bestAsk;let stop=t.stopPrice,exit:string|undefined;
  if(!validRangeHolding(m)){
    if(dir*(px-stop)<=0)return{memory:m,stop,exit:'RANGE_HARD_PROTECTION',reason:'原始区间记忆异常，按已提交硬保护退出'};
    return{memory:m,stop,exit:undefined,reason:'原始区间记忆异常，保留已提交硬保护'};
  }
  m.reverseEligible=false;
  const net=dir*(px-t.entryPrice)-(px+t.entryPrice)*.0005;
  if(q.observedAt>m.quoteAt){m.quoteAt=q.observedAt;if(net>m.peak+m.n5*.05){m.peak=net;m.peakAt=now;m.peakSamples=1;}
    else if(net>=m.peak-m.n5*.25&&m.peak>0){m.peakSamples=Math.min(3,m.peakSamples+1);if(m.peakSamples>=3)m.retainedPeak=Math.max(m.retainedPeak,Math.min(net,m.peak));}}
  if(m.kind==='WICK'&&m.proof.bodyBaseline>0&&(m.proof.wickMultiple??0)>=3){
    const Dtp=m.proof.bodyBaseline*m.proof.wickMultiple!*m.scale,adverse=dir*(t.entryPrice-px);
    const minNet=wickProfitTarget(t.side,t.entryPrice,t.quantity),stored=m.proof.target*m.scale;
    if(minNet!==undefined&&dir*(minNet-stored)>0&&dir*(minNet-m.proof.price*m.scale)>0)m.proof.target=minNet/m.scale;
    const tpPx=m.proof.target*m.scale,goal=dir>0?Math.max(t.entryPrice+Dtp,tpPx):Math.min(t.entryPrice-Dtp,tpPx);
    if(adverse>=2*Dtp&&!m.insideAt){m.insideAt=now;m.stage='REVIEW';m.reason='浮亏到了止盈距离的2倍，回到1倍亏损或成本就出';}
    if(dir*(px-goal)>=0){exit='WICK_TARGET';m.stage='EXIT';m.reason='到达止盈';}
    else if(m.insideAt&&dir*(px-t.entryPrice)>=0){exit='WICK_BREAKEVEN';m.stage='EXIT';m.reason='浮亏到过2倍止盈距离，价格回到成本，保本出场';}
    else if(m.insideAt&&adverse<=Dtp){exit='WICK_ONE_STOP';m.stage='EXIT';m.reason='浮亏到过2倍止盈距离，回到1倍止损出场';}
    else if(adverse>=3*Dtp||dir*(px-stop)<=0){exit='WICK_HARD_STOP';m.stage='EXIT';m.reason='浮亏到达止盈距离的3倍，直接止损';}
    else{m.stage=m.insideAt?'REVIEW':'HOLD';m.reason=adverse<=Dtp?'浮亏还没到1倍止盈距离，继续拿着':m.insideAt?'浮亏到过2倍，等回到1倍止损或成本':'浮亏超过1倍止盈距离，还没到2倍，继续拿着';}
    return{memory:m,stop,exit,reason:m.reason};
  }
  const returning=m.kind==='EDGE_RETURN';
  const r=m.retainedPeak/m.initialRisk,share=returning?0:r>=6?.8:r>=4?.65:r>=2?.5:0;
  if(share){const floor=Math.min(m.retainedPeak*share,m.retainedPeak-m.n5),guard=t.entryPrice+dir*(floor+(px+t.entryPrice)*.0005);
    if(floor>0&&dir*(guard-stop)>0)stop=guard;}
  if(!returning&&dir*(px-stop)<=0){exit='RANGE_HARD_PROTECTION';m.reason='实际退出价触及原结构或已赚优势保护';}
  const rows=specialRows(path,now).filter(r=>r.volumeVenue===m.source),minutes=specialRows(minutePath,now,60000).filter(r=>r.volumeVenue===m.source),last=rows.at(-1),scaled=(p:number)=>p*m.scale;
  const boundary=dir>0?m.H:m.L;
  if(m.kind==='INTERNAL_TREND'&&!m.breakoutAt&&last&&end(last)>t.openedAt&&dir*(scaled(last.close)-boundary)>m.D){m.breakoutAt=end(last);m.reason='内部顺势已突破原边缘，继续持有';}
  const breakout=m.kind==='EDGE_BREAKOUT'||!!m.breakoutAt,
    fast=breakout&&now-Math.max(t.openedAt,m.breakoutAt??m.proof.fiveAt)<=300000;
  if(fast){const inward=strongRangeProof(minutes,Math.max(m.breakoutAt??m.proof.fiveAt,Math.ceil(t.openedAt/60000)*60000),dir>0?'SHORT':'LONG',m.n5/m.scale,m.D/m.scale/2,p=>dir*(scaled(p)-boundary)<-m.D);
    if(inward&&now-inward.at<=120000){if(!exit){exit='RANGE_BREAKOUT_FAILED';m.reason='突破后快速回区间，两至三根强势小线确认失效';}
      m.reverseEligible=Math.abs(px-boundary)<=m.E;}}
  if(!exit&&last&&end(last)>m.lastBarAt&&end(last)>t.openedAt){
    const full=[...decodeRangeWindow(m.window),...rows.filter(r=>r.time*1000>=m.window.cutoff)],swings=rangeSwings(full,m.n5/m.scale);
    m.swings=retainEdgeSwings(m.swings,swings,m.H,m.L,m.scale);
    const support=swings.findLast(s=>s.confirmedAt<=end(last)&&s.kind===(dir>0?'LOW':'HIGH')&&s.confirmedAt>t.openedAt);
    if(!returning&&support&&dir*(scaled(support.price)-dir*m.D-stop)>0&&dir*(px-scaled(support.price))>m.n5)stop=scaled(support.price)-dir*m.D;
    const boundary=dir>0?m.H:m.L,inside=dir*(scaled(last.close)-boundary)<-m.D;
    if(breakout){
      if(inside){if(!m.insideAt)m.insideAt=end(last);m.stage='REVIEW';m.reason='完整5分钟回到区间内，检查后续收复';
        const inward=strongRangeProof(minutes,m.insideAt,dir>0?'SHORT':'LONG',m.n5/m.scale,m.D/m.scale/2,p=>dir*(scaled(p)-boundary)<-m.D),
          failed=minutes.filter(r=>r.time*1000>=m.insideAt).slice(-2);
        if(inward&&(fast||dir*(boundary-scaled(last.close))>=m.n5)){exit='RANGE_BREAKOUT_FAILED';m.reason='回到区间内且新完成证据未能收复，突破计划失效';
          m.reverseEligible=!!inward&&inward.at>t.openedAt&&Math.abs(px-boundary)<=m.E&&failed.every(r=>dir*(scaled(r.close)-boundary)<-m.D);}
      }else if(dir*(scaled(last.close)-boundary)>m.D){m.insideAt=0;m.stage='HOLD';m.reason='原边缘仍有效，保留外侧推进';}
    }else{
      if(m.kind==='EDGE_RETURN'){const edge=dir>0?m.L:m.H,room=Math.max(m.n5,m.D),close=scaled(last.close),
        outside=dir>0?close<=edge-room:close>=edge+room,inside=dir>0?close>=edge:close<=edge;
        if(outside&&!m.returnProbeAt){m.returnProbeAt=end(last);m.stage='REVIEW';m.reason='第一根5分钟收在区间外一个正常波动，下影线不算，先拿着';}
        else if(m.returnProbeAt&&!m.returnBackAt&&inside&&end(last)>m.returnProbeAt){m.returnBackAt=end(last);m.stage='HOLD';m.reason='已收回区间内，再有一根收在外面才止损';}
        else if(m.returnProbeAt&&m.returnBackAt&&outside&&end(last)>m.returnBackAt){exit='RANGE_RETURN_FAILED';m.reason='收回区间后，又一根5分钟收在区间外，回归止损';}}
      else if(dir*(scaled(last.close)-stop)<-m.D){exit='RANGE_STRUCTURE_FAILED';m.reason='完成5分钟破坏实际方向的持仓结构';}
      m.swings=retainEdgeSwings(m.swings,swings,m.H,m.L,m.scale);
    }
    m.lastBarAt=end(last);
  }
  // Minute failed recovery may arrive between five-minute refreshes.
  if(!exit&&breakout&&m.insideAt){const boundary=dir>0?m.H:m.L,
    inward=strongRangeProof(minutes,m.insideAt,dir>0?'SHORT':'LONG',m.n5/m.scale,m.D/m.scale/2,p=>dir*(scaled(p)-boundary)<-m.D);
    if(inward&&(fast||dir*(boundary-px)>=m.n5)){exit='RANGE_BREAKOUT_FAILED';m.reason='完成回内后，随后强势向内证明使突破失效';m.reverseEligible=Math.abs(px-boundary)<=m.E;}}
  if(!exit&&m.kind==='EDGE_RETURN'&&dir*(px-m.proof.target*m.scale)>=0){exit='RANGE_RETURN_TARGET';m.reason='到达回归重心，按原计划出场';}
  const contrary=minutes.filter(r=>r.time*1000>=t.openedAt).slice(-2);
  if(!exit&&contrary.length===2&&contrary[1]!.time-contrary[0]!.time===60&&now-end(contrary[1]!,60000)<=120000
    &&contrary.every(r=>dir*(r.close-r.open)<0)&&dir*(scaled(contrary[1]!.close)-scaled(contrary[0]!.open))<-m.proof.n1*m.scale){
    m.stage='REVIEW';m.reason='两根完成小线反向超过正常噪声，复查结构；不直接平仓或反向';}
  if(!exit&&now-m.progressReviewAt>=900000){m.progressReviewAt=now;
    if(now-m.peakAt>=1800000&&net<=m.n5){m.stage='REVIEW';m.reason='30分钟没有新进展，等待结构损伤或恢复失败；时间本身不平仓';}}
  if(m.breakoutAt)m.lastBarAt=Math.max(m.lastBarAt,m.breakoutAt);
  if(exit)m.stage='EXIT';return{memory:m,stop,exit,reason:m.reason};
}
/** Stronger than the basket, or actually opposite it. Flat non-response and same-direction weakness are not scanned. */
export function tradableAnomaly(kind:string,residual:number){
  return kind==='OPPOSITE_MOVE'||(kind==='OWN_ACCELERATION'&&residual>0);
}
/** Price that nets `minNet` after both taker fees. Undefined when size cannot reach it above zero. */
export function wickProfitTarget(side:Side,entry:number,quantity:number,minNet=5,fee=.0005){
  if(!(entry>0)||!(quantity>0)||!(minNet>0)||!(fee>=0)||fee>=1)return;
  const raw=side==='LONG'
    ?(minNet+entry*quantity*(1+fee))/(quantity*(1-fee))
    :(entry*quantity*(1-fee)-minNet)/(quantity*(1+fee));
  if(!Number.isFinite(raw)||raw<=0)return;
  if(side==='LONG'?raw<=entry:raw>=entry)return;
  return raw;
}
export function wickSignal(bar:CandleLike){
  const body=Math.abs(bar.close-bar.open),upper=bar.high-Math.max(bar.open,bar.close),lower=Math.min(bar.open,bar.close)-bar.low;
  if(!(body>0)||!(bar.high>=Math.max(bar.open,bar.close))||!(bar.low<=Math.min(bar.open,bar.close))||!(upper>=0)||!(lower>=0))return;
  const longUpper=upper>body*1.5,longLower=lower>body*1.5,smallUpper=upper<body*.5,smallLower=lower<body*.5;
  const side:Side|undefined=longUpper&&smallLower?'SHORT':longLower&&smallUpper?'LONG':undefined;
  if(!side)return;
  const wick=side==='SHORT'?upper:lower,ratio=wick/body,multiple=Math.min(5,Math.max(3,3+(ratio-1.5)/1.5*2));
  return{side,body,upper,lower,multiple};
}
export type RangeScanner={prices:Map<string,{at:number;price:number}[]>;detected:Map<string,RangeDiscovery['anomalies'][number]>;quiet?:Set<string>};
export function scanRangeAnomalies(rows:{symbol:string;last:number;observedAt:number;source:string;sourceCount:number;volume24hUsd:number}[],scanner:RangeScanner,now:number,shared:number,loaded:number):RangeDiscovery{
  if(rows.length>4096)throw new Error('COMMON_POOL_CAPACITY');
  const present=new Set(rows.map(r=>r.symbol));for(const [key] of scanner.prices)if(!present.has(key.split(':')[0]!))scanner.prices.delete(key);
  const measured=rows.flatMap(row=>{
    if(now-row.observedAt>12000||row.observedAt>now||row.last<=0)return[];
    const key=`${row.symbol}:${row.source}`,p=scanner.prices.get(key)??[],last=p.at(-1);
    if(!last||row.observedAt>last.at){if(last&&Math.floor(last.at/60000)===Math.floor(row.observedAt/60000))p[p.length-1]={at:row.observedAt,price:row.last};
      else p.push({at:row.observedAt,price:row.last});while(p.length>64)p.shift();scanner.prices.set(key,p);}
    const duration=p.length>=16?15:3,anchor=p.findLast(x=>x.at<=row.observedAt-duration*60000),tail=anchor?p.filter(x=>x.at>=anchor.at):[];
    if(!anchor||row.observedAt-duration*60000-anchor.at>120000||tail.some((x,i)=>i>0&&x.at-tail[i-1]!.at>120000))return[];
    const own=row.last/anchor.price-1,normal=median(p.slice(0,-2).slice(-20).slice(1).map((x,i)=>Math.abs(x.price/p.slice(0,-2).slice(-20)[i]!.price-1)));
    return[{row,own,duration,normal}];
  }),marketRows=measured.filter(x=>x.row.volume24hUsd>=1e6),market=marketRows.length>=5?median(marketRows.map(x=>x.own)):null;
  const abnormalities=measured.filter(x=>x.row.volume24hUsd>=1e6&&market!==null&&
    (Math.abs(x.own-market)>=Math.max(x.duration===15?.004:.0015,x.normal*Math.sqrt(x.duration)*3)
      ||Math.abs(market)>=(x.duration===15?.004:.0015)&&Math.abs(x.own)<Math.abs(market)*.25));
  for(const x of abnormalities){const old=scanner.detected.get(x.row.symbol),residual=x.own-market!,kind=Math.abs(x.own)<Math.abs(market!)*.25?'ACTIVE_NONRESPONSE':x.own*market!<0?'OPPOSITE_MOVE':'OWN_ACCELERATION';
    const quiet=scanner.quiet??=new Set<string>();
    if(!tradableAnomaly(kind,residual)){if(old&&!old.frozen)scanner.detected.delete(x.row.symbol);quiet.delete(x.row.symbol);continue;}
    if(quiet.has(x.row.symbol))continue;
    if(old&&!old.frozen&&now-old.detectedAt>=WICK_WATCH_MS){scanner.detected.delete(x.row.symbol);quiet.add(x.row.symbol);continue;}
    scanner.detected.set(x.row.symbol,{symbol:x.row.symbol,source:old?.source??x.row.source,sourceCount:x.row.sourceCount,detectedAt:old?.detectedAt??now,...(old?.frozen?{frozen:true}:{}),
      own:x.own,residual,kind,score:Math.min(99,60+Math.abs(residual)*2000)});}
  const quiet=scanner.quiet??=new Set<string>(),tradableNow=new Set(abnormalities.filter(x=>tradableAnomaly(Math.abs(x.own)<Math.abs(market!)*.25?'ACTIVE_NONRESPONSE':x.own*market!<0?'OPPOSITE_MOVE':'OWN_ACCELERATION',x.own-market!)).map(x=>x.row.symbol));
  for(const symbol of quiet)if(!tradableNow.has(symbol))quiet.delete(symbol);
  for(const [symbol,a] of scanner.detected){const row=rows.find(r=>r.symbol===symbol),aged=!a.frozen&&now-a.detectedAt>=WICK_WATCH_MS;
    if((!a.frozen&&!tradableAnomaly(a.kind,a.residual))||aged||now-a.detectedAt>1800000||!present.has(symbol)||!row||row.volume24hUsd<RANGE_MIN_VOLUME_24H_USD){
      if(aged&&tradableNow.has(symbol))quiet.add(symbol);scanner.detected.delete(symbol);}}
  const anomalies=[...scanner.detected.values()];
  return{at:now,scanned:rows.filter(r=>now-r.observedAt<=12000).length,shared,excluded:shared-rows.length,marketSamples:marketRows.length,marketMove:market,
    anomalies:rankRangeDiscovery(anomalies,now),queued:Math.max(0,anomalies.length-30),loaded};
}
/** Per-account admission: source closure is never native zero exposure. */
export function rangeExecutionAdmission(t:Trade,q:Quote|undefined,now:number,confirmedFlat:boolean){
  const m=t.unified?.anomaly;if(!m)return null;
  if(!confirmedFlat)return'原方向尚未在本账户确认归零，等待平仓或未知提交核对';
  if(!q?.fresh||now-q.observedAt>10000||q.observedAt>now)return'等待本账户新鲜执行报价';
  if(now-m.proof.at>120000||now<m.proof.at)return'原入场证明已过期，不迟到复制';
  const px=t.side==='LONG'?q.bestAsk:q.bestBid,dir=d(t.side);
  if(Math.abs(px-m.proof.price*m.scale)>m.n5)return'执行价已离开原证明一个正常波动，不追单';
  if(m.kind==='EDGE_RETURN'&&Math.min(Math.abs(px-m.H),Math.abs(px-m.L))>m.n5+Math.max(m.E,m.n5)+m.D)return'当前执行价已离开可回归的边界，取消反向';
  if(dir*(px-t.stopPrice)<=0)return'原计划保护位已触发，不开新仓';return null;
}
