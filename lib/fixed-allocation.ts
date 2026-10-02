/** Position-size reference only. Account balances and existing admission gates
 * retain their actual values; no pause, exit, signal or LIVE-switch authority. */
export const FIXED_ALLOCATION_EQUITY=1000;
export const FIXED_ALLOCATION_POLICY='fixed-1000-v1';
export type FixedLiveBasis={version:typeof FIXED_ALLOCATION_POLICY;sourceEquity:1000;liveEquity:number;establishedAt:number;accountKey:string};
export function fixedLiveBasis(prior:FixedLiveBasis|undefined,equity:number,accountKey:string,now:number):FixedLiveBasis{
  if(prior){
    if(prior.version!==FIXED_ALLOCATION_POLICY||prior.sourceEquity!==1000||!(prior.liveEquity>0)
      ||!Number.isFinite(prior.liveEquity)||prior.accountKey!==accountKey||!(prior.establishedAt>0&&Number.isFinite(prior.establishedAt)))
      throw new Error('固定实盘仓位基准与当前账户不一致');
    return prior;
  }
  if(!(equity>0&&Number.isFinite(equity))||!accountKey||!(now>0&&Number.isFinite(now)))throw new Error('固定实盘仓位基准尚未确认');
  return{version:FIXED_ALLOCATION_POLICY,sourceEquity:1000,liveEquity:equity,establishedAt:now,accountKey};
}
