import type { Hte31Candle } from './hte31-types.ts';
import type { DirectMarketCandidate } from './direct-market-types.ts';
import type { HistoricalForecast } from './historical-forecast.ts';
import { cleanAnalogCandles, ANALOG_MIN_SAMPLES, historicalSwingVotes } from './historical-forecast.ts';
import { minuteTime,scalpCostBps } from './scalp-strategy.ts';
import {DIRECT_POSITION_POLICY_VERSION,type DirectPositionDecision} from './direct-market-position-brain.ts';
export const ANALOG_POSITION_POLICY='analog-path-exit-v2';
export const ANALOG_MIN_NET_REWARD_R=0.8;
export const ANALOG_RISK_POLICY={
 riskRate:.04,
 portfolioRiskRate:.12,
 dailyLossRate:.12,
 minimumTp2NetProfitUsdt:30,
 lossPauseMs:30*60_000,
} as const;
export const completeFiveMinutes=(rows:Hte31Candle[],now:number)=>cleanAnalogCandles(rows,now).slice(-400);
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const quantile=(xs:number[],p:number)=>{const a=[...xs].sort((x,y)=>x-y);if(!a.length)return 0;const t=(a.length-1)*p,i=Math.floor(t);return a[i]+(a[Math.ceil(t)]-a[i])*(t-i);};
export type AnalogIntent={side:'LONG'|'SHORT';anchor:number;createdAt:number;expiresAt:number;signalKey:string;offsetPct:number;stopPct:number;targetPct:number;expectedNetR:number;takeProfitPct:number;lossPct:number;protectedExitPct:number;fillPct:number;mode:'NOW'|'PULLBACK'};
export function historicalDirection(f:HistoricalForecast|undefined,now:number,_costBps=12):{side:'LONG'|'SHORT'|'WAIT';reason:string} {
 if(!f)return {side:'WAIT',reason:'正在读取历史对照，暂不开单'};
 if(f.state==='STALE'||now<f.signalAt||now-f.signalAt>=300_000)return {side:'WAIT',reason:'历史判断已过期，等待最新完整五分钟K线'};
 if(f.sampleCount<ANALOG_MIN_SAMPLES||f.effectiveSamples<ANALOG_MIN_SAMPLES-.5)return {side:'WAIT',reason:`独立相似片段${f.sampleCount}/${ANALOG_MIN_SAMPLES}段，依据不足，暂不开单`};
 if(f.state!=='READY')return {side:'WAIT',reason:f.reason};
 const swing=f.episodes?.length?historicalSwingVotes(f.episodes,_costBps).bias:f.swingBias;
 if(!swing)return {side:'WAIT',reason:'正在更新历史途中方向统计'};
 if(swing.upPct>50)return {side:'LONG',reason:`${swing.upPct.toFixed(0)}%历史片段先向上走出可交易波动，不要求最终收涨`};
 if(swing.downPct>50)return {side:'SHORT',reason:`${swing.downPct.toFixed(0)}%历史片段先向下走出可交易波动，不要求最终收跌`};
 return {side:'WAIT',reason:'历史片段的首段可交易波动方向分散，暂不开单'};
}
type Episode=NonNullable<HistoricalForecast['episodes']>[number];
/** Stop-first, conservative limit fills, no exits before the historical entry. */
export function replayAnalogPath(episode:Episode,side:'LONG'|'SHORT',offset:number,stop:number,target:number,cost:number) {
 const sign=side==='LONG'?1:-1,entry=-offset;cost*=1-sign*offset/100;let filled=offset===0,stopLevel=entry-stop,move=0,peak=0,age=0;
 for(let i=0;i<episode.bars.length;i++){
  const b=episode.bars[i],low=sign===1?b.lowPct:-b.highPct,high=sign===1?b.highPct:-b.lowPct,open=b.openPct*sign,close=b.closePct*sign;
  let justFilled=false;
  if(!filled){if(i>=3)break;if(low>entry)continue;filled=true;justFilled=true;}
  age++;
  if(low<=stopLevel)return {filled:true,netPct:Math.min(stopLevel,open)-entry-cost,exit:'STOP' as const};
  // A limit first touched inside a bar cannot also claim that bar's earlier high.
  if(!justFilled&&high>=entry+target)return {filled:true,netPct:target-cost,exit:'TARGET' as const};
  move=close-entry;
  if(!justFilled)peak=Math.max(peak,high-entry);
  // Protect after a real intrabar advance even if price has already retreated by the close.
  if(peak>=Math.max(cost*1.5,stop*.35))stopLevel=Math.max(stopLevel,entry+cost);
  if(age>=2&&move<=-Math.max(stop*.2,cost*1.5))return {filled:true,netPct:move-cost,exit:'EARLY' as const};
  if(age>=4&&peak<cost*1.5&&move<=0)return {filled:true,netPct:move-cost,exit:'STALL' as const};
  if(age>=6&&move<=cost)return {filled:true,netPct:move-cost,exit:'FADE' as const};
 }
 return {filled,netPct:filled?move-cost:0,exit:'TIME' as const};
}
function estimate(episodes:Episode[],side:'LONG'|'SHORT',offset:number,stop:number,target:number,cost:number){
 const outcomes=episodes.map(e=>({...replayAnalogPath(e,side,offset,stop,target,cost),weight:e.weight}));
 const total=outcomes.reduce((s,o)=>s+o.weight,0),filled=outcomes.filter(o=>o.filled),weight=filled.reduce((s,o)=>s+o.weight,0);
 return {expectedNetR:weight?filled.reduce((s,o)=>s+o.netPct*o.weight,0)/weight/(stop+cost):0,fillPct:weight/total*100,
  takeProfitPct:weight?filled.reduce((s,o)=>s+(o.exit==='TARGET'?o.weight:0),0)/weight*100:0,
  lossPct:weight?filled.reduce((s,o)=>s+(o.netPct < -1e-9?o.weight:0),0)/weight*100:100,
  protectedExitPct:weight?filled.reduce((s,o)=>s+(o.exit==='STOP'&&o.netPct>=-1e-9?o.weight:0),0)/weight*100:0};
}
export function planAnalogEntry(f:HistoricalForecast,side:'LONG'|'SHORT',atrPct:number,anchor:number,now:number):AnalogIntent|null{
 const sign=side==='LONG'?1:-1,episodes=f.episodes??[],cost=scalpCostBps(f.costBps)/100;
 if(!episodes.length||!(atrPct>0&&anchor>0))return null;
 const adverse=episodes.map(e=>Math.max(0,...e.bars.map(b=>sign===1?-b.lowPct:b.highPct)));
 // Direction comes from the first cost-sized swing. Size the target from the
 // maximum in-horizon excursion of the episodes that actually voted for that
 // direction; opposite-voting paths must not collapse a valid path target to
 // the bare fee floor.
 const votes=historicalSwingVotes(episodes,f.costBps).votes;
 const supporting=episodes.filter((_,i)=>votes[i]===sign);
 const favorable=supporting.map(e=>Math.max(0,...e.bars.map(b=>sign===1?b.highPct:-b.lowPct)));
 if(supporting.length<=episodes.length/2||!favorable.length)return null;
 // Two fixed alternatives, not a parameter search. Entire paths include losing episodes.
 const offset=Math.max(0,mean(adverse)*.5);
 const alternatives=[0,...(offset>=atrPct*.2?[offset]:[])].map(offsetPct=>{
  const targetPct=Math.max(cost*1.5,quantile(favorable,.5)*.75)+offsetPct;
  // Once the target was reached, a later reversal must not inflate the initial stop.
  const beforeTarget=episodes.map(e=>{let worst=0;for(const b of e.bars){worst=Math.max(worst,sign===1?-b.lowPct:b.highPct);if((sign===1?b.highPct:-b.lowPct)>=targetPct-offsetPct)break;}return worst;});
  // Never express the same fixed equity risk through a micro stop: a normal five-minute print
  // could otherwise cross several R before the next conservative replay fill. Wider stop means
  // proportionally smaller position size; it does not increase the account loss budget.
  const stopPct=Math.max(cost*2.5,atrPct*.65,quantile(beforeTarget,.8)-offsetPct+atrPct*.25);
  return {side,anchor,createdAt:now,expiresAt:now+15*60_000,signalKey:`${f.signalAt}:${side}`,offsetPct,stopPct,targetPct,
    ...estimate(episodes,side,offsetPct,stopPct,targetPct,cost),mode:offsetPct===0?'NOW' as const:'PULLBACK' as const};
 // The user's entry thesis is the majority first tradable swing. Path replay
 // still owns the stop/target and records expectancy, hit rate and losing-path
 // share for learning, but those retrospective ratios must not silently become
 // a second direction veto. Keep only executable safety/economics boundaries.
 }).filter(p=>p.stopPct/(1-sign*p.offsetPct/100)<=2
  &&(p.targetPct-cost)/(p.stopPct+cost)>=ANALOG_MIN_NET_REWARD_R
  &&p.fillPct>=40);
 const immediate=alternatives.find(p=>p.mode==='NOW'),delayed=alternatives.find(p=>p.mode==='PULLBACK');
 // Prefer immediacy unless a frequently-filled retracement materially improves expectancy.
 if(delayed&&immediate&&delayed.fillPct>=60&&delayed.expectedNetR>immediate.expectedNetR+.1&&immediate.lossPct>=25)return delayed;
 return immediate??null;
}
export function buildAnalogCandidate(input:{symbol:string;candles:Hte31Candle[];btcCandles:Hte31Candle[];now:number;price:number;volumeUsd:number;volumeRank:number;costBps:number;forecast?:HistoricalForecast;intent?:AnalogIntent}):DirectMarketCandidate{
 const cs=completeFiveMinutes(input.candles,input.now),last=cs.at(-1),f=input.forecast;
 const atr=mean(cs.slice(-15).slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-cs.slice(-15)[i].close),Math.abs(c.low-cs.slice(-15)[i].close))));
 const bias=historicalDirection(f,input.now,input.costBps),side=bias.side==='SHORT'?'SHORT':'LONG',sign=side==='LONG'?1:-1;
 const pending=input.intent&&input.intent.side===bias.side&&input.intent.expiresAt>input.now?input.intent:null;
 const plan=bias.side!=='WAIT'&&f&&last?(pending??planAnalogEntry(f,side,atr/last.close*100,last.close,input.now)):null;
 const entry=plan?plan.anchor*(1-sign*plan.offsetPct/100):0;
 const stop=plan?entry-sign*plan.anchor*plan.stopPct/100:0,target=plan?entry+sign*plan.anchor*plan.targetPct/100:0;
 const atrPct=last?atr/last.close*100:0;
 const betterPct=plan?Math.min(plan.stopPct*.45,Math.max(atrPct*.6,.08)):0;
 const chasePct=plan?Math.min(plan.targetPct*.2,Math.max(atrPct*.25,.03)):0;
 const zone:[number,number]=side==='LONG'
  ?[entry*(1-betterPct/100),entry*(1+chasePct/100)]
  :[entry*(1-chasePct/100),entry*(1+betterPct/100)];
 const data=cs.length>=24&&cs.slice(-24).every((c,i,a)=>i===0||minuteTime(c)-minuteTime(a[i-1])===300_000)&&!!last&&input.now-minuteTime(last)-300_000<300_000;
 const priceReady=!!plan&&input.price>=zone[0]&&input.price<=zone[1];
 const reason=!data?'五分钟行情不完整或延迟':bias.side==='WAIT'?bias.reason:!plan?'历史保护距离超过2%，或扣费后目标不足0.8倍完整风险，暂不开单':!priceReady?`${plan.mode==='PULLBACK'?'等待先反向到':'等待回到入场区'} ${entry.toPrecision(7)}；最多等待十五分钟`:`${bias.reason}，当前价格可直接入场`;
 const checks=[{key:'data',label:'行情完整',passed:data,detail:'仅使用完整连续五分钟K线'},
 {key:'history-direction',label:'历史总体方向',passed:bias.side!=='WAIT',detail:bias.reason},
 {key:'setup',label:'历史路径保护',passed:!!plan,detail:plan?`扣费后目标至少0.8倍完整风险；历史目标命中${plan.takeProfitPct.toFixed(0)}%，净亏结束${plan.lossPct.toFixed(0)}%，保本保护${plan.protectedExitPct.toFixed(0)}%，含费回放${plan.expectedNetR.toFixed(2)}风险倍数仅用于学习`:'历史保护距离超过2%，或扣费后目标不足0.8倍完整风险'},
 {key:'liquidity',label:'流动性',passed:input.volumeUsd>=12_000_000,detail:'固定币池仍须有可交易成交额'},
 {key:'entry-price',label:'入场价格',passed:priceReady,detail:reason}];
 const ready=checks.every(c=>c.passed),score=checks.filter(c=>c.passed).length/checks.length*100;
 const btc=completeFiveMinutes(input.btcCandles,input.now),byTime=new Map(btc.map(c=>[minuteTime(c),c.close]));
 const tail=cs.slice(-121),pairs=tail.slice(1).flatMap((c,i)=>{const p=tail[i],b=byTime.get(minuteTime(c)),bp=byTime.get(minuteTime(p));return b&&bp?[[c.close/p.close-1,b/bp-1]]:[];});
 const mx=mean(pairs.map(p=>p[0])),my=mean(pairs.map(p=>p[1])),den=Math.sqrt(pairs.reduce((s,p)=>s+(p[0]-mx)**2,0)*pairs.reduce((s,p)=>s+(p[1]-my)**2,0));
 const correlation=input.symbol==='BTC_USDT'?1:pairs.length>=24&&den>0?pairs.reduce((s,p)=>s+(p[0]-mx)*(p[1]-my),0)/den:null;
 const setup='ANALOG_PATH' as const,setupLabel='历史路径方向交易';
 return {symbol:input.symbol,batchId:`analog:${Math.floor(input.now/300_000)}`,observedAt:input.now,freshness:data?'FRESH':'UNAVAILABLE',scanStage:'DEEP',volumeRank:input.volumeRank,volumeUsd:input.volumeUsd,
 riskClusterId:correlation==null?'correlation-unknown':Math.abs(correlation)>=.7?'btc-correlated':`independent-${input.symbol}`,btcCorrelation:correlation,location:'MIDDLE',paths:f?.swingBias?{up:f.swingBias.upPct,down:f.swingBias.downPct,rangeOrInvalid:f.swingBias.neutralPct}:{up:0,down:0,rangeOrInvalid:100},directionalScore:bias.side==='WAIT'?0:sign,netEdgeR:plan?.expectedNetR??0,confidence:Math.round(f?.similarity??0),setup,setupLabel,setupScore:score,
 setupEvaluations:[{setup,setupLabel,side,score,triggered:bias.side!=='WAIT',qualified:ready,selected:ready,blockers:checks.filter(c=>!c.passed).map(c=>c.detail)}],
 decision:ready?side:'WAIT',entryZone:plan?zone:null,invalidationPrice:plan?stop:null,targets:plan?[entry+(target-entry)*.5,target]:[],
 evidence:[bias.reason,reason,'历史中途逆向波动决定初始保护距离；更远止损对应更小仓位'],counterEvidence:ready?[]:[reason,...checks.filter(c=>!c.passed).map(c=>c.detail)],checks,candles5m:cs,forecast:f?{...f,episodes:undefined}:undefined,assetRegime:'historical-path',maxHoldingMinutes:plan?Math.max(1,Math.min(60,Math.floor((plan.createdAt+3600000-input.now)/60000))):60,analogIntent:plan??undefined,
 scalp:plan?{signalAt:f!.signalAt,structureAt:plan.createdAt,signalKey:`${input.symbol}:${plan.signalKey}`,costBps:scalpCostBps(input.costBps),confirmationPrice:entry+(stop-entry)*.5}:undefined};
}
export function evaluateAnalogPosition(input:{side:'LONG'|'SHORT';entryPrice:number;initialStopPrice:number;currentStopPrice:number;entryAt:number;currentPrice:number;observedAt:number;roundTripCostBps:number;candles:Hte31Candle[];confirmationPrice:number}):DirectPositionDecision{
 const sign=input.side==='LONG'?1:-1,risk=Math.abs(input.entryPrice-input.initialStopPrice),progress=sign*(input.currentPrice-input.entryPrice);
 const cs=completeFiveMinutes(input.candles,input.observedAt).filter(c=>minuteTime(c)>=input.entryAt);
 const elapsed=input.observedAt-input.entryAt,cost=input.entryPrice*scalpCostBps(input.roundTripCostBps)/10000;
 const peak=Math.max(0,...cs.map(c=>sign===1?c.high-input.entryPrice:input.entryPrice-c.low));
 const fastLoss=elapsed>=600_000&&progress<=-Math.max(risk*.2,cost*1.5);
 const stalled=elapsed>=1_200_000&&peak<cost*1.5&&progress<=0;
 const faded=elapsed>=1_800_000&&progress<=cost;
 const expired=elapsed>=3_600_000,exit=fastLoss||stalled||faded||expired;
 const protect=!exit&&peak>=Math.max(cost*1.5,risk*.35);
 const reason=fastLoss?'入场后十分钟仍明显逆向，快速退出':stalled?'二十分钟没有覆盖成本的推进，退出':faded?'三十分钟未保住扣费后利润，退出':expired?'一小时持仓期限到，退出':protect?'盘中推进已覆盖成本，收紧至含费保本位':'允许计划内波动，保持结构止损';
 return {policyVersion:DIRECT_POSITION_POLICY_VERSION,action:exit?'EXIT':protect?'PROTECT':'HOLD',reason,observedAt:input.observedAt,completedBars:cs.length,progressR:risk>0?progress/risk:0,fastStructureR:0,slowStructureR:0,proposedStopPrice:protect?input.entryPrice+sign*cost:null,exitCode:exit?'brain_time_decay':null,reversalWatch:false};
}
export function analogRiskAllocation(equity:number,usedRisk:number,remainingSymbols:number,correlated:boolean) {
 if(!Number.isFinite(equity)||equity<=0||!Number.isFinite(usedRisk)||usedRisk<0||!Number.isFinite(remainingSymbols))return 0;
 const availableRate=Math.max(0,equity*ANALOG_RISK_POLICY.portfolioRiskRate-usedRisk)/equity;
 return Math.min(ANALOG_RISK_POLICY.riskRate,availableRate)*(correlated?.5:1);
}
