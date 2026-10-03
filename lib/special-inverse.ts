/** Original special-move admission, opposite actual intent. No second wallet. */
import type {DirectPlan} from './direct-strategy-types.ts';
import type {Trade,Quote} from './forward-relations.ts';
import {validMarketRoute,type MarketRoute} from './market-authority.ts';
export const SPECIAL_INVERSE_VERSION='special-move-inverse-v1';
const direction=(s:'LONG'|'SHORT')=>s==='LONG'?1:-1;
const opposite=(s:'LONG'|'SHORT')=>s==='LONG'?'SHORT' as const:'LONG' as const;
export function inverseSpecialPlan(p:DirectPlan,q:Quote):DirectPlan{
  const source=p.candidate.marketRoute;
  if(source?.controllerVersion!=='special-move-v1'||!validMarketRoute(source))throw new Error('缺少原特别行情入场依据');
  const anchor=(q.bestBid+q.bestAsk)/2,side=opposite(source.side),stop=2*anchor-source.stop;
  if(!(stop>0)||direction(side)*(anchor-stop)<=0)throw new Error('反向实际风险边界无效');
  const id=`${SPECIAL_INVERSE_VERSION}:${p.symbol}:${side}:${source.proofAt}`,
    reason=`原信号${source.side==='LONG'?'做多':'做空'} → 实际${side==='LONG'?'做多':'做空'}；${source.reason}`,
    route:MarketRoute={...structuredClone(source),controllerVersion:SPECIAL_INVERSE_VERSION,
      sourceRoute:structuredClone(source),inverseAnchor:anchor,side,phase:side==='LONG'?'UP':'DOWN',
      stop,target:source.stop,targetBasis:'SOURCE_PROTECTION_REFERENCE',reason};
  const candidate={...structuredClone(p.candidate),id,thesisId:id,side,marketRoute:route,reason,thesisSummary:reason,
    stopPrice:stop,targetPrice:source.stop,grossRemainingSpaceRate:0,netRemainingSpaceRate:0,targetRate:0,
    invalidationSummary:'按实际方向承接恢复、资金风险与盈利反压保护管理；原保护价只是反向参考',
    winnerPlan:p.candidate.winnerPlan?{...structuredClone(p.candidate.winnerPlan),initialStop:stop,target:null,
      riskGroup:`${p.candidate.clusterId??p.symbol}:${side}`}:undefined};
  return{...structuredClone(p),id,side,candidate,reason,confirmation:null,
    holdReason:'按实际持仓方向观察承接与恢复，正常回落保留持仓',
    exitCondition:'实际风险边界、承接恢复失败、新的反向持续证据或盈利反压保护'};
}
export function inverseSpecialEntryExecutable(t:Pick<Trade,'side'|'unified'|'openedAt'>,price:number,now:number){
  const r=t.unified?.marketRoute,source=r?.sourceRoute;
  if(r?.controllerVersion!==SPECIAL_INVERSE_VERSION||!source||!validMarketRoute(r)
    ||source.side===t.side||r.side!==t.side||source.proofAt>now||now-source.proofAt>12*60000
    ||t.openedAt>now||!Number.isFinite(price)||price<=0)return false;
  const d=direction(source.side),risk=d*(price-source.stop)+(price+source.stop)*.0005,
    room=d*(source.target-price)-(price+source.target)*.0005,
    width=Math.abs(r.inverseAnchor!-source.stop)/r.inverseAnchor!,drift=Math.abs(price/r.inverseAnchor!-1);
  // Original proof/position economics stay original-side measurements. Actual
  // intent has its own mirrored loss budget; source risk is not a profit forecast.
  return direction(t.side)*(price-r.stop)>0&&risk>0&&room/risk>=1.35
    &&drift<=Math.max(.0005,Math.min(.005,width*.5));
}
