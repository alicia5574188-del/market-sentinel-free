import type {ForwardState,Opportunity} from './forward-relations.ts';
import {DIRECT_STRATEGY_VERSION} from './direct-strategy-types.ts';
import {paperFilled} from './paper-execution.ts';
export function directOpportunityView(s:ForwardState,o:Opportunity){
  const p=s.directStrategy?.plans[o.symbol];if(!p)return o;
  return{...o,side:p.side,mode:p.branch==='RETURN'?'REVERSAL' as const:'CONTINUATION' as const,
    reason:p.reason,thesisSummary:p.reason,invalidationSummary:p.exitCondition,strategyVersion:DIRECT_STRATEGY_VERSION,
    eligible:!p.consumed&&(s.directStrategy?.marketAuthority?o.eligible:p.phase==='READY'&&o.eligible||p.branch==='RETURN'&&o.eligible&&!p.continuationSeen),branch:p.branch,decisionPhase:p.phase};
}
export function directStrategySummary(s:ForwardState){
  const ds=s.directStrategy;if(!ds)return null;
  return{version:ds.version,cutoverAt:ds.cutoverAt,fixedAllocationEquity:1000,summary:ds.summary,completedConversions:ds.completedConversions,
    execution:s.paperExecution?{version:s.paperExecution.version,cutoverAt:s.paperExecution.cutoverAt,
      basis:'SHARED_LIVE_ADMISSION_AND_OBSERVED_GATE_BOOK',pending:s.positions.filter(t=>!paperFilled(t)||t.paperOrder?.action)
        .map(t=>({id:t.id,symbol:t.symbol,side:t.side,kind:t.paperOrder?.action?.kind??'OPEN',
          phase:t.paperOrder?.action?.phase??t.paperOrder?.phase,at:t.paperOrder?.action?.at??t.paperOrder?.signalAt,
          reason:t.paperOrder?.action?.detail??t.paperOrder?.reason,timing:t.paperOrder?.timing})),
      cancelled:s.paperExecution.cancelled.slice(0,8).map(t=>({id:t.id,symbol:t.symbol,at:t.closedAt,reason:t.exitReason})),
      limitations:['MODELED_MATCHING_NOT_NATIVE_FILLS','NO_UNOBSERVED_BOOK_DEPTH','RPC_LATENCY_USES_OBSERVED_SAMPLES_OR_EXECUTION_CLOCK',
        'NATIVE_LIQUIDATION_FUNDING_AND_EXCHANGE_FAILURES_ARE_NOT_REPLICATED','OLD_FINANCIAL_HISTORY_NOT_REWRITTEN']}:null,
    returnOpen:s.positions.filter(t=>paperFilled(t)&&t.unified?.branch==='RETURN').length,continuationOpen:s.positions.filter(t=>paperFilled(t)&&t.unified?.branch==='CONTINUATION').length,
    legacyOpen:s.positions.filter(t=>!t.unified).length,
    plans:Object.values(ds.plans).map(({candidate,...p})=>({...p,score:candidate.score,confidence:candidate.dataConfidence??null,
      marketRoute:candidate.marketRoute??null,permission:ds.marketAuthority?(candidate.marketRoute?.branch??'WAIT'):p.branch})),
    marketAuthority:ds.marketAuthority?structuredClone(ds.marketAuthority):null,
    authority:'ONE_ACTUAL_ACCOUNT_NO_COMPANION_ORDERS',entryPolicy:ds.marketAuthority?'market-permission-own-side-response':'observed-push-response-or-completed-trend',holdingPolicy:'own-geometric-branch',
    explanation:ds.marketAuthority?'跟随币服从统一市场分支；独立币须持续残差与自身结构确认。回退按实际方向回归重心；延续按承接保护持有。':
      '回退：推进衰减兑现；延续：站稳后跟随，结构破坏退出。所有成本与前段亏损均计入当前账户'};
}
