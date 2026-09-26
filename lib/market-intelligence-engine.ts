/**
 * Market Intelligence V1
 *
 * Strategy authority comes from whole-market relationships, not an indicator checklist.
 * L0 macro cycle -> L1 broad direction -> L2 short transition -> L3 relative opportunity.
 * Only causal completed candles and fresh multi-venue consensus are used.
 */
export const MARKET_INTELLIGENCE_VERSION="market-intelligence-v1";

export type CandleLike={time:number;open:number;high:number;low:number;close:number;volume:number};
export type QuoteLike={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean;
  sourceCount?:number;disagreementRate?:number;sourceBreadth?:number;directionalAgreement?:number;medianShortMove?:number};
export type MarketBias="BULLISH"|"BEARISH"|"NEUTRAL";
export type MacroPhase="BULL_EXPANSION"|"BEAR_CONTRACTION"|"RECOVERY_UNCONFIRMED"|"DISTRIBUTION_RISK"|"BASE_BUILDING"|"UNCERTAIN";
export type ShortPhase="ADVANCING"|"PULLBACK_BUILDING"|"DECLINING"|"REBOUND_BUILDING"|"DIVERGING"|"BALANCED";
export type MarketRegime="MARKET_TREND"|"DIVERGENT"|"TRANSITION"|"BALANCED";
export type EvidenceDirection="BULLISH"|"BEARISH"|"MIXED";
export type EvidenceFamily="BREADTH"|"LEADERSHIP"|"RELATIVE"|"FLOW"|"CORRELATION";
export type EvidenceTrend="STRENGTHENING"|"WEAKENING"|"STABLE";

export type MarketEvidence={id:string;at:number;type:string;direction:EvidenceDirection;severity:number;summary:string;
  symbols:string[];sourceCount:number;expiresAt:number;family?:EvidenceFamily;firstAt?:number;lastAt?:number;samples?:number;trend?:EvidenceTrend};
export type NarrativeLayer={bias:MarketBias;score:number;confidence:number;ageMs:number;label:string;detail:string};
export type MarketNarrative={id:string;updatedAt:number;macro:NarrativeLayer&{phase:MacroPhase};major:NarrativeLayer;
  short:NarrativeLayer&{phase:ShortPhase};transition:{direction:MarketBias;pressure:number;confidence:number;detail:string;
    score?:number;stage?:"STABLE"|"EARLY"|"BUILDING"|"CONFIRMED";drivers?:string[]};
  tailRisk:{level:"LOW"|"MEDIUM"|"HIGH";score:number;detail:string};summary:string;plan:string;details:string[];
  expectedShortMinutes:[number,number]};
export type MarketSymbolState={symbol:string;watchScore:number;regime:MarketRegime;stage:"OBSERVE"|"READY";
  clusterId:string;correlation:number;beta:number;volatility:number;dataConfidence:number;actualMove:number;expectedMove:number;
  residual:number;residualZ:number;residualPersistence:number;relativeStrength:number;longScore:number;shortScore:number;
  pathLong:number;pathShort:number;roomLong:number;roomShort:number;sourceCount:number;venueAgreement:number;venuePressure:number;reasons:string[];
  signalSide:"LONG"|"SHORT";signalSince:number;signalBars:number;signalLastBar:number};
export type MarketCluster={id:string;leader:string;members:string[];averageCorrelation:number};
export type MarketInternals={breadth3:number;breadth12:number;breadthSlope:number;dispersion:number;synchrony:number;
  venuePressure:number;residualBalance:number;leaderPersistence:number};
export type MarketIntelligenceState={version:string;startedAt:number;updatedAt:number;narrative:MarketNarrative;
  evidence:MarketEvidence[];history:Array<{at:number;macro:MarketBias;major:MarketBias;short:MarketBias;summary:string}>;
  symbols:Record<string,MarketSymbolState>;clusters:MarketCluster[];
  coverage:{intradayMarkets:number;dailyMarkets:number;quoteMarkets:number;multiVenueMarkets:number};internals?:MarketInternals};

export type IntelligenceOpportunity={
  id:string;symbol:string;side:"LONG"|"SHORT";mode:"RELATIVE"|"REVERSAL"|"CONTINUATION";premium:boolean;reserve?:boolean;
  score:number;eligible:boolean;completedAt:number;expiresAt:number;price:number;stopPrice:number;targetPrice:number;stopRate:number;
  targetRate:number;directionStrength:number;pathEfficiency:number;momentumPersistence:number;positionScore:number;spaceScore:number;
  executionScore:number;grossRemainingSpaceRate:number;netRemainingSpaceRate:number;pullbackRiskRate:number;edgeRatio:number;
  expectedHoldMinutes:number;marketFit:number;regionId:null;regionQuality:null;reason:string;strategyVersion:string;regime:MarketRegime;
  confirmationStage:"OBSERVE"|"READY";sourceCount:number;disagreementRate:number;clusterId:string;thesisId:string;thesisSummary:string;
  invalidationSummary:string;residual:number;relativeStrength:number;dataConfidence:number;thesisSince:number;thesisBars:number;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(xs:number[])=>{const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;};
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const stdev=(xs:number[])=>{if(xs.length<2)return 0;const m=mean(xs);return Math.sqrt(mean(xs.map(x=>(x-m)**2)));};
const corr=(a:number[],b:number[])=>{const n=Math.min(a.length,b.length);if(n<6)return 0;const x=a.slice(-n),y=b.slice(-n),mx=mean(x),my=mean(y);
  const sx=Math.sqrt(x.reduce((s,v)=>s+(v-mx)**2,0)),sy=Math.sqrt(y.reduce((s,v)=>s+(v-my)**2,0));
  if(!(sx>0&&sy>0))return 0;return clip(x.reduce((s,v,i)=>s+(v-mx)*(y[i]!-my),0)/(sx*sy),-1,1);};
const beta=(a:number[],b:number[])=>{const n=Math.min(a.length,b.length);if(n<6)return 1;const x=a.slice(-n),y=b.slice(-n),mx=mean(x),my=mean(y);
  const den=y.reduce((s,v)=>s+(v-my)**2,0);if(!(den>1e-16))return 1;return clip(x.reduce((s,v,i)=>s+(v-mx)*(y[i]!-my),0)/den,-3,3);};
const ret=(rows:CandleLike[],bars:number)=>rows.length>bars&&rows.at(-1)!.close>0?rows.at(-1)!.close/rows[rows.length-1-bars]!.close-1:0;
const returns=(rows:CandleLike[],count=36)=>{const tail=rows.slice(-(count+1)),out:number[]=[];for(let i=1;i<tail.length;i++)if(tail[i-1]!.close>0)out.push(tail[i]!.close/tail[i-1]!.close-1);return out;};
const marketBias=(score:number,threshold=.22):MarketBias=>score>threshold?"BULLISH":score<-threshold?"BEARISH":"NEUTRAL";
function stableBias(score:number,previous:MarketBias|undefined,enter:number,release:number,flip:number):MarketBias{
  if(!previous||previous==="NEUTRAL")return score>enter?"BULLISH":score<-enter?"BEARISH":"NEUTRAL";
  if(previous==="BULLISH"){if(score<=-flip)return"BEARISH";if(score<=-release)return"NEUTRAL";return"BULLISH";}
  if(score>=flip)return"BULLISH";if(score>=release)return"NEUTRAL";return"BEARISH";
}
const biasZh=(b:MarketBias)=>b==="BULLISH"?"偏多":b==="BEARISH"?"偏空":"中性";
const fmtPct=(v:number)=>`${v>=0?"+":""}${(v*100).toFixed(2)}%`;

function valid(rows:CandleLike[]|undefined,now:number,seconds:number){
  const a=(rows??[]).filter(r=>r.time>0&&r.open>0&&r.close>0&&r.low>0&&r.high>=Math.max(r.open,r.close)
    &&r.low<=Math.min(r.open,r.close)&&r.volume>=0&&r.time*1000+seconds*1000<=now).sort((x,y)=>x.time-y.time);
  return a.slice(-160);
}
function marketFactor(series:Record<string,number[]>,count=36){
  const values=Object.values(series),out:number[]=[];if(!values.length)return out;
  const n=Math.min(count,...values.map(v=>v.length));for(let back=n;back>=1;back--)out.push(median(values.map(v=>v[v.length-back]!).filter(Number.isFinite)));
  return out;
}
function breadthFor(paths:Record<string,CandleLike[]>,bars:number){const moves=Object.values(paths).filter(r=>r.length>bars).map(r=>ret(r,bars));
  return moves.length?2*(moves.filter(v=>v>0).length/moves.length)-1:0;}
function smoothed(previous:number|undefined,raw:number,alpha:number){return Number.isFinite(previous)?previous!*(1-alpha)+raw*alpha:raw;}
function layerAge(previous:NarrativeLayer|undefined,nextBias:MarketBias,now:number,previousAt:number){
  return previous&&previous.bias===nextBias?Math.max(0,(previous.ageMs??0)+(now-previousAt)):0;}
function layer(label:string,rawScore:number,previous:NarrativeLayer|undefined,now:number,previousAt:number,alpha:number,detail:string,
  stability:"MACRO"|"MAJOR"|"SHORT"):NarrativeLayer{
  const score=clip(smoothed(previous?.score,rawScore,alpha),-1,1),
    params=stability==="MACRO"?{enter:.34,release:.16,flip:.52}:stability==="MAJOR"?{enter:.28,release:.12,flip:.42}:{enter:.24,release:.07,flip:.36},
    b=stableBias(score,previous?.bias,params.enter,params.release,params.flip);
  return{bias:b,score,confidence:clip(Math.abs(score)*.72+.18,.18,.96),ageMs:layerAge(previous,b,now,previousAt),label,detail};}
function macroPhase(score:number,breadth:number,dispersion:number):MacroPhase{
  if(score>.36&&breadth>.12)return"BULL_EXPANSION";if(score<-.36&&breadth<-.12)return"BEAR_CONTRACTION";
  if(score>.08&&breadth>-0.05)return"RECOVERY_UNCONFIRMED";if(score<-.08&&breadth<.08)return"BASE_BUILDING";
  if(dispersion>.8&&score>.05)return"DISTRIBUTION_RISK";return"UNCERTAIN";}
function shortPhase(major:number,short:number,dispersion:number):ShortPhase{
  if(short>.28&&major>=-.05)return"ADVANCING";if(short<-.28&&major<=.05)return"DECLINING";
  if(major>.16&&short<-.10)return"PULLBACK_BUILDING";if(major<-.16&&short>.10)return"REBOUND_BUILDING";
  if(dispersion>.72)return"DIVERGING";return"BALANCED";}
function evidenceFamily(type:string):EvidenceFamily{
  if(type.includes("BREADTH"))return"BREADTH";if(type.includes("LEADER"))return"LEADERSHIP";
  if(type.includes("RESIDUAL"))return"RELATIVE";if(type.includes("VENUE")||type.includes("FLOW"))return"FLOW";return"CORRELATION";
}
function mkEvidence(id:string,now:number,type:string,direction:EvidenceDirection,severity:number,summary:string,symbols:string[]=[],sourceCount=0):MarketEvidence{
  return{id,at:now,type,direction,severity:clip(severity),summary,symbols,sourceCount,expiresAt:now+45*60_000,
    family:evidenceFamily(type),firstAt:now,lastAt:now,samples:1,trend:"STABLE"};}
function addEvidence(rows:MarketEvidence[],row:MarketEvidence){
  const family=row.family??evidenceFamily(row.type),keySymbols=[...row.symbols].sort().join(","),
    same=rows.find(x=>(x.family??evidenceFamily(x.type))===family&&x.type===row.type&&[...x.symbols].sort().join(",")===keySymbols
      &&row.at-(x.lastAt??x.at)<15*60_000);
  if(!same){rows.unshift(row);return;}
  const prior=same.severity,delta=row.severity-prior;
  same.at=row.at;same.lastAt=row.at;same.firstAt??=same.at;same.samples=(same.samples??1)+1;
  same.trend=delta>.08?"STRENGTHENING":delta<-.08?"WEAKENING":"STABLE";
  same.severity=clip(prior*.72+row.severity*.28);same.summary=row.summary;same.sourceCount=Math.max(same.sourceCount,row.sourceCount);
  same.expiresAt=row.expiresAt;same.family=family;
}

export function initialMarketIntelligenceState(now:number):MarketIntelligenceState{
  const narrative:MarketNarrative={id:`mi-${now.toString(36)}`,updatedAt:now,
    macro:{bias:"NEUTRAL",score:0,confidence:.2,ageMs:0,label:"超大周期",detail:"等待足够的长期市场数据。",phase:"UNCERTAIN"},
    major:{bias:"NEUTRAL",score:0,confidence:.2,ageMs:0,label:"大方向",detail:"等待全市场共同方向。"},
    short:{bias:"NEUTRAL",score:0,confidence:.2,ageMs:0,label:"短期优势",detail:"等待市场内部变化。",phase:"BALANCED"},
    transition:{direction:"NEUTRAL",pressure:0,confidence:.2,detail:"尚未形成明确的状态转移压力。"},
    tailRisk:{level:"LOW",score:15,detail:"暂无足够证据显示系统性尾部风险正在抬升。"},
    summary:"市场智能正在建立全市场基线。",plan:"先观察全市场关系，不因单一币或单一交易所变化下结论。",details:[],expectedShortMinutes:[30,120]};
  return{version:MARKET_INTELLIGENCE_VERSION,startedAt:now,updatedAt:now,narrative,evidence:[],history:[],symbols:{},clusters:[],
    coverage:{intradayMarkets:0,dailyMarkets:0,quoteMarkets:0,multiVenueMarkets:0},
    internals:{breadth3:0,breadth12:0,breadthSlope:0,dispersion:0,synchrony:0,venuePressure:0,residualBalance:0,leaderPersistence:1}};}

export function buildMarketIntelligence(input:{paths:Record<string,CandleLike[]>;minutePaths?:Record<string,CandleLike[]>;
  daily?:Record<string,CandleLike[]>;quotes:Record<string,QuoteLike>;previous?:MarketIntelligenceState;now:number;allowed?:Set<string>}){
  const previous=input.previous?.version===MARKET_INTELLIGENCE_VERSION?input.previous:initialMarketIntelligenceState(input.now),paths:Record<string,CandleLike[]>={};
  for(const [symbol,rows] of Object.entries(input.paths)){if(input.allowed&&!input.allowed.has(symbol))continue;const v=valid(rows,input.now,300);if(v.length>=30)paths[symbol]=v;}
  const retSeries:Record<string,number[]>={};for(const [s,r] of Object.entries(paths))retSeries[s]=returns(r,36);
  const factor=marketFactor(retSeries,36),factor6=factor.slice(-6).reduce((p,v)=>p+v,0),factor12=factor.slice(-12).reduce((p,v)=>p+v,0),
    volFactor=Math.max(.00035,stdev(factor));
  const breadth3=breadthFor(paths,3),breadth12=breadthFor(paths,12),breadthSlope=clip((breadth3-breadth12)/1.2,-1,1);

  const dailyPaths:Record<string,CandleLike[]>={};for(const [s,rows] of Object.entries(input.daily??{})){const v=valid(rows,input.now,86400);if(v.length>=18)dailyPaths[s]=v;}
  const macroMoves=Object.values(dailyPaths).map(r=>{const n=Math.min(30,r.length-1),r7=ret(r,Math.min(7,r.length-1)),r30=ret(r,n),vol=Math.max(.005,stdev(returns(r,n)));return{r7,r30,vol,n};}),
    macroReady=macroMoves.length>=3,
    macroRaw=macroReady?clip(median(macroMoves.map(x=>.45*x.r7/(x.vol*Math.sqrt(7))+.55*x.r30/(x.vol*Math.sqrt(x.n))))/3,-1,1):0,
    macroBreadth=macroReady?2*(macroMoves.filter(x=>x.r30>0).length/macroMoves.length)-1:0;

  type Provisional=Omit<MarketSymbolState,"clusterId"|"watchScore"|"regime"|"stage"|"longScore"|"shortScore"|"reasons"|"signalSide"|"signalSince"|"signalBars"|"signalLastBar">;
  const provisional:Record<string,Provisional>={},residualZs:number[]=[];
  for(const [symbol,rows] of Object.entries(paths)){
    const series=retSeries[symbol]??[],c=corr(series,factor),b=beta(series,factor),actual=ret(rows,6),expected=b*factor6,residual=actual-expected,
      vol=Math.max(.0004,stdev(series)),z=clip(residual/(vol*Math.sqrt(6)+1e-9),-3,3),r3=ret(rows,3),r12=ret(rows,12),
      exp3=b*factor.slice(-3).reduce((p,v)=>p+v,0),exp12=b*factor12,res3=r3-exp3,res12=r12-exp12,
      persistence=clip([res3,residual,res12].filter(v=>Math.sign(v)===Math.sign(residual)&&Math.abs(v)>.15*vol).length/3),
      q=input.quotes[symbol],sourceCount=Math.max(0,q?.sourceCount??0),venueAgreement=clip(q?.directionalAgreement??.5),
      venuePressure=clip((q?.sourceBreadth??0)*.55+Math.sign(q?.medianShortMove??0)*Math.min(1,Math.abs(q?.medianShortMove??0)/(vol*1.5))*.45,-1,1),
      dataConfidence=clip((.36+.10*Math.min(4,sourceCount)+.20*Math.abs(c)+.18*venueAgreement-.25*Math.min(.01,q?.disagreementRate??0)/.01)*100,10,100),
      tail=rows.slice(-24),hi=Math.max(...tail.map(x=>x.high)),lo=Math.min(...tail.map(x=>x.low)),last=rows.at(-1)!.close,
      roomLong=Math.max(vol*2.5,(hi-last)/last+vol),roomShort=Math.max(vol*2.5,(last-lo)/last+vol),
      pos=series.slice(-8),pathLong=clip(.5+.5*(pos.filter(v=>v>0).length-pos.filter(v=>v<0).length)/Math.max(1,pos.length)),pathShort=1-pathLong,
      relativeStrength=clip(.5+z/6);
    residualZs.push(z);provisional[symbol]={symbol,correlation:c,beta:b,volatility:vol,dataConfidence,actualMove:actual,expectedMove:expected,residual,residualZ:z,
      residualPersistence:persistence,relativeStrength,pathLong,pathShort,roomLong,roomShort,sourceCount,venueAgreement,venuePressure};}

  const dispersion=clip(stdev(residualZs)/1.35,0,1.5),synchrony=median(Object.values(provisional).map(x=>Math.max(0,x.correlation))),
    venuePressureMarket=median(Object.values(provisional).filter(x=>x.sourceCount>=2).map(x=>x.venuePressure)),
    strongPositive=residualZs.filter(x=>x>.45).length,strongNegative=residualZs.filter(x=>x<-.45).length,
    residualBalance=residualZs.length?(strongPositive-strongNegative)/residualZs.length:0,
    previousInternals=previous.internals??{breadth3:0,breadth12:0,breadthSlope:0,dispersion:0,synchrony:0,venuePressure:0,residualBalance:0,leaderPersistence:1},
    majorRaw=clip(factor12/(volFactor*Math.sqrt(12)+1e-9)/2.8*.55+breadth12*.30+venuePressureMarket*.15,-1,1),
    shortRaw=clip(factor6/(volFactor*Math.sqrt(6)+1e-9)/2.5*.42+breadth3*.25+breadthSlope*.18+venuePressureMarket*.15,-1,1);

  const prevN=previous.narrative,macroBase=layer("超大周期",macroRaw,prevN.macro,input.now,previous.updatedAt,.04,"慢速周期判断","MACRO"),
    major=layer("大方向",majorRaw,prevN.major,input.now,previous.updatedAt,.10,"数小时共同方向","MAJOR"),
    short=layer("短期优势",shortRaw,prevN.short,input.now,previous.updatedAt,.30,"市场内部短期变化","SHORT"),
    phase:MacroPhase=macroReady?macroPhase(macroBase.score,macroBreadth,dispersion):"UNCERTAIN",sphase=shortPhase(major.score,short.score,dispersion),
    macro={...macroBase,phase},shortLayer={...short,phase:sphase};

  const breadthDelta=breadth3-previousInternals.breadth3,residualDelta=residualBalance-previousInternals.residualBalance,
    syncDelta=synchrony-previousInternals.synchrony,dispersionDelta=dispersion-previousInternals.dispersion,
    marketProgress=factor6/(volFactor*Math.sqrt(6)+1e-9),
    flowResponse=venuePressureMarket===0?0:clip(marketProgress/(Math.abs(venuePressureMarket)+.15),-1,1),
    rawTransition=clip((short.score-major.score)*.34+breadthDelta*.22+residualDelta*.20+venuePressureMarket*.10
      -Math.sign(major.score||1)*Math.max(0,dispersionDelta)*.08+syncDelta*.06,-1,1),
    priorTransition=(prevN.transition as MarketNarrative["transition"]&{score?:number}).score??0,
    transitionScore=clip(priorTransition*.72+rawTransition*.28,-1,1),
    transitionDirection=stableBias(transitionScore,prevN.transition.direction,.18,.06,.38),
    transitionPressure=Math.abs(transitionScore)*100,
    transitionStage:NonNullable<MarketNarrative["transition"]["stage"]>=transitionDirection==="NEUTRAL"||transitionPressure<18?"STABLE"
      :transitionPressure<34?"EARLY":transitionPressure<55?"BUILDING":"CONFIRMED",
    tailScore=clip(18+Math.max(0,-macro.score)*30+Math.max(0,-major.score)*18+dispersion*18+Math.max(0,-venuePressureMarket)*12+(synchrony>.72&&short.score<-.2?15:0),0,100),
    tailLevel=tailScore>=68?"HIGH":tailScore>=38?"MEDIUM":"LOW";

  const states:Record<string,MarketSymbolState>={};
  for(const [symbol,p] of Object.entries(provisional)){
    const market=p.venuePressure*.08+(short.score*.55+major.score*.30+macro.score*.15)*.92,
      longScore=clip(50+18*p.residualZ+13*p.residualPersistence*(p.residual>=0?1:-1)+12*market+5*(p.pathLong-.5)*2,0,100),
      shortScore=clip(50-18*p.residualZ-13*p.residualPersistence*(p.residual>=0?1:-1)-12*market+5*(p.pathShort-.5)*2,0,100),
      signalSide:"LONG"|"SHORT"=longScore>=shortScore?"LONG":"SHORT",
      signalLastBar=(paths[symbol]?.at(-1)?.time??Math.floor(input.now/1000))*1000+300_000,
      prior=previous.symbols[symbol],sameEpisode=prior?.signalSide===signalSide,
      sameCompletedBar=sameEpisode&&prior?.signalLastBar===signalLastBar,
      signalBars=sameEpisode?Math.max(1,(prior?.signalBars??1)+(sameCompletedBar?0:1)):1,
      signalSince=sameEpisode?(prior?.signalSince??signalLastBar):signalLastBar;
    states[symbol]={...p,clusterId:"",watchScore:Math.max(longScore,shortScore),regime:"BALANCED",stage:"OBSERVE",longScore,shortScore,reasons:[],
      signalSide,signalSince,signalBars,signalLastBar};}

  const directionForLeaders=major.score>=0?1:-1,
    currentLeaders=[...Object.values(states)].sort((a,b)=>directionForLeaders*(b.residualZ-a.residualZ)).slice(0,5).map(x=>x.symbol),
    priorLeaders=[...Object.values(previous.symbols??{})].sort((a,b)=>directionForLeaders*(b.residualZ-a.residualZ)).slice(0,5).map(x=>x.symbol),
    leaderPersistence=priorLeaders.length?currentLeaders.filter(x=>priorLeaders.includes(x)).length/Math.min(5,priorLeaders.length):1,
    ordered=Object.values(states).sort((a,b)=>b.dataConfidence-a.dataConfidence||a.symbol.localeCompare(b.symbol)),clusters:MarketCluster[]=[];
  for(const row of ordered){let chosen:MarketCluster|undefined,bestCorr=.72;for(const c of clusters){const r=corr(retSeries[row.symbol]??[],retSeries[c.leader]??[]);
      if(r>bestCorr){chosen=c;bestCorr=r;}}if(!chosen){chosen={id:`corr:${row.symbol}`,leader:row.symbol,members:[],averageCorrelation:1};clusters.push(chosen);}
    chosen.members.push(row.symbol);row.clusterId=chosen.id;}
  for(const c of clusters)c.averageCorrelation=mean(c.members.map(s=>corr(retSeries[s]??[],retSeries[c.leader]??[])));

  const evidenceRows=(previous.evidence??[]).filter(x=>x.expiresAt>input.now).slice(0,40);
  if(breadthSlope<-.22)addEvidence(evidenceRows,mkEvidence("breadth-down-"+input.now,input.now,"BREADTH_CONTRACTION","BEARISH",Math.abs(breadthSlope),
    `市场参与度正在收缩：短周期广度比慢广度低 ${Math.abs(breadthSlope*100).toFixed(0)} 个强度点。`));
  if(breadthSlope>.22)addEvidence(evidenceRows,mkEvidence("breadth-up-"+input.now,input.now,"BREADTH_EXPANSION","BULLISH",breadthSlope,
    "市场参与度正在扩散，更多资产开始加入当前短期移动。"));
  if(dispersion>.62)addEvidence(evidenceRows,mkEvidence("disp-"+input.now,input.now,"DISPERSION_EXPANSION","MIXED",clip(dispersion/1.2),
    "市场内部差异扩大，统一行情正在让位于更强的个体分化。"));
  if(Math.abs(syncDelta)>.12)addEvidence(evidenceRows,mkEvidence("corr-"+input.now,input.now,syncDelta>0?"CORRELATION_RISING":"CORRELATION_FALLING","MIXED",clip(Math.abs(syncDelta)*2.5),
    syncDelta>0?"资产同步性明显上升，局部风险更容易传播成全市场变化。":"资产同步性下降，市场正在从统一方向转向分化/轮动。"));
  if(leaderPersistence<.45&&priorLeaders.length>=3)addEvidence(evidenceRows,mkEvidence("leader-"+input.now,input.now,"LEADERSHIP_ROTATION","MIXED",clip(1-leaderPersistence),
    `原领先组保留率仅 ${(leaderPersistence*100).toFixed(0)}%，领导结构正在轮换。`,currentLeaders));
  if(Math.abs(residualDelta)>.16)addEvidence(evidenceRows,mkEvidence("res-balance-"+input.now,input.now,"RESIDUAL_DISTRIBUTION_SHIFT",residualDelta>0?"BULLISH":"BEARISH",clip(Math.abs(residualDelta)*2),
    `全市场强弱残差分布发生迁移，净变化 ${(residualDelta*100).toFixed(0)} 个百分点。`));
  if(Math.abs(venuePressureMarket)>.22){
    const aligned=Math.sign(venuePressureMarket)===Math.sign(marketProgress),progressEnough=Math.abs(marketProgress)>.18;
    addEvidence(evidenceRows,mkEvidence("flow-"+input.now,input.now,aligned&&progressEnough?"FLOW_WITH_PRICE_PROGRESS":"FLOW_ABSORBED_OR_STALLED",
      aligned&&progressEnough?(venuePressureMarket>0?"BULLISH":"BEARISH"):"MIXED",clip(Math.abs(venuePressureMarket)),
      aligned&&progressEnough?"跨所短时压力正在得到价格响应，推动仍有效。":"跨所短时压力与价格推进不匹配，出现吸收/推动效率下降迹象。",
      [],Math.round(median(Object.values(states).map(x=>x.sourceCount)))));
  }

  for(const row of [...Object.values(states)].sort((a,b)=>Math.abs(b.residualZ)*b.residualPersistence-Math.abs(a.residualZ)*a.residualPersistence).slice(0,5)){
    if(Math.abs(row.residualZ)<.75||row.residualPersistence<.55)continue;const d:EvidenceDirection=row.residualZ>0?"BULLISH":"BEARISH";
    addEvidence(evidenceRows,mkEvidence("res-"+row.symbol+"-"+input.now,input.now,row.residualZ>0?"PERSISTENT_POSITIVE_RESIDUAL":"PERSISTENT_NEGATIVE_RESIDUAL",d,
      clip(Math.abs(row.residualZ)/2),`${row.symbol.replace("_USDT","")} 持续${row.residualZ>0?"强于":"弱于"}其相关市场理论路径，偏离约 ${fmtPct(row.residual)}。`,[row.symbol],row.sourceCount));}

  macro.detail=!macroReady?`超大周期日线覆盖 ${macroMoves.length} 个市场，仍在建立长期基线；不会用分钟级走势代替牛熊判断。`
    :phase==="BULL_EXPANSION"?"长期市场结构更接近扩张阶段，但仍持续检查高相关风险和二次探底证据。"
    :phase==="BEAR_CONTRACTION"?"长期市场结构仍偏收缩，任何上涨都需要区分真正修复与熊市反弹。"
    :phase==="RECOVERY_UNCONFIRMED"?"长期修复正在形成，但底部尚不能视为完全确认，仍保留二次探底假设。"
    :phase==="BASE_BUILDING"?"市场更像在低位修复/筑底，尚没有足够广度确认完整牛市。"
    :phase==="DISTRIBUTION_RISK"?"长期价格仍不弱，但内部高度分化，顶部/分配风险需要持续观察。":"超大周期证据相互冲突，暂不强行归类牛熊阶段。";
  major.detail=`全市场数小时共同方向${biasZh(major.bias)}；同步度 ${(synchrony*100).toFixed(0)}%，广度 ${(breadth12*100).toFixed(0)}。`;
  shortLayer.detail=`短期${biasZh(shortLayer.bias)}；广度变化 ${(breadthSlope*100).toFixed(0)}，分化度 ${(Math.min(1,dispersion)*100).toFixed(0)}%，跨所压力 ${(venuePressureMarket*100).toFixed(0)}。`;
  const transitionDrivers=[
      Math.abs(breadthDelta)>.15?`广度${breadthDelta>0?"改善":"恶化"}`:"",
      Math.abs(residualDelta)>.12?`残差分布${residualDelta>0?"转强":"转弱"}`:"",
      leaderPersistence<.5?"领导结构轮换":"",
      Math.abs(syncDelta)>.12?`相关性${syncDelta>0?"上升":"下降"}`:"",
      Math.abs(venuePressureMarket)>.22?(Math.abs(flowResponse)<.25?"跨所压力被吸收":"跨所压力有价格响应"):"",
    ].filter(Boolean),
    transitionDetail=transitionDirection==="NEUTRAL"?"市场内部变化仍处于观察阶段，尚未形成足够一致的状态迁移。"
      :`市场正在向${biasZh(transitionDirection)}状态迁移，阶段 ${transitionStage}；当前驱动：${transitionDrivers.join("、")||"内部结构持续变化"}。`,
    evidenceTop=evidenceRows.slice(0,6).map(x=>x.summary),shortRange:[number,number]=shortLayer.confidence>.7?[30,120]:dispersion>.7?[20,90]:[45,180],
    summary=`超大周期${biasZh(macro.bias)}（${phase}），大方向${biasZh(major.bias)}，短期${biasZh(shortLayer.bias)}；${transitionDetail}`,
    plan=shortLayer.bias==="BEARISH"&&major.bias==="BULLISH"?"优先寻找回调中持续弱于相关组的空头；保留抗跌资产，等待回调结束后的多头表达。"
      :shortLayer.bias==="BULLISH"&&major.bias==="BEARISH"?"优先寻找反弹中持续强于相关组的多头；同时保留弱势币作为反弹结束后的空头候选。"
      :shortLayer.bias==="BULLISH"?"优先做相对强势、回撤浅且相关组中性价比最高的多头，不重复堆同一相关风险。"
      :shortLayer.bias==="BEARISH"?"优先做相对弱势、反弹弱且相关组中性价比最高的空头，不重复堆同一相关风险。"
      :"不强行押注统一方向，继续寻找与全市场路径明显分离且持续的异类。";
  const narrative:MarketNarrative={id:previous.narrative.id||`mi-${input.now.toString(36)}`,updatedAt:input.now,macro,major,short:shortLayer,
    transition:{direction:transitionDirection,pressure:transitionPressure,confidence:clip(.25+Math.abs(transitionScore)*.7),detail:transitionDetail,
      score:transitionScore,stage:transitionStage,drivers:transitionDrivers},
    tailRisk:{level:tailLevel,score:tailScore,detail:tailLevel==="HIGH"?"多项系统性风险正在同时抬升，应降低高相关净敞口并优先保护已有利润。"
      :tailLevel==="MEDIUM"?"存在需要防范的深度回撤/二次探底风险，但尚不足以停止独立优质机会。":"当前没有看到足够集中的系统性崩塌证据。"},
    summary,plan,details:evidenceTop,expectedShortMinutes:shortRange};

  const opportunities:IntelligenceOpportunity[]=[];
  for(const row of Object.values(states)){
    const bestSide=row.longScore>=row.shortScore?"LONG":"SHORT",side=bestSide==="LONG"?1:-1,score=Math.max(row.longScore,row.shortScore),
      room=bestSide==="LONG"?row.roomLong:row.roomShort,path=bestSide==="LONG"?row.pathLong:row.pathShort,
      pullback=Math.max(.0035,row.volatility*Math.sqrt(4)*1.25),stopRate=clip(Math.max(.0055,pullback*1.18),.0055,.028),
      gross=Math.max(stopRate*1.55,room+Math.abs(row.residual)*.65),net=Math.max(0,gross-.0019),edge=net/Math.max(pullback,.001),
      marketFit=clip(.5+side*(shortLayer.score*.55+major.score*.30+macro.score*.15)/2),residualAligned=side*row.residualZ>0,
      mode:"RELATIVE"|"REVERSAL"|"CONTINUATION"=residualAligned&&side*major.score<-.08?"REVERSAL":side*shortLayer.score>.10?"CONTINUATION":"RELATIVE",
      hold=Math.round(clip(80+90*Math.abs(major.score)+120*row.residualPersistence+80*marketFit,60,360)),
      q=input.quotes[row.symbol],price=q&&q.bestBid>0&&q.bestAsk>=q.bestBid?(q.bestBid+q.bestAsk)/2:paths[row.symbol]!.at(-1)!.close,
      exec=clip(55+10*Math.min(4,row.sourceCount)+20*row.venueAgreement-20*Math.min(.01,q?.disagreementRate??0)/.01,0,100),
      quality=score*.62+Math.min(100,edge*35)*.18+row.dataConfidence*.12+exec*.08,
      rawEligible=quality>=72&&edge>=1.30&&row.dataConfidence>=65&&row.sourceCount>=2&&row.residualPersistence>=.66&&Math.abs(row.residualZ)>=.25,
      exceptional=quality>=88&&edge>=1.60&&row.residualPersistence>=.99&&Math.abs(row.residualZ)>=1.10&&row.sourceCount>=3,
      mature=row.signalBars>=2,
      eligible=rawEligible&&(mature||exceptional);
    row.watchScore=quality;row.regime=Math.abs(row.residualZ)>=.8&&row.residualPersistence>=.55?"DIVERGENT":Math.abs(shortLayer.score)>.28?"MARKET_TREND":dispersion>.6?"TRANSITION":"BALANCED";row.stage=eligible?"READY":"OBSERVE";
    const thesisId=`${MARKET_INTELLIGENCE_VERSION}:${row.symbol}:${bestSide}:${row.signalSince}`,
      thesisSummary=`${row.symbol.replace("_USDT","")} ${bestSide==="LONG"?"做多":"做空"}：相对市场残差 ${fmtPct(row.residual)}，持续性 ${(row.residualPersistence*100).toFixed(0)}%，同方向已连续 ${row.signalBars} 根完成5m观察，相关组 ${row.clusterId.replace("corr:","")}。`,
      invalidationSummary=bestSide==="LONG"?"若相对强势消失并持续弱于相关组，或结构止损被击穿，则原多头假设失效。":"若相对弱势消失并持续强于相关组，或结构止损被击穿，则原空头假设失效。";
    opportunities.push({id:thesisId,symbol:row.symbol,side:bestSide,mode,premium:quality>=82,score:quality,eligible,completedAt:input.now,
      expiresAt:input.now+20*60_000,price,stopPrice:price*(1-side*stopRate),targetPrice:price*(1+side*gross),stopRate,targetRate:gross,
      directionStrength:score,pathEfficiency:path*100,momentumPersistence:row.residualPersistence*100,positionScore:Math.min(100,55+Math.abs(row.residualZ)*15),
      spaceScore:Math.min(100,edge*38),executionScore:exec,grossRemainingSpaceRate:gross,netRemainingSpaceRate:net,pullbackRiskRate:pullback,
      edgeRatio:edge,expectedHoldMinutes:hold,marketFit:marketFit*100,regionId:null,regionQuality:null,reason:`${thesisSummary} ${narrative.plan}`,
      strategyVersion:MARKET_INTELLIGENCE_VERSION,regime:row.regime,confirmationStage:row.stage,sourceCount:row.sourceCount,
      disagreementRate:q?.disagreementRate??0,clusterId:row.clusterId,thesisId,thesisSummary,invalidationSummary,residual:row.residual,
      relativeStrength:row.relativeStrength,dataConfidence:row.dataConfidence,thesisSince:row.signalSince,thesisBars:row.signalBars});}
  const groupBest=new Map<string,IntelligenceOpportunity>();for(const o of opportunities.filter(x=>x.eligible)){const key=`${o.clusterId}:${o.side}`,old=groupBest.get(key);if(!old||o.score>old.score)groupBest.set(key,o);}
  for(const o of opportunities){if(!o.eligible)continue;const best=groupBest.get(`${o.clusterId}:${o.side}`);if(best&&best.id!==o.id){o.eligible=false;o.reason+=` 同一高相关组已有更优表达 ${best.symbol.replace("_USDT","")}，本币保持观察。`;}}
  opportunities.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score);

  const history=[...previous.history],lastHistory=history[0],
    labelsChanged=!lastHistory||lastHistory.macro!==macro.bias||lastHistory.major!==major.bias||lastHistory.short!==shortLayer.bias;
  if(!lastHistory||input.now-lastHistory.at>=5*60_000||labelsChanged)history.unshift({at:input.now,macro:macro.bias,major:major.bias,short:shortLayer.bias,summary});
  const coverage={intradayMarkets:Object.keys(paths).length,dailyMarkets:Object.keys(dailyPaths).length,
    quoteMarkets:Object.values(states).filter(x=>x.sourceCount>=1).length,multiVenueMarkets:Object.values(states).filter(x=>x.sourceCount>=2).length};
  const internals:MarketInternals={breadth3,breadth12,breadthSlope,dispersion,synchrony,venuePressure:venuePressureMarket,
    residualBalance,leaderPersistence};
  const state:MarketIntelligenceState={version:MARKET_INTELLIGENCE_VERSION,startedAt:previous.startedAt||input.now,updatedAt:input.now,narrative,
    evidence:evidenceRows.slice(0,40),history:history.slice(0,96),symbols:states,clusters,coverage,internals};
  const up=Object.values(states).filter(x=>x.longScore>=62).length,down=Object.values(states).filter(x=>x.shortScore>=62).length,neutral=Math.max(0,Object.keys(states).length-up-down);
  const pulse={at:input.now,up,down,neutral,
    bias:(shortLayer.bias==="BULLISH"?"UP":shortLayer.bias==="BEARISH"?"DOWN":"MIXED") as "UP"|"DOWN"|"MIXED",
    strength:Math.abs(shortLayer.score)*100,expansion:Math.min(100,dispersion*100)};
  return{state,opportunities,pulse};}

export function urgentMinuteSymbols(state:MarketIntelligenceState,allowed?:Set<string>){
  return Object.values(state.symbols).filter(x=>(!allowed||allowed.has(x.symbol))&&(x.stage==="READY"||x.watchScore>=68)).sort((a,b)=>b.watchScore-a.watchScore).map(x=>x.symbol);}

export function intelligenceExitDecision(input:{side:"LONG"|"SHORT";ageMin:number;signedRate:number;peakFavorableRate:number;firstProfit:boolean;
  stopRate:number;stopped:boolean;expectedHoldMinutes:number;maxHoldMinutes:number;invalidationBars:number;state?:MarketSymbolState}){
  const side=input.side==="LONG"?1:-1,state=input.state,same=state?(input.side==="LONG"?state.longScore:state.shortScore):50,
    relative=state?side*state.residualZ:0;let reason:string|null=null;
  if(input.stopped)reason="STRUCTURE_STOP";
  else if(input.invalidationBars>=2)reason="THESIS_INVALIDATED";
  else if(input.ageMin>=input.expectedHoldMinutes*.65&&!input.firstProfit&&input.signedRate<-.15*input.stopRate&&same<48)reason="NO_POSITIVE_FEEDBACK";
  else if(input.ageMin>=input.expectedHoldMinutes&&same<50&&Math.abs(relative)<.18)reason="RELATIVE_EDGE_GONE";
  else if(input.ageMin>=input.maxHoldMinutes)reason="MAX_HOLD";
  return{reason,floorCandidate:0,holdScore:clip(same*.72+(50+relative*14)*.28,0,100)};}
