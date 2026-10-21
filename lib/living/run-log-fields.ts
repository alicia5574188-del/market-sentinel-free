/**
 * Run-log / export / archive columns for trades the living layer opened or protected. Keys are only present when the
 * note exists (same pattern as s1Fields), so every earlier row is byte-identical.
 */
export type LivingFields={rule_epoch:string;living_kind:"normal"|"fast";living_playbook:string;living_thesis:string|null;
  living_reward_pct:number|null;living_reward_t:number|null;living_reward_n:number|null;living_persistence:string|null;living_rank:number|null;
  living_invalidation:number;living_evidence:string;living_multiple:number;living_episode:string|null;living_hold_min:number;living_why:string;
  living_handoff_at:number|null;
  /** v2: capital state / emotion at entry, market intent state, the narrative and the evidence numbers */
  living_intent:string|null;living_market_intent:string|null;living_story:string|null;living_flow_evidence:string|null;
  /** v3: environment pick at entry (coin env + market env + why), "" before v3 */living_env?:string|null;
  living_protect_code:string|null;living_protect_stop:number|null;living_protect_at:number|null;living_protect_reason:string|null};
type NoteLike={v?:unknown;k?:unknown;pb?:unknown;th?:unknown;ep?:unknown;ev?:unknown;mult?:unknown;sc?:unknown;t?:unknown;n?:unknown;per?:unknown;
  rk?:unknown;inv?:unknown;hold?:unknown;why?:unknown;ho?:unknown;in?:unknown;mk?:unknown;nar?:unknown;evd?:unknown;env?:unknown};
type GuardLike={stop?:unknown;code?:unknown;reason?:unknown;at?:unknown};
const num=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
const str=(v:unknown)=>typeof v==="string"?v:null;
export function livingFields(note:unknown,guard:unknown):Partial<LivingFields>{
  const n=note as NoteLike|undefined,g=guard as GuardLike|undefined;
  const out:Partial<LivingFields>={};
  if(n&&(n.v==="living-v1"||n.v==="living-v2")){
    Object.assign(out,{rule_epoch:n.v,living_kind:n.k==="F"?"fast":"normal",living_playbook:str(n.pb)??"",living_thesis:str(n.th),
      living_reward_pct:num(n.sc)==null?null:Math.round(num(n.sc)!*1e6)/1e4,living_reward_t:num(n.t),living_reward_n:num(n.n),
      living_persistence:str(n.per),living_rank:num(n.rk),living_invalidation:num(n.inv)??0,living_evidence:str(n.ev)??"",
      living_multiple:num(n.mult)??0,living_episode:str(n.ep),living_hold_min:num(n.hold)??0,living_why:str(n.why)??"",living_handoff_at:num(n.ho)});
    if(n.v==="living-v2")Object.assign(out,{living_intent:str(n.in),living_market_intent:str(n.mk),living_story:str(n.nar),living_flow_evidence:str(n.evd),...(typeof n.env==="string"?{living_env:n.env}:{})});
  }
  if(g&&num(g.stop)!=null)Object.assign(out,{living_protect_code:str(g.code),living_protect_stop:num(g.stop),living_protect_at:num(g.at),living_protect_reason:str(g.reason)});
  return out;
}
/** Export-time epoch mark: rows opened once the living layer acted carry rule_epoch "living-v2" (no stored row changes). */
export function withLivingEpoch<T extends {opened_at:number;rule_epoch?:string}>(rows:T[],epochStartedAt:number|null|undefined,epoch="living-v2"):T[]{
  if(epochStartedAt==null||!Number.isFinite(epochStartedAt))return rows;
  return rows.map(r=>r.opened_at>=epochStartedAt&&r.rule_epoch==null?{...r,rule_epoch:epoch}:r);
}
