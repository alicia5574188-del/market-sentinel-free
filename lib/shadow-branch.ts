/**
 * Shadow BTC branch — RECORD ONLY. Never read by an entry, an exit, sizing, a stop or live copying.
 *
 * At the signal: if BTC's 1h move is with the signal by >= 0.57% the shadow follows the signal with TP 6% / SL 1%
 * (at most 24 h); otherwise the shadow takes the opposite side with the order's own stop distance and exits after 6 h.
 * The branch is derived from entry-time data already stored with each record (btc_1h_pct = entry-features btcChange(…,1),
 * the same function and inputs as the TREND/SHOCK gate value; stop_dist_pct), so nothing new is stored in the Durable
 * Object. The outcome is replayed from the stored price path when the export / archive row is built.
 * Price-move % only (not ROE). Conservative replay: on the entry minute only the adverse side counts; if SL and TP are
 * both inside one bar, SL wins; a time exit uses the bar midpoint.
 */
export type ShadowSide='LONG'|'SHORT';
export type PathPointLike=readonly [number,number,number];
export const SHADOW_FOLLOW_MIN_PCT=0.57;
export const SHADOW_FOLLOW_TP_PCT=6,SHADOW_FOLLOW_SL_PCT=1,SHADOW_FOLLOW_MAX_MIN=1440;
export const SHADOW_REVERSE_HOLD_MIN=360;
/** Same as PAPER_COST: 2 × (fee .07% + slippage .025%) per round trip, funding allowance .02% per day. */
export const SHADOW_COST={roundTrip:0.0019,fundingPerDay:0.0002} as const;
/** btc_1h_pct is trustworthy from this deploy on (557f8f81: live BTC mids; the hourly series was frozen before). Older rows get null; use /workspace/combo/shadow_backfill.py. */
export const SHADOW_BTC_RELIABLE_SINCE=1792341000000;

export type ShadowPlan={btc1h_aligned_pct:number|null;shadow_branch:'follow'|'reverse'|null;shadow_side:ShadowSide|null;
  shadow_plan:'TP6/SL1'|'own_stop/6h'|null;shadow_stop_pct:number|null;shadow_tp_pct:number|null};
export type ShadowOutcome={shadow_exit_reason:'TP'|'SL'|'TIME'|null;shadow_exit_min:number|null;shadow_move_pct:number|null;shadow_net_pct:number|null};
export type ShadowFields=ShadowPlan&ShadowOutcome;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const r4=(v:number)=>Math.round(v*1e4)/1e4;
export const NO_SHADOW_PLAN:ShadowPlan={btc1h_aligned_pct:null,shadow_branch:null,shadow_side:null,shadow_plan:null,shadow_stop_pct:null,shadow_tp_pct:null};
export const NO_SHADOW_OUTCOME:ShadowOutcome={shadow_exit_reason:null,shadow_exit_min:null,shadow_move_pct:null,shadow_net_pct:null};

export function shadowPlan(input:{signalSide:ShadowSide|null|undefined;btc1hPct:unknown;stopDistPct:unknown;openedAt?:number|null}):ShadowPlan{
  const side=input.signalSide;
  if(side!=='LONG'&&side!=='SHORT'||!finite(input.btc1hPct))return NO_SHADOW_PLAN;
  if(input.openedAt!=null&&input.openedAt<SHADOW_BTC_RELIABLE_SINCE)return NO_SHADOW_PLAN;
  const aligned=r4(input.btc1hPct*(side==='LONG'?1:-1));
  if(aligned>=SHADOW_FOLLOW_MIN_PCT)return {btc1h_aligned_pct:aligned,shadow_branch:'follow',shadow_side:side,shadow_plan:'TP6/SL1',
    shadow_stop_pct:SHADOW_FOLLOW_SL_PCT,shadow_tp_pct:SHADOW_FOLLOW_TP_PCT};
  const own=finite(input.stopDistPct)&&input.stopDistPct>0?r4(input.stopDistPct):null;
  return {btc1h_aligned_pct:aligned,shadow_branch:'reverse',shadow_side:side==='LONG'?'SHORT':'LONG',shadow_plan:'own_stop/6h',
    shadow_stop_pct:own,shadow_tp_pct:null};
}

/** Replays the plan on [minute since signal, low, high] points (sorted by minute). Null outcome until it is decided. */
export function shadowOutcome(plan:ShadowPlan,entry:number,points:readonly PathPointLike[]):ShadowOutcome{
  if(!plan.shadow_side||!finite(plan.shadow_stop_pct)||!(entry>0)||!points.length)return NO_SHADOW_OUTCOME;
  const d=plan.shadow_side==='LONG'?1:-1,stop=-plan.shadow_stop_pct/100,tp=plan.shadow_tp_pct==null?null:plan.shadow_tp_pct/100;
  const horizon=plan.shadow_branch==='follow'?SHADOW_FOLLOW_MAX_MIN:SHADOW_REVERSE_HOLD_MIN;
  const done=(move:number,minute:number,reason:'TP'|'SL'|'TIME'):ShadowOutcome=>({shadow_exit_reason:reason,shadow_exit_min:Math.round(minute),
    shadow_move_pct:r4(move*100),shadow_net_pct:r4((move-SHADOW_COST.roundTrip-SHADOW_COST.fundingPerDay*minute/1440)*100)});
  let last:{m:number;mid:number}|null=null,first=true;
  for(const [m,lo,hi] of points){
    if(m>horizon)break;
    if(!(lo>0)||!(hi>0))continue;
    const adverse=d===1?lo/entry-1:1-hi/entry,favour=first?0:(d===1?hi/entry-1:1-lo/entry);first=false;
    if(adverse<=stop)return done(stop,m,'SL');
    if(tp!=null&&favour>=tp)return done(tp,m,'TP');
    last={m,mid:d===1?((lo+hi)/2)/entry-1:1-((lo+hi)/2)/entry};
  }
  // Decided by time only once the path reaches the horizon (the 6h–24h tail is 15-minute buckets).
  const covered=points.at(-1)![0]>=horizon-(horizon>SHADOW_REVERSE_HOLD_MIN?15:1);
  return covered&&last?done(last.mid,last.m,'TIME'):NO_SHADOW_OUTCOME;
}

export function shadowFields(input:{signalSide:ShadowSide|null|undefined;btc1hPct:unknown;stopDistPct:unknown;openedAt?:number|null;entry:number;points:readonly PathPointLike[]}):ShadowFields{
  try{
    const plan=shadowPlan(input);
    return {...plan,...(plan.shadow_side?shadowOutcome(plan,input.entry,input.points):NO_SHADOW_OUTCOME)};
  }catch{return {...NO_SHADOW_PLAN,...NO_SHADOW_OUTCOME};}
}
