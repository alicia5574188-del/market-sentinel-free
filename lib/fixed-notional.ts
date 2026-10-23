/**
 * Fixed paper notional (500 U) for unified-pool orders (pool playbook dp / daily breakout hx / burst-leader bh).
 *
 * Stops, take-profits, the lock and every exit are PRICE rules (stopRate, o.stop, livingGuard, pool-lock riskR). They do not read the
 * notional, so changing the size never moves them. The notional only enters: the risk gates (total / side / 5-minute / episode),
 * the margin cap, the 1x-equity notional cap, the minimum contract count, the fee and the per-order risk statistics.
 *
 *  gates "virtual": the gates keep reading what the original formula (risk budget / stop) would have opened, so the order flow is
 *                   the same as before; only the size actually traded changes. The real exposure is then NOT bounded by the gates.
 *  gates "actual":  the fixed size is the wanted size; the existing headroom logic shrinks it, and rejects it when what is left is
 *                   below the pool floor. The gates then bound the real exposure.
 *  maxRiskRate:     optional cap on one order's real risk (share of equity). null = none.
 * Pure: no I/O. Applies to new orders only; open positions are never rewritten.
 */
export type FixedNotionalGates="virtual"|"actual";
export type FixedNotionalCfg={usdt:number;gates:FixedNotionalGates;maxRiskRate:number|null};
/** usdt <= 0 switches the fixed size off (the original formula sizes the order). Mutated only by tests. */
export const FIXED_NOTIONAL_CFG:FixedNotionalCfg={usdt:500,gates:"virtual",maxRiskRate:null};
export const fixedNotionalActive=(cfg:FixedNotionalCfg,note:{hx?:1;bh?:1}|null|undefined)=>cfg.usdt>0&&!!note&&(note.hx===1||note.bh===1);
/** the notional an order is actually sized to, before rounding down to whole contracts */
export function fixedTargetNotional(cfg:FixedNotionalCfg,i:{equity:number;stopRate:number;costRate:number;virtualNotional:number;gateHeadroomNotional:number}):number{
  let n=cfg.usdt;
  if(cfg.gates==="actual")n=Math.min(n,i.gateHeadroomNotional);
  if(cfg.maxRiskRate!=null&&cfg.maxRiskRate>0)n=Math.min(n,cfg.maxRiskRate*i.equity/(i.stopRate+i.costRate));
  return Math.max(0,n);
}
/** what the original formula would have opened: its notional, risk and margin (kept on the trade for the gates and the records) */
export const virtualSizing=(virtualNotional:number,stopRate:number,costRate:number,leverage:number)=>
  ({notional:virtualNotional,risk:virtualNotional*(stopRate+costRate),margin:virtualNotional/Math.max(leverage,1)});
