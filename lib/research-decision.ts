/** Research scores a proposal by the price 30 minutes later, not by our exit.
 * Decision reads only settled scores, and that stance is what the next order uses.
 * A missing desk means forward. Nothing here throws: a bad note must not brick the book. */
import {BEIJING_UTC_OFFSET_MS} from './beijing-time.ts';

export const RESEARCH_DESK_VERSION='research-desk-v1' as const;
export const DESK_ORDER_POLICY='desk-v1' as const;
/** Round trip at the 5bp taker: two fills. A move inside this did not clear cost. */
export const ROUND_TRIP_COST=.001;
export const CLAIM_HORIZON_MS=30*60_000;
export const HOLD_HORIZON_MS=90*60_000;
export const DECISION_BLOCK=20;
const WRONG_BAR=.65;
const FADE_LOSE_BAR=.35;
const SETTLED_CAP=240;
const BREADTH_FLAT=.05;

export type SessionName='ASIA'|'EUROPE'|'US';
export type ClaimKind='CONTINUE'|'SUSPECT'|'SKIP';
export type DeskStance='FORWARD'|'REVERSE'|'FLAT';
export type SideName='LONG'|'SHORT';
export type ResearchClaim={
  id:string;symbol:string;openedAt:number;session:SessionName;engineSide:SideName;kind:ClaimKind;
  slow:-1|0|1;fast:-1|0|1;entryMid:number;confirmExtreme:number|null;swept:boolean;
  settledAt?:number;settleMid?:number;engineReturn?:number;correct?:boolean;
};
export type StanceLatch={stance:'REVERSE'|'FLAT';session:SessionName;since:number;need:number};
export type ResearchDesk={version:typeof RESEARCH_DESK_VERSION;stance:DeskStance;latch?:StanceLatch;claims:ResearchClaim[];note:string};
export type DeskClaimView={
  id:string;symbol:string;engineSide:SideName;kind:ClaimKind;session:SessionName;openedAt:number;
  settled:boolean;correct:boolean|null;swept:boolean;engineReturn:number|null;
};
export type DeskResearchView={
  stance:DeskStance;session:SessionName;note:string;continueN:number;continueWrong:number;
  suspectN:number;suspectRight:number;unsettled:number;latchLeft:number|null;claims:DeskClaimView[];
};
type QuoteLike={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean};

const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
export const beijingSession=(at:number):SessionName=>{
  const hour=new Date(at+BEIJING_UTC_OFFSET_MS).getUTCHours();
  if(hour>=7&&hour<15)return 'ASIA';
  if(hour>=15&&hour<21)return 'EUROPE';
  return 'US';
};
const biasSign=(bias:unknown):-1|0|1=>bias==='BULLISH'?1:bias==='BEARISH'?-1:0;
export function readNarrative(input:{major?:unknown;short?:unknown;breadth3?:unknown}):{slow:-1|0|1;fast:-1|0|1}{
  const slow=biasSign(input.major),short=biasSign(input.short);
  const breadth=finite(input.breadth3)?input.breadth3:0;
  const fast: -1|0|1=short!==0?short:Math.abs(breadth)>=BREADTH_FLAT?(breadth>0?1:-1):0;
  return {slow,fast};
}
export function classifyClaim(engineSide:SideName,slow:-1|0|1,fast:-1|0|1):ClaimKind{
  if(slow===0||fast===0)return 'SKIP';
  const engine=engineSide==='LONG'?1:-1;
  return slow===engine&&fast===engine?'CONTINUE':'SUSPECT';
}
export function ensureResearchDesk(desk:ResearchDesk|undefined):ResearchDesk{
  if(desk&&desk.version===RESEARCH_DESK_VERSION&&Array.isArray(desk.claims)
    &&(desk.stance==='FORWARD'||desk.stance==='REVERSE'||desk.stance==='FLAT')){
    if(desk.latch&&desk.latch.stance!=='REVERSE'&&desk.latch.stance!=='FLAT')delete desk.latch;
    else if(desk.latch&&!(desk.latch.need>0))desk.latch.need=DECISION_BLOCK;
    if(typeof desk.note!=='string')desk.note='';
    return desk;
  }
  return {version:RESEARCH_DESK_VERSION,stance:'FORWARD',claims:[],note:'样本不够，新单先跟提案同一边。'};
}
function trimClaims(desk:ResearchDesk){
  const settled=desk.claims.filter(c=>finite(c.settledAt));
  if(settled.length<=SETTLED_CAP)return;
  const drop=new Set(settled.slice(0,settled.length-SETTLED_CAP).map(c=>c.id));
  desk.claims=desk.claims.filter(c=>!drop.has(c.id));
}
export function attachProposal(desk:ResearchDesk,input:{
  id:string;symbol:string;openedAt:number;engineSide:SideName;slow:-1|0|1;fast:-1|0|1;entryMid:number;confirmExtreme:number|null;
}):boolean{
  if(!input.id||desk.claims.some(c=>c.id===input.id)||!(input.entryMid>0))return false;
  const engineSide:SideName=input.engineSide==='SHORT'?'SHORT':'LONG';
  desk.claims.push({id:input.id.slice(0,80),symbol:String(input.symbol??'').slice(0,32),openedAt:input.openedAt,
    session:beijingSession(input.openedAt),engineSide,kind:classifyClaim(engineSide,input.slow,input.fast),
    slow:input.slow,fast:input.fast,entryMid:input.entryMid,
    confirmExtreme:finite(input.confirmExtreme)&&input.confirmExtreme>0?input.confirmExtreme:null,swept:false});
  trimClaims(desk);return true;
}
function freshMid(q:QuoteLike|undefined,now:number){
  if(!q||!q.fresh||!(q.bestBid>0)||q.bestAsk<q.bestBid||!(q.observedAt<=now)||now-q.observedAt>10_000)return null;
  return (q.bestBid+q.bestAsk)/2;
}
function sessionSample(desk:ResearchDesk,now:number){
  const session=beijingSession(now);
  const rows=desk.claims.filter(c=>finite(c.settledAt)&&c.session===session&&c.kind!=='SKIP')
    .sort((a,b)=>(a.settledAt??0)-(b.settledAt??0));
  const cont=rows.filter(c=>c.kind==='CONTINUE').slice(-DECISION_BLOCK);
  const sus=rows.filter(c=>c.kind==='SUSPECT').slice(-DECISION_BLOCK);
  return {session,cont,sus};
}
export function sampleStance(desk:ResearchDesk,now:number):DeskStance{
  const {cont,sus}=sessionSample(desk,now);
  if(cont.length<DECISION_BLOCK||sus.length<DECISION_BLOCK)return 'FORWARD';
  const wrong=cont.filter(c=>c.correct!==true).length/cont.length;
  const right=sus.filter(c=>c.correct===true).length/sus.length;
  if(wrong>WRONG_BAR&&right<FADE_LOSE_BAR)return 'FLAT';
  if(wrong>WRONG_BAR&&right>WRONG_BAR)return 'REVERSE';
  return 'FORWARD';
}
function describe(desk:ResearchDesk,now:number){
  const {session,cont,sus}=sessionSample(desk,now);
  const name=session==='ASIA'?'亚盘':session==='EUROPE'?'欧盘':'美盘';
  const latch=desk.latch;
  const settled=desk.claims.filter(c=>finite(c.settledAt));
  const left=latch?Math.max(0,latch.need-settled.filter(c=>(c.settledAt??0)>latch.since).length):null;
  const sample=cont.length<DECISION_BLOCK||sus.length<DECISION_BLOCK
    ?`${name}延续 ${cont.length}/20、可疑 ${sus.length}/20，样本不够，新单继续${desk.stance==='REVERSE'?'反向':desk.stance==='FLAT'?'停开':'正向'}。`
    :`${name}延续错了 ${cont.filter(c=>c.correct!==true).length}/20，可疑反着读对了 ${sus.filter(c=>c.correct===true).length}/20。`;
  const hold=left!=null&&left>0?`这个方向再看 ${left} 笔才重判。`:'';
  return (sample+hold).slice(0,180);
}
export function refreshStance(desk:ResearchDesk,now:number){
  const settled=desk.claims.filter(c=>finite(c.settledAt));
  const latch=desk.latch;
  if(latch&&(latch.stance==='REVERSE'||latch.stance==='FLAT')){
    const newer=settled.filter(c=>(c.settledAt??0)>latch.since).length;
    if(newer<latch.need){desk.stance=latch.stance;desk.note=describe(desk,now);return;}
  }
  const next=sampleStance(desk,now);
  desk.stance=next;
  if(next==='REVERSE'||next==='FLAT')desk.latch={stance:next,session:beijingSession(now),since:now,need:DECISION_BLOCK};
  else delete desk.latch;
  desk.note=describe(desk,now);
}
/** First fresh mid at or after the horizon. A source exit price is not a research mark. */
export function observeResearch(desk:ResearchDesk,quotes:Record<string,QuoteLike|undefined>,now:number){
  let dirty=false;
  for(const c of desk.claims){
    if(!c?.id)continue;
    const q=quotes[c.symbol],mid=freshMid(q,now);
    if(mid==null)continue;
    if(!c.swept&&finite(c.confirmExtreme)&&c.confirmExtreme>0&&(c.engineSide==='LONG'?mid<=c.confirmExtreme:mid>=c.confirmExtreme)){
      c.swept=true;dirty=true;
    }
    if(finite(c.settledAt))continue;
    const horizon=c.openedAt+CLAIM_HORIZON_MS;
    if(now<horizon||!q||q.observedAt<horizon||!(c.entryMid>0))continue;
    const ret=(c.engineSide==='LONG'?1:-1)*(mid-c.entryMid)/c.entryMid;
    c.settledAt=now;c.settleMid=mid;c.engineReturn=ret;
    if(c.kind==='CONTINUE')c.correct=ret>ROUND_TRIP_COST;
    else if(c.kind==='SUSPECT')c.correct=!(ret>ROUND_TRIP_COST);
    dirty=true;
  }
  const prevStance=desk.stance,prevSince=desk.latch?.since??-1,prevLatch=desk.latch?.stance??'';
  refreshStance(desk,now);
  if(desk.stance!==prevStance||(desk.latch?.since??-1)!==prevSince||(desk.latch?.stance??'')!==prevLatch)dirty=true;
  return dirty;
}
function viewClaim(c:ResearchClaim):DeskClaimView{
  return {id:c.id,symbol:c.symbol,engineSide:c.engineSide,kind:c.kind,session:c.session,openedAt:c.openedAt,
    settled:finite(c.settledAt),correct:typeof c.correct==='boolean'?c.correct:null,swept:c.swept===true,
    engineReturn:finite(c.engineReturn)?c.engineReturn:null};
}
export function researchDeskView(desk:ResearchDesk|undefined,now:number):DeskResearchView{
  const empty=ensureResearchDesk(desk);
  const live=desk&&desk.version===RESEARCH_DESK_VERSION?desk:empty;
  const {session,cont,sus}=sessionSample(live,now);
  const settled=live.claims.filter(c=>finite(c.settledAt));
  const latch=live.latch;
  const latchLeft=latch?Math.max(0,latch.need-settled.filter(c=>(c.settledAt??0)>latch.since).length):null;
  const recent=live.claims.slice(-8);
  const extra=live.claims.filter(c=>!finite(c.settledAt)&&!recent.includes(c)).slice(-4);
  return {stance:live.stance,session,note:live.note||describe(live,now),
    continueN:cont.length,continueWrong:cont.filter(c=>c.correct!==true).length,
    suspectN:sus.length,suspectRight:sus.filter(c=>c.correct===true).length,
    unsettled:live.claims.filter(c=>!finite(c.settledAt)).length,latchLeft,
    claims:[...extra,...recent].map(viewClaim)};
}
