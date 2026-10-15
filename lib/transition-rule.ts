import type {EntryStructure} from "./entry-structure.ts";

export const TRANSITION_RULE_VERSION="transition-room-v1";
/** 爆发段仍用这条：异动方向前方不到这个百分比就反手。距离本身已经是百分数。 */
export const TRANSITION_ROOM_PCT=1.5;
/** 已稳定的过渡只在这个窄档反手做空。距离是百分数，期望是收益率。 */
export const SETTLED_FADE_ROOM_MIN=0.3;
export const SETTLED_FADE_ROOM_MAX=0.8;
export const SETTLED_FADE_EXPECTANCY_MIN=0.004;
export const SETTLED_FADE_EXPECTANCY_MAX=0.008;

export type TransitionEntry={
  version:typeof TRANSITION_RULE_VERSION;
  signalSide:"LONG"|"SHORT";
  side:"LONG"|"SHORT";
  roomPct:number|null;
  touches:number|null;
  expectancy:number|null;
  fade:boolean;
  stopRate:number;
  holdMin:number;
};

/** 做多看上方压力，做空看下方支撑。算不出来就返回 null。 */
export function transitionRoomPct(structure:EntryStructure|null|undefined,signalSide:"LONG"|"SHORT"){
  const zone=signalSide==="LONG"?structure?.resistance:structure?.support;
  if(!zone)return null;
  if(signalSide==="LONG"&&zone.place!=="上方")return null;
  if(signalSide==="SHORT"&&zone.place!=="下方")return null;
  if(!(zone.distancePct>=0))return null;
  return zone.distancePct;
}

function zoneTouches(structure:EntryStructure|null|undefined,signalSide:"LONG"|"SHORT"){
  const zone=signalSide==="LONG"?structure?.resistance:structure?.support;
  if(!zone)return null;
  if(signalSide==="LONG"&&zone.place!=="上方")return null;
  if(signalSide==="SHORT"&&zone.place!=="下方")return null;
  return typeof zone.touches==="number"?zone.touches:null;
}

/** 爆发段进场仍用旧的空间规则。算不出前方空间就跳过。 */
export function transitionEntryDecision(structure:EntryStructure|null|undefined,signalSide:"LONG"|"SHORT"):
  {action:"SKIP";reason:string}|{action:"ENTER";entry:TransitionEntry}{
  const room=transitionRoomPct(structure,signalSide);
  if(room==null)return {action:"SKIP",reason:"过渡行情算不出异动方向前面的空间，这单不做"};
  const fade=room<TRANSITION_ROOM_PCT;
  return {action:"ENTER",entry:{
    version:TRANSITION_RULE_VERSION,signalSide,roomPct:room,touches:zoneTouches(structure,signalSide),expectancy:null,fade,
    side:fade?(signalSide==="LONG"?"SHORT":"LONG"):signalSide,
    stopRate:fade?0.015:0.008,holdMin:fade?45:60,
  }};
}

/**
 * 已经稳定的过渡。只有「异动做多、前方压力 0.3% 到 0.8%、第一次靠近、期望 0.4% 到 0.8%」才反手做空。
 * 其余都按异动方向做，空间算不出来也不跳过。
 */
export function settledTransitionEntry(structure:EntryStructure|null|undefined,signalSide:"LONG"|"SHORT",expectancy:number|null|undefined):TransitionEntry{
  const room=transitionRoomPct(structure,signalSide);
  const touches=zoneTouches(structure,signalSide);
  const exp=typeof expectancy==="number"&&Number.isFinite(expectancy)?expectancy:null;
  const fade=signalSide==="LONG"
    &&room!=null&&room>=SETTLED_FADE_ROOM_MIN&&room<SETTLED_FADE_ROOM_MAX
    &&touches===1
    &&exp!=null&&exp>=SETTLED_FADE_EXPECTANCY_MIN&&exp<SETTLED_FADE_EXPECTANCY_MAX;
  return {
    version:TRANSITION_RULE_VERSION,signalSide,side:fade?"SHORT":signalSide,roomPct:room,touches,expectancy:exp,fade,
    stopRate:fade?0.015:0.008,holdMin:fade?45:60,
  };
}

export function transitionExitReason(input:{signedRate:number;ageMin:number;stopRate:number;holdMin:number}){
  if(-input.signedRate>=input.stopRate-1e-12)return "TRANSITION_STOP" as const;
  if(input.ageMin>=input.holdMin)return "TRANSITION_TIME" as const;
  return null;
}
