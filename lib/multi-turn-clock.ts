export const MULTI_TURN_CLOCK_VERSION="multi-turn-clock-v1";
export const MULTI_TURN_CLOCK_BAR_MS=300_000;
export const MULTI_TURN_CLOCK_GRACE_MS=90_000;
export const MULTI_TURN_FALLBACK_MARK_GRACE_MS=150_000;
export type MultiTurnClockDecision={version:typeof MULTI_TURN_CLOCK_VERSION;targetSlot:number;targetCompletedAt:number;dataDue:boolean;fallbackMarkDue:boolean;markDue:boolean;};
/** Pure clock arbitration. Wall time alone can never consume a completed-candle slot. */
export function evaluateMultiTurnClock(input:{now:number;lastCycleAt:number|null;lastMarkAt:number;newestPathCompletedAt:number;allowDataCycle:boolean;}):MultiTurnClockDecision{
  const targetSlot=Math.floor((input.now-MULTI_TURN_CLOCK_GRACE_MS)/MULTI_TURN_CLOCK_BAR_MS);
  const lastDataSlot=input.lastCycleAt?Math.floor((input.lastCycleAt-MULTI_TURN_CLOCK_GRACE_MS)/MULTI_TURN_CLOCK_BAR_MS):-1;
  const targetCompletedAt=targetSlot*MULTI_TURN_CLOCK_BAR_MS;
  const dataDue=input.allowDataCycle&&targetSlot>lastDataSlot&&input.newestPathCompletedAt>=targetCompletedAt;
  const lastMarkSlot=input.lastMarkAt?Math.floor((input.lastMarkAt-MULTI_TURN_CLOCK_GRACE_MS)/MULTI_TURN_CLOCK_BAR_MS):-1;
  const fallbackMarkDue=!input.allowDataCycle&&targetSlot>lastMarkSlot&&input.now>=targetSlot*MULTI_TURN_CLOCK_BAR_MS+MULTI_TURN_FALLBACK_MARK_GRACE_MS;
  return{version:MULTI_TURN_CLOCK_VERSION,targetSlot,targetCompletedAt,dataDue,fallbackMarkDue,markDue:dataDue||fallbackMarkDue};
}
