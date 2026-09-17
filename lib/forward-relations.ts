/** Forward-only market-response learning and generated-rule PAPER execution.
 * No legacy strategy import, exchange write, historical outcome preload or dynamic code evaluation.
 * Measurements are market observations, never shadow orders or synthetic fills.
 */
import { EVIDENCE_POLICY, PREVIOUS_POLICY, blankDiagnostics, collectFeedback, entryEconomics, executionCalibration, evidenceQuality, familyKey, inspectCondition,
  ruleApplies, type Feedback, type Evidence, type Candidate, type EvidenceDiagnostics } from "./forward-evidence.ts";
// The storage schema stays v1.0 so an algorithm upgrade cannot reset the ledger.
export const FORWARD_VERSION = "forward-relations-v1.0";
export const FORWARD_GRAMMAR = "conditional-response-conjunction-v1";
export const BAR_MS = 300_000;
export const HORIZONS = [15, 60, 180] as const;
export const FEATURES = ["5分钟推进", "15分钟推进", "1小时推进", "路径效率", "成交量变化", "收盘位置", "振幅变化", "相对市场推进"] as const;
export const PAPER_COST = { feeRate: .0007, slippageRate: .00025, fundingAllowancePerDay: .0002,
  assumption: "双边吃单费各7bp＋滑点各2.5bp＋实际买卖价差；资金费为每日2bp不利占位，并非Gate实际结算" };
const COST_FLOOR = .0022, DAY = 86_400_000;
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
  grammar: string; liveEligible: false; evidence?: Evidence };
export type Trade = { id: string; symbol: string; side: "LONG" | "SHORT"; rule: Rule; openedAt: number; closedAt: number | null;
  status: "OPEN" | "CLOSED"; entryPrice: number; exitPrice: number | null; quantity: number; contracts: number;
  quantoMultiplier: number; notional: number; leverage: number; margin: number; plannedRisk: number; stopPrice: number;
  armPrice: number; favorable: number; adverse: number; lastPrice: number; lastQuoteAt: number; entryFee: number;
  exitFee: number; fundingAllowance: number; grossPnl: number | null; netPnl: number | null; exitReason: string | null;
  relationFailureBars: number; lastRelationBar: number; execution: "REAL_QUOTE_PAPER_MODEL"; liveEligible: false;
  forecast?: { policy:string; family:string; signalAt:number; signalPrice:number; baseNetRate:number;
    calibratedNetRate:number; remainingNetRate:number; quality:number; sizingEquity?:number } };
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
  fitDiagnostics: { tested: number; qualified: number; trainGroups: number; checkGroups: number; latestAt: number };
  selectedSymbols: string[]; storage: { persistedAt: number; error: string | null }; liveEligible: false;
  policyVersion?:string; feedback?:Feedback[]; evidenceDiagnostics?:EvidenceDiagnostics;
  entryDiagnostics?:{at:number;matched:number;opened:number;reasons:Record<string,number>;retry?:boolean;queued?:number};
  quoteRetries?:QuoteRetry[];
  participation?:{since:number;cycles:number;matches:number;quoteWaits:number;retryChecks:number;retryFills:number;opened:number};
  policyUpgrades?:NonNullable<ForwardState["policyUpgrade"]>[];
  relationEntries?:Record<string,number>;
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
    lastBars:{},lastEntryBars:{},policyVersion:EVIDENCE_POLICY,feedback:[],relationEntries:{},latestReason:"启动真实行情前向实验；旧K线只计算特征，不回填学习收益或模拟订单。",
    fitDiagnostics:{tested:0,qualified:0,trainGroups:0,checkGroups:0,latestAt:0},selectedSymbols:[],storage:{persistedAt:0,error:null},liveEligible:false};
  event(s,now,"START",FORWARD_VERSION,s.latestReason);return s;
}
export function normalizeForward(v:ForwardState|null|undefined,now:number):ForwardState {
  if(!v)return initialForward(now);
  if(v.version!==FORWARD_VERSION||!finite(v.balance)||!Array.isArray(v.positions)||!Array.isArray(v.samples)||!Array.isArray(v.rules)||v.liveEligible!==false)
    throw new Error("前向账户存储格式异常；保留原数据，禁止自动重置");
  if(v.policyVersion&&![EVIDENCE_POLICY,PREVIOUS_POLICY].includes(v.policyVersion))throw new Error("未知前向算法版本，拒绝降级或重置");
  return v;
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
  const candidates:Candidate[]=[],diagnostics=blankDiagnostics();let trainGroups=0,checkGroups=0;
  s.feedback=collectFeedback(s.feedback??[],s.history,now);
  const rank=(a:Candidate,b:Candidate)=>b.estimatedNetRate-a.estimatedNetRate;
  for(const h of HORIZONS){
    const rows=s.samples.filter(r=>r.horizon===h&&r.availableAt<=now&&r.endAt<=now&&r.at>=s.startedAt);
    if(rows.length<8||Math.max(...rows.map(r=>r.endAt))<now-h*60_000-BAR_MS)continue;
    const generate=(pool:Measurement[],symbol?:string)=>{
      const ordered=[...pool].sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
      const split=ordered[Math.floor(ordered.length*.6)]?.at??0,discovery=ordered.filter(r=>r.endAt<=split);
      trainGroups=Math.max(trainGroups,new Set(discovery.map(r=>Math.floor(r.at/(h*60000)))).size);
      checkGroups=Math.max(checkGroups,new Set(ordered.filter(r=>r.at>=split).map(r=>Math.floor(r.at/(h*60000)))).size);
      if(discovery.length<(symbol?3:12))return [];
      const stumps:Candidate[]=[],seen=new Set<string>();
      const assess=(conditions:Condition[])=>inspectCondition({rows:ordered,conditions,horizon:h,now,feedback:s.feedback??[],scopeSymbol:symbol},diagnostics);
      for(let f=0;f<FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const){
        const threshold=Math.round(quantile(discovery.map(r=>r.x[f]),p)*100)/100,key=`${f}:${op}:${threshold}`;
        if(seen.has(key))continue;seen.add(key);
        const c=assess([{feature:f,op,threshold}]);if(c)stumps.push(c);
      }
      const top=[...stumps].sort(rank).slice(0,3),combined=[...stumps];
      for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
        if(top[i].conditions[0].feature===top[j].conditions[0].feature)continue;
        const c=assess([...top[i].conditions,...top[j].conditions].sort((a,b)=>a.feature-b.feature));if(c)combined.push(c);
      }
      return combined.sort(rank);
    };
    const shared=generate(rows),kept=new Set<string>();
    for(const c of shared){if(kept.has(c.evidence.family))continue;kept.add(c.evidence.family);candidates.push(c);if(kept.size>=2)break;}
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
    const reason=`${text} 后${c.horizon}分钟${scope}；${c.side==="LONG"?"多":"空"}向原始净反应假设${(c.estimatedNetRate*100).toFixed(3)}%，成交校准后${((c.evidence.calibratedNet??c.estimatedNetRate)*100).toFixed(3)}%。${c.evidence.uncertain?"证据不确定，降低排序/风险而不假装已证明通用优势。":""}退出采用${c.exitMode==="REACTION_DECAY"?"回吐保护":"反应期限"}；不是胜率或盈利保证。`;
    const r:Rule={...c,id:`fr-${s.startedAt}-${s.revision+1}`,signature,parentId:parent?.id??null,version:(parent?.version??0)+1,
      createdAt:now,expiresAt:now+Math.max(60,c.horizon*2)*60_000,status:"EXPERIMENTAL",reason,mutation,grammar:FORWARD_GRAMMAR,liveEligible:false};
    s.rules.unshift(r);event(s,now,"RULE",r.id,reason,{mutation,rawNet:c.evidence.rawNet,penalty:c.evidence.calibration.penalty,
      netEstimate:r.estimatedNetRate,samples:r.samples,scope:c.evidence.scope});
  }
  for(const r of previous)if(r.status==="DORMANT"&&!candidates.some(c=>c.evidence.family===familyKey(r)))
    event(s,now,"DORMANT",r.id,"当前适用性、集中度或成交偏差校准不再支持该规则；继续观察市场，不把失败直接反向。");
  s.rules=s.rules.slice(0,48);const active=s.rules.filter(r=>r.status==="EXPERIMENTAL").length;
  s.fitDiagnostics={tested:diagnostics.tested,qualified:active,trainGroups,checkGroups,latestAt:now};s.evidenceDiagnostics=diagnostics;
  s.latestReason=active?`${active}条交易假设；集中度和成交偏差用于排序/风险，报价暂缺在本根5分钟窗口内重试。未证明盈利。`
    :`当前未形成满足原始成本后估计的交易假设；检查${diagnostics.tested}项表达。不是冷启动或停机，不强制开单。`;
  event(s,now,"FIT",EVIDENCE_POLICY,s.latestReason,{tested:diagnostics.tested,qualified:active,trainGroups,checkGroups});
}
function ingest(s:ForwardState,paths:Record<string,Candle[]>,now:number){
  const frames=Object.entries(paths).flatMap(([sym,rows])=>{const f=frameFromCandles(sym,rows,now);return f&&now-f.at<=180_000?[f]:[];});
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
function manage(s:ForwardState,quotes:Record<string,Quote>,now:number){
  for(const t of s.positions){const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const px=exitPrice(t,q),d=direction(t.side),r=d*(px/t.entryPrice-1);t.lastPrice=px;t.lastQuoteAt=q.observedAt;
    if(t.favorable<t.rule.armRate&&r>=t.rule.armRate)event(s,now,"PROTECTION",t.id,"已观测有利反应触及生成的保护启动点；保存状态，原始止损不放宽。",{favorable:r,armRate:t.rule.armRate});
    t.favorable=Math.max(t.favorable,r);t.adverse=Math.max(t.adverse,-r);const f=s.frames[t.symbol];
    if(f&&f.at>t.lastRelationBar){const contrary=s.rules.some(a=>a.status==="EXPERIMENTAL"&&a.expiresAt>now&&a.side!==t.side&&a.horizon===t.rule.horizon&&ruleApplies(a,t.symbol)&&conditionMatches(f.x,a.conditions));
      t.relationFailureBars=contrary?t.relationFailureBars+1:0;t.lastRelationBar=f.at;}
    const elapsed=now-t.openedAt,reason=r<=-t.rule.stopRate?"保护止损：当前可执行价触及原始风险边界"
      :elapsed>=t.rule.horizon*60_000?"反应期限结束：按生成规则退出"
      :elapsed>=15*60_000&&t.relationFailureBars>=2?"关系变化：连续两根已收盘K线出现相反方向的新证据"
      :t.rule.exitMode==="REACTION_DECAY"&&elapsed>=5*60_000&&t.favorable>=t.rule.armRate&&t.favorable-r>=t.rule.givebackRate?"反应回吐：有利波动后触发生成的回吐边界":null;
    if(reason)closeTrade(s,t,q,now,reason);
  }s.positions=s.positions.filter(t=>t.status==="OPEN");
}
function openTrades(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,retry=false){
  const waiting=s.quoteRetries??[];
  const candidates=Object.values(s.frames).flatMap(f=>s.rules.filter(r=>r.status==="EXPERIMENTAL"&&r.createdAt<=now&&r.expiresAt>now
    &&f.at>=s.startedAt&&now-f.at<BAR_MS&&conditionMatches(f.x,r.conditions)
    &&(!retry||waiting.some(w=>w.ruleId===r.id&&w.symbol===f.symbol&&w.signalAt===f.at&&w.expiresAt>now)))
    .map(r=>({f,r}))).sort((a,b)=>(b.r.evidence?.quality??0)-(a.r.evidence?.quality??0)
      ||b.r.estimatedNetRate-a.r.estimatedNetRate||a.f.symbol.localeCompare(b.f.symbol));
  let blocker="";const diagnostics={at:now,matched:candidates.length,opened:0,reasons:{} as Record<string,number>,retry,queued:0};
  s.entryDiagnostics=diagnostics;s.relationEntries??={};s.quoteRetries=[];
  s.participation??={since:now,cycles:0,matches:0,quoteWaits:0,retryChecks:0,retryFills:0,opened:0};
  if(retry)s.participation.retryChecks++;else{s.participation.cycles++;s.participation.matches+=candidates.length;}
  const reject=(reason:string)=>{blocker=reason;diagnostics.reasons[reason]=(diagnostics.reasons[reason]??0)+1;};
  const readySymbols=(side:Trade["side"])=>new Set(candidates.filter(({f,r})=>r.side===side&&ruleApplies(r,f.symbol)
    &&!s.positions.some(t=>t.symbol===f.symbol)&&(s.lastEntryBars[f.symbol]??0)<f.at
    &&freshQuote(quotes[f.symbol],now)&&quotes[f.symbol].entryReady!==false).map(({f})=>f.symbol)).size;
  for(const{f,r}of candidates){
    if(s.positions.some(t=>t.symbol===f.symbol)||(s.lastEntryBars[f.symbol]??0)>=f.at)continue;
    if(!ruleApplies(r,f.symbol)){reject("规则为本币专用或当前币不在已观测样本范围内");continue;}
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
    const d=direction(r.side),price=(r.side==="LONG"?q.bestAsk:q.bestBid)*(1+d*PAPER_COST.slippageRate);
    // Discovery's raw positive-cost hypothesis is NOT a validated edge. The
    // bounded/calibrated estimate scores risk. Midpoint progression avoids
    // subtracting the entry slippage twice: it is in modeled cost already.
    const economics=entryEconomics(r,f.price,(q.bestBid+q.bestAsk)/2,spread);
    if(economics.contextInvalid){reject("入场前价格已明显偏离原观察条件，不把下跌自动当成便宜机会");continue;}
    if(economics.remaining<=0){reject("价差及入场前已发生的价格推进吃掉剩余优势");continue;}
    const gross=s.positions.reduce((a,t)=>a+t.notional,0),risk=s.positions.reduce((a,t)=>a+t.plannedRisk,0),same=s.positions.filter(t=>t.side===r.side).reduce((a,t)=>a+t.plannedRisk,0);
    const quality=Math.min(r.evidence!.quality,economics.quality,evidenceQuality(r.evidence!.rawNet,
      r.evidence!.boundedNet??r.evidence!.rawNet,r.standardError,r.evidence!.costRate,calibration.penalty));
    // Share existing capacity across simultaneously executable opportunities.
    // No new 3%-per-horizon veto; total and directional risk limits stay intact.
    const peers=Math.max(1,readySymbols(r.side));
    const targetRisk=Math.min(equity*.015*quality,Math.max(0,equity*.065-same)/peers);
    const lossRate=r.stopRate+Math.max(COST_FLOOR,r.evidence!.costRate)+spread;
    const desired=Math.min(equity*1.5,targetRisk/lossRate,Math.max(0,equity*4-gross)/peers);
    const immediateExit=(r.side==="LONG"?q.bestBid:q.bestAsk)*(1-d*PAPER_COST.slippageRate);
    const immediateCost=Math.max(r.evidence!.costRate,PAPER_COST.feeRate*(1+immediateExit/price)+d*(1-immediateExit/price));
    const wanted=Math.max(0,Math.min(desired,(equity*4-gross)/(1+4*immediateCost),
      targetRisk/(lossRate+.015*quality*immediateCost),
      (equity*.10-risk)/(lossRate+.10*immediateCost),
      (equity*.065-same)/(lossRate+.065*immediateCost)));
    if(wanted<equity*.05||wanted<desired*.25){reject("账户可用风险预算或有效仓位不足，不填碎片订单");continue;}
    const count=Math.floor(wanted/(price*meta.quantoMultiplier));if(count<Math.max(1,meta.minContracts??1)){reject("风险额度或最小张数不足");continue;}
    const quantity=count*meta.quantoMultiplier,notional=quantity*price;
    if(notional<equity*.05||notional<desired*.25){reject("整数张数后只剩碎片仓位，跳过而不放大风险");continue;}
    const usedMargin=s.positions.reduce((a,t)=>a+t.margin,0),markedAfter=equity-notional*immediateCost;
    const marginTarget=Math.min(equity*.2,Math.max(0,markedAfter*.75-usedMargin)/peers);
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
      forecast:{policy:EVIDENCE_POLICY,family,signalAt:f.at,signalPrice:f.price,baseNetRate:economics.remaining,
        calibratedNetRate:calibratedNet,remainingNetRate:economics.remaining,quality,sizingEquity:equity-notional*immediateCost}};
    s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=notional;s.positions.push(t);s.lastEntryBars[f.symbol]=f.at;
    s.relationEntries[episodeKey]=f.at+BAR_MS;diagnostics.opened++;s.participation.opened++;
    if(retry)s.participation.retryFills++;
    event(s,now,"ENTRY",t.id,`${f.symbol}按实验假设${r.id}使用新鲜买卖价模拟成交；不是Gate实盘成交。`,
      {ruleId:r.id,notional,contracts:count,remainingNet:economics.remaining,calibrationPenalty:calibration.penalty,quality,quoteRetry:Number(retry)});
  }
  for(const[key,until]of Object.entries(s.relationEntries))if(until<now)delete s.relationEntries[key];
  s.quoteRetries=[...new Map(s.quoteRetries.map(w=>[`${w.symbol}:${w.ruleId}:${w.signalAt}`,w])).values()].slice(0,90);
  diagnostics.queued=s.quoteRetries.length;
  if(diagnostics.opened)s.latestReason=`本轮${retry?"报价重试后":""}模拟开仓${diagnostics.opened}笔；管理${s.positions.length}笔持仓。`;
  else if(blocker)s.latestReason=blocker;else if(s.positions.length)s.latestReason=`管理${s.positions.length}笔前向模拟持仓；原始保护止损不会放宽。`;
}
export function advanceForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;quotes:Record<string,Quote>;contracts:Record<string,Contract>}){
  const{now,paths,quotes,contracts}=input,s=structuredClone(input.state),before=s.revision;
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
  // Wait for a bounded Top30 refresh after the completed 5-minute boundary.
  const dataDue=upgraded||!s.lastCycleAt||Math.floor((now-90_000)/BAR_MS)>Math.floor((s.lastCycleAt-90_000)/BAR_MS);
  // Exits at currently executable prices happen first. Their now-known results
  // can calibrate NEW entries immediately; no future closure enters learning.
  manage(s,quotes,now);s.feedback=collectFeedback(s.feedback??[],s.history,now);
  if(dataDue){ingest(s,paths,now);s.lastCycleAt=now;if(now-s.lastFitAt>=15*60_000)synthesizeRules(s,now);
    for(const r of s.rules)if(r.status==="EXPERIMENTAL"&&r.expiresAt<=now){r.status="DORMANT";event(s,now,"DORMANT",r.id,"证据过期，停止新开仓，等待新反应。");}}
  if(dataDue)openTrades(s,quotes,contracts,now);
  else if(s.quoteRetries?.some(w=>w.expiresAt>now))openTrades(s,quotes,contracts,now,true);
  else s.quoteRetries=[];
  const marked=forwardEquity(s,quotes,now);
  if(!marked.stalePositions){s.peakEquity=Math.max(s.peakEquity,marked.equity);s.maxDrawdown=Math.max(s.maxDrawdown,1-marked.equity/Math.max(s.peakEquity,1e-9));}
  if(dataDue){const k=dayKey(now),a=s.daily.find(d=>d.day===k);if(a){a.endEquity=marked.equity;a.lastAt=now;}else s.daily.push({day:k,firstAt:now,lastAt:now,startEquity:s.daily.at(-1)?.endEquity??s.initialEquity,endEquity:marked.equity,exactBoundary:false});s.daily=s.daily.slice(-400);}
  s.lastQuoteCycleAt=now;return{state:s,changed:dataDue||s.revision!==before};
}
export function forwardWatchSymbols(s:ForwardState,now:number){
  const matched=Object.values(s.frames).filter(f=>now-f.at<11*60_000&&s.rules.some(r=>r.status==="EXPERIMENTAL"&&r.expiresAt>now&&ruleApplies(r,f.symbol)&&conditionMatches(f.x,r.conditions)));
  return[...new Set([...s.positions.map(p=>p.symbol),...matched.map(f=>f.symbol)])];
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const marked=forwardEquity(s,quotes,now),count=Object.fromEntries(HORIZONS.map(h=>[h,s.samples.filter(r=>r.horizon===h).length]));
  return{version:s.version,grammar:FORWARD_GRAMMAR,mode:"REAL_FEED_PAPER",liveEligible:false,startedAt:s.startedAt,updatedAt:s.lastQuoteCycleAt,
    policyVersion:s.policyVersion??"legacy-forward-v1.0",policyUpgrade:s.policyUpgrade??null,policyUpgrades:s.policyUpgrades??[],
    participation:s.participation??null,quoteRetries:s.quoteRetries?.filter(w=>w.expiresAt>now)??[],
    evidenceDiagnostics:s.evidenceDiagnostics??null,entryDiagnostics:s.entryDiagnostics??null,feedbackCount:s.feedback?.length??0,
    lastCycleAt:s.lastCycleAt,lastFitAt:s.lastFitAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...marked,
    targetEquity:s.initialEquity*2,netPnl:marked.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,
    fees:s.fees,fundingAllowance:s.fundingAllowance,turnover:s.turnover,observations:s.observations,measured:s.measured,invalidated:s.invalidated,
    pending:Object.keys(s.pending).length,sampleCounts:count,fitDiagnostics:s.fitDiagnostics,rules:s.rules,positions:s.positions,history:s.history,
    events:s.events.slice(0,80),daily:s.daily,marketCount:s.selectedSymbols.length,markets:s.selectedSymbols,latestReason:s.latestReason,storage:s.storage,
    nextCycleAt:s.lastCycleAt?(Math.floor((s.lastCycleAt-90_000)/BAR_MS)+1)*BAR_MS+90_000:now,cost:PAPER_COST,
    boundaries:{scope:"PAPER_ONLY",grammar:"最多两个连续特征条件；方向、期限、止损和回吐退出由新市场反应生成",historyBackfill:false,
      sampleMeaning:"市场条件与后来反应；不是影子订单或连胜晋级",accounting:"新鲜买卖价模拟成交；净值包含退出费用与资金占位",
      risk:"单笔风险上限1.5%，置信信息用于0.5至1倍预算缩放；总风险10%，同向6.5%，总名义额4倍；当前可执行机会分配预算，不以少交易冒充改善",
      validation:"前向实验未证明盈利或月翻倍；多重规则筛选存在估计偏差",liquidation:"当前盘口保护，不冒充交易所标记价格强平复现"}};
}
