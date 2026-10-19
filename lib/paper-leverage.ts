/**
 * Paper leverage for new market-intelligence positions (TREND / SHOCK). Leverage only changes margin per position:
 * notional, risk, stop and P&L are sized before this and do not depend on it.
 *
 * Safety rule: the isolated-margin liquidation distance must clear the stop by a buffer, so the stop always fires
 * well before liquidation even with a gap or a late quote:
 *   liquidation distance ≈ 1/leverage − maintenance rate − cost reserve
 *   required            = max(stop × 1.5, stop + 1%)
 * Start at min(20, contract max) and step down one at a time until it holds. Never above the contract max and never
 * below the old 10x (or the contract max if lower), which is what every trade used before.
 */
export const PAPER_LEVERAGE_TARGET=20;
export const PAPER_LEVERAGE_FLOOR=10;
/** Used when the contract's maintenance rate is missing or implausible. */
export const DEFAULT_MAINTENANCE_RATE=.01;
/** Fees and slippage that eat into isolated margin before liquidation (round trip taker + slippage, rounded up). */
export const LIQUIDATION_COST_RESERVE=.002;
export const STOP_BUFFER_RATIO=1.5;
export const STOP_BUFFER_ABS=.01;

export const maintenanceRateOf=(rate:unknown)=>typeof rate==="number"&&Number.isFinite(rate)&&rate>0&&rate<.5?rate:DEFAULT_MAINTENANCE_RATE;
export const liquidationDistance=(leverage:number,maintenanceRate:number)=>1/leverage-maintenanceRate-LIQUIDATION_COST_RESERVE;
export const requiredLiquidationDistance=(stopRate:number)=>Math.max(stopRate*STOP_BUFFER_RATIO,stopRate+STOP_BUFFER_ABS);

export type PaperLeverage={leverage:number;liquidationDistance:number;required:number;maintenanceRate:number;safe:boolean};

export function safePaperLeverage(input:{leverageMax:number|null|undefined;maintenanceRate:number|null|undefined;stopRate:number}):PaperLeverage{
  const max=Math.max(1,Math.floor(input.leverageMax||PAPER_LEVERAGE_FLOOR)); // same default as before when the contract has no max
  const top=Math.min(PAPER_LEVERAGE_TARGET,max),floor=Math.min(PAPER_LEVERAGE_FLOOR,max);
  const mmr=maintenanceRateOf(input.maintenanceRate),required=requiredLiquidationDistance(Math.max(0,input.stopRate));
  const at=(leverage:number):PaperLeverage=>{const distance=liquidationDistance(leverage,mmr);
    return {leverage,liquidationDistance:distance,required,maintenanceRate:mmr,safe:Number.isFinite(input.stopRate)&&distance>=required};};
  for(let leverage=top;leverage>floor;leverage--){const r=at(leverage);if(r.safe)return r;}
  return at(floor);
}

/**
 * Isolated-margin liquidation price for a linear USDT perpetual (Gate's formula without fees):
 *   LONG  liq = entry × (1 − 1/leverage) / (1 − mmr)
 *   SHORT liq = entry × (1 + 1/leverage) / (1 + mmr)
 * At 20x and mmr 0.5% that is 4.52% away from entry; at 10x and mmr 1%, 9.09% (long).
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
