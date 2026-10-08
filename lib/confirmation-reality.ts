/** Decides whether new copies fade the confirmation, pause, or briefly follow it.
 * The pause is a clock hour after persistence has been high and expansion has been
 * mostly HIGH, then either persistence drops or that expansion thins out.
 * Following uses the shadow's own completed results, never this book's result. */
export const CONFIRMATION_REALITY_VERSION='confirmation-reality-v1' as const;
const HOUR=60*60*1000;
const RECENT=12;
const CERTAIN_PERSISTENCE=0.70;
const CERTAIN_HIGH_SHARE=0.5;
const ROLLOVER=0.06;
const MIN_HOUR=4;
const PAUSE_MS=6*HOUR;
const FOLLOW_MS=2*HOUR;

export type ConfirmationRealityTrade={
  status?:string;exitReason?:string|null;netPnl?:number|null;openedAt?:number;closedAt?:number|null;
  inverseCopy?:{sourceEntryPlan?:{
    environmentPersistenceScore?:number;environmentTransitionPressure?:number;environmentProfitExpansion?:string;
  }|null;fills?:{sourceGross?:number;sourceFee?:number;frozenSourceFee?:number;sourceFunding?:number}[];
    detachedSourceClosed?:boolean}|null;
};
type Kind='REAL'|'FAKE';
type Expansion='HIGH'|'NORMAL'|'LOW'|null;
type Row={openedAt:number;closedAt:number;kind:Kind;persistence:number|null;transition:number|null;expansion:Expansion};
export type BookRegimeName='FADE'|'PAUSE'|'FOLLOW';
export type ConfirmationReality={
  version:typeof CONFIRMATION_REALITY_VERSION;ordersAffected:false;
  classified:number;fake:number;real:number;
  recentRealShare:number|null;priorRealShare:number|null;
  certainty:{seen:boolean;peakPersistence:number|null;at:number|null;highShare:number|null};
  rollover:{seen:boolean;fromPersistence:number|null;toPersistence:number|null;at:number|null};
  state:'FAKE_MAJORITY'|'CERTAINTY'|'REAL_MAJORITY'|'MIXED'|'NO_SAMPLE';
  regime:BookRegimeName;
  entryHalted:boolean;sentence:string;
};

const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const pct=(v:number|null)=>v==null?'—':`${Math.round(v*100)}%`;
const share=(rows:Row[])=>rows.length?rows.filter(r=>r.kind==='REAL').length/rows.length:null;

function kindOf(t:ConfirmationRealityTrade):Kind|null{
  if(t.status!=='CLOSED'||!t.inverseCopy||!finite(t.netPnl))return null;
  if(t.exitReason==='INVERSE_SOFT_LOSS_EXIT')return 'REAL';
  if(t.exitReason==='SHADOW_SOURCE_EXIT')return t.netPnl>0?'FAKE':'REAL';
  return null;
}
function expansionOf(v:string|undefined):Expansion{
  return v==='HIGH'||v==='NORMAL'||v==='LOW'?v:null;
}
function shadowWin(t:ConfirmationRealityTrade):boolean|null{
  if(t.status!=='CLOSED'||!t.inverseCopy)return null;
  const fills=t.inverseCopy.fills;
  if(!fills?.length)return null;
  if(t.exitReason==='INVERSE_SOFT_LOSS_EXIT'&&!t.inverseCopy.detachedSourceClosed)return null;
  let net=0;
  for(const f of fills)net+=(f.sourceGross??0)-(f.frozenSourceFee??f.sourceFee??0)-(f.sourceFunding??0);
  return finite(net)?net>0:null;
}
function rowsOf(trades:ConfirmationRealityTrade[]):Row[]{
  const rows:Row[]=[];
  for(const t of trades){
    const kind=kindOf(t);if(!kind||!finite(t.openedAt)||!finite(t.closedAt))continue;
    const plan=t.inverseCopy?.sourceEntryPlan;
    rows.push({openedAt:t.openedAt,closedAt:t.closedAt,kind,
      persistence:finite(plan?.environmentPersistenceScore)?plan!.environmentPersistenceScore!:null,
      transition:finite(plan?.environmentTransitionPressure)?plan!.environmentTransitionPressure!:null,
      expansion:expansionOf(plan?.environmentProfitExpansion)});
  }
  return rows;
}
function hours(rows:Row[]){
  const buckets=new Map<number,{rows:Row[]}>();
  for(const row of rows){
    const at=Math.floor(row.openedAt/HOUR)*HOUR;
    const bucket=buckets.get(at)??{rows:[]};bucket.rows.push(row);buckets.set(at,bucket);
  }
  return [...buckets.entries()].sort((a,b)=>a[0]-b[0]).map(([at,bucket])=>{
    const pers=bucket.rows.map(r=>r.persistence).filter((v):v is number=>v!=null);
    const high=bucket.rows.filter(r=>r.expansion==='HIGH').length;
    return {at,n:bucket.rows.length,persistence:pers.length?pers.reduce((a,b)=>a+b,0)/pers.length:null,
      highShare:bucket.rows.length?high/bucket.rows.length:0,realShare:share(bucket.rows)??0};
  });
}

export type RegimeOpen={id?:string;at:number;persistence:number|null;expansion:Expansion};
export function bookRegime(trades:ConfirmationRealityTrade[],now=Date.now(),opens?:RegimeOpen[]):{mode:BookRegimeName;reason:string;pauseUntil:number;followUntil:number}{
  type Ev={at:number;sort:0|1;kind:'open'|'close';persistence:number|null;expansion:Expansion;shadowWin?:boolean};
  const events:Ev[]=[];
  const merged=new Map<string,RegimeOpen>();
  trades.forEach((t,index)=>{
    if(!t.inverseCopy||!finite(t.openedAt)||t.openedAt>now)return;
    const plan=t.inverseCopy.sourceEntryPlan;
    const id=t.inverseCopy&&'sourceId' in t.inverseCopy&&typeof (t.inverseCopy as {sourceId?:string}).sourceId==='string'
      ?(t.inverseCopy as {sourceId:string}).sourceId:`trade-${index}`;
    merged.set(id,{id,at:t.openedAt,persistence:finite(plan?.environmentPersistenceScore)?plan!.environmentPersistenceScore!:null,
      expansion:expansionOf(plan?.environmentProfitExpansion)});
  });
  for(const row of opens??[])if(finite(row.at)&&row.at<=now)merged.set(row.id??`${row.at}:${row.persistence}`,row);
  for(const row of merged.values())events.push({at:row.at,sort:0,kind:'open',persistence:row.persistence,expansion:row.expansion});
  for(const t of trades){
    const win=shadowWin(t);
    if(win!=null&&finite(t.closedAt)&&t.closedAt<=now)events.push({at:t.closedAt,sort:1,kind:'close',persistence:null,expansion:null,shadowWin:win});
  }
  events.sort((a,b)=>a.at-b.at||a.sort-b.sort);
  const buckets=new Map<number,{pers:number[];high:number;n:number}>();
  const gate:{mode:BookRegimeName;pauseUntil:number;followUntil:number}={mode:'FADE',pauseUntil:0,followUntil:0};
  let climax:{peak:number;hour:number}|null=null;
  const recent:boolean[]=[];
  const wins=()=>recent.length>=RECENT?recent.filter(Boolean).length/RECENT:0;
  function advance(at:number){
    if(gate.mode==='PAUSE'&&at>=gate.pauseUntil){
      if(wins()>0.5){gate.mode='FOLLOW';gate.followUntil=gate.pauseUntil+FOLLOW_MS;}
      else gate.mode='FADE';
    }
    if(gate.mode==='FOLLOW'&&(at>=gate.followUntil||(recent.length>=RECENT&&wins()<=0.5)))gate.mode='FADE';
  }
  function consider(hour:number,at:number){
    const bucket=buckets.get(hour);if(!bucket||bucket.n<MIN_HOUR||!bucket.pers.length)return;
    const avg=bucket.pers.reduce((a,b)=>a+b,0)/bucket.pers.length,highShare=bucket.high/bucket.n;
    if(!climax&&avg>=CERTAIN_PERSISTENCE&&highShare>=CERTAIN_HIGH_SHARE){climax={peak:avg,hour};return;}
    if(climax&&hour>climax.hour&&gate.mode==='FADE'&&at>=gate.pauseUntil&&(climax.peak-avg>=ROLLOVER||highShare<0.3)){
      gate.mode='PAUSE';gate.pauseUntil=at+PAUSE_MS;gate.followUntil=0;climax=null;
    }
  }
  for(const e of events){
    advance(e.at);
    if(e.kind==='close'){recent.push(!!e.shadowWin);if(recent.length>RECENT)recent.shift();advance(e.at);continue;}
    const hour=Math.floor(e.at/HOUR)*HOUR,bucket=buckets.get(hour)??{pers:[],high:0,n:0};
    bucket.n++;if(e.persistence!=null)bucket.pers.push(e.persistence);if(e.expansion==='HIGH')bucket.high++;
    buckets.set(hour,bucket);consider(hour,e.at);
  }
  advance(now);
  const mode=gate.mode,pauseUntil=gate.pauseUntil,followUntil=gate.followUntil;
  const reason=mode==='PAUSE'?'持续力已从高位掉下来，新单先停 6 小时，不改顺着做。'
    :mode==='FOLLOW'?'停开结束，最近 12 笔影子赢面过半，这两小时顺着做。':'';
  return {mode,reason,pauseUntil,followUntil};
}

export function confirmationRealityView(trades:ConfirmationRealityTrade[],now=Date.now(),extra?:{opens?:RegimeOpen[];pauseUntil?:number}):ConfirmationReality{
  const rows=rowsOf(trades).sort((a,b)=>a.closedAt-b.closedAt);
  const regime=bookRegime(trades,now,extra?.opens);
  const mode:BookRegimeName=regime.mode==='FADE'&&extra?.pauseUntil!=null&&now<extra.pauseUntil?'PAUSE':regime.mode;
  const base={version:CONFIRMATION_REALITY_VERSION,ordersAffected:false as const,
    classified:rows.length,fake:rows.filter(r=>r.kind==='FAKE').length,real:rows.filter(r=>r.kind==='REAL').length,regime:mode};
  if(rows.length<4)return {...base,recentRealShare:null,priorRealShare:null,
    certainty:{seen:false,peakPersistence:null,at:null,highShare:null},
    rollover:{seen:false,fromPersistence:null,toPersistence:null,at:null},
    state:'NO_SAMPLE',entryHalted:mode==='PAUSE',sentence:'确认样本还不够。新单先反着做。'};
  const recent=rows.slice(-RECENT),prior=rows.slice(-RECENT*2,-RECENT);
  const recentRealShare=share(recent),priorRealShare=share(prior);
  const openHours=hours(rows.filter(r=>r.closedAt<=now));
  let peak:typeof openHours[number]|null=null;
  for(const hour of openHours){
    if(hour.persistence!=null&&hour.persistence>=CERTAIN_PERSISTENCE&&hour.highShare>=CERTAIN_HIGH_SHARE
      &&(peak==null||hour.persistence>=(peak.persistence??0)))peak=hour;
  }
  let rolled:typeof openHours[number]|null=null;
  if(peak){
    for(const hour of openHours){
      if(hour.at<=peak.at||hour.persistence==null)continue;
      if(peak.persistence!-hour.persistence>=ROLLOVER){rolled=hour;break;}
    }
  }
  const certainty={seen:!!peak,peakPersistence:peak?.persistence??null,at:peak?.at??null,highShare:peak?.highShare??null};
  const rollover={seen:!!rolled,fromPersistence:peak?.persistence??null,toPersistence:rolled?.persistence??null,at:rolled?.at??null};
  const latest=openHours.at(-1);
  const stillCertain=!!latest&&latest.persistence!=null&&latest.persistence>=CERTAIN_PERSISTENCE&&latest.highShare>=CERTAIN_HIGH_SHARE;
  const realNow=(recentRealShare??0)>0.5;
  const state:ConfirmationReality['state']=realNow?'REAL_MAJORITY':stillCertain?'CERTAINTY':(recentRealShare??1)<=0.30?'FAKE_MAJORITY':'MIXED';
  const sentence=mode==='PAUSE'
    ?`持续力已从 ${pct(certainty.peakPersistence)} 的高位掉下来。新单先停 6 小时，不改顺着做。已经开着的单照旧平。`
    :mode==='FOLLOW'
    ?'停开结束，最近 12 笔影子赢面过半。这两小时顺着做，时间一到就回到反着做。'
    :state==='CERTAINTY'
      ?`持续力已经到 ${pct(latest?.persistence??null)}，利润扩张停在「高」。还没掉下来，继续反着做。`
      :`现在反着做。确认一出来，新单做反方向。`;
  return {...base,recentRealShare,priorRealShare,certainty,rollover,state,entryHalted:mode==='PAUSE',sentence};
}

export function inverseEntryHalted(trades:ConfirmationRealityTrade[],now=Date.now()){
  const regime=bookRegime(trades,now);
  return {halted:regime.mode==='PAUSE',mode:regime.mode,reason:regime.reason};
}
