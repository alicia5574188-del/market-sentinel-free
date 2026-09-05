import type { Hte31Candle } from './hte31-types.ts';
import type { DirectMarketCandidate } from './direct-market-types.ts';
import type { HistoricalForecast } from './historical-forecast.ts';
import type { DirectPositionDecision } from './direct-market-position-brain.ts';
import { DIRECT_POSITION_POLICY_VERSION } from './direct-market-position-brain.ts';

export const SCALP_POLICY = { riskRate: 0.0025, portfolioRiskRate: 0.0075, dailyLossRate: 0.015,
  lossPauseMs: 30 * 60_000, maximumHoldingMinutes: 15, minimumCostBps: 12, maximumOpenPositions: 3 } as const;
export const SCALP_POSITION_POLICY = 'minute-pullback-exit-v1';
export const minuteTime = (c: Hte31Candle) => c.time > 10_000_000_000 ? c.time : c.time * 1000;
const mean = (xs: number[]) => xs.length ? xs.reduce((a,b) => a+b,0)/xs.length : 0;
const ema = (xs: number[], period: number) => xs.reduce((a,b,i) => i ? a+(b-a)*2/(period+1) : b,0);
export const scalpCostBps = (configured: number) => Math.max(SCALP_POLICY.minimumCostBps, Number.isFinite(configured) ? configured : 0);
export function completeMinutes(rows: Hte31Candle[], now: number) {
  return [...new Map(rows.filter(c => [c.open,c.high,c.low,c.close,c.volume,minuteTime(c)].every(Number.isFinite)
    && c.low > 0 && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) && c.volume >= 0
    && minuteTime(c) % 60_000 === 0 && minuteTime(c)+60_000 <= now).map(c => [minuteTime(c),c])).values()]
    .sort((a,b) => minuteTime(a)-minuteTime(b)).slice(-390);
}
/** No partial higher-timeframe bars, and no aggregation across holes. */
export function aggregateMinutes(rows: Hte31Candle[], minutes: number) {
  const groups = new Map<number,Hte31Candle[]>();
  for (const c of rows) { const t=Math.floor(minuteTime(c)/(minutes*60_000))*minutes*60_000; groups.set(t,[...(groups.get(t)??[]),c]); }
  return [...groups].flatMap(([t,cs]) => cs.length === minutes && cs.every((c,i)=>minuteTime(c)===t+i*60_000)
    ? [{time:t/1000,open:cs[0].open,high:Math.max(...cs.map(c=>c.high)),low:Math.min(...cs.map(c=>c.low)),close:cs.at(-1)!.close,volume:cs.reduce((s,c)=>s+c.volume,0)}] : []);
}
export function buildScalpCandidate(input: {symbol:string; candles:Hte31Candle[]; btcCandles:Hte31Candle[]; now:number; price:number;
  volumeUsd:number; volumeRank:number; costBps:number; forecast?:HistoricalForecast}): DirectMarketCandidate {
  const cs=completeMinutes(input.candles,input.now), last=cs.at(-1), prior=cs.at(-2);
  const htf=aggregateMinutes(cs,15), closes=htf.map(c=>c.close);
  const fast=ema(closes,5), slow=ema(closes,12), oldFast=ema(closes.slice(0,-1),5);
  const sign=fast>=slow?1:-1, side=sign===1?'LONG' as const:'SHORT' as const;
  const atr=mean(cs.slice(-15).slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-cs.slice(-15)[i].close),Math.abs(c.low-cs.slice(-15)[i].close))));
  const pullback=cs.slice(-4,-1), impulse=cs.slice(-10,-4), signalPrice=last?.close??input.price;
  const pullbackLow=Math.min(...pullback.map(c=>c.low)),pullbackHigh=Math.max(...pullback.map(c=>c.high));
  const stop=sign===1?pullbackLow-atr*0.25:pullbackHigh+atr*0.25;
  const risk=sign*(signalPrice-stop), cost=signalPrice*scalpCostBps(input.costBps)/10_000;
  const local=cs.slice(-31,-4);
  // Profit target comes from the preceding swing, never stretched to pass cost checks.
  const swing=sign===1?Math.max(...local.map(c=>c.high)):Math.min(...local.map(c=>c.low));
  const target=swing-sign*atr*0.1, room=sign*(target-signalPrice);
  const directionReady=closes.length>=12 && sign*(fast-slow)>atr*0.1 && sign*(fast-oldFast)>0
    && sign*((closes.at(-1)??0)-slow)>0;
  const pullbackReady=pullback.length===3 && impulse.length===6 && prior != null
    && pullback.some(c=>sign*(c.close-c.open)<0)
    && sign*(prior.close-impulse.at(-1)!.close)<0
    && Math.abs(prior.close-impulse.at(-1)!.close)<=atr*3
    && mean(pullback.map(c=>c.volume))<=mean(impulse.map(c=>c.volume))*1.1;
  const trigger=Boolean(last&&prior&&sign*(last.close-last.open)>0&&sign*(last.close-prior.close)>0
    && (sign===1?last.close>Math.max(prior.open,prior.close):last.close<Math.min(prior.open,prior.close))
    && last.volume>=mean(pullback.map(c=>c.volume))*1.1);
  const contiguous=cs.length>=195 && cs.slice(-195).every((c,i,all)=>i===0||minuteTime(c)-minuteTime(all[i-1])===60_000);
  const checks=[
    {key:'data',label:'一分钟行情完整',passed:contiguous&&!!last&&input.now-minuteTime(last)-60_000<60_000,detail:'需要连续行情和刚完成的一分钟K线；启动直接读取近期数据'},
    {key:'trend',label:'十五分钟方向',passed:directionReady,detail:'完成的十五分钟均线同向，价格仍在趋势一侧'},
    {key:'pullback',label:'缩量回踩',passed:pullbackReady,detail:'近期回踩幅度受控，回踩量不高于推进段'},
    {key:'setup',label:'恢复确认',passed:trigger,detail:'一分钟收盘收回前一根实体，并有成交量恢复'},
    {key:'liquidity',label:'流动性',passed:input.volumeUsd>=12_000_000,detail:'固定六币中仍须有足够成交额'},
    {key:'structural-stop',label:'结构止损',passed:Number.isFinite(risk)&&risk>=atr*0.65&&risk/signalPrice<=0.01&&stop>0,detail:'回踩极值外留四分之一平均波幅缓冲'},
    {key:'cost',label:'扣费空间',passed:room>=3*cost&&room>=risk&&Number.isFinite(room),detail:'前方真实结构空间至少为往返成本三倍，且不小于止损距离'},
    {key:'entry-drift',label:'不追价',passed:atr>0&&Math.abs(input.price-signalPrice)<=atr*0.25,detail:'报价仍在信号收盘附近'},
  ];
  const ready=checks.every(c=>c.passed), blockers=checks.filter(c=>!c.passed).map(c=>`${c.label}：${c.detail}`);
  const btc=completeMinutes(input.btcCandles,input.now), byTime=new Map(btc.map(c=>[minuteTime(c),c.close]));
  const pairs=cs.slice(-121).slice(1).flatMap((c,i)=>{const p=cs.slice(-121)[i],b=byTime.get(minuteTime(c)),bp=byTime.get(minuteTime(p));return b&&bp?[[c.close/p.close-1,b/bp-1]]:[]});
  const mx=mean(pairs.map(p=>p[0])),my=mean(pairs.map(p=>p[1]));
  const cov=pairs.reduce((s,p)=>s+(p[0]-mx)*(p[1]-my),0),den=Math.sqrt(pairs.reduce((s,p)=>s+(p[0]-mx)**2,0)*pairs.reduce((s,p)=>s+(p[1]-my)**2,0));
  const correlation=input.symbol==='BTC_USDT'?1:pairs.length>=60&&den>0?cov/den:null;
  const score=checks.filter(c=>c.passed).length/checks.length*100;
  const setup='MINUTE_PULLBACK' as const, setupLabel='顺势回踩快进快出';
  return {symbol:input.symbol,batchId:`minute:${Math.floor(input.now/60_000)}`,observedAt:input.now,freshness:checks[0].passed?'FRESH':'UNAVAILABLE',scanStage:'DEEP',
    volumeRank:input.volumeRank,volumeUsd:input.volumeUsd,riskClusterId:correlation==null?'correlation-unknown':Math.abs(correlation)>=0.7?'btc-correlated':`independent-${input.symbol}`,btcCorrelation:correlation,
    location:sign===1?'BOTTOM':'TOP',paths:input.forecast?{up:input.forecast.upPct,down:input.forecast.downPct,rangeOrInvalid:input.forecast.neutralPct}:{up:0,down:0,rangeOrInvalid:100},
    directionalScore:directionReady?sign:0,netEdgeR:risk>0?(room-cost)/(risk+cost):0,confidence:Math.round(score),setup,setupLabel,setupScore:score,
    setupEvaluations:[{setup,setupLabel,side,score,triggered:directionReady&&pullbackReady&&trigger,qualified:ready,selected:ready,blockers}],
    decision:ready?side:'WAIT',entryZone:ready?[signalPrice-atr*0.25,signalPrice+atr*0.25]:null,invalidationPrice:ready?stop:null,
    targets:ready?[signalPrice+sign*Math.max(cost*1.5,room*0.5),target]:[],
    evidence:['十五分钟顺势，一分钟缩量回踩后恢复；不追价','最长十五分钟；三分钟无推进且失去确认则提前退出','历史相似走势仅辅助，不拦截样本不足的有效短线信号'],
    counterEvidence:blockers,checks,candles5m:aggregateMinutes(cs,5),forecast:input.forecast,assetRegime:'intraday-trend',maxHoldingMinutes:15,
    scalp:{signalAt:last?minuteTime(last)+60_000:0,structureAt:pullback[0]?minuteTime(pullback[0]):0,signalKey:`${input.symbol}:${side}:${pullback[0]?minuteTime(pullback[0]):0}`,costBps:scalpCostBps(input.costBps),confirmationPrice:prior?(sign===1?Math.max(prior.open,prior.close):Math.min(prior.open,prior.close)):signalPrice}};
}
export function scalpEntryRisk(input:{equity:number;dayOpeningEquity:number;dayNet:number;lastClosed:{net:number;exitAt:number}[];now:number;latchedUntil?:number}) {
  if ((input.latchedUntil??0)>input.now) return '当日亏损保护已生效，次日再评估';
  if (![input.equity,input.dayOpeningEquity,input.dayNet,input.now].every(Number.isFinite) || !(input.equity>0&&input.dayOpeningEquity>0)) return '账户权益不可用';
  if(input.dayNet<=-input.dayOpeningEquity*SCALP_POLICY.dailyLossRate) return '当日净亏损达到1.5%，停止新开仓';
  const last=input.lastClosed.slice(0,3);
  if(last.length===3&&last.every(c=>c.net<0)&&input.now-last[0].exitAt<SCALP_POLICY.lossPauseMs) return '连续三笔亏损，暂停新开仓三十分钟';
  return null;
}
export function evaluateScalpPosition(input:{side:'LONG'|'SHORT';entryPrice:number;initialStopPrice:number;currentStopPrice:number;entryAt:number;currentPrice:number;observedAt:number;roundTripCostBps:number;candles:Hte31Candle[];confirmationPrice:number}):DirectPositionDecision {
  const sign=input.side==='LONG'?1:-1,risk=Math.abs(input.entryPrice-input.initialStopPrice),progress=sign*(input.currentPrice-input.entryPrice);
  const cs=completeMinutes(input.candles,input.observedAt).filter(c=>minuteTime(c)>=input.entryAt),last=cs.at(-1);
  const failed=Boolean(last&&input.observedAt-minuteTime(last)<120_000&&sign*(last.close-input.confirmationPrice)<0&&sign*(input.currentPrice-input.confirmationPrice)<0);
  const exit=input.observedAt-input.entryAt>=15*60_000||input.observedAt-input.entryAt>=3*60_000&&progress<risk*0.25&&failed;
  const fee=input.entryPrice*scalpCostBps(input.roundTripCostBps)/10_000,protect=progress>Math.max(fee*1.5,risk*0.5);
  const proposed=input.entryPrice+sign*fee;
  return {policyVersion:DIRECT_POSITION_POLICY_VERSION,action:exit?'EXIT':protect?'PROTECT':'HOLD',reason:exit?'时间预算用尽或回踩确认失效，快速退出':protect?'已覆盖往返费用，收紧至扣费保本位':'保持结构止损，等待推进',observedAt:input.observedAt,completedBars:cs.length,progressR:risk>0?progress/risk:0,fastStructureR:0,slowStructureR:0,proposedStopPrice:protect?proposed:null,exitCode:exit?'brain_time_decay':null,reversalWatch:false};
}

/** Execution truth: old stop wins ambiguous bars; gaps never fill at a better stop. */
export function resolveScalpExit(input:{side:'LONG'|'SHORT';stop:number;target:number;price:number;open?:number;high:number;low:number;timeout:boolean;decision:DirectPositionDecision|null}) {
  const stopHit=input.side==='LONG'?input.low<=input.stop:input.high>=input.stop;
  const firstVisible=input.open??input.price;
  if(stopHit) return {code:'stop_loss',price:input.side==='LONG'?Math.min(input.stop,firstVisible):Math.max(input.stop,firstVisible),reason:'结构保护触发，按首个可见价格保守结算'};
  if(input.side==='LONG'?input.high>=input.target:input.low<=input.target) return {code:'take_profit',price:input.target,reason:'短线目标完成，全部退出'};
  if(input.decision?.action==='EXIT') return {code:input.decision.exitCode??'brain_time_decay',price:input.price,reason:input.decision.reason};
  if(input.timeout) return {code:'timeout',price:input.price,reason:'持仓时间预算结束，全部退出'};
  return null;
}

export function correlatedScalpExposure(next:{side:'LONG'|'SHORT';correlation:number|null}, held:{side:'LONG'|'SHORT';correlation:number|null}) {
  if(next.correlation==null||held.correlation==null) return true;
  return Math.abs(next.correlation)>=0.7&&Math.abs(held.correlation)>=0.7
    && (next.side==='LONG'?1:-1)*Math.sign(next.correlation)===(held.side==='LONG'?1:-1)*Math.sign(held.correlation);
}
