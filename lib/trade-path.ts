/** Observation only. Never changes an order, a stop, or the account. */
import {shadowFields} from './shadow-branch.ts';
import type {ForwardState, Quote, Trade} from './forward-relations.ts';

export const TRADE_PATH_KEY='market-intelligence:trade-paths:v1';
export const TRADE_PATH_INDEX_KEY='market-intelligence:trade-paths:v2';
export const TRADE_PATH_PAGE_PREFIX='market-intelligence:trade-paths:v2:';
export const TRADE_PATH_VERSION='trade-path-v1' as const;
export const TRADE_PATH_PAGE_VERSION='trade-path-v2' as const;
const AFTER_MINUTES=360;
/** After the minute-by-minute 6 hours, one 15-minute high/low bucket per point up to 24 hours from the signal. */
export const TAIL_MINUTES=1440;
const TAIL_BUCKET=15;
/** Exit-condition snapshots for opened paper trades: one every 30 minutes while open, at most 48 (24 hours). */
const TRACK_EVERY=30;
const TRACK_CAP=48;
/** Radar (all-ticker) price used only when no quote is fresh; it is at most this old. */
const FALLBACK_WINDOW_MS=120_000;
/** Entry features are written only if the record is first seen within this long of its signal. */
export const FEATURE_FRESH_MS=10*60_000;
/** Run-log record cap. Same number as the not-opened archive (UNOPENED_COLD_CAP): one limit for records + paths. */
export const PATH_CAP=1200;
const PATH_PAGE_SIZE=4;
const PAGE_BYTE_BUDGET=96_000;
const PRICE_WINDOW_MS=5*60_000;
const COST_RATE=0.002;
const FEE_RATE=0.0007;
const TAKE_PROFITS=[0.4,0.6,0.8,1,1.5,2,3];
const STOP_LOSSES=[0.3,0.4,0.6,0.8,1,1.5];
const HOLD_MINUTES=[5,15,30,45,60,90,120,180];

export type PathPoint=[number,number,number];
/** What the exit logic looked like at one moment. Read off the trade; never written back. */
export type PathState={m:number;pct:number;stage:string|null;stop:number|null;
  pi:string|null;pi_phase:string|null;wm_phase:string|null;wm_stop:number|null;wm_action:string|null;
  pl_phase:string|null;pl_action:string|null;pl_floor:number|null;pl_giveback:number|null;pl_trajectory:string|null;
  pp_mode:string|null;pp_floor:number|null;pp_locked_r:number|null;hv:string|null};
export type PathEnd=PathState&{trigger:string|null;detail:string|null;evidence:Record<string,string|number|boolean|null>|null;
  exit_stage:string|null;peak_pct:number;exit_pct:number;giveback_pct:number};
export type EntryFeatureValue=number|string|boolean|null;
export type TradePath={
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;qty:number;notional:number;entryFee:number;openedAt:number;
  exit:number|null;exitAt:number|null;net:number|null;hold:PathPoint[];after:PathPoint[];page?:number;
  /** 6h-24h after the signal: [minute since open (bucket start), low, high], 15-minute buckets. */
  tail?:PathPoint[];
  /** Entry features captured the tick the record appeared (see lib/entry-features.ts). */
  x?:Record<string,EntryFeatureValue>|null;
  /** Exit-logic state at the best price while the record was open. */
  peak?:PathState|null;
  /** Exit-logic state, trigger and giveback when the record closed. */
  end?:PathEnd|null;
  /** Opened paper trades only: exit-logic state every 30 minutes while open. */
  track?:PathState[];
};
export type PathCapture={features?:(t:Trade)=>Record<string,EntryFeatureValue>|null;fallback?:Record<string,{px:number;at:number}>};
export type TradePathBook={
  version:typeof TRADE_PATH_VERSION;accountStartedAt:number;trades:TradePath[];
  dirty:number[];drop:number[];indexDirty:boolean;
};
export type TradePathPage={version:typeof TRADE_PATH_PAGE_VERSION;accountStartedAt:number;page:number;trades:TradePath[]};
export type TradePathIndex={version:typeof TRADE_PATH_PAGE_VERSION;accountStartedAt:number;pages:number[]};
export type PathWrite={op:'put';page:number;value:TradePathPage}|{op:'delete';page:number}|{op:'index';value:TradePathIndex};

export function emptyTradePathBook(accountStartedAt:number):TradePathBook{
  return {version:TRADE_PATH_VERSION,accountStartedAt,trades:[],dirty:[],drop:[],indexDirty:false};
}
export function restoreTradePathBook(saved:TradePathBook|undefined,accountStartedAt:number){
  if(!saved||saved.version!==TRADE_PATH_VERSION||saved.accountStartedAt!==accountStartedAt||!Array.isArray(saved.trades))return emptyTradePathBook(accountStartedAt);
  return {version:TRADE_PATH_VERSION,accountStartedAt,trades:saved.trades,dirty:[],drop:[],indexDirty:false};
}
export function adoptLegacyPaths(saved:TradePathBook|undefined,accountStartedAt:number){
  const book=restoreTradePathBook(saved,accountStartedAt);
  const count=book.trades.length;
  book.trades.forEach((row,index)=>{row.page=Math.floor((count-1-index)/PATH_PAGE_SIZE);});
  book.dirty=[...new Set(book.trades.map(row=>row.page??0))];
  book.indexDirty=book.trades.length>0;
  return book;
}
export function bookFromStoredPaths(accountStartedAt:number,index:TradePathIndex,pages:Iterable<TradePathPage|undefined>){
  const book=emptyTradePathBook(accountStartedAt);
  const byPage=new Map<number,TradePath[]>();
  for(const page of pages){
    if(!page||page.version!==TRADE_PATH_PAGE_VERSION||page.accountStartedAt!==accountStartedAt||!Array.isArray(page.trades))continue;
    byPage.set(page.page,page.trades);
  }
  for(const page of [...index.pages].sort((a,b)=>b-a)){
    const rows=byPage.get(page);if(rows)book.trades.push(...rows);
  }
  return book;
}
export function peekPathWrite(book:TradePathBook):PathWrite|null{
  return pendingPathWrites(book,1)[0]??null;
}
/** Thin and newly closed pages go out first, then every other dirty page. The index is in the same batch. */
export function pendingPathWrites(book:TradePathBook,limit=8):PathWrite[]{
  const rank=(page:number)=>{
    const rows=book.trades.filter(row=>(row.page??0)===page);
    if(rows.some(row=>row.exit!=null))return 0;
    if(rows.some(row=>row.hold.length<=1))return 1;
    return 2;
  };
  const chosen=[...book.dirty].sort((a,b)=>rank(a)-rank(b)||book.dirty.indexOf(a)-book.dirty.indexOf(b)).slice(0,Math.max(1,limit));
  const jobs:PathWrite[]=chosen.map(page=>({op:'put',page,value:packPathPage(book.accountStartedAt,page,book.trades.filter(row=>(row.page??0)===page))}));
  if(book.indexDirty&&(jobs.length>0||book.dirty.length===0)){
    const pages=[...new Set(book.trades.map(row=>row.page??0))].sort((a,b)=>a-b);
    jobs.push({op:'index',value:{version:TRADE_PATH_PAGE_VERSION,accountStartedAt:book.accountStartedAt,pages}});
  }
  if(jobs.length)return jobs;
  const drop=book.drop[0];
  return drop==null?[]:[{op:'delete',page:drop}];
}
export function commitPathWrite(book:TradePathBook,job:PathWrite){
  if(job.op==='put'){
    const at=book.dirty.indexOf(job.page);
    if(at>=0)book.dirty.splice(at,1);
  }else if(job.op==='index')book.indexDirty=false;
  else book.drop.shift();
}

const num=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?Math.round(v*1e6)/1e6:null;
const str=(v:unknown)=>typeof v==="string"?v:null;
const favorablePct=(side:'LONG'|'SHORT',entry:number,px:number)=>entry>0?Math.round((side==='LONG'?px/entry-1:1-px/entry)*1e6)/1e4:0;
/** Snapshot of the exit logic as it stands on the trade. Pure read. */
export function pathState(t:Trade,stage:string|null,m:number,pct:number):PathState{
  const pi=t.positionIntelligence,wm=t.winnerManagement,pl=t.profitLifecycle,pp=t.profitProtection;
  return {m,pct,stage,stop:num(t.stopPrice),pi:str(pi?.decision),pi_phase:str(pi?.phase),
    wm_phase:str(wm?.phase),wm_stop:num(wm?.protectedStop),wm_action:str(wm?.requestedAction),
    pl_phase:str(pl?.phase),pl_action:str(pl?.action),pl_floor:num(pl?.floorRate),pl_giveback:num(pl?.givebackRatio),pl_trajectory:str(pl?.trajectory),
    pp_mode:str(pp?.mode),pp_floor:num(pp?.floorRate),pp_locked_r:num(pp?.lockedR),hv:str(t.holdValue?.action)};
}
function bestFavorable(row:TradePath){
  let best=0;
  for(const point of row.hold)best=Math.max(best,favorablePct(row.side,row.entry,point[1]),favorablePct(row.side,row.entry,point[2]));
  return best;
}
function evidenceOf(raw:unknown){
  if(!raw||typeof raw!=="object")return null;
  const out:Record<string,string|number|boolean|null>={};let n=0;
  for(const [key,value] of Object.entries(raw as Record<string,unknown>)){
    if(n>=16)break;
    if(value===null||typeof value==="boolean"||typeof value==="number"||typeof value==="string"){
      out[key]=typeof value==="string"?value.slice(0,120):typeof value==="number"?num(value):value;n++;
    }
  }
  return out;
}

export function observeTradePaths(book:TradePathBook,state:ForwardState,execution:Record<string,Quote>,analysis:Record<string,Quote>,now:number,bars?:Record<string,{time:number;high:number;low:number}[]>,capture?:PathCapture){
  let changed=false;
  if(book.accountStartedAt!==state.startedAt){book.accountStartedAt=state.startedAt;book.trades=[];book.dirty=[];book.indexDirty=true;changed=true;}
  const byId=new Map(book.trades.map(row=>[row.id,row]));
  for(const t of [...state.positions,...state.history,...(state.unopenedTrades??[])]){
    if(t.inverseCopy)continue;
    let row=byId.get(t.id);
    if(!row){
      const page=nextPathPage(book);
      let x:Record<string,EntryFeatureValue>|null=null;
      // Only at (or right after) the signal: features computed later would describe a different moment.
      try{x=capture?.features&&now-t.openedAt<=FEATURE_FRESH_MS?capture.features(t):null;}catch{x=null;}
      row={id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,qty:t.quantity,notional:t.notional,entryFee:t.entryFee,openedAt:t.openedAt,
        exit:null,exitAt:null,net:null,hold:[],after:[],page,...(x?{x}:{})};
      if(!book.trades.some(item=>(item.page??0)===page))book.indexDirty=true;
      book.trades.unshift(row);byId.set(t.id,row);markDirty(book,page);changed=true;
    }
    if(row.hold.length<=1&&rebuildFromBars(row,bars?.[t.symbol],t.closedAt??now)){markDirty(book,row.page??0);changed=true;}
    const stage=state.environmentContext?.environment??null;
    if(t.status==='CLOSED'&&row.exit==null&&t.exitPrice!=null&&t.closedAt!=null){
      row.exit=t.exitPrice;row.exitAt=t.closedAt;row.net=t.netPnl;row.qty=t.realization?.initialQuantity??row.qty;
      const exitMin=Math.max(0,Math.floor((t.closedAt-t.openedAt)/60_000));
      note(row.hold,exitMin,t.exitPrice);markDirty(book,row.page??0);changed=true;
      try{
        const peakPct=Math.max(bestFavorable(row),row.peak?.pct??0),exitPct=favorablePct(row.side,row.entry,t.exitPrice);
        row.end={...pathState(t,stage,exitMin,exitPct),trigger:str(t.exitAudit?.trigger)??str(t.exitReason),detail:str(t.exitAudit?.detail)?.slice(0,200)??null,
          evidence:evidenceOf(t.exitAudit?.evidence),exit_stage:str(t.exitRegime?.stage),peak_pct:peakPct,exit_pct:exitPct,
          giveback_pct:Math.round((peakPct-exitPct)*1e4)/1e4};
      }catch{/* 出场快照失败不挡路径 */}
    }
    const live=execution[t.symbol],wide=analysis[t.symbol],spare=capture?.fallback?.[t.symbol];
    const minute=Math.floor((now-t.openedAt)/60_000);
    if(t.status==='OPEN'){
      if(now-row.openedAt<=AFTER_MINUTES*60_000){
        const px=pathPrice(t.side,live,wide,t.lastPrice,t.lastQuoteAt,now,spare);
        if(px!=null&&note(row.hold,minute,px)){markDirty(book,row.page??0);changed=true;}
        if(px!=null){
          const pct=favorablePct(t.side,row.entry,px);
          if(pct>0&&pct>(row.peak?.pct??0)){row.peak=pathState(t,stage,minute,pct);markDirty(book,row.page??0);changed=true;}
          if(!t.unopened){
            const track=row.track??[];
            if(track.length<TRACK_CAP&&(!track.length||minute-track.at(-1)!.m>=TRACK_EVERY)){
              row.track=[...track,pathState(t,stage,minute,pct)];markDirty(book,row.page??0);changed=true;
            }
          }
        }
      }
    }else if(row.exitAt!=null&&now>=row.exitAt&&now-row.openedAt<=AFTER_MINUTES*60_000){
      const px=pathPrice(t.side,live,wide,0,0,now,spare);
      if(px!=null&&note(row.after,Math.floor((now-row.exitAt)/60_000),px)){markDirty(book,row.page??0);changed=true;}
    }
    // 6h-24h tail, whatever the status: the signal's longer outcome.
    if(minute>AFTER_MINUTES&&minute<=TAIL_MINUTES){
      const px=t.status==='OPEN'?pathPrice(t.side,live,wide,t.lastPrice,t.lastQuoteAt,now,spare):pathPrice(t.side,live,wide,0,0,now,spare);
      if(px!=null){
        row.tail??=[];
        if(noteTail(row.tail,Math.floor(minute/TAIL_BUCKET)*TAIL_BUCKET,px)){markDirty(book,row.page??0);changed=true;}
      }
    }
    if(!row.hold.length&&note(row.hold,0,row.entry)){markDirty(book,row.page??0);changed=true;}
  }
  if(book.trades.length>PATH_CAP){
    // Oldest records go first, but never the path of a record that is still open (a long hold keeps its path).
    const open=new Set([...state.positions,...(state.unopenedTrades??[])].filter(t=>t.status==='OPEN').map(t=>t.id));
    const dropped:TradePath[]=[];
    for(let i=book.trades.length-1;i>=0&&book.trades.length-dropped.length>PATH_CAP;i--)
      if(!open.has(book.trades[i]!.id))dropped.push(book.trades[i]!);
    const gone=new Set(dropped);
    book.trades=book.trades.filter(row=>!gone.has(row));
    for(const page of new Set(dropped.map(row=>row.page??0))){
      if(book.trades.some(row=>(row.page??0)===page))markDirty(book,page);
      else retirePage(book,page);
    }
    if(dropped.length)changed=true;
  }
  return changed;
}

/**
 * Ghost paths: rows written for a signal that never reached a saved account. When a forward save fails the account
 * rolls back to the last saved state, but the path row observed on the unsaved state stays, and the next tick
 * records the same signal again under a new id. Those rows join no export row and only take PATH_CAP slots.
 *
 * A row is a ghost only when BOTH hold:
 *  - its id is not owned by any account row the export joins (positions, history, not-opened incl. cold-restored,
 *    and the closed-order journal);
 *  - it opened at or after `cutoff`: the latest of the oldest retained openedAt of each non-empty capped set
 *    (closed not-opened rows, closed trades). Capped sets evict oldest-first, so inside that window each of them
 *    still holds every row it ever had, and an unknown id cannot be a row that merely aged out. Older rows are
 *    left alone. Open rows are never evicted; they own ids but do not move the cutoff.
 * The caller must pass `complete:true` only when every owner set is fully loaded for this account; otherwise,
 * or when anything looks inconsistent, nothing is removed.
 */
export type PathOwnerSet={capped:boolean;rows:readonly {id:string;openedAt:number}[]};
export type PathOwnerSets={startedAt:number;complete:boolean;sets:readonly PathOwnerSet[]};
export const GHOST_PRUNE_LIMIT=64;
export function ghostPathPlan(book:TradePathBook,owners:PathOwnerSets){
  if(!owners.complete||book.accountStartedAt!==owners.startedAt)return null;
  const ids=new Set<string>();let cutoff=-Infinity;
  for(const set of owners.sets){
    let oldest=Infinity;
    for(const row of set.rows){
      if(!row||typeof row.id!=='string'||!Number.isFinite(row.openedAt))return null;
      ids.add(row.id);oldest=Math.min(oldest,row.openedAt);
    }
    if(set.capped&&set.rows.length)cutoff=Math.max(cutoff,oldest);
  }
  // No owner rows at all: nothing to compare against, so nothing can be called a ghost.
  if(!ids.size)return null;
  return {ids,cutoff};
}
/** Removes at most `limit` ghost rows. Storage follows through the normal dirty/retire page writes. */
export function pruneGhostPaths(book:TradePathBook,owners:PathOwnerSets,limit=GHOST_PRUNE_LIMIT){
  const plan=ghostPathPlan(book,owners);
  if(!plan)return {removed:0,remaining:0,cutoff:null as number|null};
  const ghost=(row:TradePath)=>!plan.ids.has(row.id)&&Number.isFinite(row.openedAt)&&row.openedAt>=plan.cutoff;
  const doomed=new Set<TradePath>();let remaining=0;
  for(const row of book.trades){
    if(!ghost(row))continue;
    if(doomed.size<Math.max(0,limit))doomed.add(row);else remaining++;
  }
  if(!doomed.size)return {removed:0,remaining,cutoff:plan.cutoff};
  const pages=new Set([...doomed].map(row=>row.page??0));
  book.trades=book.trades.filter(row=>!doomed.has(row));
  for(const page of pages){
    if(book.trades.some(row=>(row.page??0)===page))markDirty(book,page);
    else retirePage(book,page);
  }
  book.indexDirty=true;
  return {removed:doomed.size,remaining,cutoff:plan.cutoff};
}

/**
 * Orphan paths: rows whose id is owned by no record the run log keeps (account positions/history, the closed-order
 * journal, in-memory not-opened rows and every id in the cold not-opened archive). A path alone is not an order
 * record, so it leaves the log. This is what follows an incomplete not-opened row out of the log after that row is
 * removed. Account trades keep their paths: the journal (4000) holds more closed trades than PATH_CAP, so an account
 * trade path always has an owner. Same guards as pruneGhostPaths: `complete` must mean every owner set is loaded.
 */
export const ORPHAN_PRUNE_LIMIT=64;
/** A record's price path is part of a complete record: it must exist with the entry point, and a closed record's
 * path must carry the exit. */
export function pathComplete(row:TradePath|undefined,closed:boolean){
  return !!row&&row.hold.length>0&&entryFeaturesComplete(row.x)&&(!closed||(row.exit!=null&&row.exitAt!=null&&!!row.end));
}
/** Entry features that are always computable when the record is written (5m candles + the trade itself). */
export const FEATURES_REQUIRED=['leverage','stop_dist_pct','hour_utc','weekday','chg_1h_pct','atr_5m_pct','dist_high_10h_pct','dist_low_10h_pct','range_pos_10h','mkt_with_share'] as const;
export function entryFeaturesComplete(x:TradePath['x']){
  if(!x)return false;
  for(const key of FEATURES_REQUIRED){const v=x[key];if(v===null||v===undefined||(typeof v==='number'&&!Number.isFinite(v)))return false;}
  return true;
}

/**
 * The research label of one record, from its own path: what the signal did over 24 hours, whatever the exit did.
 * Price % and leveraged ROE % (price % x the leverage the trade used / would have used). Minutes are since the signal.
 */
export type PathLabel={path_minutes:number;mfe_pct:number;mae_pct:number;mfe_min:number|null;mae_before_mfe_pct:number;
  mfe_6h_pct:number;mae_6h_pct:number;mfe_roe_pct:number|null;mae_roe_pct:number|null;mfe_6h_roe_pct:number|null;
  reached_roe_5:boolean|null;reached_roe_5_min:number|null;reached_roe_10:boolean|null;
  /** Which came first, +5% or -5% leveraged ROE: UP, DOWN, BOTH (same minute), or NONE yet. */
  first_roe_5:'UP'|'DOWN'|'BOTH'|'NONE'|null;
  hold_mfe_pct:number;exit_giveback_pct:number|null};
export function pathLabel(row:TradePath):PathLabel{
  const lev=typeof row.x?.leverage==='number'&&row.x.leverage>0?row.x.leverage:null;
  const exitMin=row.exitAt!=null?Math.max(0,Math.floor((row.exitAt-row.openedAt)/60_000)):null;
  const points:PathPoint[]=[...row.hold,...(exitMin==null?[]:row.after.map(p=>[exitMin+p[0],p[1],p[2]] as PathPoint)),...(row.tail??[])]
    .sort((a,b)=>a[0]-b[0]);
  let mfe=0,mae=0,mfeMin:number|null=null,maeBefore=0,mfe6=0,mae6=0,hit5:number|null=null,hit10=false,end=0,runningMae=0;
  let first:'UP'|'DOWN'|'BOTH'|'NONE'='NONE';
  for(const p of points){
    const best=Math.max(favorablePct(row.side,row.entry,p[1]),favorablePct(row.side,row.entry,p[2]));
    const worst=Math.min(favorablePct(row.side,row.entry,p[1]),favorablePct(row.side,row.entry,p[2]));
    runningMae=Math.max(runningMae,-worst);
    if(best>mfe){mfe=best;mfeMin=p[0];maeBefore=runningMae;}
    mae=Math.max(mae,-worst);
    if(p[0]<=AFTER_MINUTES){mfe6=Math.max(mfe6,best);mae6=Math.max(mae6,-worst);}
    if(lev!=null&&first==='NONE'){const up=best*lev>=5,down=-worst*lev>=5;first=up&&down?'BOTH':up?'UP':down?'DOWN':'NONE';}
    if(lev!=null&&hit5==null&&best*lev>=5)hit5=p[0];
    if(lev!=null&&best*lev>=10)hit10=true;
    end=Math.max(end,p[0]);
  }
  const r=(v:number)=>Math.round(v*1e4)/1e4;
  return {path_minutes:end,mfe_pct:r(mfe),mae_pct:r(mae),mfe_min:mfeMin,mae_before_mfe_pct:r(maeBefore),mfe_6h_pct:r(mfe6),mae_6h_pct:r(mae6),
    mfe_roe_pct:lev==null?null:r(mfe*lev),mae_roe_pct:lev==null?null:r(mae*lev),mfe_6h_roe_pct:lev==null?null:r(mfe6*lev),
    reached_roe_5:lev==null?null:hit5!=null,reached_roe_5_min:hit5,reached_roe_10:lev==null?null:hit10,first_roe_5:lev==null?null:first,
    hold_mfe_pct:r(bestFavorable(row)),exit_giveback_pct:row.end?r(row.end.giveback_pct):null};
}
export function pruneOrphanPaths(book:TradePathBook,owners:{startedAt:number;complete:boolean;ids:ReadonlySet<string>},limit=ORPHAN_PRUNE_LIMIT){
  if(!owners.complete||book.accountStartedAt!==owners.startedAt||!owners.ids.size)return {removed:0,remaining:0};
  const doomed=new Set<TradePath>();let remaining=0;
  for(const row of book.trades){
    if(owners.ids.has(row.id))continue;
    if(doomed.size<Math.max(0,limit))doomed.add(row);else remaining++;
  }
  if(!doomed.size)return {removed:0,remaining};
  const pages=new Set([...doomed].map(row=>row.page??0));
  book.trades=book.trades.filter(row=>!doomed.has(row));
  for(const page of pages){
    if(book.trades.some(row=>(row.page??0)===page))markDirty(book,page);
    else retirePage(book,page);
  }
  book.indexDirty=true;
  return {removed:doomed.size,remaining};
}

function nextPathPage(book:TradePathBook){
  if(!book.trades.length)return 0;
  let max=0,count=0;
  for(const row of book.trades){
    const page=row.page??0;
    if(page>max){max=page;count=1;}
    else if(page===max)count++;
  }
  return count>=PATH_PAGE_SIZE?max+1:max;
}
function markDirty(book:TradePathBook,page:number){if(!book.dirty.includes(page))book.dirty.push(page);}
function retirePage(book:TradePathBook,page:number){
  book.dirty=book.dirty.filter(item=>item!==page);
  if(!book.drop.includes(page))book.drop.push(page);
  book.indexDirty=true;
}
function packPathPage(accountStartedAt:number,page:number,trades:TradePath[]):TradePathPage{
  const copy=trades.map(row=>({...row,hold:row.hold.map(point=>[...point] as PathPoint),after:row.after.map(point=>[...point] as PathPoint)}));
  for(let guard=0;guard<8&&roughBytes(copy)>PAGE_BYTE_BUDGET;guard++){
    const row=copy.reduce((left,right)=>left.hold.length+left.after.length>=right.hold.length+right.after.length?left:right);
    if(row.hold.length>60)row.hold=thin(row.hold);
    else if(row.after.length>60)row.after=thin(row.after);
    else break;
  }
  return {version:TRADE_PATH_PAGE_VERSION,accountStartedAt,page,trades:copy};
}
function roughBytes(trades:TradePath[]){
  return trades.reduce((sum,row)=>sum+160+(row.hold.length+row.after.length+(row.tail?.length??0))*24
    +(row.x?900:0)+(row.peak?420:0)+(row.end?900:0)+(row.track?.length??0)*420,80);
}
function thin(points:PathPoint[]){return points.filter((_,index)=>index===0||index===points.length-1||index%2===0);}
function pathPrice(side:'LONG'|'SHORT',live:Quote|undefined,wide:Quote|undefined,lastPrice:number,lastQuoteAt:number,now:number,spare?:{px:number;at:number}){
  const exec=side==='LONG'?live?.bestBid:live?.bestAsk;
  if(live&&exec!=null&&exec>0&&live.bestAsk>=live.bestBid&&now-live.observedAt<=PRICE_WINDOW_MS)return exec;
  if(wide&&wide.bestBid>0&&wide.bestAsk>=wide.bestBid&&now-wide.observedAt<=PRICE_WINDOW_MS)return (wide.bestBid+wide.bestAsk)/2;
  if(lastPrice>0&&lastQuoteAt>0&&now-lastQuoteAt<=PRICE_WINDOW_MS)return lastPrice;
  // Last resort: the all-ticker radar price the worker already fetched (no extra request).
  if(spare&&spare.px>0&&Number.isFinite(spare.px)&&now-spare.at<=FALLBACK_WINDOW_MS&&spare.at<=now)return spare.px;
  return null;
}
function noteTail(points:PathPoint[],bucket:number,price:number){
  if(!Number.isFinite(price)||price<=0||bucket<=AFTER_MINUTES-TAIL_BUCKET||bucket>TAIL_MINUTES)return false;
  const last=points.at(-1);
  if(last&&last[0]===bucket){
    const low=Math.min(last[1],price),high=Math.max(last[2],price);
    if(low===last[1]&&high===last[2])return false;
    last[1]=low;last[2]=high;return true;
  }
  if(last&&bucket<last[0])return false;
  if(points.length>=Math.ceil((TAIL_MINUTES-AFTER_MINUTES)/TAIL_BUCKET)+1)return false;
  points.push([bucket,price,price]);
  return true;
}
function barMs(time:number){return time<1e12?time*1000:time;}
function rebuildFromBars(row:TradePath,bars:{time:number;high:number;low:number}[]|undefined,endAt:number){
  if(!bars?.length||row.hold.length>1)return false;
  const points:PathPoint[]=[];
  for(const bar of bars){
    const start=barMs(bar.time);
    if(!(bar.high>0)||!(bar.low>0)||start+300_000<=row.openedAt||start>=endAt)continue;
    const minute=Math.max(0,Math.floor((Math.max(start,row.openedAt)-row.openedAt)/60_000));
    const low=Math.min(bar.low,bar.high),high=Math.max(bar.low,bar.high),last=points.at(-1);
    if(last&&last[0]===minute){last[1]=Math.min(last[1],low);last[2]=Math.max(last[2],high);}
    else points.push([minute,low,high]);
  }
  if(points.length<2)return false;
  row.hold=points;return true;
}
function note(points:PathPoint[],minute:number,price:number){
  if(!Number.isFinite(price)||price<=0||minute<0)return false;
  const last=points.at(-1);
  if(last&&last[0]===minute){
    const low=Math.min(last[1],price),high=Math.max(last[2],price);
    if(low===last[1]&&high===last[2])return false;
    last[1]=low;last[2]=high;return true;
  }
  if(last&&minute<last[0])return false;
  if(points.length>=400)return false;
  if(minute>AFTER_MINUTES)return false;
  points.push([minute,price,price]);
  return true;
}

export type PathExport={
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;exit:number|null;openedAt:number;closedAt:number|null;
  maxFavorablePct:number;maxAdversePct:number;bestHoldMin:number|null;direction:string;
  hold:PathPoint[];after:PathPoint[];tail?:PathPoint[];peak?:PathState|null;end?:PathEnd|null;track?:PathState[];
};
export function exportTradePaths(book:TradePathBook,keep?:(id:string)=>boolean):PathExport[]{
  return (keep?book.trades.filter(row=>keep(row.id)):book.trades).map(row=>{
    const peak=extreme(row);
    return {id:row.id,symbol:row.symbol,side:row.side,entry:row.entry,exit:row.exit,openedAt:row.openedAt,closedAt:row.exitAt,
      maxFavorablePct:round(peak.favorable*100),maxAdversePct:round(peak.adverse*100),bestHoldMin:peak.minute,
      direction:peak.favorable>=COST_RATE?'进场后走出过成本':'进场后没有走出成本',
      hold:row.hold,after:row.after,...(row.tail?.length?{tail:row.tail}:{}),peak:row.peak??null,end:row.end??null,
      ...(row.track?.length?{track:row.track}:{})};
  });
}
/** Per-record research columns for the run-log row: entry features + the 24h label. */
export function pathColumns(row:TradePath|undefined,signal?:ShadowSignal|null):Record<string,EntryFeatureValue>|null{
  if(!row)return null;
  return {...(row.x??{}),...pathLabel(row),...shadowColumns(row,signal)};
}
/** Signal side (before any gate flip) and, for gated TREND/SHOCK entries, the exact BTC 1h value the gate used. */
export type ShadowSignal={side?:'LONG'|'SHORT'|null;gateBtc1hPct?:number|null};
/** Record-only shadow BTC branch (lib/shadow-branch.ts): plan from the entry-time btc_1h_pct/stop_dist_pct, outcome replayed from this path. */
export function shadowColumns(row:TradePath,signal?:ShadowSignal|null){
  const exitMin=row.exitAt!=null?Math.max(0,Math.floor((row.exitAt-row.openedAt)/60_000)):null;
  const points=[...row.hold,...(exitMin==null?[]:row.after.map(p=>[exitMin+p[0],p[1],p[2]] as PathPoint)),...(row.tail??[])].sort((a,b)=>a[0]-b[0]);
  const gate=signal?.gateBtc1hPct;
  return shadowFields({signalSide:signal?.side??row.side,btc1hPct:typeof gate==='number'&&Number.isFinite(gate)?gate:row.x?.btc_1h_pct,stopDistPct:row.x?.stop_dist_pct,openedAt:row.openedAt,entry:row.entry,points});
}

export function searchHolding(book:TradePathBook,keep?:(id:string)=>boolean){
  const rows=book.trades.filter(row=>row.hold.length>0&&(!keep||keep(row.id)));
  if(!rows.length)return {trades:0,best:null,profitable:false,verdict:'重置之后还没有走出价格路径。新单从下一拍开始记，从信号起 6 小时的每一分钟都会留下，到点就停。'};
  let best:{tpPct:number;slPct:number;holdMin:number;net:number;wins:number;trades:number}|null=null;
  for(const tp of TAKE_PROFITS)for(const sl of STOP_LOSSES)for(const holdMin of HOLD_MINUTES){
    let net=0,wins=0,used=0;
    for(const row of rows){
      const result=simulate(row,tp,sl,holdMin);if(!result)continue;
      net+=result.net;used++;if(result.net>0)wins++;
    }
    if(!used)continue;
    if(!best||net>best.net)best={tpPct:tp,slPct:sl,holdMin,net:round(net),wins,trades:used};
  }
  const right=rows.filter(row=>extreme(row).favorable>=COST_RATE).length;
  const verdict=!best?'还没有足够的价格路径。'
    :best.net>0?`固定止盈 ${best.tpPct}%、止损 ${best.slPct}%、持有 ${best.holdMin} 分钟，这 ${best.trades} 笔净利润 ${best.net}。`
    :`这 ${rows.length} 笔里，没有任何一种固定止盈、止损、持仓时间能让净利润为正。最好的一种也是 ${best.net}。问题在入场。`;
  return {trades:rows.length,directionRight:right,afterMinutes:AFTER_MINUTES,best,profitable:!!best&&best.net>0,verdict};
}

function simulate(row:TradePath,tpPct:number,slPct:number,holdMin:number){
  const dir=row.side==='LONG'?1:-1,tp=tpPct/100,sl=slPct/100,path=continued(row);
  let exit=path.at(-1)!,reason:'sl'|'tp'|'time'|'open'='open';
  for(const point of path){
    const worst=Math.min(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    const best=Math.max(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    if(worst<=-sl){exit=[point[0],stopPrice(row,sl),stopPrice(row,sl)];reason='sl';break;}
    if(best>=tp){exit=[point[0],tpPrice(row,tp),tpPrice(row,tp)];reason='tp';break;}
    if(point[0]>=holdMin){exit=point;reason='time';break;}
  }
  if(reason==='open'&&row.exit!=null&&row.exitAt!=null&&!row.after.length)exit=[Math.floor((row.exitAt-row.openedAt)/60_000),row.exit,row.exit];
  const price=(exit[1]+exit[2])/2,gross=dir*row.qty*(price-row.entry),fee=row.entryFee+row.qty*price*FEE_RATE;
  return {net:gross-fee,minute:exit[0]};
}
function continued(row:TradePath):PathPoint[]{
  if(row.exitAt==null||!row.after.length)return row.hold;
  const base=Math.max(0,Math.floor((row.exitAt-row.openedAt)/60_000));
  return [...row.hold,...row.after.map(([minute,low,high])=>[base+minute,low,high] as PathPoint)];
}
function stopPrice(row:TradePath,sl:number){return row.side==='LONG'?row.entry*(1-sl):row.entry*(1+sl);}
function tpPrice(row:TradePath,tp:number){return row.side==='LONG'?row.entry*(1+tp):row.entry*(1-tp);}
function signed(dir:number,entry:number,price:number){return dir*(price/entry-1);}
function extreme(row:TradePath){
  let favorable=0,adverse=0,minute:number|null=null;
  const dir=row.side==='LONG'?1:-1;
  for(const point of row.hold){
    const best=Math.max(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    const worst=Math.min(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    if(best>favorable){favorable=best;minute=point[0];}
    adverse=Math.max(adverse,-worst);
  }
  return {favorable,adverse,minute};
}
function round(n:number){return Number(n.toFixed(4));}
