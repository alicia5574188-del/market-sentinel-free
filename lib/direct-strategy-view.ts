import type {ForwardState,Opportunity} from './forward-relations.ts';
import {DIRECT_STRATEGY_VERSION} from './direct-strategy-types.ts';
import {paperFilled} from './paper-execution.ts';
import type {ReviewEvent} from './review-trace.ts';
export function directOpportunityView(s:ForwardState,o:Opportunity){
  const p=s.directStrategy?.plans[o.symbol];if(!p)return o;
  return{...o,side:p.side,mode:p.branch==='RETURN'?'REVERSAL' as const:'CONTINUATION' as const,
    reason:p.reason,thesisSummary:p.reason,invalidationSummary:p.exitCondition,strategyVersion:DIRECT_STRATEGY_VERSION,
    eligible:!p.consumed&&(s.directStrategy?.marketAuthority?o.eligible:p.phase==='READY'&&o.eligible||p.branch==='RETURN'&&o.eligible&&!p.continuationSeen),
    branch:s.directStrategy?.marketAuthority&&!o.marketRoute&&p.phase==='OBSERVE'?'WAIT':p.branch,decisionPhase:p.phase};
}
/** Stable observation rows preserve changes without re-recording every refreshed
 * candidate identity. Exact authorization/fill events still use their real IDs. */
export function marketCandidateReviewEvents(s:ForwardState,now:number):ReviewEvent[]{
  return s.opportunities.map(o=>{
    const view=directOpportunityView(s,o),market=!!s.directStrategy?.marketAuthority,
      code=view.eligible?'STRATEGY_ELIGIBLE':s.directStrategy?.plans[o.symbol]?.consumed?'EVENT_CONSUMED':
        /^[A-Z_]+:/.test(view.reason)?view.reason.split(':')[0]:'STRATEGY_NOT_ELIGIBLE';
    return{at:now,id:market?`market-observation:${o.symbol}`:o.id,candidateId:o.id,symbol:o.symbol,
      stage:'CANDIDATE_OBSERVED',side:view.side,reason:market?(/^[A-Z_]+:/.test(view.reason)&&code!=='EVENT_CONSUMED'?view.reason:`${code}: ${view.reason}`):
        view.eligible?'STRATEGY_ELIGIBLE':'STRATEGY_NOT_ELIGIBLE',price:o.price,plan:o.tradePlan,expiresAt:o.expiresAt};
  });
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
      branch:ds.marketAuthority&&!candidate.marketRoute&&p.phase==='OBSERVE'?'WAIT':p.branch,
      marketRoute:candidate.marketRoute??null,permission:ds.marketAuthority?(candidate.marketRoute?.branch??'WAIT'):p.branch})),
    marketAuthority:ds.marketAuthority?structuredClone(ds.marketAuthority):null,
    authority:'ONE_ACTUAL_ACCOUNT_NO_COMPANION_ORDERS',entryPolicy:ds.marketAuthority?'market-permission-own-side-response':'observed-push-response-or-completed-trend',holdingPolicy:'own-geometric-branch',
    explanation:ds.marketAuthority?'共同趋势明确时跟随共同方向；市场分化时按本币完整结构参与。逆共同趋势须持续独立残差确认。回退到重心退出，延续按承接保护持有。':
      '回退：推进衰减兑现；延续：站稳后跟随，结构破坏退出。所有成本与前段亏损均计入当前账户'};
}
