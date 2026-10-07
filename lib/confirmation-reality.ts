/** Research only. Watches whether a fresh confirmation was fake or real, and
 * whether the market got unusually sure the current state would last before
 * confirmations turned real. Never places or exits an order. */
export const CONFIRMATION_REALITY_VERSION='confirmation-reality-v1' as const;
const HOUR=60*60*1000;
const RECENT=12;
const CERTAIN_PERSISTENCE=0.70;
const CERTAIN_HIGH_SHARE=0.5;
const ROLLOVER=0.06;

export type ConfirmationRealityTrade={
  status?:string;exitReason?:string|null;netPnl?:number|null;openedAt?:number;closedAt?:number|null;
  inverseCopy?:{sourceEntryPlan?:{
    environmentPersistenceScore?:number;environmentTransitionPressure?:number;environmentProfitExpansion?:string;
  }|null}|null;
};
type Kind='REAL'|'FAKE';
type Expansion='HIGH'|'NORMAL'|'LOW'|null;
type Row={openedAt:number;closedAt:number;kind:Kind;persistence:number|null;transition:number|null;expansion:Expansion};
export type ConfirmationReality={
  version:typeof CONFIRMATION_REALITY_VERSION;ordersAffected:false;
  classified:number;fake:number;real:number;
  recentRealShare:number|null;priorRealShare:number|null;
  certainty:{seen:boolean;peakPersistence:number|null;at:number|null;highShare:number|null};
  rollover:{seen:boolean;fromPersistence:number|null;toPersistence:number|null;at:number|null};
  state:'FAKE_MAJORITY'|'CERTAINTY'|'REAL_MAJORITY'|'MIXED'|'NO_SAMPLE';
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

export function confirmationRealityView(trades:ConfirmationRealityTrade[],now=Date.now()):ConfirmationReality{
  const rows=rowsOf(trades).sort((a,b)=>a.closedAt-b.closedAt);
  const base={version:CONFIRMATION_REALITY_VERSION,ordersAffected:false as const,
    classified:rows.length,fake:rows.filter(r=>r.kind==='FAKE').length,real:rows.filter(r=>r.kind==='REAL').length};
  if(rows.length<4)return {...base,recentRealShare:null,priorRealShare:null,
    certainty:{seen:false,peakPersistence:null,at:null,highShare:null},
    rollover:{seen:false,fromPersistence:null,toPersistence:null,at:null},
    state:'NO_SAMPLE',entryHalted:false,sentence:'确认样本还不够，不能判断方向是假的还是真的。反向继续开。'};
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
  const entryHalted=inverseEntryHalted(trades,now).halted;
  const state:ConfirmationReality['state']=realNow?'REAL_MAJORITY':stillCertain?'CERTAINTY':(recentRealShare??1)<=0.30?'FAKE_MAJORITY':'MIXED';
  const sentence=entryHalted
    ?`条件持续力已从 ${pct(certainty.peakPersistence)} 的高位掉下来，最近 ${recent.length} 笔确认里 ${recent.filter(r=>r.kind==='REAL').length} 笔方向是真的。不再反着做，新单顺着确认方向开。已经开着的反向照旧出场。`
    :state==='REAL_MAJORITY'
    ?`最近 ${recent.length} 笔确认里，${recent.filter(r=>r.kind==='REAL').length} 笔方向是真的。这次前面没有「持续力先升到高位再掉下来」，不停开。`
    :state==='CERTAINTY'
      ?`最近确认仍多半是假的，反向继续开。条件持续力已经到 ${pct(latest?.persistence??null)}，利润扩张停在「高」。这是变真之前会先出现的状态，还没到停开。`
      :state==='FAKE_MAJORITY'
        ?`最近 ${recent.length} 笔确认里，只有 ${recent.filter(r=>r.kind==='REAL').length} 笔方向是真的。反向继续开。`
        :`最近确认真假掺半（真方向 ${pct(recentRealShare)}）。还没到停开，反向继续开。`;
  return {...base,recentRealShare,priorRealShare,certainty,rollover,state,entryHalted,sentence};
}

export function inverseEntryHalted(trades:ConfirmationRealityTrade[],now=Date.now()){
  type Open={at:number;sort:0;persistence:number|null;expansion:Expansion};
  type Close={at:number;sort:1;result:Kind};
  const events:(Open|Close)[]=[];
  for(const t of trades){
    if(!t.inverseCopy||!finite(t.openedAt)||t.openedAt>now)continue;
    const plan=t.inverseCopy.sourceEntryPlan;
    events.push({at:t.openedAt,sort:0,persistence:finite(plan?.environmentPersistenceScore)?plan.environmentPersistenceScore:null,
      expansion:expansionOf(plan?.environmentProfitExpansion)});
    const result=kindOf(t);
    if(result&&finite(t.closedAt)&&t.closedAt<=now)events.push({at:t.closedAt,sort:1,result});
  }
  events.sort((a,b)=>a.at-b.at||a.sort-b.sort);
  let peak:number|null=null,rolled=false,halted=false;
  const recent:Kind[]=[];
  for(const e of events){
    if(e.sort===0){
      if(e.persistence!=null&&e.persistence>=CERTAIN_PERSISTENCE&&e.expansion==='HIGH'){if(!rolled)peak=Math.max(peak??0,e.persistence);}
      else if(peak!=null&&!rolled&&e.persistence!=null&&peak-e.persistence>=ROLLOVER)rolled=true;
    }else{
      recent.push(e.result);if(recent.length>RECENT)recent.shift();
      if(recent.length<RECENT)continue;
      const real=recent.filter(x=>x==='REAL').length/RECENT;
      if(!halted&&rolled&&real>0.5)halted=true;
      if(halted&&real<=0.30){halted=false;peak=null;rolled=false;}
    }
  }
  return {halted,reason:halted?'条件持续力已从高位回落，最近确认多半是真方向，新单改为顺着确认方向开。':''};
}
