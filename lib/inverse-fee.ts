/** Current owner LIVE taker reference; frozen source and legacy receipts stay 7bp.
 * Per-fill stamps keep future rate changes from rewriting booked money. */
export const SHADOW_FEE_RATE=.0007;
export const INVERSE_COST={feeRate:.0005};
export const INVERSE_FEE_POLICY='gate-taker-5bp-v1' as const;
export type InverseFeeStamp={feeRate?:number;feePolicy?:typeof INVERSE_FEE_POLICY};
export function recordedInverseFeeRate(fill:InverseFeeStamp){
  if(fill.feeRate===undefined&&fill.feePolicy===undefined)return SHADOW_FEE_RATE;
  if(fill.feePolicy!==INVERSE_FEE_POLICY||fill.feeRate!==INVERSE_COST.feeRate)
    throw new Error('反向成交手续费版本/费率无效，保留已扣费用');
  return fill.feeRate;
}
