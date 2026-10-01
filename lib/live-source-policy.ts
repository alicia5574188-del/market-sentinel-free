/** Execution projection only. Never edits either PAPER ledger or decides a
 * strategy exit. The adverse native guard retains the source's INITIAL risk
 * width; source moving reference prices are not inverse stop instructions. */
import type {Trade} from './forward-relations.ts';
export const INVERSE_LIVE_POLICY='inverse-paper-live-v1';
export function liveProtectionPrice(t:Trade) {
  if(!t.inverseCopy)return t.stopPrice;
  const i=t.inverseCopy,initial=i.sourceEntryPlan?.winnerPlan?.initialStop;
  if(i.sourceSide===t.side||i.sourceEntryPrice!==t.entryPrice||!(initial&&Number.isFinite(initial)&&initial>0))
    throw new Error('反向实盘缺少已保存的原始风险边界；禁止把影子移动参考价当作止损');
  const sourceDirection=i.sourceSide==='LONG'?1:-1,width=sourceDirection*(t.entryPrice-initial);
  if(!(width>0))throw new Error('反向实盘原始风险边界无效');
  const price=t.entryPrice+(t.side==='SHORT'?width:-width);
  if(!(price>0))throw new Error('反向实盘保护价格无效');
  return price;
}
