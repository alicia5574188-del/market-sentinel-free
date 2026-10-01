/** Episode loss budget. Profit never replenishes failed attempts. A new causal
 * structure after the last failure, not a timer or refreshed label, renews it. */
export type WinnerRiskLedger=Record<string,{eventAt:number;loss:number;lastFailureAt:number;updatedAt:number}>;
export function winnerEventHeadroom(ledger:WinnerRiskLedger,key:string,eventAt:number,equity:number,openRisk:number){
  const old=ledger[key],renew=!!old&&eventAt>old.lastFailureAt&&eventAt>old.eventAt,
    consumed=old&&!renew?old.loss:0;
  return{headroom:Math.max(0,equity*.015-consumed-openRisk),consumed,renew};
}
export function recordWinnerRiskLoss(ledger:WinnerRiskLedger,key:string,eventAt:number,net:number,now:number){
  if(!key||![eventAt,net,now].every(Number.isFinite))return;
  const old=ledger[key],renew=!!old&&eventAt>old.lastFailureAt&&eventAt>old.eventAt;
  ledger[key]={eventAt:renew||!old?eventAt:old.eventAt,loss:(old&&!renew?old.loss:0)+Math.max(0,-net),
    lastFailureAt:net<0?now:old?.lastFailureAt??0,updatedAt:now};
  // Old keys are diagnostic state only after their finite observation history
  // has expired. Keep active recent episodes, even when their class is losing.
  for(const [k,v]of Object.entries(ledger))if(now-v.updatedAt>86400000)delete ledger[k];
}
