import type { Candle, SignalMetric } from "./signal-engine.ts";
import type { EntryCheck, EntryPlan, ExitRule, TradeSide } from "./trade-lifecycle.ts";
import {
  classifyShadowRegime,
  evaluateShadowStrategies,
  type MarketRegime,
  type ShadowStrategyInput,
  type ShadowStrategySignal,
} from "./shadow-strategy-engine.ts";

export type Strategy2Id =
  | "trend_pullback" | "trend_breakout" | "range_reversion" | "compression_breakout"
  | "expansion_momentum" | "liquidation_reversal" | "liquidation_continuation"
  | "exhaustion_reversal" | "relative_strength" | "rotation_leadership"
  | "failed_breakout" | "flow_divergence";

export type Strategy2AssetRegime =
  | "trend_up" | "trend_down" | "range" | "compression"
  | "expansion_up" | "expansion_down" | "leverage_liquidation" | "transition";

export type Strategy2Input = ShadowStrategyInput & {
  crossSectionRank?: number | null;
  rotationVelocity?: number | null;
  marketAdvancingRatio?: number | null;
  marketDecliningRatio?: number | null;
};

export type Strategy2Meta = {
  playbookId: string;
  assetRegime: Strategy2AssetRegime;
  setupScore: number;
  evidenceScore: number;
  triggerActive: boolean;
  hardGatePassed: boolean;
  candidateSide: TradeSide;
  globalRegime?: string;
  tradeMode?: "exploration" | "standard" | "high_conviction";
  supportingPlaybooks?: string[];
  strategyConflict?: number;
  experienceSamples?: number;
  expectancyR?: number | null;
};

export type Strategy2Signal = Omit<ShadowStrategySignal, "strategyId"> & {
  strategyId: Strategy2Id;
  strategyMeta: Strategy2Meta;
};

const FIVE_MINUTES = 300_000;
const PLAYBOOKS: Record<Strategy2Id, string> = {
  trend_pullback: "P1_TREND_PULLBACK",
  trend_breakout: "P2_TREND_BREAKOUT",
  range_reversion: "P3_RANGE_REVERSAL",
  compression_breakout: "P4_COMPRESSION_BREAKOUT",
  expansion_momentum: "P5_EXPANSION_MOMENTUM",
  liquidation_reversal: "P6_LIQUIDATION_REVERSAL",
  liquidation_continuation: "P7_LIQUIDATION_CONTINUATION",
  exhaustion_reversal: "P8_EXHAUSTION_REVERSAL",
  relative_strength: "P9_RELATIVE_STRENGTH",
  rotation_leadership: "P10_ROTATION_LEADERSHIP",
  failed_breakout: "P11_FAILED_BREAKOUT",
  flow_divergence: "P12_FLOW_DIVERGENCE",
};

export const STRATEGY2_LABELS: Record<Strategy2Id, string> = {
  trend_pullback: "P1 趋势回踩", trend_breakout: "P2 趋势突破", range_reversion: "P3 震荡边缘反转",
  compression_breakout: "P4 压缩突破", expansion_momentum: "P5 扩张动量", liquidation_reversal: "P6 清算反转",
  liquidation_continuation: "P7 清算延续", exhaustion_reversal: "P8 衰竭反转", relative_strength: "P9 相对强弱",
  rotation_leadership: "P10 轮动/龙头强弱", failed_breakout: "P11 假突破反向", flow_divergence: "P12 资金流背离",
};

const LEGACY_DIRECTION_CHECKS: Partial<Record<Strategy2Id, ReadonlySet<string>>> = {
  trend_pullback: new Set(["regime", "resume", "spot-flow"]),
  range_reversion: new Set(["regime", "range-edge", "microstructure"]),
  compression_breakout: new Set(["compression", "closed-breakout", "spot-flow"]),
  relative_strength: new Set(["relative-edge", "trend", "spot-flow"]),
};

function clamp(value: number, min = 0, max = 100) { return Math.min(max, Math.max(min, value)); }
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function candleMs(time: number) { return time > 10_000_000_000 ? time : time * 1000; }
function completed(input: Strategy2Input) {
  return input.candles5m.filter((c) => [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite))
    .filter((c) => candleMs(c.time) + FIVE_MINUTES <= input.observedAt).sort((a,b) => a.time-b.time);
}
function atr(rows: Candle[], period=14) {
  if (rows.length <= period) return null;
  const r = rows.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-rows[i].close),Math.abs(c.low-rows[i].close)));
  return mean(r.slice(-period));
}
function rsi(values:number[], period=14) {
  if (values.length<=period) return null; const d=values.slice(1).map((v,i)=>v-values[i]); const w=d.slice(-period);
  const g=mean(w.map(v=>Math.max(v,0))), l=mean(w.map(v=>Math.max(-v,0))); return l===0?(g===0?50:100):100-100/(1+g/l);
}
function volumeRatio(rows:Candle[]) { if(rows.length<22)return null; return rows.at(-1)!.volume/Math.max(mean(rows.slice(-21,-1).map(c=>c.volume)),Number.EPSILON); }
function recentMove(rows:Candle[], n=6) { const a=rows.at(-(n+1))?.close??0,b=rows.at(-1)?.close??0; return a>0?(b/a-1)*100:0; }
function range(rows:Candle[], n=24) {
  const w=rows.slice(-n); if(!w.length)return {high:0,low:0,position:.5}; const high=Math.max(...w.map(c=>c.high)),low=Math.min(...w.map(c=>c.low));
  const span=high-low, close=w.at(-1)!.close; return {high,low,position:span>0?(close-low)/span:.5};
}
function dir(side:TradeSide){return side==="LONG"?1:-1;}
function signed(value:number|null|undefined,side:TradeSide){return (value??0)*dir(side);}
function swingStop(rows:Candle[], side:TradeSide, currentAtr:number|null, n=10, pad=.15){
  if(!rows.length||currentAtr==null)return 0; const w=rows.slice(-n); return side==="LONG"?Math.min(...w.map(c=>c.low))-currentAtr*pad:Math.max(...w.map(c=>c.high))+currentAtr*pad;
}
function exitRules(side:TradeSide, stop:number,tp1:number,tp2:number,mins:number):ExitRule[]{return [
  {code:"stop_loss",label:"结构止损",condition:`${side==="LONG"?"价格 ≤":"价格 ≥"} ${stop}`},
  {code:"breakeven",label:"第一目标保护",condition:`到达 ${tp1} 后止损移动到入场价`},
  {code:"take_profit",label:"第二目标",condition:`到达 ${tp2} 完成退出`},
  {code:"structure_reversal",label:"结构反转",condition:"主交易逻辑或单币环境失效"},
  {code:"flow_reversal",label:"资金流反转",condition:"资金流持续反向"},
  {code:"macro_risk",label:"紧急风险退出",condition:"环境进入 RED / 紧急风险"},
  {code:"timeout",label:"时间止损",condition:`${mins} 分钟未兑现则退出`},
];}

function hardBlockers(input:Strategy2Input){
  const b:string[]=[];
  if(input.dataQuality<.62)b.push("DATA_UNSAFE");
  if(input.volumeUsd<8_000_000)b.push("LIQUIDITY_TOO_LOW");
  if(input.fundingRate!=null&&Math.abs(input.fundingRate)>=.0015)b.push("LEVERAGE_EXTREME");
  if((input.macroEventRisk??0)>=.98)b.push("EMERGENCY_EVENT_RISK");
  return b;
}
function plan(input:Strategy2Input, side:TradeSide, stop:number, tp2R:number, mins:number, soft:EntryCheck[], requiredSoftKeys:string[]=[]):EntryPlan|null{
  const rows=completed(input), a=atr(rows), entry=input.futuresPrice; if(a==null||entry<=0||stop<=0)return null;
  const risk=Math.abs(entry-stop), riskPct=risk/entry*100; if(risk<=0||riskPct>6)return null;
  const tp1=entry+dir(side)*risk, tp2=entry+dir(side)*risk*tp2R;
  const hard:EntryCheck[]=[
    {key:"risk-distance",label:"结构止损距离",passed:riskPct<=6,required:true,detail:`${riskPct.toFixed(2)}%`},
    {key:"data-hard",label:"数据安全",passed:input.dataQuality>=.62,required:true,detail:`${Math.round(input.dataQuality*100)}%`},
    {key:"liquidity-hard",label:"流动性安全",passed:input.volumeUsd>=8_000_000,required:true,detail:`${(input.volumeUsd/1e6).toFixed(1)}M`},
    {key:"funding-hard",label:"杠杆安全",passed:input.fundingRate==null||Math.abs(input.fundingRate)<.0015,required:true,detail:`${((input.fundingRate??0)*100).toFixed(4)}%`},
    {key:"event-hard",label:"事件安全",passed:(input.macroEventRisk??0)<.98,required:true,detail:`${Math.round((input.macroEventRisk??0)*100)}`},
  ];
  const directional=soft.map(c=>({...c,required:requiredSoftKeys.includes(c.key)}));
  const checks=[...hard,...directional];
  return {ready:checks.every(c=>!c.required||c.passed),side,entryPrice:entry,entryZone:[entry-a*.2,entry+a*.2],stopLossPrice:stop,takeProfit1Price:tp1,takeProfit2Price:tp2,riskPerUnit:risk,plannedRiskPct:riskPct,riskReward:tp2R,maxHoldingMinutes:mins,checks,exitRules:exitRules(side,stop,tp1,tp2,mins)};
}
function metrics(input:Strategy2Input, regime:MarketRegime, asset:Strategy2AssetRegime):SignalMetric[]{return [
  {key:"multi-timeframe",label:"多周期结构",score:regime.trendScore,detail:`${(regime.trendScore*100).toFixed(0)}`,available:input.multiTimeframeTrend!=null,category:"price"},
  {key:"spot-flow",label:"现货主动流",score:input.spotCvdRatio??0,detail:input.spotCvdRatio==null?"--":`${(input.spotCvdRatio*100).toFixed(1)}%`,available:input.spotCvdRatio!=null,category:"spot"},
  {key:"order-book",label:"订单簿",score:input.orderBookImbalance??0,detail:input.orderBookImbalance==null?"--":`${(input.orderBookImbalance*100).toFixed(1)}%`,available:input.orderBookImbalance!=null,category:"microstructure"},
  {key:"derivatives",label:"OI / Funding",score:(input.openInterestChangePct??0)/4,detail:`OI ${(input.openInterestChangePct??0).toFixed(2)}%`,available:input.openInterestChangePct!=null||input.fundingRate!=null,category:"derivatives"},
  {key:"asset-regime",label:"单币环境",score:Math.abs(regime.trendScore),detail:asset,available:true,category:"cross"},
];}

export function classifyStrategy2AssetRegime(input:Strategy2Input):Strategy2AssetRegime{
  const rows=completed(input), base=classifyShadowRegime(input), aNow=atr(rows.slice(-20),10),aOld=atr(rows.slice(-42,-12),14);
  const ar=aNow!=null&&aOld!=null&&aOld>0?aNow/aOld:base.compressionRatio, move=recentMove(rows), vol=volumeRatio(rows)??1, trend=input.multiTimeframeTrend??base.trendScore;
  if(Math.abs(input.liquidationImbalance??0)>=.48)return "leverage_liquidation";
  if(ar!=null&&ar<=.80)return "compression";
  if((ar!=null&&ar>=1.18)||vol>=1.35){if(Math.abs(move)>=.25||Math.abs(trend)>=.28)return (move||trend)>=0?"expansion_up":"expansion_down";}
  if(Math.abs(trend)>=.34)return trend>=0?"trend_up":"trend_down";
  if(Math.abs(trend)<=.24&&(base.rangeWidthPct??99)<=6)return "range";
  return "transition";
}

type Eval={id:Strategy2Id;label:string;side:TradeSide;trigger:boolean;setup:number;evidence:number;stop:number;rr:number;mins:number;thesis:string;soft:EntryCheck[];requiredSoftKeys?:string[]};
function make(input:Strategy2Input,regime:MarketRegime,asset:Strategy2AssetRegime,e:Eval):Strategy2Signal{
  const blockers=hardBlockers(input), p=plan(input,e.side,e.stop,e.rr,e.mins,e.soft,e.requiredSoftKeys), hard=blockers.length===0&&Boolean(p?.ready);
  const ready=e.trigger&&hard&&e.setup*.55+e.evidence*.45>=48;
  const score=dir(e.side)*clamp(e.setup*.58+e.evidence*.42)/100;
  const failedDirectional=p?.checks.filter(c=>c.required&&!c.passed&&!c.key.endsWith("-hard")&&c.key!=="risk-distance")??[];
  return {strategyId:e.id,label:e.label,shadowOnly:true,state:blockers.length?"blocked":ready?"ready":"watching",side:blockers.length?"WAIT":e.side,score:Number(score.toFixed(4)),confidence:Math.round(clamp(45+Math.abs(score)*40+input.dataQuality*12)),regime,thesis:e.thesis,reasons:e.soft.filter(c=>c.passed).map(c=>c.label),blockers:[...blockers,...failedDirectional.map(c=>`${c.label}方向确认不足`),...e.soft.filter(c=>!c.passed&&!e.requiredSoftKeys?.includes(c.key)).map(c=>`${c.label}待增强`)],entryPlan:p,metrics:metrics(input,regime,asset),strategyMeta:{playbookId:PLAYBOOKS[e.id],assetRegime:asset,setupScore:Math.round(clamp(e.setup)),evidenceScore:Math.round(clamp(e.evidence)),triggerActive:e.trigger,hardGatePassed:hard,candidateSide:e.side}};
}
function adaptLegacy(input:Strategy2Input, regime:MarketRegime, asset:Strategy2AssetRegime, s:ShadowStrategySignal):Strategy2Signal{
  const id:Strategy2Id=s.strategyId==="volatility_breakout"?"compression_breakout":s.strategyId as Strategy2Id;
  const side:TradeSide=s.side==="SHORT"?"SHORT":"LONG"; const checks=s.entryPlan?.checks??[]; const passed=checks.filter(c=>c.passed).length; const evidence=checks.length?passed/checks.length*100:Math.abs(s.score)*100;
  const setup=clamp(Math.abs(s.score)*75+(s.entryPlan?20:0));
  const blockers=hardBlockers(input), requiredDirection=LEGACY_DIRECTION_CHECKS[id]??new Set<string>();
  const p=s.entryPlan?{...s.entryPlan,checks:s.entryPlan.checks.map(c=>({...c,required:c.key==="risk-distance"||requiredDirection.has(c.key)}))}:null;
  if(p)p.ready=blockers.length===0&&p.checks.every(c=>!c.required||c.passed);
  const trigger = id==="trend_pullback"?Math.abs(s.score)>=.28:id==="compression_breakout"?s.side!=="WAIT":id==="range_reversion"?s.side!=="WAIT":s.side!=="WAIT";
  const ready=trigger&&Boolean(p?.ready)&&setup*.55+evidence*.45>=48;
  const directionFailures=p?.checks.filter(c=>c.required&&!c.passed&&c.key!=="risk-distance").map(c=>`${c.label}方向确认不足`)??[];
  return {...s,strategyId:id,label:STRATEGY2_LABELS[id],state:blockers.length?"blocked":ready?"ready":"watching",side:blockers.length?"WAIT":side,entryPlan:p,blockers:[...new Set([...blockers,...directionFailures,...s.blockers])],strategyMeta:{playbookId:PLAYBOOKS[id],assetRegime:asset,setupScore:Math.round(setup),evidenceScore:Math.round(evidence),triggerActive:trigger,hardGatePassed:blockers.length===0&&Boolean(p?.ready),candidateSide:side}};
}

export function evaluateStrategy2Pool(input:Strategy2Input):Strategy2Signal[]{
  const rows=completed(input), regime=classifyShadowRegime(input), asset=classifyStrategy2AssetRegime(input), a=atr(rows),vr=volumeRatio(rows)??1,move=recentMove(rows),rw=range(rows),last=rows.at(-1)??null,prev=rows.at(-2)??null;
  const old=evaluateShadowStrategies(input).map(s=>adaptLegacy(input,regime,asset,s));
  const legacy=new Map(old.map(s=>[s.strategyId,s]));
  const trendSide:TradeSide=(input.multiTimeframeTrend??0)>=0?"LONG":"SHORT";
  const trendBreak=trendSide==="LONG"?(last?.close??0)>=rw.high-(a??0)*.08:(last?.close??0)<=rw.low+(a??0)*.08;
  const p2=make(input,regime,asset,{id:"trend_breakout",label:STRATEGY2_LABELS.trend_breakout,side:trendSide,trigger:Math.abs(input.multiTimeframeTrend??0)>=.25&&trendBreak,setup:clamp(Math.abs(input.multiTimeframeTrend??0)*70+(trendBreak?25:0)),evidence:clamp((vr-0.7)*45+signed(input.spotCvdRatio,trendSide)*500+55),stop:swingStop(rows,trendSide,a,10,.12),rr:2.1,mins:150,thesis:"趋势结构已经形成时允许突破延续，但入场前必须有真实现货资金流同向确认。",soft:[{key:"trend",label:"趋势方向",passed:Math.abs(input.multiTimeframeTrend??0)>=.25,required:false,detail:""},{key:"volume",label:"量能",passed:vr>=.9,required:false,detail:`${vr.toFixed(2)}x`},{key:"flow",label:"现货流",passed:signed(input.spotCvdRatio,trendSide)>=.004,required:false,detail:""}],requiredSoftKeys:["flow"]});
  const expSide:TradeSide=move>=0?"LONG":"SHORT";
  const p5=make(input,regime,asset,{id:"expansion_momentum",label:STRATEGY2_LABELS.expansion_momentum,side:expSide,trigger:(asset==="expansion_up"||asset==="expansion_down")&&Math.abs(move)>=.2,setup:clamp(Math.abs(move)*28+(vr-1)*35+45),evidence:clamp(55+signed(input.spotCvdRatio,expSide)*450+signed(input.openInterestChangePct,expSide)*3),stop:swingStop(rows,expSide,a,8,.12),rr:2.0,mins:110,thesis:"波动已经扩张后只顺着得到现货主动流确认的真实动量参与。",soft:[{key:"expansion",label:"波动扩张",passed:asset.startsWith("expansion"),required:false,detail:asset},{key:"flow",label:"资金流",passed:signed(input.spotCvdRatio,expSide)>=.004,required:false,detail:""}],requiredSoftKeys:["flow"]});
  const liq=(input.liquidationImbalance??0), liqSide:TradeSide=liq>=0?"SHORT":"LONG", contSide:TradeSide=liq>=0?"LONG":"SHORT";
  const rejection=prev&&last?(contSide==="LONG"?last.close<last.open&&last.close<prev.close:last.close>last.open&&last.close>prev.close):false;
  const p6Absorption=signed(input.spotCvdRatio,liqSide)>=.004||signed(input.orderBookImbalance,liqSide)>=.02;
  const p6=make(input,regime,asset,{id:"liquidation_reversal",label:STRATEGY2_LABELS.liquidation_reversal,side:liqSide,trigger:Math.abs(liq)>=.35&&rejection,setup:clamp(Math.abs(liq)*100+(rejection?30:0)),evidence:clamp(50+signed(input.spotCvdRatio,liqSide)*500+signed(input.orderBookImbalance,liqSide)*100),stop:swingStop(rows,liqSide,a,8,.22),rr:1.8,mins:70,thesis:"清算冲击后不仅要出现拒绝，还要看到现货流或订单簿吸收才允许测试反转。",soft:[{key:"liquidation",label:"清算冲击",passed:Math.abs(liq)>=.35,required:false,detail:`${liq.toFixed(2)}`},{key:"rejection",label:"拒绝K线",passed:Boolean(rejection),required:false,detail:""},{key:"absorption",label:"反转吸收",passed:p6Absorption,required:false,detail:"现货流/订单簿至少一项同向"}],requiredSoftKeys:["absorption"]});
  const p7Direction=signed(input.spotCvdRatio,contSide)>=.004||signed(input.multiTimeframeTrend,contSide)>=.18;
  const p7NotOpposed=signed(input.multiTimeframeTrend,contSide)>=-.18;
  const p7=make(input,regime,asset,{id:"liquidation_continuation",label:STRATEGY2_LABELS.liquidation_continuation,side:contSide,trigger:Math.abs(liq)>=.35&&Math.abs(move)>=.25&&!rejection,setup:clamp(Math.abs(liq)*90+Math.abs(move)*25),evidence:clamp(50+signed(input.spotCvdRatio,contSide)*420+Math.max(0,input.openInterestChangePct??0)*4),stop:swingStop(rows,contSide,a,6,.18),rr:1.7,mins:60,thesis:"清算仍在扩散时，只有资金流或高周期结构至少一项继续同向且高周期不强烈反对才追随。",soft:[{key:"liquidation",label:"清算持续",passed:Math.abs(liq)>=.35,required:false,detail:""},{key:"no-reject",label:"未出现反转吸收",passed:!rejection,required:false,detail:""},{key:"direction-confirm",label:"延续方向确认",passed:p7Direction,required:false,detail:"现货流或多周期结构至少一项同向"},{key:"trend-not-opposed",label:"高周期不强烈反向",passed:p7NotOpposed,required:false,detail:""}],requiredSoftKeys:["direction-confirm","trend-not-opposed"]});
  const closes=rows.map(c=>c.close),r=rsi(closes),exhaust=Math.abs(input.changePercentage??0)>=7||(r!=null&&(r>=72||r<=28)),revSide:TradeSide=(input.changePercentage??0)>=0?"SHORT":"LONG";
  const rejection2=last? (revSide==="SHORT"?last.close<last.open:last.close>last.open):false;
  const revFlow=signed(input.spotCvdRatio,revSide),revBook=signed(input.orderBookImbalance,revSide);
  const p8Confirm=(Boolean(rejection2)&&(revFlow>=0||revBook>=0))||(revFlow>=.006&&revBook>=-.02);
  const p8=make(input,regime,asset,{id:"exhaustion_reversal",label:STRATEGY2_LABELS.exhaustion_reversal,side:revSide,trigger:exhaust&&(rejection2||revFlow>=.004),setup:clamp((exhaust?55:0)+(rejection2?25:0)+Math.abs(input.changePercentage??0)*2),evidence:clamp(50+revFlow*500),stop:swingStop(rows,revSide,a,10,.22),rr:1.8,mins:100,thesis:"价格过度延伸后不再仅凭超买超卖猜顶底，必须出现拒绝配合不反向的微观资金流，或更强的现货反转流。",soft:[{key:"stretch",label:"价格延伸",passed:exhaust,required:false,detail:`RSI ${r?.toFixed(1)??"--"}`},{key:"rejection",label:"拒绝确认",passed:Boolean(rejection2),required:false,detail:""},{key:"reversal-confirm",label:"反转方向确认",passed:p8Confirm,required:false,detail:"拒绝与资金流/订单簿必须形成方向证据"}],requiredSoftKeys:["reversal-confirm"]});
  const rank=input.crossSectionRank??.5,rotSide:TradeSide=rank>=.5?"LONG":"SHORT",leader=rotSide==="LONG"?rank>=.75:rank<=.25,vel=signed(input.rotationVelocity,rotSide);
  const p10Direction=signed(input.multiTimeframeTrend,rotSide)>=.18||signed(input.spotCvdRatio,rotSide)>=.006;
  const p10=make(input,regime,asset,{id:"rotation_leadership",label:STRATEGY2_LABELS.rotation_leadership,side:rotSide,trigger:leader&&(vel>=.015||Math.abs((input.changePercentage??0)-(input.benchmarkMomentum??0))>=1.2),setup:clamp((rotSide==="LONG"?rank:1-rank)*60+Math.abs(input.rotationVelocity??0)*300),evidence:clamp(52+signed(input.spotCvdRatio,rotSide)*400+signed(input.multiTimeframeTrend,rotSide)*25),stop:swingStop(rows,rotSide,a,10,.12),rr:1.9,mins:210,thesis:"横截面强弱只能发现候选，真正开仓还必须得到自身高周期结构或现货流的方向确认。",soft:[{key:"rank",label:"横截面排名",passed:leader,required:false,detail:`${Math.round(rank*100)}%`},{key:"velocity",label:"轮动速度",passed:vel>=.015,required:false,detail:`${vel.toFixed(3)}`},{key:"direction-confirm",label:"自身方向确认",passed:p10Direction,required:false,detail:"多周期结构或现货流至少一项同向"}],requiredSoftKeys:["direction-confirm"]});
  const prior=rows.slice(-24,-2),ph=prior.length?Math.max(...prior.map(c=>c.high)):0,pl=prior.length?Math.min(...prior.map(c=>c.low)):0,failedHigh=Boolean(prev&&last&&prev.high>ph&&last.close<ph),failedLow=Boolean(prev&&last&&prev.low<pl&&last.close>pl),failSide:TradeSide=failedHigh?"SHORT":"LONG";
  const p11Micro=signed(input.spotCvdRatio,failSide)>=.004||signed(input.orderBookImbalance,failSide)>=.02;
  const p11=make(input,regime,asset,{id:"failed_breakout",label:STRATEGY2_LABELS.failed_breakout,side:failSide,trigger:failedHigh||failedLow,setup:clamp((failedHigh||failedLow?65:0)+(asset==="transition"?15:0)),evidence:clamp(50+signed(input.spotCvdRatio,failSide)*500+signed(input.orderBookImbalance,failSide)*90),stop:swingStop(rows,failSide,a,8,.18),rr:1.75,mins:100,thesis:"突破失败并回到结构内后，还要看到现货流或订单簿站到反向一侧才交易。",soft:[{key:"failure",label:"假突破回收",passed:failedHigh||failedLow,required:false,detail:""},{key:"microstructure",label:"反向微观结构",passed:p11Micro,required:false,detail:"现货流/订单簿至少一项确认"}],requiredSoftKeys:["microstructure"]});
  const bearish=move>.18&&(input.spotCvdRatio??0)<=-.008,bullish=move<-.18&&(input.spotCvdRatio??0)>=.008,divSide:TradeSide=bearish?"SHORT":"LONG";
  const p12NotOpposed=signed(input.multiTimeframeTrend,divSide)>=-.28&&signed(input.orderBookImbalance,divSide)>=-.05;
  const p12=make(input,regime,asset,{id:"flow_divergence",label:STRATEGY2_LABELS.flow_divergence,side:divSide,trigger:bearish||bullish,setup:clamp((bearish||bullish?65:0)+Math.abs(input.spotCvdRatio??0)*350),evidence:clamp(55+signed(input.orderBookImbalance,divSide)*100+Math.min(20,Math.abs(input.openInterestChangePct??0)*3)),stop:swingStop(rows,divSide,a,10,.18),rr:1.8,mins:120,thesis:"价格与 Spot CVD 背离后，只在高周期结构和订单簿没有同时强烈反对时测试收敛。",soft:[{key:"divergence",label:"价格/资金流背离",passed:bearish||bullish,required:false,detail:`价格 ${move.toFixed(2)}%`},{key:"non-opposition",label:"结构未强烈反对",passed:p12NotOpposed,required:false,detail:"高周期与订单簿不能同时逆向压制"}],requiredSoftKeys:["non-opposition"]});
  return [legacy.get("trend_pullback")!,p2,legacy.get("range_reversion")!,legacy.get("compression_breakout")!,p5,p6,p7,p8,legacy.get("relative_strength")!,p10,p11,p12];
}
