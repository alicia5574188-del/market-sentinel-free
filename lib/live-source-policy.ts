/** Inverse execution follows committed source events only. Reference prices
 * and allocation risk are never independent exchange exit instructions. */
import type {Trade} from './forward-relations.ts';
export const INVERSE_LIVE_POLICY='inverse-paper-live-v1';
export const INVERSE_LIVE_EXIT_POLICY='shadow-events-only-v1';
export const isInverseLiveReceipt=(receipt?:{sourceRole?:string})=>receipt?.sourceRole==='INVERSE_PAPER';
export function liveProtectionPrice(t:Trade) {
  if(!t.inverseCopy)return t.stopPrice;
  const i=t.inverseCopy;
  if(i.sourceSide===t.side||i.sourceEntryPrice!==t.entryPrice)
    throw new Error('反向实盘源身份或方向无效');
  return null;
}
