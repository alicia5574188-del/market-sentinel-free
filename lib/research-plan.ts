/** A market warning changes new risk, never owns a healthy position's exit.
 * Scores derived from the same price path are one evidence group, not votes.
 * Pure, bounded and causal; consumes existing feeds and hypothesis memory only.
 */
import type {CandleLike, MarketSymbolState, QuoteLike} from './market-intelligence-engine.ts';
import type {MarketHypothesisResearchState} from './market-intelligence-hypothesis-research.ts';

export const RESEARCH_PLAN_VERSION='research-plan-v1';
export type PlanResearchContext={
  version:typeof RESEARCH_PLAN_VERSION;at:number;sourceAt:number|null;
  level:'CLEAR'|'WATCH'|'CAUTION'|'UNKNOWN';hypothesisIds:string[];eventAt:number|null;
  hypotheses:{id:string;kind:string;direction:string;status:string;confidence:number;observations:number;targetHitStreak:number;confirmedAt:number|null;updatedAt:number}[];
  independent:boolean;baseRiskScale:number;entryAction:'NORMAL'|'SMALLER_RISK'|'CONFIRM_MORE';riskScale:number;reason:string;
};
export type PlanResearchDecision={
  version:typeof RESEARCH_PLAN_VERSION;at:number;context:PlanResearchContext;
  level:'HEALTHY'|'MARKET_CAUTION'|'LOCAL_REVIEW'|'PROTECT'|'INVALIDATED';
  evidenceGroups:('PRICE'|'BOOK')[];priceAliases:string[];
  bars:number[];price:number;closedPrices:number[];bookReceipt:number[]|null;referencePrice:number|null;buffer:number;priceSequenceFailed:boolean;
  localWeakening:boolean;bookOpposed:boolean;allowExit:boolean;protect:boolean;reason:string;
};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
/** Stable confirmed hypotheses only; expired, future and weakening records cannot
 * manufacture a new warning. An independent trend retains the original entry lane. */
export function researchPlanContext(input:{now:number;side:'LONG'|'SHORT';state?:MarketSymbolState;
  score:number;research?:MarketHypothesisResearchState;baseRiskScale?:number}):PlanResearchContext{
  const {now,side,state:s,research:r}=input;
  const independent=!!s&&input.score>=82&&s.residualPersistence>=.95&&s.sourceCount>=3&&s.dataConfidence>=78&&Math.abs(s.residualZ)>=.55;
  const fresh=!!r&&finite(r.updatedAt)&&r.updatedAt<=now&&now-r.updatedAt<=15*60_000;
  const active=fresh?r!.active.filter(h=>h.updatedAt<=now&&now-h.updatedAt<=15*60_000&&h.expiresAt>now&&h.startedAt<=now):[];
  const opposed=active.filter(h=>h.direction!=='MIXED'&&h.direction!==side&&h.confidence>=.55);
  const confirmed=opposed.filter(h=>h.status==='CONFIRMED'&&h.confidence>=.68&&h.observations>=3&&h.targetHitStreak>=2
    &&finite(h.confirmedAt)&&h.confirmedAt<=now);
  const baseRiskScale=Math.max(.70,Math.min(1,finite(input.baseRiskScale)?input.baseRiskScale:1));
  const caution=confirmed.length>0,level=!fresh?'UNKNOWN':caution?'CAUTION':opposed.length?'WATCH':'CLEAR';
  const selected=(caution?confirmed:opposed).sort((a,b)=>b.confidence-a.confidence).slice(0,3);
  return{version:RESEARCH_PLAN_VERSION,at:now,sourceAt:fresh?r!.updatedAt:null,level,
    hypothesisIds:selected.map(h=>h.id),hypotheses:selected.map(h=>({id:h.id,kind:h.kind,direction:h.direction,status:h.status,confidence:h.confidence,observations:h.observations,targetHitStreak:h.targetHitStreak,confirmedAt:h.confirmedAt,updatedAt:h.updatedAt})),eventAt:caution?Math.min(...confirmed.map(h=>h.confirmedAt!)):null,independent,baseRiskScale,
    entryAction:caution?(independent?'SMALLER_RISK':'CONFIRM_MORE'):'NORMAL',riskScale:Math.min(baseRiskScale,caution?(independent?.85:.70):1),
    reason:caution?(independent?'市场反向预警已持续确认；独立趋势仍保留原入场通道，只降低本次新增风险。':'市场反向预警已持续确认；降低新增风险，并等待更完整的本币实时响应。')
      :level==='WATCH'?'市场有形成中的担忧；不延迟有效机会，不改变健康持仓。'
      :level==='UNKNOWN'?'稳定研究数据不足或过期；不把未知当反向证据，沿用原交易计划。':'稳定研究未确认相反变化，沿用原交易计划。'};
}

/** Caller supplies the same closed 5m rows used by winner management. The entry
 * bar is excluded. A repeated quote, a future candle and a missing bar cannot
 * stand in for a later failed recovery. Hard stops remain outside this helper. */
export function evaluatePlanResearch(input:{now:number;openedAt:number;side:'LONG'|'SHORT';price:number;entryPrice:number;
  originalRisk:number;peakNetRate:number;cost:number;rows:CandleLike[];context:PlanResearchContext;quote?:QuoteLike;
  concerns:string[];positionExit:boolean;exitBasis?:string|null}):PlanResearchDecision{
  const d=input.side==='LONG'?1:-1,cost=input.cost,R=Math.max(cost,input.originalRisk);
  const rows=input.rows.filter(r=>r.time*1000>=input.openedAt&&r.time*1000+300_000<=input.now).slice(-3);
  const a=rows.at(-3),b=rows.at(-2),c=rows.at(-1);
  const contiguous=!!a&&!!b&&!!c&&b.time-a.time===300&&c.time-b.time===300;
  const fresh=!!c&&input.now-(c.time*1000+300_000)<=6*60_000;
  const buffer=Math.max(input.entryPrice*cost*.5,rows.length?rows.reduce((n,r)=>n+r.high-r.low,0)/rows.length*.2:0);
  const reference=a?(d>0?a.low:a.high):null;
  const failed=contiguous&&fresh&&reference!=null&&d*(b!.close-reference)<-buffer&&d*(c!.close-reference)<-buffer
    &&d*(input.price-reference)<-buffer;
  const signed=d*(input.price/input.entryPrice-1),giveback=Math.max(0,input.peakNetRate-(signed-cost));
  const material=signed<=-Math.max(cost*1.15,R*.35)||giveback>=Math.max(cost*2,R*.8);
  const aliases=[...new Set(input.concerns.filter(x=>['RELATIVE','PATH','STRUCTURE'].includes(x)))];
  const q=input.quote,bookFresh=!!q&&q.fresh&&q.observedAt>input.openedAt&&q.observedAt<=input.now&&input.now-q.observedAt<=10_000;
  const bookOpposed=bookFresh&&(q!.liquiditySourceCount??0)>=2&&(q!.disagreementRate??0)<=.008
    &&d*(q!.bookImbalance??0)<=-.15&&d*((q!.bidLiquidityChange??0)-(q!.askLiquidityChange??0))*.5<=-.10;
  // Preserve actual rapid entry failure, not score-only or market-only exits.
  const fastFailure=input.exitBasis==='ENTRY_PRICE_FALSIFIED'&&bookOpposed&&signed<=-Math.max(cost*1.15,R*.35);
  const allowExit=input.positionExit&&((failed&&material)||fastFailure);
  const localWeakening=fresh&&!!b&&!!c&&c.time-b.time===300&&d*(c.close-b.close)<0
    &&(d>0?c.high<=b.high:c.low>=b.low)&&d*(input.price-b.close)<0&&giveback>=Math.max(cost*2,R*.5)&&aliases.length>0;
  const protect=input.context.level==='CAUTION'&&localWeakening;
  const level=allowExit?'INVALIDATED':protect?'PROTECT':aliases.length?'LOCAL_REVIEW':input.context.level==='CAUTION'?'MARKET_CAUTION':'HEALTHY';
  return{version:RESEARCH_PLAN_VERSION,at:input.now,context:input.context,level,
    evidenceGroups:[...(aliases.length||failed?['PRICE' as const]:[]),...(bookOpposed?['BOOK' as const]:[])],priceAliases:aliases,
    bars:rows.map(r=>r.time*1000+300_000),price:input.price,closedPrices:rows.map(r=>r.close),
    bookReceipt:bookFresh?[q!.observedAt,q!.liquiditySourceCount??0,q!.bookImbalance??0,q!.bidLiquidityChange??0,q!.askLiquidityChange??0,q!.disagreementRate??0]:null,referencePrice:reference,buffer,priceSequenceFailed:failed,
    localWeakening,bookOpposed,allowExit,protect,
    reason:allowExit?(fastFailure?'入场后价格实质逆向且独立盘口反证成立，原入场依据已证伪。':'新的完整K线先破坏承接、随后恢复失败，当前价格仍未收复，原计划失效。')
      :protect?'市场预警持续，本币也出现已完成K线上的推进失败；进入分批保护确认，不直接全平。'
      :level==='MARKET_CAUTION'?'市场预警只影响新增风险；本币尚未确认走坏，继续执行原持仓计划。'
      :aliases.length?'分数或局部价格出现担忧，但不足以确认原计划失败；同源价格指标只记一组，不强制退出。'
      :'本币原计划仍有效，正常回调与市场预警不单独结束趋势仓。'};
}
