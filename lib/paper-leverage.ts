/**
 * Paper leverage for new market-intelligence positions (TREND / SHOCK): fixed 10x (user, 2026-10-19: "杠杆还是固定10倍").
 * If the contract's max leverage is below 10, the contract max is used; a contract with no known max gets 10 — the same
 * rule every trade used before the short-lived up-to-20x step-down (605fe2a0), which is withdrawn.
 * Leverage only changes margin per position: notional, risk, stop and P&L are sized before this and do not depend on it.
 * There is NO liquidation-vs-stop check here (none was asked for; open decisions stay as they were): with a high
 * maintenance rate and a wide stop, the isolated liquidation price can sit inside the stop. The liquidation model
 * (isolatedLiquidationPrice / liquidateIfHit) still applies and closes such a trade as LIQUIDATION.
 */
export const PAPER_LEVERAGE_FIXED=10;
/** Used when the contract's maintenance rate is missing or implausible. */
export const DEFAULT_MAINTENANCE_RATE=.01;
/** Fees and slippage that eat into isolated margin before liquidation (round trip taker + slippage, rounded up). Analysis only. */
export const LIQUIDATION_COST_RESERVE=.002;

export const maintenanceRateOf=(rate:unknown)=>typeof rate==="number"&&Number.isFinite(rate)&&rate>0&&rate<.5?rate:DEFAULT_MAINTENANCE_RATE;
/** Approximate distance (fraction of entry) from entry to the isolated liquidation price, net of the cost reserve. Analysis only. */
export const liquidationDistance=(leverage:number,maintenanceRate:number)=>1/leverage-maintenanceRate-LIQUIDATION_COST_RESERVE;

/** min(10, floor(contract max)); no/zero max → 10; never below 1. */
export function fixedPaperLeverage(leverageMax:number|null|undefined){
  return Math.max(1,Math.min(PAPER_LEVERAGE_FIXED,Math.floor(leverageMax||PAPER_LEVERAGE_FIXED)));
}

/**
 * Isolated-margin liquidation price for a linear USDT perpetual (Gate's formula without fees):
 *   LONG  liq = entry × (1 − 1/leverage) / (1 − mmr)
 *   SHORT liq = entry × (1 + 1/leverage) / (1 + mmr)
 * At 10x: mmr 0.5% → 9.55% away from entry (long), mmr 1% → 9.09%, mmr 5% → 5.26%.
 */
export function isolatedLiquidationPrice(input:{entry:number;leverage:number;side:"LONG"|"SHORT";maintenanceRate:number|null|undefined}){
  const {entry,leverage,side}=input,mmr=maintenanceRateOf(input.maintenanceRate);
  if(!(entry>0)||!(leverage>1))return null; // 1x isolated cannot be liquidated by price alone
  const liq=side==="LONG"?entry*(1-1/leverage)/(1-mmr):entry*(1+1/leverage)/(1+mmr);
  return Number.isFinite(liq)&&liq>0?liq:null;
}
/** Long: the executable bid at or below the liquidation price. Short: the ask at or above it. */
export const liquidationHit=(side:"LONG"|"SHORT",price:number,liquidationPrice:number|null|undefined)=>
  liquidationPrice!=null&&Number.isFinite(price)&&(side==="LONG"?price<=liquidationPrice:price>=liquidationPrice);
/**
 * htf-donch20 (daily trend breakout) only: its stops are 2 daily ATRs (median 11.5%), wider than the 9.5% liquidation distance at
 * the fixed 10x. It uses the highest whole leverage ≤ fixedPaperLeverage(contract max) whose isolated liquidation distance keeps
 * the stop within `fraction` (40%, the item-5 rule) of it; 1x (no price liquidation) when nothing above 1 does. Null when even
 * 1x cannot hold the stop (stop ≥ 100%·fraction). Leverage only changes margin: notional, risk and the stop do not depend on it.
 */
export function htfPaperLeverage(stopRate:number,leverageMax:number|null|undefined,maintenanceRate:number|null|undefined,fraction=.40){
  if(!(stopRate>0)||!(stopRate<fraction))return null;
  for(let lev=fixedPaperLeverage(leverageMax);lev>1;lev--){
    const liq=isolatedLiquidationPrice({entry:1,leverage:lev,side:"LONG",maintenanceRate});
    if(liq!=null&&stopRate<=fraction*(1-liq))return lev;
  }
  return 1;
}
