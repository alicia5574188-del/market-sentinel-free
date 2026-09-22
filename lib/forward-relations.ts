/** Forward-only market-response learning and generated-rule PAPER execution.
 * No legacy strategy import, exchange write, historical outcome preload or dynamic code evaluation.
 * Measurements are market observations, never shadow orders or synthetic fills.
 */
import { EVIDENCE_POLICY, PREVIOUS_POLICY, blankDiagnostics, collectFeedback, entryEconomics, executionCalibration, evidenceQuality, familyKey, forwardSymbolAllowed, inspectCondition,
  ruleApplies, type Feedback, type Evidence, type Candidate, type EvidenceDiagnostics } from "./forward-evidence.ts";
import { TIMELY_PROTECTION_POLICY, newExitControl, observeExitControl, protectedExitDecision, makeExitAudit,
  type ExitControl, type ExitAudit, type ExitDecision } from "./forward-protection.ts";
import { assessMarketTurn, MARKET_TURN_PROTECTION_VERSION, MARKET_TURN_TARGET_DIRECTION_RISK_RATE,
  type MarketTurnProtection } from "./forward-turn-protection.ts";
import { MARKET_STATE_VERSION, TURN_FORECAST_VERSION, marketRiskBudget, selectDirectionalCandidates, sideRiskHeadroom,
  updateMarketState, updateTurnForecast, type MarketState, type TurnForecast } from "./forward-market-state.ts";
import { forwardProtectionChanged } from "./forward-protection-checkpoint.ts";
import { FORWARD_ADAPTIVE_VERSION, adaptiveCandidatePriority, adaptiveEntryAdjustment, adaptiveTargetRisk, calibrationRiskMultiplier,
  familyRiskHeadroom, inspectRapidCondition, sampleRiskMultiplier, type AdaptiveCandidate, type AdaptiveLane } from "./forward-adaptive.ts";
import { MULTI_TURN_VERSION, TURN_CONFIG, TURN_TIMEFRAMES, evaluateMultiTurn, initialMultiTurn, turnCandidates,
  type MultiTurnState, type TurnCandidate, type TurnEvidence, type TurnPhase, type TurnSide, type TurnTimeframe } from "./multi-turn-engine.ts";
import { MULTI_TURN_PROFIT_PROTECTION_VERSION, multiTurnProfitFloor, supportedProfitVersion, type MultiTurnProfitVersion, type MultiTurnTradeProfitProtection } from "./multi-turn-profit-protection.ts";
import { evaluateMultiTurnHoldValue, evaluateMultiTurnTimeFallback, multiTurnHoldWindows, type MultiTurnHoldValue } from "./multi-turn-hold-value.ts";
import { MULTI_TURN_ROTATION_COOLDOWN_MS, MULTI_TURN_ROTATION_VERSION, evaluateRotationOpportunity,
  multiTurnRotationReentryCooldownMs, rankWeakRotationHoldings, rotationAdvantageEnough, rotationRiskSaturated } from "./multi-turn-rotation.ts";
// The storage schema stays v1.0 so an algorithm upgrade cannot reset the ledger.
export const FORWARD_VERSION = "forward-relations-v1.0";
export const FORWARD_GRAMMAR = "conditional-response-conjunction-v1";
export const BAR_MS = 300_000;
export const HORIZONS = [15, 60, 180] as const;
export const FEATURES = ["5分钟推进", "15分钟推进", "1小时推进", "路径效率", "成交量变化", "收盘位置", "振幅变化", "相对市场推进"] as const;
export const PAPER_COST = { feeRate: .0007, slippageRate: .00025, fundingAllowancePerDay: .0002,
  assumption: "双边吃单费各7bp＋滑点各2.5bp＋实际买卖价差；资金费为每日2bp不利占位，并非Gate实际结算" };
const COST_FLOOR = .0022, DAY = 86_400_000;
export const MULTI_TURN_TARGET_LEVERAGE = 20;
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Quote = { bestBid: number; bestAsk: number; observedAt: number; fresh: boolean; entryReady?: boolean };
export type Contract = { quantoMultiplier: number; leverageMax: number; maintenanceRate: number; minContracts?: number };
export type Frame = { symbol: string; at: number; seenAt: number; price: number; x: number[] };
export type Measurement = Frame & { horizon: number; endAt: number; availableAt: number; response: number; up: number; down: number };
export type Pending = Frame & { horizon: number; dueAt: number };
export type Condition = { feature: number; op: "GE" | "LE"; threshold: number };
export type Rule = { id: string; signature: string; parentId: string | null; version: number; createdAt: number; expiresAt: number;
  status: "EXPERIMENTAL" | "DORMANT"; conditions: Condition[]; side: "LONG" | "SHORT"; horizon: number;
  stopRate: number; armRate: number; givebackRate: number; exitMode: "HORIZON" | "REACTION_DECAY";
  samples: number; trainGroups: number; checkGroups: number; estimatedNetRate: number; priorResponse: number | null;
  recentResponse: number; standardError: number; reason: string; mutation: "CREATE" | "REVISE" | "RECALL";
  grammar: string; liveEligible: false; evidence?: Evidence; adaptiveLane?:AdaptiveLane;
  authority?:"LEGACY_FORWARD"|"MULTI_TURN";turnTimeframe?:TurnTimeframe };
export type MultiTurnEntryContext = {
  version:"multi-turn-entry-context-v1";capturedAt:number;timeframe:TurnTimeframe;side:"LONG"|"SHORT";
  phase:TurnPhase;signalAt:number;signalPrice:number;reason:string;directionConfidence:number;continuationScore:number;
  turnProbability:number;triggerProbability:number;expectedMoveRate:number;modeledCostRate:number;remainingSpaceRate:number;
  stopRate:number;riskCap:number;bestHoldMinutes:number;strongExtensionMinutes:number;hardExtensionMinutes:number;
  evidence:TurnEvidence;
  timeframeStates:Array<{timeframe:TurnTimeframe;direction:TurnSide;phase:TurnPhase;directionConfidence:number;
    continuationScore:number;turnProbability:number;triggerProbability:number;expectedMoveRate:number;atrRate:number;
    evidence:TurnEvidence}>;
};
export type Trade = { id: string; symbol: string; side: "LONG" | "SHORT"; rule: Rule; openedAt: number; closedAt: number | null;
  status: "OPEN" | "CLOSED"; entryPrice: number; exitPrice: number | null; quantity: number; contracts: number;
  quantoMultiplier: number; notional: number; leverage: number; margin: number; plannedRisk: number; stopPrice: number;
  armPrice: number; favorable: number; adverse: number; lastPrice: number; lastQuoteAt: number; entryFee: number;
  exitFee: number; fundingAllowance: number; grossPnl: number | null; netPnl: number | null; exitReason: string | null;
  relationFailureBars: number; lastRelationBar: number; execution: "REAL_QUOTE_PAPER_MODEL"; liveEligible: false;
  exitControl?: ExitControl; exitAudit?: ExitAudit; profitProtection?:MultiTurnTradeProfitProtection; holdValue?:MultiTurnHoldValue;
  entryContext?:MultiTurnEntryContext;
  profitProtectionMigration?:{version:MultiTurnProfitVersion;state:"CURRENT"|"GUARDED"|"DEFERRED";updatedAt:number;baselineFavorable:number};
  forecast?: { policy:string; family:string; signalAt:number; signalPrice:number; baseNetRate:number;
    calibratedNetRate:number; remainingNetRate:number; quality:number; sizingEquity?:number };
  turn?:{version:typeof MULTI_TURN_VERSION;timeframe:TurnTimeframe;signalAt:number;entryTurnProbability:number;
    entryContinuation:number;entryDirectionConfidence:number} };
export type AuditEvent = { id: string; at: number; kind: "START" | "RULE" | "DORMANT" | "ENTRY" | "EXIT" | "PROTECTION" | "DATA_GAP" | "FIT" | "UPGRADE";
  subject: string; reason: string; detail?: Record<string, string | number | null> };
export type Daily = { day: string; firstAt: number; lastAt: number; startEquity: number; endEquity: number; exactBoundary: boolean };
export type QuoteRetry = { symbol:string; ruleId:string; signalAt:number; expiresAt:number; firstAt:number };
export type ForwardState = { version: string; startedAt: number; revision: number; lastCycleAt: number; lastFitAt: number;
  lastQuoteCycleAt: number; balance: number; initialEquity: number; peakEquity: number; maxDrawdown: number;
  resolved: number; wins: number; grossPnl: number; fees: number; fundingAllowance: number; turnover: number;
  observations: number; measured: number; invalidated: number; frames: Record<string, Frame>; pending: Record<string, Pending>;
  samples: Measurement[]; rules: Rule[]; positions: Trade[]; history: Trade[]; events: AuditEvent[]; daily: Daily[];
  lastBars: Record<string, number>; lastEntryBars: Record<string, number>; latestReason: string;
  fitDiagnostics: { tested: number; qualified: number; trainGroups: number; checkGroups: number; latestAt: number;
    rapidQualified?:number; activeLong?:number; activeShort?:number };
  selectedSymbols: string[]; storage: { persistedAt: number; error: string | null }; liveEligible: false;
  adaptationVersion?:string; lastFitMeasured?:number;
  strategyAuthorityVersion?:string;turnEngine?:MultiTurnState;turnLastEntryBars?:Record<string,number>;turnSymbolExitAt?:Record<string,number>;cutoverAt?:number;
  turnRotationBlockedUntil?:Record<string,number>;
  rotationState?:{version:typeof MULTI_TURN_ROTATION_VERSION;lastAt:number;count:number;lastFrom:string|null;lastTo:string|null};
  policyVersion?:string; feedback?:Feedback[]; evidenceDiagnostics?:EvidenceDiagnostics;
  entryDiagnostics?:{at:number;matched:number;opened:number;reasons:Record<string,number>;retry?:boolean;queued?:number;adaptiveScaled?:number};
  quoteRetries?:QuoteRetry[];
  participation?:{since:number;cycles:number;matches:number;quoteWaits:number;retryChecks:number;retryFills:number;opened:number};
  exitPolicyUpgrade?:{policy:string;at:number;equity:number;balance:number;resolved:number;inheritedPositionIds:string[]};
  policyUpgrades?:NonNullable<ForwardState["policyUpgrade"]>[];
  relationEntries?:Record<string,number>;
  turnProtection?:MarketTurnProtection;
  marketState?:MarketState;
  turnForecast?:TurnForecast;
  policyUpgrade?:{at:number;from:string;to:string;equity:number;stalePositions:number;balance:number;resolved:number;positionIds:string[]} };

const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
const clip = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export function quantile(v: number[], p: number) { const a = [...v].sort((x, y) => x-y); return a.length ? a[Math.min(a.length-1, Math.floor((a.length-1)*p))] : 0; }
const finite = (v: number) => Number.isFinite(v);
const hash = (v: string) => { let h=2166136261; for(let i=0;i<v.length;i++)h=Math.imul(h^v.charCodeAt(i),16777619);return(h>>>0).toString(36); };
const direction = (side: Trade["side"]) => side === "LONG" ? 1 : -1;
const dayKey = (now: number) => new Date(now + 7*3_600_000).toISOString().slice(0,10);
function event(s:ForwardState,now:number,kind:AuditEvent["kind"],subject:string,reason:string,detail?:AuditEvent["detail"]) {
  s.revision++;s.events.unshift({id:`f${s.startedAt}-${s.revision}`,at:now,kind,subject,reason,...(detail?{detail}:{})});s.events=s.events.slice(0,256);
}
export function initialForward(now:number):ForwardState {
  const s:ForwardState={version:FORWARD_VERSION,startedAt:now,revision:0,lastCycleAt:0,lastFitAt:0,lastQuoteCycleAt:0,
    balance:1000,initialEquity:1000,peakEquity:1000,maxDrawdown:0,resolved:0,wins:0,grossPnl:0,fees:0,fundingAllowance:0,turnover:0,
    observations:0,measured:0,invalidated:0,frames:{},pending:{},samples:[],rules:[],positions:[],history:[],events:[],daily:[],
    lastBars:{},lastEntryBars:{},policyVersion:EVIDENCE_POLICY,feedback:[],relationEntries:{},
    latestReason:"启动真实行情前向实验；旧K线只计算特征，不回填学习收益或模拟订单。",
    fitDiagnostics:{tested:0,qualified:0,trainGroups:0,checkGroups:0,latestAt:0,rapidQualified:0,activeLong:0,activeShort:0},
    selectedSymbols:[],storage:{persistedAt:0,error:null},liveEligible:false,adaptationVersion:FORWARD_ADAPTIVE_VERSION,lastFitMeasured:0,
    strategyAuthorityVersion:"legacy-forward-rules-v1",turnLastEntryBars:{}};
  event(s,now,"START",FORWARD_VERSION,s.latestReason);return s;
}
export function initialMultiTurnForward(now:number):ForwardState{
  const s=initialForward(now);
  s.revision=0;s.events=[];s.rules=[];s.samples=[];s.pending={};s.frames={};s.feedback=[];s.relationEntries={};s.quoteRetries=[];
  s.strategyAuthorityVersion=MULTI_TURN_VERSION;s.turnEngine=initialMultiTurn();s.turnLastEntryBars={};s.turnSymbolExitAt={};
  s.turnRotationBlockedUntil={};s.rotationState={version:MULTI_TURN_ROTATION_VERSION,lastAt:0,count:0,lastFrom:null,lastTo:null};s.cutoverAt=now;
  s.latestReason="Multi-Turn六周期转折引擎已启动；旧Forward规则不再拥有新开仓或策略退出权。";
  event(s,now,"START",MULTI_TURN_VERSION,s.latestReason);return s;
}
export function normalizeForward(v:ForwardState|null|undefined,now:number):ForwardState {
  if(!v)return initialForward(now);
  if(v.version!==FORWARD_VERSION||!finite(v.balance)||!Array.isArray(v.positions)||!Array.isArray(v.samples)||!Array.isArray(v.rules)||v.liveEligible!==false)
    throw new Error("前向账户存储格式异常；保留原数据，禁止自动重置");
  if(v.policyVersion&&![EVIDENCE_POLICY,PREVIOUS_POLICY].includes(v.policyVersion))throw new Error("未知前向算法版本，拒绝降级或重置");
  if(v.exitPolicyUpgrade&&v.exitPolicyUpgrade.policy!==TIMELY_PROTECTION_POLICY)throw new Error("未知退出策略，保留原账户");
  if(v.positions.some(t=>t.exitControl&&t.exitControl.policy!==TIMELY_PROTECTION_POLICY))throw new Error("未知持仓退出策略，保留原持仓");
  if(v.turnProtection&&v.turnProtection.version!==MARKET_TURN_PROTECTION_VERSION)throw new Error("未知市场转折保护版本，保留原账户");
  if(v.marketState&&v.marketState.version!==MARKET_STATE_VERSION)throw new Error("未知组合市场状态版本，保留原账户");
  if(v.turnForecast&&v.turnForecast.version!==TURN_FORECAST_VERSION)throw new Error("未知转折预警版本，保留原账户");
  if(v.positions.some(t=>t.profitProtection&&!supportedProfitVersion(t.profitProtection.version)))
    throw new Error("未知Multi-Turn利润保护版本，保留原持仓");
  if(v.positions.some(t=>t.profitProtectionMigration&&!supportedProfitVersion(t.profitProtectionMigration.version)))
    throw new Error("未知Multi-Turn利润保护迁移版本，保留原持仓");
  const authority=v.strategyAuthorityVersion??"legacy-forward-rules-v1";
  return {...v,adaptationVersion:v.adaptationVersion??"legacy-forward-adaptation-v1",lastFitMeasured:v.lastFitMeasured??v.measured,
    strategyAuthorityVersion:authority,turnLastEntryBars:v.turnLastEntryBars??{},
    ...(authority===MULTI_TURN_VERSION?{
      turnSymbolExitAt:v.turnSymbolExitAt??{},
      turnRotationBlockedUntil:v.turnRotationBlockedUntil??{},
      rotationState:v.rotationState?.version===MULTI_TURN_ROTATION_VERSION?v.rotationState:
        {version:MULTI_TURN_ROTATION_VERSION,lastAt:0,count:0,lastFrom:null,lastTo:null},
    }:v.turnSymbolExitAt?{turnSymbolExitAt:v.turnSymbolExitAt}:{}),
    ...(v.turnEngine?.version===MULTI_TURN_VERSION?{turnEngine:v.turnEngine}:{})};
}
export function frameFromCandles(symbol:string,rows:Candle[],now:number):Frame|null {
  const a=rows.filter(r=>r.time*1000+BAR_MS<=now).slice(-25);
  if(a.length<25||a.some((r,i)=>![r.time,r.open,r.high,r.low,r.close,r.volume].every(finite)||r.open<=0||r.close<=0||r.low<=0
    ||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.volume<0||(i>0&&r.time!==a[i-1].time+300)))return null;
  const r=a[24],at=r.time*1000+BAR_MS;if(now-at>11*60_000)return null;
  const scale=Math.max(.0005,quantile(a.slice(0,-1).map(c=>(c.high-c.low)/c.close),.5));
  const changes=a.slice(-7).slice(1).map((c,i)=>Math.abs(c.close/a[a.length-7+i].close-1)),move6=r.close/a[18].close-1;
  const x=[(r.close/r.open-1)/scale,(r.close/a[21].close-1)/(scale*Math.sqrt(3)),(r.close/a[12].close-1)/(scale*Math.sqrt(12)),
    move6/Math.max(changes.reduce((p,c)=>p+c,0),1e-9),Math.log(Math.max(r.volume,1e-9)/Math.max(mean(a.slice(0,-1).map(c=>c.volume)),1e-9)),
    2*(r.close-r.low)/Math.max(r.high-r.low,1e-9)-1,Math.log(Math.max((r.high-r.low)/r.close,1e-9)/scale),0].map(v=>clip(v,-8,8));
  return{symbol,at,seenAt:now,price:r.close,x};
}
export function conditionMatches(x:number[],conditions:Condition[]) {
  return conditions.every(c=>finite(x[c.feature])&&(c.op==="GE"?x[c.feature]>=c.threshold:x[c.feature]<=c.threshold));
}
export function synthesizeRules(s:ForwardState,now:number) {
  const candidates:Array<Candidate&{adaptiveLane?:AdaptiveLane}>=[],diagnostics=blankDiagnostics();
  let trainGroups=0,checkGroups=0,rapidQualified=0;
  s.feedback=collectFeedback(s.feedback??[],s.history,now);
  const score=(a:Candidate)=>Math.max(0,a.evidence.calibratedNet??a.estimatedNetRate)*a.evidence.quality
    /Math.max(1e-6,a.evidence.costRate+a.standardError);
  const rank=(a:Candidate,b:Candidate)=>score(b)-score(a)||b.estimatedNetRate-a.estimatedNetRate;
  for(const h of HORIZONS){
    const rows=s.samples.filter(r=>r.horizon===h&&r.availableAt<=now&&r.endAt<=now&&r.at>=s.startedAt);
    if(rows.length<8||Math.max(...rows.map(r=>r.endAt))<now-h*60_000-BAR_MS)continue;
    const generate=(pool:Measurement[],symbol?:string)=>{
      const ordered=[...pool].sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
      const split=ordered[Math.floor(ordered.length*.6)]?.at??0,discovery=ordered.filter(r=>r.endAt<=split);
      trainGroups=Math.max(trainGroups,new Set(discovery.map(r=>Math.floor(r.at/(h*60000)))).size);
      checkGroups=Math.max(checkGroups,new Set(ordered.filter(r=>r.at>=split).map(r=>Math.floor(r.at/(h*60000)))).size);
      if(discovery.length<(symbol?3:12))return [];
      const stumps:Candidate[]=[],rapid:AdaptiveCandidate[]=[],seen=new Set<string>();
      const assess=(conditions:Condition[])=>inspectCondition({rows:ordered,conditions,horizon:h,now,feedback:s.feedback??[],scopeSymbol:symbol},diagnostics);
      for(let f=0;f<FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const){
        const threshold=Math.round(quantile(discovery.map(r=>r.x[f]),p)*100)/100,key=`${f}:${op}:${threshold}`;
        if(seen.has(key))continue;seen.add(key);
        const conditions=[{feature:f,op,threshold}];
        const base=assess(conditions);if(base)stumps.push(base);
        if(h===15&&!symbol){
          const fast=inspectRapidCondition({rows:ordered,conditions,now,feedback:s.feedback??[]});
          if(fast){rapid.push(fast);rapidQualified++;}
        }
      }
      const top=[...stumps].sort(rank).slice(0,3),combined:Array<Candidate&{adaptiveLane?:AdaptiveLane}>=[...stumps];
      for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
        if(top[i].conditions[0].feature===top[j].conditions[0].feature)continue;
        const c=assess([...top[i].conditions,...top[j].conditions].sort((a,b)=>a.feature-b.feature));if(c)combined.push(c);
      }
      combined.push(...rapid);
      return combined.sort(rank);
    };
    const shared=generate(rows);
    // Keep a slightly broader learned set, then guarantee that an independently
    // qualified opposite-side family is not erased by a strong incumbent trend.
    // Risk caps, not candidate pre-pruning, decide how much capital can migrate.
    for(const c of selectDirectionalCandidates(shared,2))candidates.push(c);
    // Single-coin evidence is not banned and is never exported to other coins.
    // Scope uses that coin's own chronological discovery/check split.
    const local:Candidate[]=[];
    const ordered=[...rows].sort((a,b)=>a.at-b.at),discoveryEnd=ordered[Math.floor(rows.length*.6)]?.at??0;
    // Nominate at most TWO local markets using only earlier observations. Do
    // not test all 30 and keep whichever happens to win the later check set.
    // This trades some opportunity coverage for bounded search/CPU variance.
    const nominees=[...new Set(rows.map(r=>r.symbol))].map(symbol=>{
      const early=rows.filter(r=>r.symbol===symbol&&r.endAt<=discoveryEnd);
      return {symbol,count:early.length,score:Math.abs(quantile(early.map(r=>r.response),.5))};
    }).filter(a=>a.count>=3).sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol)).slice(0,2);
    for(const {symbol:sym} of nominees){
      const own=rows.filter(r=>r.symbol===sym);if(own.length<8)continue;
      const best=generate(own,sym)[0];if(best)local.push(best);
    }
    if(local.length)candidates.push(local.sort(rank)[0]);
  }
  s.lastFitAt=now;
  const previous=s.rules.filter(r=>r.status==="EXPERIMENTAL");for(const r of previous)r.status="DORMANT";
  for(const c of candidates){
    const signature=hash(JSON.stringify([c.conditions,c.side,c.horizon,c.exitMode,c.evidence.scope,c.evidence.scope==="SINGLE_ASSET"?c.evidence.symbols[0]:null]));
    const exact=s.rules.find(r=>r.signature===signature&&r.evidence?.policy===EVIDENCE_POLICY);
    // Unchanged measurements and executions are not a new revision or a fresh
    // lease. Otherwise a stale signal could be kept alive indefinitely.
    if(exact?.evidence?.sourceKey===c.evidence.sourceKey){
      if(exact.expiresAt>now)exact.status="EXPERIMENTAL";else diagnostics.expired++;
      continue;
    }
    const parent=exact??previous.find(r=>familyKey(r)===c.evidence.family&&r.evidence?.scope===c.evidence.scope
      &&(c.evidence.scope!=="SINGLE_ASSET"||r.evidence.symbols[0]===c.evidence.symbols[0]));
    const mutation=parent?(exact&&!previous.includes(parent)?"RECALL":"REVISE"):"CREATE";
    const text=c.conditions.map(k=>`${FEATURES[k.feature]}${k.op==="GE"?"≥":"≤"}${k.threshold}`).join(" 且 ");
    const scope=c.evidence.scope==="SINGLE_ASSET"?`仅${c.evidence.symbols[0]}`:`已观测${c.evidence.symbols.length}币的跨币实验，适用性尚待成交验证`;
    const lane=c.adaptiveLane==="RAPID_15M"?"快速适应层":"基础学习层";
    const reason=`${lane}：${text} 后${c.horizon}分钟${scope}；${c.side==="LONG"?"多":"空"}向原始净反应假设${(c.estimatedNetRate*100).toFixed(3)}%，成交校准后${((c.evidence.calibratedNet??c.estimatedNetRate)*100).toFixed(3)}%。${c.evidence.uncertain?"证据不确定，降低排序/风险而不假装已证明通用优势。":""}退出采用${c.exitMode==="REACTION_DECAY"?"回吐保护":"反应期限"}；不是胜率或盈利保证。`;
    const r:Rule={...c,id:`fr-${s.startedAt}-${s.revision+1}`,signature,parentId:parent?.id??null,version:(parent?.version??0)+1,
      createdAt:now,expiresAt:now+Math.max(60,c.horizon*2)*60_000,status:"EXPERIMENTAL",reason,mutation,grammar:FORWARD_GRAMMAR,
      liveEligible:false,adaptiveLane:c.adaptiveLane??"BASE"};
    s.rules.unshift(r);event(s,now,"RULE",r.id,reason,{mutation,rawNet:c.evidence.rawNet,penalty:c.evidence.calibration.penalty,
      netEstimate:r.estimatedNetRate,samples:r.samples,scope:c.evidence.scope});
  }
  for(const r of previous)if(r.status==="DORMANT"&&!candidates.some(c=>c.evidence.family===familyKey(r)))
    event(s,now,"DORMANT",r.id,"当前适用性、集中度或成交偏差校准不再支持该规则；继续观察市场，不把失败直接反向。");
  s.rules=s.rules.slice(0,48);const activeRules=s.rules.filter(r=>r.status==="EXPERIMENTAL"),active=activeRules.length;
  s.lastFitMeasured=s.measured;
  s.fitDiagnostics={tested:diagnostics.tested,qualified:active,trainGroups,checkGroups,latestAt:now,rapidQualified,
    activeLong:activeRules.filter(r=>r.side==="LONG").length,activeShort:activeRules.filter(r=>r.side==="SHORT").length};
  s.evidenceDiagnostics=diagnostics;
  s.latestReason=active?`${active}条交易假设（快层候选${rapidQualified}）；新成熟反应可在5分钟周期触发重估，行情预警只迁移优先级/额度，不再直接让学习系统停摆。未证明盈利。`
    :`当前未形成满足原始成本后估计的交易假设；检查${diagnostics.tested}项表达。不是冷启动或停机，继续按5分钟新反应更新。`;
  event(s,now,"FIT",EVIDENCE_POLICY,s.latestReason,{tested:diagnostics.tested,qualified:active,trainGroups,checkGroups});
}
function ingest(s:ForwardState,paths:Record<string,Candle[]>,now:number){
  const frames=Object.entries(paths).flatMap(([sym,rows])=>{if(!forwardSymbolAllowed(sym))return[];const f=frameFromCandles(sym,rows,now);return f&&now-f.at<=180_000?[f]:[];});
  const byAt=new Map<number,Frame[]>();for(const f of frames){const a=byAt.get(f.at)??[];a.push(f);byAt.set(f.at,a);}
  for(const group of byAt.values()){const med=quantile(group.map(f=>f.x[1]),.5);for(const f of group)f.x[7]=clip(f.x[1]-med,-8,8);}
  s.selectedSymbols=frames.map(f=>f.symbol);
  for(const [sym,f]of Object.entries(s.frames))if(now-f.at>DAY&&!s.positions.some(t=>t.symbol===sym)){
    delete s.frames[sym];delete s.lastBars[sym];delete s.lastEntryBars[sym];
  }
  for(const f of frames){
    s.frames[f.symbol]=f;if(f.at<s.startedAt||f.at<=(s.lastBars[f.symbol]??0))continue;
    const rows=paths[f.symbol];s.lastBars[f.symbol]=f.at;
    for(const h of HORIZONS){
      const key=`${f.symbol}:${h}`,p=s.pending[key];
      if(p&&f.at>=p.dueAt){
        const route=rows.filter(r=>r.time*1000>=p.at&&r.time*1000<p.dueAt);
        const complete=route.length===h/5&&route.every((r,i)=>r.time*1000===p.at+i*BAR_MS);
        if(complete){const last=route.at(-1)!;s.samples.push({...p,endAt:p.dueAt,availableAt:now,response:last.close/p.price-1,
          up:Math.max(0,...route.map(r=>r.high/p.price-1)),down:Math.max(0,...route.map(r=>1-r.low/p.price))});s.measured++;}
        else{s.invalidated++;event(s,now,"DATA_GAP",key,"反应区间不连续，作废测量，不插值、不计成交。");}delete s.pending[key];
      }
      if(!s.pending[key]){s.pending[key]={...f,x:[...f.x],horizon:h,dueAt:f.at+h*60_000};s.observations++;}
    }
  }
  s.samples=HORIZONS.flatMap(h=>s.samples.filter(r=>r.horizon===h&&r.availableAt>=now-7*DAY).slice(-384));
  for(const[k,p]of Object.entries(s.pending))if(now-p.dueAt>11*60_000){delete s.pending[k];s.invalidated++;event(s,now,"DATA_GAP",k,"到期后仍无可核对行情，测量作废。");}
}
export function freshQuote(q:Quote|undefined,now:number):q is Quote {
  return!!q&&q.fresh&&[q.bestBid,q.bestAsk,q.observedAt].every(finite)&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now+1000&&now-q.observedAt<=8000;
}
function exitPrice(t:Trade,q:Quote){return(t.side==="LONG"?q.bestBid:q.bestAsk)*(1-direction(t.side)*PAPER_COST.slippageRate);}
export function forwardEquity(s:ForwardState,quotes:Record<string,Quote>,now:number){
  let floating=0,stalePositions=0;for(const t of s.positions){const q=quotes[t.symbol],px=freshQuote(q,now)?exitPrice(t,q):t.lastPrice;
    if(!freshQuote(q,now))stalePositions++;floating+=direction(t.side)*t.quantity*(px-t.entryPrice)-t.quantity*px*PAPER_COST.feeRate
      -t.notional*PAPER_COST.fundingAllowancePerDay*Math.max(0,now-t.openedAt)/DAY;}
  return{equity:s.balance+floating,floating,stalePositions};
}
function closeTrade(s:ForwardState,t:Trade,q:Quote,now:number,reason:string){
  const px=exitPrice(t,q);t.status="CLOSED";t.closedAt=now;t.exitPrice=px;t.exitReason=reason;t.lastPrice=px;t.lastQuoteAt=q.observedAt;
  t.exitFee=t.quantity*px*PAPER_COST.feeRate;t.fundingAllowance=t.notional*PAPER_COST.fundingAllowancePerDay*(now-t.openedAt)/DAY;
  t.grossPnl=direction(t.side)*t.quantity*(px-t.entryPrice);t.netPnl=t.grossPnl-t.entryFee-t.exitFee-t.fundingAllowance;
  s.balance+=t.grossPnl-t.exitFee-t.fundingAllowance;s.fees+=t.exitFee;s.fundingAllowance+=t.fundingAllowance;s.grossPnl+=t.grossPnl;
  s.turnover+=t.quantity*px;s.resolved++;s.wins+=Number(t.netPnl>0);s.history.unshift(t);s.history=s.history.slice(0,80);
  s.lastEntryBars[t.symbol]=Math.max(s.lastEntryBars[t.symbol]??0,s.frames[t.symbol]?.at??0,Math.floor(now/BAR_MS)*BAR_MS);
  event(s,now,"EXIT",t.id,reason,{netPnl:t.netPnl,entryRule:t.rule.id,holdingMinutes:(now-t.openedAt)/60000});
}
function manage(s:ForwardState,quotes:Record<string,Quote>,now:number,turn:MarketTurnProtection|null,marketState:MarketState|null,turnForecast:TurnForecast|null){
  const marked=forwardEquity(s,quotes,now),threatened=turn?.until&&turn.until>now?turn:null;
  // Observe each executable position once. Its own stop/deadline/confirmed exit
  // has priority, and risk already scheduled to leave must not be cut again by
  // either portfolio reducer. Stale positions remain in risk but cannot be sold.
  const observed=new Map<string,{q:Quote;px:number;r:number;observationGapMs:number;normal:ReturnType<typeof protectedExitDecision>}>();
  for(const t of s.positions){const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const px=exitPrice(t,q),r=direction(t.side)*(px/t.entryPrice-1);
    if(t.favorable<t.rule.armRate&&r>=t.rule.armRate)event(s,now,"PROTECTION",t.id,"已观测有利反应触及生成的保护启动点；保存状态，原始止损不放宽。",{favorable:r,armRate:t.rule.armRate});
    t.favorable=Math.max(t.favorable,r);t.adverse=Math.max(t.adverse,-r);
    const observationGapMs=observeExitControl(t,q.observedAt,now);t.lastPrice=px;t.lastQuoteAt=q.observedAt;
    const f=s.frames[t.symbol];
    if(f&&f.at>t.lastRelationBar){const contrary=s.rules.some(a=>a.status==="EXPERIMENTAL"&&a.expiresAt>now&&a.side!==t.side&&a.horizon===t.rule.horizon&&ruleApplies(a,t.symbol)&&conditionMatches(f.x,a.conditions));
      t.relationFailureBars=contrary?t.relationFailureBars+1:0;t.lastRelationBar=f.at;}
    observed.set(t.id,{q,px,r,observationGapMs,normal:protectedExitDecision(t,r,now)});
  }
  const remaining=s.positions.filter(t=>!observed.get(t.id)?.normal);
  let remainingThreatenedRisk=threatened?remaining.filter(t=>t.side===threatened.threatenedSide).reduce((n,t)=>n+t.plannedRisk,0):0;
  const targetThreatenedRisk=threatened?Math.max(0,marked.equity*MARKET_TURN_TARGET_DIRECTION_RISK_RATE):0;
  const cuts=new Set<string>(),stateCuts=new Set<string>();
  // Portfolio cuts require a fresh valuation of the WHOLE remaining account.
  // A stale lastPrice is useful display fallback, not authority to liquidate a
  // different fresh position. Holding extra portfolio risk until valuation
  // recovers is deliberate; each fresh position's own exits still run below.
  if(marked.stalePositions===0&&threatened&&remainingThreatenedRisk>targetThreatenedRisk){
    const vulnerable=remaining.filter(t=>t.side===threatened.threatenedSide).flatMap(t=>{
      const row=observed.get(t.id);if(!row)return[];const{r}=row;
      // Preserve already-armed winners; they keep their original giveback protection.
      // Cut losing/unarmed exposure first until the broad-turn risk target is reached.
      if(r>0&&t.favorable>=t.rule.armRate)return[];
      return[{t,r}];
    }).sort((a,b)=>a.r-b.r||b.t.plannedRisk-a.t.plannedRisk);
    for(const row of vulnerable){
      if(remainingThreatenedRisk<=targetThreatenedRisk)break;
      cuts.add(row.t.id);remainingThreatenedRisk=Math.max(0,remainingThreatenedRisk-row.t.plannedRisk);
    }
  }
  // UNKNOWN may retain a previous label for entry caution, not new authority
  // to liquidate existing exposure. A valid computed state lasts its normal
  // five-minute evaluation interval; executable hard stops remain independent.
  const observedState=marketState&&marketState.rawMode!=="UNKNOWN"&&marketState.markets>=8
    &&marketState.observedAt<=now&&now-marketState.observedAt<=BAR_MS?marketState:null;
  const observedForecast=turnForecast?.fresh&&turnForecast.observedAt<=now&&now-turnForecast.observedAt<=BAR_MS
    &&(turnForecast.phase==="PULLBACK"||turnForecast.phase==="REVERSAL_RISK")?turnForecast:null;
  if(marked.stalePositions===0&&((observedState&&(observedState.mode==="TRANSITION"||observedState.mode==="NEUTRAL"))||observedForecast)){
    const budget=marketRiskBudget(observedState,marked.equity,s.peakEquity,observedForecast);
    const afterTurn=remaining.filter(t=>!cuts.has(t.id));
    let longRisk=afterTurn.filter(t=>t.side==="LONG").reduce((n,t)=>n+t.plannedRisk,0);
    let shortRisk=afterTurn.filter(t=>t.side==="SHORT").reduce((n,t)=>n+t.plannedRisk,0);
    const vulnerable=afterTurn.flatMap(t=>{
      const row=observed.get(t.id);if(!row)return[];const{r}=row;
      if(r>0&&t.favorable>=t.rule.armRate)return[];
      return[{t,r}];
    }).sort((a,b)=>a.r-b.r||b.t.plannedRisk-a.t.plannedRisk);
    const over=()=>longRisk+shortRisk>marked.equity*budget.totalRate+1e-9
      ||longRisk>marked.equity*budget.longRate+1e-9||shortRisk>marked.equity*budget.shortRate+1e-9
      ||Math.abs(longRisk-shortRisk)>marked.equity*budget.netDirectionalRate+1e-9;
    while(over()){
      const net=longRisk-shortRisk;
      const preferred:Trade["side"]=longRisk>marked.equity*budget.longRate||net>marked.equity*budget.netDirectionalRate?"LONG"
        :shortRisk>marked.equity*budget.shortRate||-net>marked.equity*budget.netDirectionalRate?"SHORT"
        :longRisk>=shortRisk?"LONG":"SHORT";
      const idx=vulnerable.findIndex(x=>x.t.side===preferred&&!stateCuts.has(x.t.id));
      if(idx<0)break;
      const row=vulnerable[idx];stateCuts.add(row.t.id);
      if(row.t.side==="LONG")longRisk=Math.max(0,longRisk-row.t.plannedRisk);else shortRisk=Math.max(0,shortRisk-row.t.plannedRisk);
    }
  }
  for(const t of s.positions){const row=observed.get(t.id);if(!row)continue;
    const{q,px,observationGapMs,normal}=row;
    const forecastCut=stateCuts.has(t.id)&&observedForecast&&t.side===observedForecast.threatenedSide;
    const decision=normal??(cuts.has(t.id)?{trigger:"MARKET_TURN" as const,
      reason:"市场转折保护：广泛同步逆向且波动加速，优先削减尚未形成盈利保护的同向风险",boundaryRate:null}
      :stateCuts.has(t.id)?forecastCut?{trigger:"TURN_FORECAST" as const,
        reason:`转折预警${observedForecast?.phase==="REVERSAL_RISK"?"升级":"生效"}：15分钟广度与较长周期出现反向背离，提前压低${t.side==="LONG"?"多":"空"}向脆弱风险；不把预警直接当成反手信号`,boundaryRate:null}
        :{trigger:"MARKET_STATE" as const,
          reason:`组合市场状态${observedState?.mode==="NEUTRAL"?"进入震荡中性":"进入转折过渡"}：降低单边风险，优先退出尚未形成盈利保护的脆弱仓位`,boundaryRate:null}:null);
    if(decision){
      closeTrade(s,t,q,now,decision.reason);
      if(t.exitControl)t.exitAudit=makeExitAudit(t,decision,px,q.observedAt,now,observationGapMs);
    }
  }s.positions=s.positions.filter(t=>t.status==="OPEN");
}

export function turnModeledCost(tf:TurnTimeframe,spread=0){
  const expectedHold=Math.max(15,TURN_CONFIG[tf].minutes*2);
  return Math.max(COST_FLOOR,2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+Math.max(0,spread)
    +PAPER_COST.fundingAllowancePerDay*expectedHold/1440);
}

export function multiTurnEntryLeverage(stopRate:number,maintenanceRate:number,costRate:number,leverageMax:number){
  if(![stopRate,maintenanceRate,costRate,leverageMax].every(Number.isFinite)||stopRate<=0||maintenanceRate<0||costRate<0||leverageMax<1)
    return 1;
  const safeLeverage=Math.max(1,Math.floor(.8/Math.max(stopRate+maintenanceRate+costRate,1e-9)));
  return Math.max(1,Math.floor(Math.min(MULTI_TURN_TARGET_LEVERAGE,leverageMax,safeLeverage)));
}

function multiTurnRule(s:ForwardState,candidate:TurnCandidate,now:number):Rule{
  const cfg=TURN_CONFIG[candidate.timeframe],net=Math.max(0,candidate.expectedMoveRate-turnModeledCost(candidate.timeframe));
  return{id:`mt-${s.startedAt}-${s.revision+1}`,signature:hash(JSON.stringify(["MULTI_TURN",candidate.symbol,candidate.timeframe,
      candidate.side,candidate.completedAt])),parentId:null,version:1,createdAt:now,expiresAt:now+cfg.maxHoldMinutes*60_000,
    status:"EXPERIMENTAL",conditions:[],side:candidate.side,horizon:cfg.maxHoldMinutes,stopRate:candidate.stopRate,
    armRate:Math.max(candidate.expectedMoveRate,candidate.stopRate*.75),givebackRate:Math.max(.0025,candidate.expectedMoveRate*.35),
    exitMode:"REACTION_DECAY",samples:s.turnEngine?.calibration[candidate.timeframe].count??0,trainGroups:0,checkGroups:0,
    estimatedNetRate:net,priorResponse:null,recentResponse:0,standardError:0,
    reason:`Multi-Turn ${candidate.timeframe}：${candidate.reason}；由时间—空间持仓价值、该周期转折、原始硬止损或安全寿命共同管理退出。`,
    mutation:"CREATE",grammar:MULTI_TURN_VERSION,liveEligible:false,authority:"MULTI_TURN",turnTimeframe:candidate.timeframe};
}

function manageMultiTurn(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const engine=s.turnEngine;if(!engine)return;
  s.turnLastEntryBars??={};
  for(const t of s.positions){
    if(t.rule.authority!=="MULTI_TURN"||!t.turn)throw new Error("Multi-Turn账户混入旧策略持仓，拒绝静默管理");
    const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const px=exitPrice(t,q),ret=direction(t.side)*(px/t.entryPrice-1);
    t.favorable=Math.max(t.favorable,ret);t.adverse=Math.max(t.adverse,-ret);
    const gap=observeExitControl(t,q.observedAt,now);t.lastPrice=px;t.lastQuoteAt=q.observedAt;
    const frame=engine.frames[t.symbol]?.[t.turn.timeframe],cfg=TURN_CONFIG[t.turn.timeframe];
    const freshFrame=frame&&frame.ready&&frame.completedAt<=now
      &&now-frame.completedAt<=Math.max(BAR_MS*2,cfg.minutes*60_000*1.5)?frame:null;
    const spread=(q.bestAsk-q.bestBid)/Math.max((q.bestAsk+q.bestBid)/2,1e-9);
    const modeledCost=turnModeledCost(t.turn.timeframe,spread),riskRate=t.plannedRisk/Math.max(t.notional,1e-9);
    const holdValue=freshFrame?evaluateMultiTurnHoldValue({timeframe:t.turn.timeframe,frame:freshFrame,side:t.side,
      openedAt:t.openedAt,now,returnRate:ret,favorableRate:t.favorable,modeledCostRate:modeledCost}):null;
    const timeFallback=evaluateMultiTurnTimeFallback({timeframe:t.turn.timeframe,openedAt:t.openedAt,now,
      returnRate:ret,favorableRate:t.favorable,modeledCostRate:modeledCost,
      entryExpectedMoveRate:t.entryContext?.expectedMoveRate??t.rule.armRate});
    if(holdValue)t.holdValue=holdValue;
    // Keep the stable single-signal protection model. Do not sum correlated
    // time/space scores into a second aggressive profit-retention multiplier.
    const floor=multiTurnProfitFloor(t.favorable,riskRate,modeledCost,freshFrame?{
      continuationScore:freshFrame.continuationScore,turnProbability:freshFrame.triggerProbability,
      phase:freshFrame.phase,rawDirectionAligned:freshFrame.rawDirection==="NEUTRAL"||freshFrame.rawDirection===t.side,
    }:null);
    if(floor){
      const protectedFloor=Math.max(t.profitProtection?.floorRate??0,floor.floorRate);
      t.profitProtection={...floor,floorRate:protectedFloor,lockedR:protectedFloor/riskRate,
        retentionRate:protectedFloor/Math.max(t.favorable,1e-9),checkpointBand:Math.floor(protectedFloor/riskRate*4+1e-9),
        peakR:Math.max(t.profitProtection?.peakR??0,floor.reachedR),updatedAt:now};
      // A legacy DEFERRED marker cannot coexist with an armed floor: the
      // checkpoint reader correctly rejects that inconsistent combination.
      if(t.profitProtectionMigration?.state==="DEFERRED")t.profitProtectionMigration={
        ...t.profitProtectionMigration,version:MULTI_TURN_PROFIT_PROTECTION_VERSION,state:"CURRENT",updatedAt:now};
    }
    let decision:ExitDecision|null=null;
    if(ret<=-t.rule.stopRate)decision={trigger:"HARD_STOP",reason:"Multi-Turn硬止损：当前可执行价触及该周期原始结构风险边界",boundaryRate:-t.rule.stopRate};
    else if(freshFrame&&freshFrame.direction!==t.side&&freshFrame.lastTurnAt!=null&&freshFrame.lastTurnAt>=t.openedAt)
      decision={trigger:"MULTI_TURN",reason:`${t.turn.timeframe}已确认转向${freshFrame.direction==="LONG"?"多":"空"}；退出原${t.side==="LONG"?"多":"空"}向仓位`,boundaryRate:null};
    else if(freshFrame&&freshFrame.direction===t.side&&freshFrame.phase==="TURNING"&&freshFrame.triggerProbability>=.90
      &&freshFrame.evidence.structure>=.65&&(freshFrame.evidence.cusum>=.60||freshFrame.evidence.changePoint>=.65))
      decision={trigger:"MULTI_TURN",reason:`${t.turn.timeframe}转折概率达到${(freshFrame.triggerProbability*100).toFixed(0)}%，结构破坏与序贯变化同时成立；提前退出该周期旧方向`,boundaryRate:null};
    else if(t.profitProtection&&ret<=t.profitProtection.floorRate)
      decision={trigger:"PROFIT_GIVEBACK",reason:`利润路径保护：已观测最高顺向${(t.favorable*100).toFixed(2)}%，当前回落触及只能上移的保护线${(t.profitProtection.floorRate*100).toFixed(2)}%。`,boundaryRate:t.profitProtection.floorRate};
    else if(timeFallback)
      decision={trigger:"HOLD_VALUE",reason:`时间—空间持仓价值退出：${timeFallback.reason}`,boundaryRate:null};
    else if(holdValue&&holdValue.action!=="HOLD")
      decision={trigger:"HOLD_VALUE",reason:`时间—空间持仓价值退出：${holdValue.reason}`,boundaryRate:null};
    else if(now-t.openedAt>=t.rule.horizon*60_000)
      decision={trigger:"MAX_LIFETIME",reason:`${t.turn.timeframe}超过异常安全寿命上限；退出以防止孤立陈旧持仓，不作为正常策略期限`,boundaryRate:null};
    if(!decision)continue;
    closeTrade(s,t,q,now,decision.reason);
    const sourceRule=s.rules.find(r=>r.id===t.rule.id);if(sourceRule)sourceRule.status="DORMANT";
    s.turnSymbolExitAt??={};s.turnSymbolExitAt[t.symbol]=now;
    if(t.exitControl)t.exitAudit=makeExitAudit(t,decision,px,q.observedAt,now,gap);
    const key=`${t.symbol}:${t.turn.timeframe}`;
    s.turnLastEntryBars[key]=Math.max(s.turnLastEntryBars[key]??0,freshFrame?.completedAt??0,Math.floor(now/BAR_MS)*BAR_MS);
  }
  s.positions=s.positions.filter(t=>t.status==="OPEN");
}
type MultiTurnOpenOptions={
  allowRotation?:boolean;
  onlyCandidate?:{symbol:string;timeframe:TurnTimeframe;completedAt:number};
};

function trySelectiveRiskRotation(input:{state:ForwardState;candidate:TurnCandidate;quotes:Record<string,Quote>;
  contracts:Record<string,Contract>;now:number;entrySymbols?:ReadonlySet<string>;remainingSpaceRate:number;costRate:number}){
  const s=input.state,engine=s.turnEngine,frame=engine?.frames[input.candidate.symbol]?.[input.candidate.timeframe];
  if(!engine||!frame)return false;
  const rotation=s.rotationState??{version:MULTI_TURN_ROTATION_VERSION,lastAt:0,count:0,lastFrom:null,lastTo:null};
  if(rotation.version!==MULTI_TURN_ROTATION_VERSION||input.now-rotation.lastAt<MULTI_TURN_ROTATION_COOLDOWN_MS)return false;
  const marked=forwardEquity(s,input.quotes,input.now);if(marked.stalePositions||!(marked.equity>0))return false;
  const totalRisk=s.positions.reduce((n,t)=>n+t.plannedRisk,0);
  const sideRisk=s.positions.filter(t=>t.side===input.candidate.side).reduce((n,t)=>n+t.plannedRisk,0);
  const sleeveRisk=s.positions.filter(t=>t.turn?.timeframe===input.candidate.timeframe).reduce((n,t)=>n+t.plannedRisk,0);
  if(!rotationRiskSaturated({equity:marked.equity,totalRisk,sideRisk,sleeveRisk,riskCap:input.candidate.riskCap}))return false;
  const opportunity=evaluateRotationOpportunity({candidate:input.candidate,frame,remainingSpaceRate:input.remainingSpaceRate,costRate:input.costRate});
  if(!opportunity.eligible)return false;
  const weak=rankWeakRotationHoldings({now:input.now,holdings:s.positions.flatMap(t=>
    t.turn&&t.holdValue&&t.holdValue.evaluatedAt>=input.now-15_000?[{
      id:t.id,symbol:t.symbol,side:t.side,timeframe:t.turn.timeframe,openedAt:t.openedAt,holdValue:t.holdValue,
    }]:[])});
  for(const row of weak){
    if(!rotationAdvantageEnough(opportunity,row))continue;
    const weakQuote=input.quotes[row.holding.symbol];if(!freshQuote(weakQuote,input.now))continue;
    const reason=`择优换仓：账户风险接近满额，${input.candidate.symbol} ${input.candidate.timeframe}候选优势显著高于${row.holding.symbol}；${opportunity.reason} ${row.reason}`;
    const trial=structuredClone(s),trialWeak=trial.positions.find(t=>t.id===row.holding.id);if(!trialWeak)continue;
    const trialDecision:ExitDecision={trigger:"ROTATION",reason,boundaryRate:null};
    const trialPx=exitPrice(trialWeak,weakQuote);
    closeTrade(trial,trialWeak,weakQuote,input.now,reason);
    if(trialWeak.exitControl)trialWeak.exitAudit=makeExitAudit(trialWeak,trialDecision,trialPx,weakQuote.observedAt,input.now,0);
    trial.positions=trial.positions.filter(t=>t.status==="OPEN");
    openMultiTurnTrades(trial,input.quotes,input.contracts,input.now,input.entrySymbols,{
      allowRotation:false,onlyCandidate:{symbol:input.candidate.symbol,timeframe:input.candidate.timeframe,completedAt:input.candidate.completedAt}});
    if(!trial.positions.some(t=>t.symbol===input.candidate.symbol&&t.openedAt===input.now))continue;

    const actual=s.positions.find(t=>t.id===row.holding.id);if(!actual)continue;
    const decision:ExitDecision={trigger:"ROTATION",reason,boundaryRate:null},px=exitPrice(actual,weakQuote);
    closeTrade(s,actual,weakQuote,input.now,reason);
    if(actual.exitControl)actual.exitAudit=makeExitAudit(actual,decision,px,weakQuote.observedAt,input.now,0);
    const sourceRule=s.rules.find(r=>r.id===actual.rule.id);if(sourceRule)sourceRule.status="DORMANT";
    s.turnSymbolExitAt??={};s.turnSymbolExitAt[actual.symbol]=input.now;
    s.turnRotationBlockedUntil??={};
    s.turnRotationBlockedUntil[actual.symbol]=input.now+multiTurnRotationReentryCooldownMs(actual.turn!.timeframe);
    const oldKey=`${actual.symbol}:${actual.turn!.timeframe}`;
    s.turnLastEntryBars??={};s.turnLastEntryBars[oldKey]=Math.max(s.turnLastEntryBars[oldKey]??0,Math.floor(input.now/BAR_MS)*BAR_MS);
    s.positions=s.positions.filter(t=>t.status==="OPEN");
    s.rotationState={version:MULTI_TURN_ROTATION_VERSION,lastAt:input.now,count:rotation.count+1,
      lastFrom:actual.symbol,lastTo:input.candidate.symbol};
    openMultiTurnTrades(s,input.quotes,input.contracts,input.now,input.entrySymbols,{
      allowRotation:false,onlyCandidate:{symbol:input.candidate.symbol,timeframe:input.candidate.timeframe,completedAt:input.candidate.completedAt}});
    if(!s.positions.some(t=>t.symbol===input.candidate.symbol&&t.openedAt===input.now))
      throw new Error("择优换仓原子校验失败：弱仓已退出但强候选未能进入；整轮状态不得发布");
    event(s,input.now,"PROTECTION",MULTI_TURN_ROTATION_VERSION,reason,{
      from:actual.symbol,to:input.candidate.symbol,candidateScore:opportunity.score,holdingScore:row.score,
      candidateEdgeRatio:opportunity.edgeRatio,holdingEdgeRatio:row.holding.holdValue.edgeRatio});
    s.latestReason=`择优换仓完成：${actual.symbol} → ${input.candidate.symbol}；仅在风险满额且强弱差显著时执行。`;
    return true;
  }
  return false;
}

function openMultiTurnTrades(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,
  entrySymbols?:ReadonlySet<string>,options:MultiTurnOpenOptions={}){
  const engine=s.turnEngine;if(!engine||engine.version!==MULTI_TURN_VERSION)return;
  s.turnLastEntryBars??={};s.quoteRetries=[];
  const candidates=turnCandidates(engine,tf=>turnModeledCost(tf,0))
    .filter(candidate=>!entrySymbols||entrySymbols.has(candidate.symbol))
    .filter(candidate=>!options.onlyCandidate||(candidate.symbol===options.onlyCandidate.symbol
      &&candidate.timeframe===options.onlyCandidate.timeframe&&candidate.completedAt===options.onlyCandidate.completedAt));
  const diagnostics={at:now,matched:candidates.length,opened:0,reasons:{} as Record<string,number>,retry:false,queued:0,adaptiveScaled:0};
  s.entryDiagnostics=diagnostics;
  const reject=(reason:string)=>{diagnostics.reasons[reason]=(diagnostics.reasons[reason]??0)+1;};
  for(const candidate of candidates){
    if(s.positions.some(t=>t.symbol===candidate.symbol))continue;
    if((s.turnRotationBlockedUntil?.[candidate.symbol]??0)>now){reject("该币刚被择优换出，冷却期内不重新追入");continue;}
    if(now-(s.turnSymbolExitAt?.[candidate.symbol]??-Infinity)<10_000){reject("该币刚完成周期转折退出；下一执行周期再比较各周期新方向");continue;}
    const key=`${candidate.symbol}:${candidate.timeframe}`;
    if((s.turnLastEntryBars[key]??0)>=candidate.completedAt)continue;
    const cfg=TURN_CONFIG[candidate.timeframe],maxAge=Math.max(BAR_MS*2,cfg.minutes*60_000*1.5);
    if(candidate.completedAt>now||now-candidate.completedAt>maxAge){reject("该周期转折状态已过期，等待新完整K线");continue;}
    const q=quotes[candidate.symbol],meta=contracts[candidate.symbol];
    if(!freshQuote(q,now)||q.entryReady===false){reject("等待新鲜可执行盘口；状态继续保留，不补过去成交");continue;}
    if(!meta||!finite(meta.quantoMultiplier)||meta.quantoMultiplier<=0||!finite(meta.leverageMax)||meta.leverageMax<1
      ||!finite(meta.maintenanceRate)){reject("等待合约乘数和杠杆元数据");continue;}
    const marked=forwardEquity(s,quotes,now),equity=marked.equity;if(equity<=0){reject("净值不足，不自动充值");break;}
    if(marked.stalePositions){reject("已有持仓估值过期，只管理风险不新增仓位");break;}
    const mid=(q.bestBid+q.bestAsk)/2,spread=(q.bestAsk-q.bestBid)/mid;if(spread>.0015){reject("当前买卖价差过大");continue;}
    const d=candidate.side==="LONG"?1:-1,progress=d*(mid/candidate.signalPrice-1);
    const adverseLimit=Math.max(.0015,Math.min(candidate.stopRate*.35,candidate.expectedMoveRate*.60));
    if(progress < -adverseLimit){reject("转折状态形成后价格已明显逆向，原入场上下文失效");continue;}
    const cost=turnModeledCost(candidate.timeframe,spread),remaining=candidate.expectedMoveRate-cost-Math.max(0,progress);
    if(remaining<=0){reject("价格推进和交易成本已吃掉该周期剩余空间");continue;}
    const totalRisk=s.positions.reduce((n,t)=>n+t.plannedRisk,0),sideRisk=s.positions.filter(t=>t.side===candidate.side).reduce((n,t)=>n+t.plannedRisk,0);
    const sleeveRisk=s.positions.filter(t=>t.turn?.timeframe===candidate.timeframe).reduce((n,t)=>n+t.plannedRisk,0);
    const gross=s.positions.reduce((n,t)=>n+t.notional,0),drawdown=Math.max(0,1-equity/Math.max(s.peakEquity,equity));
    const drawdownScale=drawdown>=.20?.50:drawdown>=.10?.70:drawdown>=.05?.85:1;
    const quality=clip(candidate.continuationScore*(.65+.35*candidate.confidence),.15,1);
    const headroom=Math.min(equity*.10-totalRisk,equity*.065-sideRisk,equity*candidate.riskCap-sleeveRisk);
    const targetRisk=Math.max(0,Math.min(equity*.015*quality*drawdownScale,headroom));
    const lossRate=candidate.stopRate+cost;
    const leverage=multiTurnEntryLeverage(candidate.stopRate,meta.maintenanceRate,cost,meta.leverageMax);
    const usedMargin=s.positions.reduce((n,t)=>n+t.margin,0);
    // Nominal value remains risk-authoritative. Leverage is normally fixed at
    // 20x and margin becomes the balancing variable. A structurally wide stop
    // may lower leverage, never raise it beyond 20x to force a position through.
    const marginCapNotional=Math.max(0,(equity*.75-usedMargin)/(1/leverage+.75*PAPER_COST.feeRate));
    // Risk ratios are evaluated on marked equity, which immediately reflects
    // round-trip fee/slippage/spread drag. Reserve that same immediate mark cost
    // when sizing so persisted sleeve/directional/portfolio caps remain true
    // after the order is opened, not only before the entry fee is booked.
    const immediateMarkCost=Math.max(0,2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+spread);
    const totalCapNotional=Math.max(0,(equity*.10-totalRisk)/(lossRate+.10*immediateMarkCost));
    const sideCapNotional=Math.max(0,(equity*.065-sideRisk)/(lossRate+.065*immediateMarkCost));
    const sleeveCapNotional=Math.max(0,(equity*candidate.riskCap-sleeveRisk)/(lossRate+candidate.riskCap*immediateMarkCost));
    const desired=Math.min(equity*1.5,targetRisk/Math.max(lossRate,1e-9),totalCapNotional,sideCapNotional,sleeveCapNotional,
      marginCapNotional,Math.max(0,equity*4-gross));
    if(!(desired>=equity*.05)){
      if(options.allowRotation!==false&&trySelectiveRiskRotation({state:s,candidate,quotes,contracts,now,entrySymbols,
        remainingSpaceRate:remaining,costRate:cost}))return;
      reject("该周期剩余风险额度不足有效仓位，不生成碎片订单");continue;
    }
    const price=(candidate.side==="LONG"?q.bestAsk:q.bestBid)*(1+d*PAPER_COST.slippageRate);
    const exitNow=(candidate.side==="LONG"?q.bestBid:q.bestAsk)*(1-d*PAPER_COST.slippageRate);
    const notionalPer=price*meta.quantoMultiplier,riskPer=notionalPer*lossRate;
    const equityDeltaPer=-notionalPer*PAPER_COST.feeRate
      +d*meta.quantoMultiplier*(exitNow-price)-meta.quantoMultiplier*exitNow*PAPER_COST.feeRate;
    const capCount=(rate:number,used:number,addedRiskPer=0)=>Math.max(0,Math.floor((equity*rate-used)
      /Math.max(1e-12,addedRiskPer-rate*equityDeltaPer)));
    const qualityRate=.015*quality*drawdownScale;
    let count=Math.floor(desired/notionalPer);
    // The new fill's immediate drag lowers the denominator for every existing
    // risk sleeve, not merely the sleeve that receives the new position.
    // Constrain all sleeves, both directions and every existing single-trade
    // risk simultaneously on post-fill marked equity.
    const longRisk=s.positions.filter(t=>t.side==="LONG").reduce((n,t)=>n+t.plannedRisk,0);
    const shortRisk=s.positions.filter(t=>t.side==="SHORT").reduce((n,t)=>n+t.plannedRisk,0);
    const constraints=[
      capCount(.10,totalRisk,riskPer),
      capCount(.065,longRisk,candidate.side==="LONG"?riskPer:0),
      capCount(.065,shortRisk,candidate.side==="SHORT"?riskPer:0),
      capCount(qualityRate,0,riskPer),
      capCount(.015,0,riskPer),
      ...TURN_TIMEFRAMES.map(tf=>capCount(TURN_CONFIG[tf].riskCap,
        s.positions.filter(t=>t.turn?.timeframe===tf).reduce((n,t)=>n+t.plannedRisk,0),
        tf===candidate.timeframe?riskPer:0)),
      ...s.positions.map(t=>capCount(.015,t.plannedRisk,0)),
    ];
    count=Math.min(count,...constraints);
    if(count<Math.max(1,meta.minContracts??1)){
      if(options.allowRotation!==false&&trySelectiveRiskRotation({state:s,candidate,quotes,contracts,now,entrySymbols,
        remainingSpaceRate:remaining,costRate:cost}))return;
      reject("风险额度低于交易所最小合约张数");continue;
    }
    const quantity=count*meta.quantoMultiplier,notional=quantity*price;
    if(notional<equity*.05||notional<desired*.25){reject("合约取整后只剩碎片仓位");continue;}
    const entryFee=notional*PAPER_COST.feeRate,markedAfter=equity-entryFee,margin=notional/leverage;
    if(usedMargin+margin>markedAfter*.75+1e-8){reject("模拟可用保证金不足");continue;}
    const rule=multiTurnRule(s,candidate,now),plannedRisk=notional*lossRate;
    const entryFrame=s.turnEngine?.frames[candidate.symbol]?.[candidate.timeframe];
    const entryWindows=multiTurnHoldWindows(candidate.timeframe);
    const entryContext:MultiTurnEntryContext|undefined=entryFrame?{
      version:"multi-turn-entry-context-v1",capturedAt:now,timeframe:candidate.timeframe,side:candidate.side,
      phase:entryFrame.phase,signalAt:candidate.completedAt,signalPrice:candidate.signalPrice,reason:candidate.reason,
      directionConfidence:candidate.confidence,continuationScore:candidate.continuationScore,
      turnProbability:candidate.turnProbability,triggerProbability:entryFrame.triggerProbability,
      expectedMoveRate:candidate.expectedMoveRate,modeledCostRate:cost,remainingSpaceRate:remaining,
      stopRate:candidate.stopRate,riskCap:candidate.riskCap,
      bestHoldMinutes:entryWindows.bestHoldMinutes,strongExtensionMinutes:entryWindows.strongExtensionMinutes,
      hardExtensionMinutes:entryWindows.hardExtensionMinutes,evidence:structuredClone(entryFrame.evidence),
      timeframeStates:TURN_TIMEFRAMES.flatMap(timeframe=>{
        const observed=s.turnEngine?.frames[candidate.symbol]?.[timeframe];
        return observed?[{timeframe,direction:observed.direction,phase:observed.phase,
          directionConfidence:observed.directionConfidence,continuationScore:observed.continuationScore,
          turnProbability:observed.turnProbability,triggerProbability:observed.triggerProbability,
          expectedMoveRate:observed.expectedMoveRate,atrRate:observed.atrRate,evidence:structuredClone(observed.evidence)}]:[];
      }),
    }:undefined;
    const t:Trade={id:`ft-${s.startedAt}-${s.revision+1}`,symbol:candidate.symbol,side:candidate.side,rule:structuredClone(rule),
      openedAt:now,closedAt:null,status:"OPEN",entryPrice:price,exitPrice:null,quantity,contracts:count,quantoMultiplier:meta.quantoMultiplier,
      notional,leverage,margin,plannedRisk,stopPrice:price*(1-d*candidate.stopRate),
      armPrice:price*(1+d*Math.max(candidate.expectedMoveRate,cost*1.5)),favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q.observedAt,
      entryFee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:candidate.completedAt,
      execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,exitControl:newExitControl(),
      forecast:{policy:MULTI_TURN_VERSION,family:`TURN:${candidate.timeframe}:${candidate.side}`,signalAt:candidate.completedAt,
        signalPrice:candidate.signalPrice,baseNetRate:remaining,calibratedNetRate:remaining,remainingNetRate:remaining,quality,sizingEquity:equity-entryFee},
      turn:{version:MULTI_TURN_VERSION,timeframe:candidate.timeframe,signalAt:candidate.completedAt,
        entryTurnProbability:candidate.turnProbability,entryContinuation:candidate.continuationScore,entryDirectionConfidence:candidate.confidence},
      ...(entryContext?{entryContext}:{}),};
    s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.positions.push(t);s.rules.unshift(rule);s.rules=s.rules.slice(0,48);
    s.turnLastEntryBars[key]=candidate.completedAt;s.lastEntryBars[candidate.symbol]=candidate.completedAt;diagnostics.opened++;
    event(s,now,"ENTRY",t.id,`${candidate.symbol}按${candidate.timeframe}转折状态沿${candidate.side==="LONG"?"多":"空"}向进入；该周期独立负责策略退出。`,
      {timeframe:candidate.timeframe,turnProbability:candidate.turnProbability,continuation:candidate.continuationScore,
        notional,plannedRisk,remainingEdge:remaining});
  }
  if(diagnostics.opened)s.latestReason=`Multi-Turn本轮开仓${diagnostics.opened}笔；六周期继续独立观察转折。`;
  else if(Object.keys(diagnostics.reasons).length)s.latestReason=Object.entries(diagnostics.reasons).sort((a,b)=>b[1]-a[1])[0][0];
  else s.latestReason=`Multi-Turn管理${s.positions.length}笔持仓；无周期被强制暂停。`;
}

export function closeForwardForReset(state:ForwardState,quotes:Record<string,Quote>,now:number,
  reason="Multi-Turn正式切换：归档旧模拟仓位并重建1000U新账户"){
  const s=structuredClone(state);
  for(const t of [...s.positions]){
    const q=quotes[t.symbol];if(!freshQuote(q,now))throw new Error(`${t.symbol}缺少新鲜盘口，不能原子重置模拟账户`);
    closeTrade(s,t,q,now,reason);
  }
  s.positions=[];event(s,now,"UPGRADE",MULTI_TURN_VERSION,reason);
  return s;
}

function openTrades(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,retry=false,turn:MarketTurnProtection|null=null,marketState:MarketState|null=null,turnForecast:TurnForecast|null=null){
  const waiting=s.quoteRetries??[];
  const candidates=Object.values(s.frames).filter(f=>forwardSymbolAllowed(f.symbol)).flatMap(f=>s.rules.filter(r=>r.status==="EXPERIMENTAL"&&r.createdAt<=now&&r.expiresAt>now
    &&f.at>=s.startedAt&&now-f.at<BAR_MS&&ruleApplies(r,f.symbol)&&conditionMatches(f.x,r.conditions)
    &&(!retry||waiting.some(w=>w.ruleId===r.id&&w.symbol===f.symbol&&w.signalAt===f.at&&w.expiresAt>now)))
    .map(r=>({f,r,adjustment:adaptiveEntryAdjustment({side:r.side,horizon:r.horizon,state:marketState,forecast:turnForecast,turn})})))
    .sort((a,b)=>adaptiveCandidatePriority(b.r,b.adjustment)-adaptiveCandidatePriority(a.r,a.adjustment)
      ||b.r.estimatedNetRate-a.r.estimatedNetRate||a.f.symbol.localeCompare(b.f.symbol));
  let blocker="";const diagnostics={at:now,matched:candidates.length,opened:0,reasons:{} as Record<string,number>,retry,queued:0,adaptiveScaled:0};
  s.entryDiagnostics=diagnostics;s.relationEntries??={};s.quoteRetries=[];
  s.participation??={since:now,cycles:0,matches:0,quoteWaits:0,retryChecks:0,retryFills:0,opened:0};
  if(retry)s.participation.retryChecks++;else{s.participation.cycles++;s.participation.matches+=candidates.length;}
  const reject=(reason:string)=>{blocker=reason;diagnostics.reasons[reason]=(diagnostics.reasons[reason]??0)+1;};
  const readySymbols=(side:Trade["side"])=>new Set(candidates.filter(({f,r})=>r.side===side&&ruleApplies(r,f.symbol)
    &&!s.positions.some(t=>t.symbol===f.symbol)&&(s.lastEntryBars[f.symbol]??0)<f.at
    &&freshQuote(quotes[f.symbol],now)&&quotes[f.symbol].entryReady!==false).map(({f})=>f.symbol)).size;
  for(const{f,r,adjustment}of candidates){
    if(s.positions.some(t=>t.symbol===f.symbol)||(s.lastEntryBars[f.symbol]??0)>=f.at)continue;
    if(adjustment.riskMultiplier<.999)diagnostics.adaptiveScaled++;
    const family=familyKey(r),episodeKey=`${f.symbol}:${family}`;
    // A completed observation, not the whole holding horizon, is the repeat
    // unit. Same-bar entries cannot be duplicated by changing rule versions.
    const q=quotes[f.symbol],meta=contracts[f.symbol];
    if(!freshQuote(q,now)||q.entryReady===false){
      reject("等待新鲜盘口；在当前5分钟信号窗口内重试，不补过去成交");
      s.quoteRetries.push({symbol:f.symbol,ruleId:r.id,signalAt:f.at,expiresAt:f.at+BAR_MS,
        firstAt:waiting.find(w=>w.symbol===f.symbol&&w.ruleId===r.id&&w.signalAt===f.at)?.firstAt??now});
      if(!retry)s.participation.quoteWaits++;continue;
    }
    if(!meta||!finite(meta.quantoMultiplier)||meta.quantoMultiplier<=0||!finite(meta.leverageMax)||meta.leverageMax<1||!finite(meta.maintenanceRate)){reject("等待合约乘数和杠杆元数据");continue;}
    const marked=forwardEquity(s,quotes,now),equity=marked.equity;if(equity<=0){reject("净值不足，不自动充值或重置");break;}
    if(marked.stalePositions){reject("已有持仓估值过期，暂停新增风险");break;}
    const spread=(q.bestAsk-q.bestBid)/((q.bestAsk+q.bestBid)/2);if(spread>.0015){reject("当前买卖价差过大");continue;}
    const calibration=executionCalibration(s.feedback??[],family,r.evidence!.symbols,now);
    const calibratedNet=r.evidence!.rawNet-calibration.penalty;
    const calibrationScale=calibrationRiskMultiplier(r.evidence!.rawNet,calibratedNet);
    const sampleScale=sampleRiskMultiplier(r.evidence!.scope,r.samples);
    const d=direction(r.side),price=(r.side==="LONG"?q.bestAsk:q.bestBid)*(1+d*PAPER_COST.slippageRate);
    // Discovery's raw positive-cost hypothesis is NOT a validated edge. The
    // bounded/calibrated estimate scores risk. Midpoint progression avoids
    // subtracting the entry slippage twice: it is in modeled cost already.
    const economics=entryEconomics(r,f.price,(q.bestBid+q.bestAsk)/2,spread);
    if(economics.contextInvalid){reject("入场前价格已明显偏离原观察条件，不把下跌自动当成便宜机会");continue;}
    if(economics.remaining<=0){reject("价差及入场前已发生的价格推进吃掉剩余优势");continue;}
    const gross=s.positions.reduce((a,t)=>a+t.notional,0),risk=s.positions.reduce((a,t)=>a+t.plannedRisk,0);
    const longRisk=s.positions.filter(t=>t.side==="LONG").reduce((a,t)=>a+t.plannedRisk,0);
    const shortRisk=s.positions.filter(t=>t.side==="SHORT").reduce((a,t)=>a+t.plannedRisk,0);
    const budget=marketRiskBudget(marketState,equity,s.peakEquity,turnForecast);
    // Execution calibration has its own continuous risk multiplier below.
    // Do not apply the same loss penalty a second time through quality; quality
    // here reflects structural evidence robustness plus the current entry move.
    const quality=Math.min(economics.quality,evidenceQuality(r.evidence!.rawNet,
      r.evidence!.boundedNet??r.evidence!.rawNet,r.standardError,r.evidence!.costRate,0));
    // Best-first sequential allocation: the highest-ranked executable candidate
    // receives a meaningful slice first; the next candidate sees the recomputed
    // remaining headroom. We never pre-divide risk among candidates that may not fill.
    const stateHeadroom=sideRiskHeadroom(r.side,longRisk,shortRisk,equity,budget);
    const openFamilyRisk=s.positions.filter(t=>familyKey(t.rule)===family).reduce((sum,t)=>sum+t.plannedRisk,0);
    const effectiveHeadroom=Math.min(stateHeadroom,familyRiskHeadroom(equity,openFamilyRisk));
    const lossRate=r.stopRate+Math.max(COST_FLOOR,r.evidence!.costRate)+spread;
    const targetRisk=adaptiveTargetRisk({equity,quality,allocationScale:budget.allocationScale,
      riskMultiplier:adjustment.riskMultiplier*calibrationScale*sampleScale,stateHeadroom:effectiveHeadroom,
      readyPeers:readySymbols(r.side),minimumMeaningfulRisk:equity*.055*lossRate});
    const desired=Math.min(equity*1.5,targetRisk/lossRate,Math.max(0,equity*4-gross));
    const immediateExit=(r.side==="LONG"?q.bestBid:q.bestAsk)*(1-d*PAPER_COST.slippageRate);
    const immediateCost=Math.max(r.evidence!.costRate,PAPER_COST.feeRate*(1+immediateExit/price)+d*(1-immediateExit/price));
    const wanted=Math.max(0,Math.min(desired,(equity*4-gross)/(1+4*immediateCost),
      targetRisk/(lossRate+.015*quality*immediateCost),
      (equity*budget.totalRate-risk)/(lossRate+budget.totalRate*immediateCost),
      stateHeadroom/(lossRate+Math.max(.015,r.side==="LONG"?budget.longRate:budget.shortRate)*immediateCost)));
    if(wanted<equity*.05||wanted<desired*.25){reject("账户可用风险预算或有效仓位不足，不填碎片订单");continue;}
    const count=Math.floor(wanted/(price*meta.quantoMultiplier));if(count<Math.max(1,meta.minContracts??1)){reject("风险额度或最小张数不足");continue;}
    const quantity=count*meta.quantoMultiplier,notional=quantity*price;
    if(notional<equity*.05||notional<desired*.25){reject("整数张数后只剩碎片仓位，跳过而不放大风险");continue;}
    const usedMargin=s.positions.reduce((a,t)=>a+t.margin,0),markedAfter=equity-notional*immediateCost;
    // Margin reservation can be shared across ready names because leverage only
    // changes reserved collateral, not notional or planned loss. Risk itself is
    // shared only across meaningful slots above, avoiding fragment starvation.
    const marginPeers=Math.max(1,readySymbols(r.side));
    const marginTarget=Math.min(equity*.2,Math.max(0,markedAfter*.75-usedMargin)/marginPeers);
    if(!(marginTarget>0)){reject("模拟可用保证金不足");continue;}
    // More names share margin as well as stop risk. Leverage only changes
    // reserved margin here; neither notional nor planned loss is increased.
    const leverage=Math.max(1,Math.min(meta.leverageMax,Math.ceil(notional/marginTarget),Math.floor(.8/(r.stopRate+meta.maintenanceRate+COST_FLOOR)))),margin=notional/leverage;
    if(usedMargin+margin>markedAfter*.75){reject("模拟可用保证金不足");continue;}
    const t:Trade={id:`ft-${s.startedAt}-${s.revision+1}`,symbol:f.symbol,side:r.side,rule:structuredClone(r),openedAt:now,closedAt:null,status:"OPEN",
      entryPrice:price,exitPrice:null,quantity,contracts:count,quantoMultiplier:meta.quantoMultiplier,notional,leverage,margin,
      plannedRisk:notional*lossRate,stopPrice:price*(1-d*r.stopRate),armPrice:price*(1+d*r.armRate),favorable:0,adverse:0,
      lastPrice:price,lastQuoteAt:q.observedAt,entryFee:notional*PAPER_COST.feeRate,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,
      relationFailureBars:0,lastRelationBar:f.at,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
      exitControl:newExitControl(),
      forecast:{policy:EVIDENCE_POLICY,family,signalAt:f.at,signalPrice:f.price,baseNetRate:economics.remaining,
        calibratedNetRate:calibratedNet,remainingNetRate:economics.remaining,quality,sizingEquity:equity-notional*immediateCost}};
    s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=notional;s.positions.push(t);s.lastEntryBars[f.symbol]=f.at;
    s.relationEntries[episodeKey]=f.at+BAR_MS;diagnostics.opened++;s.participation.opened++;
    if(retry)s.participation.retryFills++;
    event(s,now,"ENTRY",t.id,`${f.symbol}按实验假设${r.id}使用新鲜买卖价模拟成交；不是Gate实盘成交。`,
      {ruleId:r.id,notional,contracts:count,remainingNet:economics.remaining,calibratedNet,calibrationPenalty:calibration.penalty,quality,
        quoteRetry:Number(retry),adaptiveRiskMultiplier:adjustment.riskMultiplier,calibrationRiskMultiplier:calibrationScale,
        sampleRiskMultiplier:sampleScale,familyRiskBefore:openFamilyRisk,adaptivePriorityMultiplier:adjustment.priorityMultiplier,
        adaptiveLane:r.adaptiveLane??"BASE"});
  }
  for(const[key,until]of Object.entries(s.relationEntries))if(until<now)delete s.relationEntries[key];
  s.quoteRetries=[...new Map(s.quoteRetries.map(w=>[`${w.symbol}:${w.ruleId}:${w.signalAt}`,w])).values()].slice(0,90);
  diagnostics.queued=s.quoteRetries.length;
  if(diagnostics.opened)s.latestReason=`本轮${retry?"报价重试后":""}模拟开仓${diagnostics.opened}笔；管理${s.positions.length}笔持仓。`;
  else if(blocker)s.latestReason=blocker;else if(s.positions.length)s.latestReason=`管理${s.positions.length}笔前向模拟持仓；原始保护止损不会放宽。`;
}
function advanceMultiTurnForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;daily?:Record<string,Candle[]>;
  quotes:Record<string,Quote>;contracts:Record<string,Contract>;entrySymbols?:string[]},s:ForwardState,before:number){
  const{now,paths,quotes,contracts}=input,daily=input.daily??{};
  if(s.strategyAuthorityVersion!==MULTI_TURN_VERSION)throw new Error("Multi-Turn权威版本不一致");
  const entrySymbols=new Set(input.entrySymbols??Object.keys(paths));
  const retainedSymbols=[...new Set([...entrySymbols,...s.positions.map(position=>position.symbol)])];
  const dataDue=!s.lastCycleAt||Math.floor((now-90_000)/BAR_MS)>Math.floor((s.lastCycleAt-90_000)/BAR_MS);
  if(dataDue){
    s.turnEngine=evaluateMultiTurn({state:s.turnEngine??initialMultiTurn(),paths,daily,retainSymbols:retainedSymbols,now});
    s.lastCycleAt=now;s.selectedSymbols=[...entrySymbols];
    const candidates=turnCandidates(s.turnEngine,tf=>turnModeledCost(tf,0)).filter(candidate=>entrySymbols.has(candidate.symbol));
    s.fitDiagnostics={tested:s.turnEngine.diagnostics.readyFrames,qualified:candidates.length,trainGroups:0,checkGroups:0,latestAt:now,
      rapidQualified:0,activeLong:candidates.filter(x=>x.side==="LONG").length,activeShort:candidates.filter(x=>x.side==="SHORT").length};
    s.observations+=s.turnEngine.diagnostics.updatedFrames;s.measured+=s.turnEngine.diagnostics.confirmedTurns;
    const turns=Object.values(s.turnEngine.frames).flatMap(by=>TURN_TIMEFRAMES.flatMap(tf=>by[tf]?.justTurned?[by[tf]!]:[]));
    if(turns.length){
      const sample=turns.slice(0,5).map(x=>`${x.symbol} ${x.timeframe}→${x.direction}`).join("；");
      event(s,now,"PROTECTION",MULTI_TURN_VERSION,`本轮确认${turns.length}个独立周期转折：${sample}`,
        {confirmed:turns.length,readyFrames:s.turnEngine.diagnostics.readyFrames});
    }
  }
  manageMultiTurn(s,quotes,now);
  openMultiTurnTrades(s,quotes,contracts,now,entrySymbols);
  const marked=forwardEquity(s,quotes,now);
  if(!marked.stalePositions){
    s.peakEquity=Math.max(s.peakEquity,marked.equity);
    s.maxDrawdown=Math.max(s.maxDrawdown,1-marked.equity/Math.max(s.peakEquity,1e-9));
  }
  if(dataDue){
    const k=dayKey(now),a=s.daily.find(d=>d.day===k);
    if(a){a.endEquity=marked.equity;a.lastAt=now;}
    else s.daily.push({day:k,firstAt:now,lastAt:now,startEquity:s.daily.at(-1)?.endEquity??s.initialEquity,endEquity:marked.equity,exactBoundary:false});
    s.daily=s.daily.slice(-400);
  }
  s.lastQuoteCycleAt=now;
  return{state:s,changed:dataDue||s.revision!==before,protectionChanged:forwardProtectionChanged(input.state,s)};
}

export function advanceForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;daily?:Record<string,Candle[]>;quotes:Record<string,Quote>;contracts:Record<string,Contract>;legacyDrainOnly?:boolean;entrySymbols?:string[]}){
  const{now,paths,quotes,contracts}=input,s=structuredClone(input.state),before=s.revision;
  if(s.strategyAuthorityVersion===MULTI_TURN_VERSION)return advanceMultiTurnForward(input,s,before);
  if(!s.exitPolicyUpgrade){
    const marked=forwardEquity(s,quotes,now);
    s.exitPolicyUpgrade={policy:TIMELY_PROTECTION_POLICY,at:now,equity:marked.equity,balance:s.balance,
      resolved:s.resolved,inheritedPositionIds:s.positions.map(t=>t.id)};
    event(s,now,"UPGRADE",TIMELY_PROTECTION_POLICY,"新订单的回吐与已确认关系变化不再额外等待持仓年龄；入场、保护幅度、原持仓、账户及规则学习不重置。");
  }else if(s.exitPolicyUpgrade.policy!==TIMELY_PROTECTION_POLICY)throw new Error("未知退出策略，拒绝覆盖");
  const upgraded=s.policyVersion!==EVIDENCE_POLICY;
  if(upgraded){
    if(s.policyVersion&&s.policyVersion!==PREVIOUS_POLICY)throw new Error("未知算法版本，禁止自动覆盖");
    const mark=forwardEquity(s,quotes,now);
    if(s.policyUpgrade)s.policyUpgrades=[...(s.policyUpgrades??[]),s.policyUpgrade].slice(-16);
    s.policyUpgrade={at:now,from:s.policyVersion??"legacy-forward-v1.0",to:EVIDENCE_POLICY,equity:mark.equity,stalePositions:mark.stalePositions,
      balance:s.balance,resolved:s.resolved,positionIds:s.positions.map(t=>t.id)};
    s.policyVersion=EVIDENCE_POLICY;s.lastFitAt=0;s.relationEntries??={};
    s.quoteRetries=[];s.participation={since:now,cycles:0,matches:0,quoteWaits:0,retryChecks:0,retryFills:0,opened:0};
    for(const r of s.rules)r.status="DORMANT";
    for(const t of [...s.history,...s.positions])s.relationEntries[`${t.symbol}:${familyKey(t.rule)}`]=Math.max(
      s.relationEntries[`${t.symbol}:${familyKey(t.rule)}`]??0,t.openedAt+t.rule.horizon*60000);
    event(s,now,"UPGRADE",EVIDENCE_POLICY,"恢复广度与及时执行：证据疑问用于排序/风险，报价短窗重试，新增规则回吐边界考虑费用；账户、亏损、历史和原持仓保护保持连续。",
      {equity:mark.equity,resolved:s.resolved,open:s.positions.length});
  }
  const adaptiveUpgraded=s.adaptationVersion!==FORWARD_ADAPTIVE_VERSION;
  if(adaptiveUpgraded){
    s.adaptationVersion=FORWARD_ADAPTIVE_VERSION;s.lastFitMeasured=-1;
    event(s,now,"UPGRADE",FORWARD_ADAPTIVE_VERSION,
      "自适应架构升级：保留原账户、持仓、历史、样本和保护边界；新增快速15分钟迁移、连续风险权重和顺序额度分配，市场预警不再直接把学习候选归零。",
      {equity:forwardEquity(s,quotes,now).equity,resolved:s.resolved,open:s.positions.length});
  }
  // Wait for a bounded Top30 refresh after the completed 5-minute boundary.
  const dataDue=upgraded||adaptiveUpgraded||!s.lastCycleAt||Math.floor((now-90_000)/BAR_MS)>Math.floor((s.lastCycleAt-90_000)/BAR_MS);
  if(dataDue){
    const priorState=s.marketState??null;
    s.marketState=updateMarketState(paths,priorState,now);
    if(!priorState||priorState.mode!==s.marketState.mode)event(s,now,"PROTECTION",MARKET_STATE_VERSION,s.marketState.reason,
      {mode:s.marketState.mode,markets:s.marketState.markets,breadth30:s.marketState.breadth30,pathEfficiency30:s.marketState.pathEfficiency30});
    const priorForecast=s.turnForecast??null;
    s.turnForecast=updateTurnForecast(paths,priorForecast,now);
    if(!priorForecast||priorForecast.phase!==s.turnForecast.phase||priorForecast.threatenedSide!==s.turnForecast.threatenedSide)
      event(s,now,"PROTECTION",TURN_FORECAST_VERSION,s.turnForecast.reason,{phase:s.turnForecast.phase,
        threatenedSide:s.turnForecast.threatenedSide??null,pressure:s.turnForecast.pressure,breadth15:s.turnForecast.breadth15,
        breadth30:s.turnForecast.breadth30,breadth60:s.turnForecast.breadth60});
    const detected=assessMarketTurn({paths,positions:s.positions,equity:forwardEquity(s,quotes,now).equity,now});
    if(detected){
      const prior=s.turnProtection;
      s.turnProtection=prior&&prior.threatenedSide===detected.threatenedSide&&prior.completedBarAt===detected.completedBarAt
        ?{...prior,until:Math.max(prior.until,detected.until)}:detected;
      if(!prior||prior.threatenedSide!==detected.threatenedSide||prior.completedBarAt!==detected.completedBarAt)
        event(s,now,"PROTECTION",MARKET_TURN_PROTECTION_VERSION,detected.reason,{markets:detected.markets,
          adverseShare:detected.adverseShare,medianAdverseMove:detected.medianAdverseMove,
          directionalRiskRate:detected.directionalRiskRate});
    }else if(s.turnProtection&&s.turnProtection.until<=now)s.turnProtection=undefined;
  }
  const turn=s.turnProtection&&s.turnProtection.until>now?s.turnProtection:null;
  const marketState=s.marketState??null,turnForecast=s.turnForecast??null;
  // Exits at currently executable prices happen first. Their now-known results
  // can calibrate NEW entries immediately; no future closure enters learning.
  manage(s,quotes,now,turn,marketState,turnForecast);s.feedback=collectFeedback(s.feedback??[],s.history,now);
  if(dataDue){ingest(s,paths,now);s.lastCycleAt=now;
    if(!input.legacyDrainOnly&&(s.measured!==(s.lastFitMeasured??-1)||now-s.lastFitAt>=15*60_000))synthesizeRules(s,now);
    for(const r of s.rules)if(r.status==="EXPERIMENTAL"&&r.expiresAt<=now){r.status="DORMANT";event(s,now,"DORMANT",r.id,"证据过期，停止新开仓，等待新反应。");}}
  if(input.legacyDrainOnly){
    s.quoteRetries=[];s.latestReason=`等待Multi-Turn安全切换：旧Forward仅管理${s.positions.length}笔既有源持仓，不再生成新开仓。`;
  }else if(dataDue)openTrades(s,quotes,contracts,now,false,turn,marketState,turnForecast);
  else if(s.quoteRetries?.some(w=>w.expiresAt>now))openTrades(s,quotes,contracts,now,true,turn,marketState,turnForecast);
  else s.quoteRetries=[];
  const marked=forwardEquity(s,quotes,now);
  if(!marked.stalePositions){s.peakEquity=Math.max(s.peakEquity,marked.equity);s.maxDrawdown=Math.max(s.maxDrawdown,1-marked.equity/Math.max(s.peakEquity,1e-9));}
  if(dataDue){const k=dayKey(now),a=s.daily.find(d=>d.day===k);if(a){a.endEquity=marked.equity;a.lastAt=now;}else s.daily.push({day:k,firstAt:now,lastAt:now,startEquity:s.daily.at(-1)?.endEquity??s.initialEquity,endEquity:marked.equity,exactBoundary:false});s.daily=s.daily.slice(-400);}
  s.lastQuoteCycleAt=now;return{state:s,changed:dataDue||s.revision!==before,protectionChanged:forwardProtectionChanged(input.state,s)};
}
export function forwardWatchSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  if(s.strategyAuthorityVersion===MULTI_TURN_VERSION&&s.turnEngine){
    const allowed=entrySymbols?new Set(entrySymbols):null;
    const ranked=turnCandidates(s.turnEngine,tf=>turnModeledCost(tf,0))
      .filter(x=>(!allowed||allowed.has(x.symbol))&&x.completedAt<=now
        &&now-x.completedAt<=Math.max(BAR_MS*2,TURN_CONFIG[x.timeframe].minutes*60_000*1.5));
    return[...new Set([...s.positions.map(p=>p.symbol),...ranked.map(x=>x.symbol)])].slice(0,11);
  }
  const matched=Object.values(s.frames).filter(f=>now-f.at<11*60_000&&s.rules.some(r=>r.status==="EXPERIMENTAL"&&r.expiresAt>now&&ruleApplies(r,f.symbol)&&conditionMatches(f.x,r.conditions)));
  return[...new Set([...s.positions.map(p=>p.symbol),...matched.map(f=>f.symbol)])];
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const marked=forwardEquity(s,quotes,now),count=Object.fromEntries(HORIZONS.map(h=>[h,s.samples.filter(r=>r.horizon===h).length]));
  const multi=s.strategyAuthorityVersion===MULTI_TURN_VERSION,engine=multi?s.turnEngine:null;
  return{version:s.version,grammar:multi?MULTI_TURN_VERSION:FORWARD_GRAMMAR,mode:"REAL_FEED_PAPER",liveEligible:false,
    strategyAuthorityVersion:s.strategyAuthorityVersion??"legacy-forward-rules-v1",cutoverAt:s.cutoverAt??null,
    startedAt:s.startedAt,updatedAt:s.lastQuoteCycleAt,
    policyVersion:s.policyVersion??"legacy-forward-v1.0",policyUpgrade:s.policyUpgrade??null,policyUpgrades:s.policyUpgrades??[],
    exitPolicyVersion:multi?MULTI_TURN_VERSION:TIMELY_PROTECTION_POLICY,exitPolicyUpgrade:s.exitPolicyUpgrade??null,
    participation:s.participation??null,quoteRetries:multi?[]:s.quoteRetries?.filter(w=>w.expiresAt>now)??[],
    evidenceDiagnostics:multi?null:s.evidenceDiagnostics??null,entryDiagnostics:s.entryDiagnostics??null,feedbackCount:s.feedback?.length??0,
    turnProtection:multi?null:s.turnProtection&&s.turnProtection.until>now?s.turnProtection:null,
    marketState:multi?null:s.marketState??null,turnForecast:multi?null:s.turnForecast??null,
    adaptationVersion:multi?MULTI_TURN_VERSION:s.adaptationVersion??"legacy-forward-adaptation-v1",
    turnEngine:engine?{version:engine.version,updatedAt:engine.updatedAt,diagnostics:engine.diagnostics,
      calibration:engine.calibration,frames:engine.frames}:null,
    turnRiskSleeves:multi?Object.fromEntries(TURN_TIMEFRAMES.map(tf=>[tf,TURN_CONFIG[tf].riskCap])):null,
    marketRiskBudget:multi?(()=>{const dd=Math.max(0,1-marked.equity/Math.max(s.peakEquity,marked.equity));
      const scale=dd>=.20?.50:dd>=.10?.70:dd>=.05?.85:1;
      return{totalRate:.10,longRate:.065,shortRate:.065,netDirectionalRate:.065,drawdownRate:dd,allocationScale:scale,
        reason:`Multi-Turn：六周期独立风险袖套合计10%，同方向最多6.5%；当前回撤只把新仓缩至${(scale*100).toFixed(0)}%，不停止转折搜索。`};})()
      :marketRiskBudget(s.marketState??null,marked.equity,s.peakEquity,s.turnForecast??null),
    lastCycleAt:s.lastCycleAt,lastFitAt:s.lastFitAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...marked,
    targetEquity:s.initialEquity*2,netPnl:marked.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,
    fees:s.fees,fundingAllowance:s.fundingAllowance,turnover:s.turnover,observations:s.observations,measured:s.measured,invalidated:s.invalidated,
    pending:multi?(engine?.pending.length??0):Object.keys(s.pending).length,sampleCounts:count,fitDiagnostics:s.fitDiagnostics,
    rules:s.rules,positions:s.positions,history:s.history,events:s.events.slice(0,80),daily:s.daily,
    marketCount:s.selectedSymbols.length,markets:s.selectedSymbols,latestReason:s.latestReason,storage:s.storage,
    nextCycleAt:s.lastCycleAt?(Math.floor((s.lastCycleAt-90_000)/BAR_MS)+1)*BAR_MS+90_000:now,cost:PAPER_COST,
    boundaries:multi?{scope:"PAPER_ONLY",grammar:"5m/15m/30m/1h/4h/1d六周期独立转折概率；同一币当前仅一条可执行源腿以保持Gate单向持仓精确复制",
      historyBackfill:false,sampleMeaning:"转折概率的未来标签只在到期后用于Brier/概率校准，不回填交易",
      accounting:"新鲜买卖价模拟成交；费用、滑点、资金占位先进入转折可交易空间",
      risk:"组合风险≤10%，同方向≤6.5%，六周期袖套1.5/2/2/2/1.5/1%；单笔≤1.5%，回撤只缩仓",
      validation:"转折检测与成本后交易仍需真实前向验证，不承诺盈利或月翻倍",
      liquidation:"对应周期开仓由对应周期转折退出；硬止损和异常安全寿命独立生效"}:
      {scope:"PAPER_ONLY",grammar:"最多两个连续特征条件；方向、期限、止损和回吐退出由新市场反应生成",historyBackfill:false,
      sampleMeaning:"市场条件与后来反应；不是影子订单或连胜晋级",accounting:"新鲜买卖价模拟成交；净值包含退出费用与资金占位",
      risk:"单笔风险上限1.5%；同一关系family的所有并行币合计最多占一个1.5%风险槽；成交校准为负仍保留15%探测风险，单币小样本连续缩仓",
      validation:"前向实验未证明盈利或月翻倍",liquidation:"当前盘口保护，不冒充交易所标记价格强平复现"}};
}
