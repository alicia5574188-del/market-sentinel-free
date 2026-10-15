import type {EntryStructure} from "./entry-structure.ts";

export const TRANSITION_RULE_VERSION="transition-room-v1";
/** 异动方向前方不到这个百分比，就做反方向。距离本身已经是百分数。 */
export const TRANSITION_ROOM_PCT=1.5;

export type TransitionEntry={
  version:typeof TRANSITION_RULE_VERSION;
  signalSide:"LONG"|"SHORT";
  side:"LONG"|"SHORT";
  roomPct:number;
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

export function transitionEntryDecision(structure:EntryStructure|null|undefined,signalSide:"LONG"|"SHORT"):
  {action:"SKIP";reason:string}|{action:"ENTER";entry:TransitionEntry}{
  const room=transitionRoomPct(structure,signalSide);
  if(room==null)return {action:"SKIP",reason:"过渡行情算不出异动方向前面的空间，这单不做"};
  const fade=room<TRANSITION_ROOM_PCT;
  return {action:"ENTER",entry:{
    version:TRANSITION_RULE_VERSION,signalSide,roomPct:room,fade,
    side:fade?(signalSide==="LONG"?"SHORT":"LONG"):signalSide,
    stopRate:fade?0.015:0.008,holdMin:fade?45:60,
  }};
}

export function transitionExitReason(input:{signedRate:number;ageMin:number;stopRate:number;holdMin:number}){
  if(-input.signedRate>=input.stopRate-1e-12)return "TRANSITION_STOP" as const;
  if(input.ageMin>=input.holdMin)return "TRANSITION_TIME" as const;
  return null;
}
