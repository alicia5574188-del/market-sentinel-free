import type {ForwardState,Opportunity} from './forward-relations.ts';
import {DIRECT_STRATEGY_VERSION} from './direct-strategy-types.ts';
import {paperFilled} from './paper-execution.ts';
import type {ReviewEvent} from './review-trace.ts';
export function directOpportunityView(s:ForwardState,o:Opportunity){
  const p=s.directStrategy?.plans[o.symbol];if(!p)return o;
  return{...o,side:p.side,mode:p.branch==='RETURN'?'REVERSAL' as const:'CONTINUATION' as const,
    reason:p.reason,thesisSummary:p.reason,invalidationSummary:p.exitCondition,strategyVersion:DIRECT_STRATEGY_VERSION,
    eligible:!p.consumed&&(s.directStrategy?.anomalyRange||s.directStrategy?.eventResponse?p.candidate.eligible:s.directStrategy?.marketAuthority?o.eligible:p.phase==='READY'&&o.eligible||p.branch==='RETURN'&&o.eligible&&!p.continuationSeen),
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
    episodeResearch:ds.episodeResearch?structuredClone(ds.episodeResearch):null,
    adaptive:ds.adaptive?structuredClone(ds.adaptive):null,
    anomalyRange:ds.anomalyRange?structuredClone(ds.anomalyRange):null,rangeResearch:ds.rangeResearch?structuredClone(ds.rangeResearch):null,
    eventResponse:ds.eventResponse?structuredClone(ds.eventResponse):null,eventResearch:ds.eventResearch?structuredClone(ds.eventResearch):null,eventResearchError:ds.eventResearchError??null,
    specialMove:ds.specialMove?structuredClone(ds.specialMove):null,specialResearch:ds.specialResearch?structuredClone(ds.specialResearch):null,
    authority:'ONE_ACTUAL_ACCOUNT_NO_COMPANION_ORDERS',entryPolicy:ds.anomalyRange?'frozen-range-five-then-minute-proof':ds.eventResponse?'stable-event-retained-price-response':ds.specialMove?'unusual-active-coin-own-explosive-leg':ds.adaptive?'causal-failure-return-or-retained-continuation':ds.marketAuthority?'market-permission-own-side-response':'observed-push-response-or-completed-trend',holdingPolicy:ds.anomalyRange?'planned-structure-edge-only-reversal':ds.eventResponse?'failed-launch-or-lost-earned-advantage':ds.adaptive?'independent-holding-support-and-earned-profit':'own-geometric-branch',
    explanation:ds.anomalyRange?'只扫描强于大盘，以及和大盘反向的币。扫到之后等一根5分钟收出影线，扫描时没走完的那根也算。影线要长过实体的1.5倍：上影线做空，下影线做多；两边都有影线时，只在另一边短于半个实体才做长的那一边。止盈按这根实体的3到5倍，硬止损最多是止盈距离的3倍。浮亏不到1倍止盈距离继续拿，到过2倍就等回到1倍亏损或成本，到3倍直接止损。仓位按这段风险计算，风险小仓位大，风险大仓位小，已有仓位越满新仓越小。':ds.eventResponse?'先记住活跃异常，再观察自身推进、优势保留与回落恢复；真实盘口确认后开单。失败启动及时结束，赚出优势后保留正常回落；旧持仓继续原规则。':ds.specialMove?'发现特别的活跃币，持续记录不响应、独走和加速；本币实际启动才交易，按自身承接与实际盈利反压管理持仓。':ds.marketAuthority?'共同趋势明确时跟随共同方向；市场分化时按本币完整结构参与。逆共同趋势须持续独立残差确认。回退到重心退出，延续按承接保护持有。':
      '回退：推进衰减兑现；延续：站稳后跟随，结构破坏退出。所有成本与前段亏损均计入当前账户'};
}
