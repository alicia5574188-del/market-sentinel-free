import type {ForwardState,Opportunity} from './forward-relations.ts';
import {DIRECT_STRATEGY_VERSION} from './direct-strategy-types.ts';
export function directOpportunityView(s:ForwardState,o:Opportunity){
  const p=s.directStrategy?.plans[o.symbol];if(!p)return o;
  return{...o,side:p.side,mode:p.branch==='RETURN'?'REVERSAL' as const:'CONTINUATION' as const,
    reason:p.reason,thesisSummary:p.reason,invalidationSummary:p.exitCondition,strategyVersion:DIRECT_STRATEGY_VERSION,
    eligible:!p.consumed&&(p.phase==='READY'&&o.eligible||p.branch==='RETURN'&&o.eligible&&!p.continuationSeen),branch:p.branch,decisionPhase:p.phase};
}
export function directStrategySummary(s:ForwardState){
  const ds=s.directStrategy;if(!ds)return null;
  return{version:ds.version,cutoverAt:ds.cutoverAt,fixedAllocationEquity:1000,summary:ds.summary,completedConversions:ds.completedConversions,
    returnOpen:s.positions.filter(t=>t.unified?.branch==='RETURN').length,continuationOpen:s.positions.filter(t=>t.unified?.branch==='CONTINUATION').length,
    legacyOpen:s.positions.filter(t=>!t.unified).length,
    plans:Object.values(ds.plans).map(({candidate,...p})=>({...p,score:candidate.score,confidence:candidate.dataConfidence??null})),
    authority:'ONE_ACTUAL_ACCOUNT_NO_COMPANION_ORDERS',entryPolicy:'observed-push-response-or-completed-trend',holdingPolicy:'own-geometric-branch',
    explanation:'回退：推进衰减兑现；延续：站稳后跟随，结构破坏退出。所有成本与前段亏损均计入当前账户'};
}
