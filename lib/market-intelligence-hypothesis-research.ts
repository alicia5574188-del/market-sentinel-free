import type { EvidenceDirection, MarketBias, MarketEvidence, MarketIntelligenceState } from "./market-intelligence-engine.ts";

export const MARKET_HYPOTHESIS_RESEARCH_VERSION="market-hypothesis-research-v1";
export const MARKET_HYPOTHESIS_ACTIVE_LIMIT=12;
export const MARKET_HYPOTHESIS_RESOLVED_LIMIT=48;
export const MARKET_HYPOTHESIS_MEMORY_LIMIT=16;

export type MarketHypothesisKind=
  |"PULLBACK_AHEAD"
  |"REBOUND_AHEAD"
  |"ROTATION_AHEAD"
  |"TREND_EXPANSION_AHEAD"
  |"REVERSAL_AHEAD";
export type MarketHypothesisDirection="LONG"|"SHORT"|"MIXED";
export type MarketHypothesisStatus="FORMING"|"CONFIRMING"|"CONFIRMED";
export type MarketHypothesis={
  id:string;key:string;kind:MarketHypothesisKind;direction:MarketHypothesisDirection;status:MarketHypothesisStatus;
  confidence:number;startedAt:number;updatedAt:number;expiresAt:number;confirmedAt:number|null;
  horizonMinutes:[number,number,number];families:string[];evidenceTypes:string[];
  thesis:string;expectedNext:string[];invalidation:string;
};
export type ResolvedMarketHypothesis={
  id:string;key:string;kind:MarketHypothesisKind;direction:MarketHypothesisDirection;
  outcome:"CONFIRMED"|"INVALIDATED"|"EXPIRED";startedAt:number;resolvedAt:number;confidence:number;leadMinutes:number|null;
};
export type MarketHypothesisMemory={
  key:string;kind:MarketHypothesisKind;direction:MarketHypothesisDirection;observations:number;confirmed:number;invalidated:number;expired:number;
  averageLeadMinutes:number|null;lastAt:number;
};
export type MarketHypothesisResearchState={
  version:typeof MARKET_HYPOTHESIS_RESEARCH_VERSION;updatedAt:number;active:MarketHypothesis[];resolved:ResolvedMarketHypothesis[];
  memory:MarketHypothesisMemory[];summary:string;
};
export type EntryHypothesisGuidance={
  action:"SUPPORTED"|"NORMAL"|"CONFIRM_MORE";extendedConfirmation:boolean;supportConfidence:number;adverseConfidence:number;
  rotationConfidence:number;hypothesisIds:string[];reason:string;
};
export type PositionHypothesisGuidance={
  supportConfidence:number;adverseConfidence:number;confirmedAdverse:boolean;hypothesisIds:string[];reason:string;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const sideBias=(side:"LONG"|"SHORT"):MarketBias=>side==="LONG"?"BULLISH":"BEARISH";
const dirFromBias=(bias:MarketBias):MarketHypothesisDirection=>bias==="BULLISH"?"LONG":bias==="BEARISH"?"SHORT":"MIXED";
const opposite=(d:MarketHypothesisDirection)=>d==="LONG"?"SHORT":d==="SHORT"?"LONG":"MIXED";
const statusFor=(confidence:number,confirmedAt:number|null):MarketHypothesisStatus=>confirmedAt?"CONFIRMED":confidence>=.68?"CONFIRMING":"FORMING";
const keyOf=(kind:MarketHypothesisKind,direction:MarketHypothesisDirection)=>`${kind}:${direction}`;
const evidenceFresh=(row:MarketEvidence,now:number)=>row.expiresAt>now&&now-(row.lastAt??row.at)<=30*60_000;
const strength=(rows:MarketEvidence[],predicate:(row:MarketEvidence)=>boolean)=>rows.filter(predicate)
  .reduce((m,row)=>Math.max(m,clip(row.severity)*(.78+.22*Math.min(1,(row.samples??1)/8))),0);
const hasType=(rows:MarketEvidence[],type:string)=>strength(rows,row=>row.type===type);
const directional=(rows:MarketEvidence[],direction:EvidenceDirection,family?:string)=>strength(rows,row=>row.direction===direction&&(!family||row.family===family));
const familyList=(rows:MarketEvidence[],types:string[])=>[...new Set(rows.filter(row=>types.includes(row.type)).map(row=>row.family??"MARKET"))].slice(0,5);
const evidenceList=(rows:MarketEvidence[],types:string[])=>[...new Set(rows.filter(row=>types.includes(row.type)).map(row=>row.type))].slice(0,6);

export function initialMarketHypothesisResearch(now:number):MarketHypothesisResearchState{
  return{version:MARKET_HYPOTHESIS_RESEARCH_VERSION,updatedAt:now,active:[],resolved:[],memory:[],
    summary:"前瞻研究正在建立：把市场细节转成可验证的未来状态假设，而不是只描述当前状态。"};
}
export function normalizeMarketHypothesisResearch(value:unknown,now:number):MarketHypothesisResearchState{
  if(!value||typeof value!=="object")return initialMarketHypothesisResearch(now);
  const raw=value as Partial<MarketHypothesisResearchState>;
  if(raw.version!==MARKET_HYPOTHESIS_RESEARCH_VERSION)return initialMarketHypothesisResearch(now);
  const active=(Array.isArray(raw.active)?raw.active:[]).filter((h):h is MarketHypothesis=>!!h&&typeof h.id==="string"&&typeof h.key==="string"
      &&Number.isFinite(h.updatedAt)&&h.updatedAt>now-3*60*60_000)
    .sort((a,b)=>b.confidence-a.confidence||b.updatedAt-a.updatedAt).slice(0,MARKET_HYPOTHESIS_ACTIVE_LIMIT);
  const resolved=(Array.isArray(raw.resolved)?raw.resolved:[]).filter((h):h is ResolvedMarketHypothesis=>!!h&&typeof h.id==="string"&&Number.isFinite(h.resolvedAt))
    .sort((a,b)=>b.resolvedAt-a.resolvedAt).slice(0,MARKET_HYPOTHESIS_RESOLVED_LIMIT);
  const memory=(Array.isArray(raw.memory)?raw.memory:[]).filter((m):m is MarketHypothesisMemory=>!!m&&typeof m.key==="string"&&Number.isFinite(m.observations))
    .sort((a,b)=>b.lastAt-a.lastAt).slice(0,MARKET_HYPOTHESIS_MEMORY_LIMIT);
  return{version:MARKET_HYPOTHESIS_RESEARCH_VERSION,updatedAt:Number.isFinite(raw.updatedAt)?raw.updatedAt!:now,active,resolved,memory,
    summary:typeof raw.summary==="string"?raw.summary:"前瞻研究正在持续验证市场状态转移。"};
}

type Candidate=Omit<MarketHypothesis,"id"|"startedAt"|"updatedAt"|"expiresAt"|"confirmedAt"|"status">;
function candidate(kind:MarketHypothesisKind,direction:MarketHypothesisDirection,confidence:number,rows:MarketEvidence[],types:string[],
  thesis:string,expectedNext:string[],invalidation:string):Candidate|null{
  if(confidence<.42)return null;
  return{key:keyOf(kind,direction),kind,direction,confidence:clip(confidence),horizonMinutes:[5,15,30],
    families:familyList(rows,types),evidenceTypes:evidenceList(rows,types),thesis,expectedNext,invalidation};
}
function detectCandidates(market:MarketIntelligenceState,now:number){
  const rows=(market.evidence??[]).filter(row=>evidenceFresh(row,now)),i=market.internals,
    major=market.narrative.major.bias,short=market.narrative.short.bias,transition=market.narrative.transition,
    breadthDown=Math.max(hasType(rows,"BREADTH_CONTRACTION"),clip(-(i?.breadthSlope??0))),
    breadthUp=Math.max(hasType(rows,"BREADTH_EXPANSION"),clip(i?.breadthSlope??0)),
    leaderRotation=hasType(rows,"LEADERSHIP_ROTATION"),corrFalling=hasType(rows,"CORRELATION_FALLING"),
    corrRising=hasType(rows,"CORRELATION_RISING"),dispersion=hasType(rows,"DISPERSION_EXPANSION"),
    flowStalled=hasType(rows,"FLOW_ABSORBED_OR_STALLED"),flowBear=Math.max(directional(rows,"BEARISH","FLOW"),hasType(rows,"BID_LIQUIDITY_WITHDRAWAL")),
    flowBull=Math.max(directional(rows,"BULLISH","FLOW"),hasType(rows,"ASK_LIQUIDITY_WITHDRAWAL")),
    residualBear=directional(rows,"BEARISH","RELATIVE"),residualBull=directional(rows,"BULLISH","RELATIVE"),
    synchrony=clip(i?.synchrony??.5),leaderPersistence=clip(i?.leaderPersistence??.5),
    transitionConf=clip((transition.pressure??0)/60),out:Candidate[]=[];

  if(major==="BULLISH"){
    const c=.25*breadthDown+.18*leaderRotation+.16*flowBear+.12*residualBear+.10*flowStalled
      +.10*(transition.direction==="BEARISH"?transitionConf:0)+.09*(short==="BEARISH"?.9:short==="NEUTRAL"?.35:0);
    const types=["BREADTH_CONTRACTION","LEADERSHIP_ROTATION","FLOW_WITH_PRICE_PROGRESS","FLOW_ABSORBED_OR_STALLED",
      "BID_LIQUIDITY_WITHDRAWAL","RESIDUAL_DISTRIBUTION_SHIFT"];
    const h=candidate("PULLBACK_AHEAD","SHORT",c,rows,types,
      "大方向仍偏多，但上涨内部质量正在先于价格走弱，研究层预判回调/横盘风险正在抬升。",
      ["短周期广度继续收缩","弱势残差向更多资产扩散","卖方流动性/价格推动效率继续增强"],
      "若广度重新扩张、领导结构恢复稳定且买方推动重新有效，则回调假设失效。");if(h)out.push(h);
  }
  if(major==="BEARISH"){
    const c=.25*breadthUp+.18*leaderRotation+.16*flowBull+.12*residualBull+.10*flowStalled
      +.10*(transition.direction==="BULLISH"?transitionConf:0)+.09*(short==="BULLISH"?.9:short==="NEUTRAL"?.35:0);
    const types=["BREADTH_EXPANSION","LEADERSHIP_ROTATION","FLOW_WITH_PRICE_PROGRESS","FLOW_ABSORBED_OR_STALLED",
      "ASK_LIQUIDITY_WITHDRAWAL","RESIDUAL_DISTRIBUTION_SHIFT"];
    const h=candidate("REBOUND_AHEAD","LONG",c,rows,types,
      "大方向仍偏空，但下跌内部质量正在先于价格改善，研究层预判反弹/止跌风险正在抬升。",
      ["短周期广度继续改善","抗跌残差向更多资产扩散","买方承接开始推动价格"],
      "若广度再次恶化、弱势领导重新集中且卖方推动恢复，则反弹假设失效。");if(h)out.push(h);
  }

  {
    const c=.28*leaderRotation+.20*corrFalling+.18*dispersion+.16*flowStalled+.10*(1-leaderPersistence)+.08*(1-synchrony);
    const types=["LEADERSHIP_ROTATION","CORRELATION_FALLING","DISPERSION_EXPANSION","FLOW_ABSORBED_OR_STALLED"];
    const h=candidate("ROTATION_AHEAD","MIXED",c,rows,types,
      "领导权、相关性与推动效率同时松动，统一方向正在向轮动/震荡结构迁移。",
      ["强弱榜继续换位","相关组内部出现更多分裂","突破后的持续性下降、回归频率提高"],
      "若领导组重新稳定、相关性上升且同方向资金流持续推动价格，则轮动假设失效。");if(h)out.push(h);
  }

  const directionalBias=short!=="NEUTRAL"?short:transition.direction,trendDir=dirFromBias(directionalBias);
  if(trendDir!=="MIXED"){
    const aligned=trendDir==="LONG"?Math.max(breadthUp,residualBull,flowBull):Math.max(breadthDown,residualBear,flowBear),
      flow=trendDir==="LONG"?flowBull:flowBear,spread=trendDir==="LONG"?breadthUp:breadthDown,
      c=.24*spread+.20*flow+.14*(trendDir==="LONG"?residualBull:residualBear)+.14*corrRising+.16*leaderPersistence
        +.12*(transition.direction===sideBias(trendDir)?transitionConf:0);
    const types=["BREADTH_EXPANSION","BREADTH_CONTRACTION","FLOW_WITH_PRICE_PROGRESS","CORRELATION_RISING",
      "RESIDUAL_DISTRIBUTION_SHIFT"];
    const h=candidate("TREND_EXPANSION_AHEAD",trendDir,c,rows,types,
      `市场内部扩散、相关性和价格响应正在向${trendDir==="LONG"?"上行":"下行"}方向集中，研究层预判统一趋势有继续扩张的条件。`,
      ["同方向广度保持","领导组稳定并带动相关组跟随","跨所压力继续产生同方向价格推进"],
      "若广度反向、领导结构快速轮换或资金流被持续吸收，则趋势扩张假设失效。");if(h)out.push(h);
    void aligned;
  }

  if(major!=="NEUTRAL"&&transition.direction!=="NEUTRAL"&&transition.direction!==major){
    const d=dirFromBias(transition.direction),
      oppositeBreadth=d==="LONG"?breadthUp:breadthDown,oppositeResidual=d==="LONG"?residualBull:residualBear,
      oppositeFlow=d==="LONG"?flowBull:flowBear,
      c=.28*transitionConf+.20*oppositeBreadth+.16*oppositeResidual+.14*oppositeFlow+.12*leaderRotation+.10*flowStalled;
    const types=["BREADTH_EXPANSION","BREADTH_CONTRACTION","RESIDUAL_DISTRIBUTION_SHIFT","LEADERSHIP_ROTATION",
      "FLOW_WITH_PRICE_PROGRESS","FLOW_ABSORBED_OR_STALLED"];
    const h=candidate("REVERSAL_AHEAD",d,c,rows,types,
      `当前大方向尚未翻转，但多类内部证据正在向${d==="LONG"?"上":"下"}迁移，研究层开始建立真正转向而非普通回调的假设。`,
      ["反方向广度继续扩散","原领导结构继续瓦解","迁移压力由EARLY进入BUILDING/CONFIRMED"],
      "若原方向广度和领导结构恢复、迁移压力回落，则反转假设失效。");if(h)out.push(h);
  }
  return out;
}

function targetMet(h:MarketHypothesis,market:MarketIntelligenceState){
  const n=market.narrative,i=market.internals;
  if(h.kind==="PULLBACK_AHEAD")return n.major.bias==="BULLISH"&&(n.short.phase==="PULLBACK_BUILDING"||n.short.bias==="BEARISH");
  if(h.kind==="REBOUND_AHEAD")return n.major.bias==="BEARISH"&&(n.short.phase==="REBOUND_BUILDING"||n.short.bias==="BULLISH");
  if(h.kind==="ROTATION_AHEAD")return n.short.phase==="DIVERGING"||(i?.leaderPersistence??1)<.45||(i?.synchrony??1)<.55;
  if(h.kind==="TREND_EXPANSION_AHEAD"){
    const b=sideBias(h.direction==="SHORT"?"SHORT":"LONG");
    return n.short.bias===b&&((h.direction==="LONG"&&(i?.breadth3??0)>.20)||(h.direction==="SHORT"&&(i?.breadth3??0)<-.20))
      &&(i?.synchrony??0)>.58;
  }
  if(h.kind==="REVERSAL_AHEAD"){
    const b=sideBias(h.direction==="SHORT"?"SHORT":"LONG");
    return n.major.bias===b||(n.transition.direction===b&&(n.transition.pressure??0)>=55);
  }
  return false;
}
function invalidated(h:MarketHypothesis,market:MarketIntelligenceState){
  const n=market.narrative,i=market.internals;
  if(h.direction==="MIXED")return (i?.leaderPersistence??0)>.72&&(i?.synchrony??0)>.72&&Math.abs(n.short.score)>.28;
  const b=sideBias(h.direction),opp=b==="BULLISH"?"BEARISH":"BULLISH",slope=i?.breadthSlope??0;
  return n.short.bias===opp&&((h.direction==="LONG"&&slope<-.35)||(h.direction==="SHORT"&&slope>.35))
    &&n.transition.direction!==b;
}
function remember(memory:MarketHypothesisMemory[],row:ResolvedMarketHypothesis){
  const hit=memory.find(m=>m.key===row.key),lead=row.leadMinutes;
  if(hit){
    const priorConfirmed=hit.confirmed;hit.observations++;hit.lastAt=row.resolvedAt;
    if(row.outcome==="CONFIRMED")hit.confirmed++;else if(row.outcome==="INVALIDATED")hit.invalidated++;else hit.expired++;
    if(row.outcome==="CONFIRMED"&&lead!=null)hit.averageLeadMinutes=priorConfirmed>0&&hit.averageLeadMinutes!=null
      ?(hit.averageLeadMinutes*priorConfirmed+lead)/(priorConfirmed+1):lead;
    return;
  }
  memory.push({key:row.key,kind:row.kind,direction:row.direction,observations:1,confirmed:row.outcome==="CONFIRMED"?1:0,
    invalidated:row.outcome==="INVALIDATED"?1:0,expired:row.outcome==="EXPIRED"?1:0,
    averageLeadMinutes:row.outcome==="CONFIRMED"?lead:null,lastAt:row.resolvedAt});
}
export function advanceMarketHypothesisResearch(previous:MarketHypothesisResearchState|undefined,market:MarketIntelligenceState,now:number){
  const prior=normalizeMarketHypothesisResearch(previous,now),detected=detectCandidates(market,now),detectedByKey=new Map(detected.map(c=>[c.key,c])),
    next:MarketHypothesis[]=[],resolved=[...prior.resolved],memory=structuredClone(prior.memory);
  for(const old of prior.active){
    const fresh=detectedByKey.get(old.key),met=targetMet(old,market),bad=invalidated(old,market);
    if(bad){
      const row:ResolvedMarketHypothesis={id:old.id,key:old.key,kind:old.kind,direction:old.direction,outcome:"INVALIDATED",
        startedAt:old.startedAt,resolvedAt:now,confidence:old.confidence,leadMinutes:null};resolved.unshift(row);remember(memory,row);continue;
    }
    if(now>old.expiresAt&&!fresh){
      const outcome=old.confirmedAt?"CONFIRMED":"EXPIRED",row:ResolvedMarketHypothesis={id:old.id,key:old.key,kind:old.kind,direction:old.direction,
        outcome,startedAt:old.startedAt,resolvedAt:now,confidence:old.confidence,
        leadMinutes:old.confirmedAt?Math.max(0,(old.confirmedAt-old.startedAt)/60_000):null};
      resolved.unshift(row);remember(memory,row);continue;
    }
    const confidence=clip(fresh?old.confidence*.58+fresh.confidence*.42:old.confidence*.90),confirmedAt=old.confirmedAt??(met?now:null),
      source=fresh??old;
    next.push({...old,...source,confidence,updatedAt:now,expiresAt:now+45*60_000,confirmedAt,status:statusFor(confidence,confirmedAt)});
    detectedByKey.delete(old.key);
  }
  for(const c of detectedByKey.values()){
    const confirmed=targetMet({...c,id:"",startedAt:now,updatedAt:now,expiresAt:now+45*60_000,confirmedAt:null,status:"FORMING"},market)?now:null;
    next.push({...c,id:`fh-${now.toString(36)}-${c.kind.toLowerCase()}-${c.direction.toLowerCase()}`,
      startedAt:now,updatedAt:now,expiresAt:now+45*60_000,confirmedAt:confirmed,status:statusFor(c.confidence,confirmed)});
  }
  next.sort((a,b)=>b.confidence-a.confidence||b.updatedAt-a.updatedAt);
  resolved.sort((a,b)=>b.resolvedAt-a.resolvedAt);memory.sort((a,b)=>b.lastAt-a.lastAt);
  const active=next.slice(0,MARKET_HYPOTHESIS_ACTIVE_LIMIT),top=active[0],
    summary=top?`前瞻研究：${top.thesis} 当前置信 ${(top.confidence*100).toFixed(0)}%，状态 ${top.status}。`
      :"前瞻研究暂未发现足够集中的下一阶段状态转移证据。";
  return{version:MARKET_HYPOTHESIS_RESEARCH_VERSION,updatedAt:now,active,resolved:resolved.slice(0,MARKET_HYPOTHESIS_RESOLVED_LIMIT),
    memory:memory.slice(0,MARKET_HYPOTHESIS_MEMORY_LIMIT),summary} satisfies MarketHypothesisResearchState;
}

export function entryHypothesisGuidance(state:MarketHypothesisResearchState,input:{
  side:"LONG"|"SHORT";score:number;residualZ:number;residualPersistence:number;sourceCount:number;dataConfidence:number;
}):EntryHypothesisGuidance{
  const active=state.active.filter(h=>h.confidence>=.55),support=active.filter(h=>h.direction===input.side),
    adverse=active.filter(h=>h.direction===opposite(input.side)),rotation=active.filter(h=>h.kind==="ROTATION_AHEAD"),
    supportConfidence=support.reduce((m,h)=>Math.max(m,h.confidence),0),adverseConfidence=adverse.reduce((m,h)=>Math.max(m,h.confidence),0),
    rotationConfidence=rotation.reduce((m,h)=>Math.max(m,h.confidence),0),
    independent=input.score>=82&&input.residualPersistence>=.95&&input.sourceCount>=3&&input.dataConfidence>=78&&Math.abs(input.residualZ)>=.55,
    extendedConfirmation=!independent&&(adverseConfidence>=.68||(rotationConfidence>=.72&&input.score<88&&Math.abs(input.residualZ)<1.15)),
    action:EntryHypothesisGuidance["action"]=extendedConfirmation?"CONFIRM_MORE":supportConfidence>=.72&&adverseConfidence<.50?"SUPPORTED":"NORMAL",
    picked=[...support,...adverse,...rotation].sort((a,b)=>b.confidence-a.confidence).slice(0,3),
    reason=extendedConfirmation
      ?"前瞻研究发现与入场方向冲突的状态转移风险；不禁止机会，但要求更完整的实时延续证明。"
      :action==="SUPPORTED"?"前瞻研究与入场方向一致；沿用原大赢家捕获链，不增加额外门槛。"
      :independent?"该机会具备高质量独立优势；前瞻研究只作上下文，不削弱原大赢家快速通道。"
      :"前瞻研究暂无足够强的支持或反对证据，沿用原实时响应确认。";
  return{action,extendedConfirmation,supportConfidence,adverseConfidence,rotationConfidence,hypothesisIds:picked.map(h=>h.id),reason};
}

export function positionHypothesisGuidance(state:MarketHypothesisResearchState,side:"LONG"|"SHORT"):PositionHypothesisGuidance{
  const active=state.active.filter(h=>h.confidence>=.55),support=active.filter(h=>h.direction===side),
    adverse=active.filter(h=>h.direction===opposite(side)),supportConfidence=support.reduce((m,h)=>Math.max(m,h.confidence),0),
    adverseConfidence=adverse.reduce((m,h)=>Math.max(m,h.confidence),0),confirmedAdverse=adverse.some(h=>h.status==="CONFIRMED"&&h.confidence>=.68),
    picked=[...support,...adverse].sort((a,b)=>b.confidence-a.confidence).slice(0,3),
    reason=confirmedAdverse?"前瞻研究已确认与持仓方向相反的状态转移；它只能加强保护/复核，不能单独强制平仓。"
      :supportConfidence>=.68?"前瞻研究仍支持持仓方向，可给健康赢家保留尾部空间。":"前瞻研究暂不对该仓位形成决定性上下文。";
  return{supportConfidence,adverseConfidence,confirmedAdverse,hypothesisIds:picked.map(h=>h.id),reason};
}
