/** Live taker is 5bp. Unstamped comparison receipts stay at the old 7bp paper rate. */
export const SHADOW_FEE_RATE=.0007;
export const INVERSE_COST={feeRate:.0005};
export const INVERSE_FEE_POLICY='gate-taker-5bp-v1' as const;
/** Measured live-vs-paper adverse execution gap: 6bp median over 122 live entries (2026-10-01/02). */
export const LIVE_EXECUTION_GAP_RATE=.0006;
export const LIVE_EXECUTION_GAP_POLICY='measured-live-gap-6bp-v1' as const;
export type InverseFeeStamp={feeRate?:number;feePolicy?:typeof INVERSE_FEE_POLICY;
  sourceFeeRate?:number;sourceFeePolicy?:typeof INVERSE_FEE_POLICY;frozenSourceFee?:number};
export function recordedInverseFeeRate(fill:InverseFeeStamp){
  if(fill.feeRate===undefined&&fill.feePolicy===undefined)return SHADOW_FEE_RATE;
  if(fill.feePolicy!==INVERSE_FEE_POLICY||fill.feeRate!==INVERSE_COST.feeRate)
    throw new Error('反向成交手续费版本/费率无效，保留已扣费用');
  return fill.feeRate;
}
export function recordedSourceFeeRate(fill:InverseFeeStamp){
  if(fill.sourceFeeRate===undefined&&fill.sourceFeePolicy===undefined)return SHADOW_FEE_RATE;
  if(fill.sourceFeePolicy!==INVERSE_FEE_POLICY||fill.sourceFeeRate!==INVERSE_COST.feeRate)
    throw new Error('影子成交手续费版本/费率无效，保留已扣费用');
  return fill.sourceFeeRate;
}