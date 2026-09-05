import type { AnalogIntent } from "./analog-path-strategy.ts";
import {
  getMarketExchange,
  type MarketAnalysisPacket,
  type MarketUniverseTicker,
} from "./exchange-market.ts";
import { buildAnalogCandidate } from "./analog-path-strategy.ts";
import { boundedMap, type MinuteCache } from "./scalp-feed.ts";
import type { HistoricalForecast } from "./historical-forecast.ts";
import type { DirectMarketCandidate, DirectMarketRadarItem, DirectTwelveHourActivity } from "./direct-market-types.ts";
import { HISTORICAL_UNIVERSE, historicalUniverse } from "./direct-market-universe.ts";
import type { ArchiveProgress } from "./historical-archive.ts";
import { getHte31Dashboard } from "./hte31-repository.ts";
import type { Hte31Candle } from "./hte31-types.ts";
import { buildResonanceGlobalMarket, type ResonanceGlobalMarketState } from "./resonance-global-market.ts";
import { getSettings, type AppSettings } from "./settings-repository.ts";

export type Hte31ScanPhase = "config" | "universe" | "deep" | "candles" | "evaluate";
export type Hte31MarketState = ResonanceGlobalMarketState;

export type Hte31ScanJob = {
  version: 4;
  id: string;
  phase: Hte31ScanPhase;
  startedAt: number;
  rotationOffset: number;
  lastObservedAt?: Record<string, number>;
  attempts: Partial<Record<Hte31ScanPhase, number>>;
  previousMarket?: Hte31MarketState | null;
  settings?: AppSettings;
  coreSymbols?: string[];
  openSymbols?: string[];
  openPositions?: { symbol: string; traderId: string; side: "LONG" | "SHORT" }[];
  universe?: MarketUniverseTicker[];
  market?: Hte31MarketState;
  target?: MarketUniverseTicker;
  packet?: MarketAnalysisPacket;
  events?: { time: number; title: string }[];
  candles?: Hte31Candle[];
  archive?: ArchiveProgress;
  btcCandles?: Hte31Candle[];
  directCandidate?: DirectMarketCandidate;
  minuteFeeds?: Record<string,{symbol:string;feed:MinuteCache;forecast?:HistoricalForecast;intent?:AnalogIntent}>;
  openedTradeId?: string | null;
  openReason?: string;
};

export type Hte31ScanCompleted = {
  observedAt: number;
  target: string;
  universe: MarketUniverseTicker[];
  market: Hte31MarketState;
  packet: MarketAnalysisPacket;
  directCandidate: DirectMarketCandidate;
  candidates?: DirectMarketCandidate[];
  feedErrors?: string[];
  directRadar?: DirectMarketRadarItem[];
  activity12h?: { current: DirectTwelveHourActivity; lastCompleted: DirectTwelveHourActivity | null };
  openedTradeId: string | null;
  openReason: string;
  settings: {
    scanEnabled: boolean;
    coreSymbols: string[];
    universeLimit: number;
    trialCapitalUsdt: number;
  };
};

export type Hte31ScanStep =
  | { kind: "progress"; job: Hte31ScanJob }
  | { kind: "paused"; observedAt: number }
  | { kind: "completed"; result: Hte31ScanCompleted };

const marketExchange = getMarketExchange();

export function createHte31ScanJob(rotationOffset: number, previousMarket: Hte31MarketState | null = null, lastObservedAt: Record<string, number> = {}): Hte31ScanJob {
  return {
    version: 4,
    id: crypto.randomUUID(),
    phase: "config",
    startedAt: Date.now(),
    rotationOffset,
    lastObservedAt,
    attempts: {},
    previousMarket,
  };
}

export function hte31PhaseLabel(phase: Hte31ScanPhase) {
  return ({
    config: "读取运行配置",
    universe: "读取固定六币报价",
    deep: "读取固定六币五分钟行情",
    candles: "读取位置与多周期结构",
    evaluate: "评估十五分钟方向与五分钟回踩",
  } satisfies Record<Hte31ScanPhase, string>)[phase];
}

export async function runHte31ScanStep(job: Hte31ScanJob,
  loadMinutes: (symbol: string, now: number) => Promise<MinuteCache>, loadAuxiliary: (symbol:string) => Promise<HistoricalForecast | undefined>,loadIntent:(symbol:string)=>Promise<AnalogIntent|undefined>=async()=>undefined): Promise<Hte31ScanStep> {
  if (job.phase === "config") {
    const settings = await getSettings();
    if (!settings.scanEnabled) return { kind: "paused", observedAt: Date.now() };
    return {kind:"progress",job:{...job,phase:"universe",settings,coreSymbols:[...HISTORICAL_UNIVERSE]}};
  }
  if (job.phase === "universe") {
    const universe=historicalUniverse(await marketExchange.fetchUniverse(1,HISTORICAL_UNIVERSE));
    if(!universe.length) throw new Error("固定币池报价暂不可用");
    const market=buildResonanceGlobalMarket(universe,job.previousMarket??null);
    return {kind:"progress",job:{...job,phase:"deep",universe,market,target:universe[0]}};
  }
  if(job.phase === "deep") {
    if(!job.universe) throw new Error("缺少固定币池");
    const now=Date.now(), feeds=await boundedMap(job.universe,2,async row => ({symbol:row.symbol,feed:await loadMinutes(row.symbol,now),forecast:await loadAuxiliary(row.symbol).catch(()=>undefined),intent:await loadIntent(row.symbol)}));
    const minuteFeeds=Object.fromEntries(feeds.flatMap(r=>r.status==='fulfilled'?[[r.value.symbol,r.value]]:[]));
    return {kind:"progress",job:{...job,phase:"evaluate",minuteFeeds}};
  }
  if(job.phase === "evaluate") {
    if(!job.universe||!job.market||!job.settings) throw new Error("五分钟评估缺少状态");
    const now=Date.now(), minuteFeeds=job.minuteFeeds??{};
    const candidates=job.universe.map((row,i)=>buildAnalogCandidate({symbol:row.symbol,candles:minuteFeeds[row.symbol]?.feed.rows??[],
      btcCandles:minuteFeeds.BTC_USDT?.feed.rows??[],now,price:row.price,volumeUsd:row.volumeUsd,volumeRank:i+1,
      costBps:job.settings!.roundTripCostBps,forecast:minuteFeeds[row.symbol]?.forecast,intent:minuteFeeds[row.symbol]?.intent}));
    const directCandidate=[...candidates].sort((a,b)=>Number(b.decision!=='WAIT')-Number(a.decision!=='WAIT')||b.setupScore-a.setupScore)[0];
    const row=job.universe.find(r=>r.symbol===directCandidate.symbol)!;
    const market={futuresPrice:row.price,volumeUsd:row.volumeUsd,changePercentage:row.changePercentage,markPrice:null,spotPrice:null,fundingRate:row.fundingRate,
      openInterestChangePct:null,basisPct:row.basisPct,spotCvdRatio:null,orderBookImbalance:null,liquidationImbalance:null,multiTimeframeTrend:null,
      timeframeTrend15m:null,timeframeTrend1h:null,timeframeTrend4h:null,macroEventRisk:null,macroEventLabel:"未读取事件日历，不作为确认依据",optionsIvPercentile:null,etfFlowScore:null,sourceAgesMs:{ticker:now-job.startedAt,candles:0}};
    // Compatibility read model only: this legacy presentation decision never executes orders.
    const packet:MarketAnalysisPacket={mode:directCandidate.freshness==='FRESH'?'live':'degraded',source:'Gate 五分钟行情',researchStatus:'uncalibrated-beta',observedAt:now,latencyMs:now-job.startedAt,symbol:row.symbol,
      market,sourceErrors:{},decision:{symbol:row.symbol,observedAt:now,state:directCandidate.decision==='WAIT'?'observing':'confirmed',stateLabel:'短线模拟验证',side:directCandidate.decision,
        confidence:directCandidate.confidence,directionalScore:directCandidate.directionalScore,posteriorLong:0.5,dataQuality:directCandidate.freshness==='FRESH'?1:0,
        regime:directCandidate.assetRegime,action:directCandidate.decision==='WAIT'?'等待回踩确认':'复核最新报价',thesis:directCandidate.evidence.join('；'),entryZone:directCandidate.entryZone,
        trigger:directCandidate.setupLabel,invalidationPrice:directCandidate.invalidationPrice,invalidation:'回踩结构失效',expiresMinutes:1,entryPlan:null,metrics:[],
        evidence:directCandidate.evidence.map(title=>({title,detail:title,score:0})),counterEvidence:directCandidate.counterEvidence.map(title=>({title,detail:title})),
        diagnostics:{rsi14:null,atrPct:null,volumeRatio:null,confirmationCount:directCandidate.checks.filter(c=>c.passed).length,contradictionCount:directCandidate.counterEvidence.length,
          staleSources:directCandidate.freshness==='FRESH'?[]:['candles'],macroEventRisk:0,optionsIvPercentile:null,experienceSampleCount:0,experienceAdjustment:0,lastCandleHigh:null,lastCandleLow:null,
          lastCompletedCandleAt:directCandidate.scalp?.signalAt??null,excludedIncompleteCandle:true}}};
    const feedErrors=Object.values(minuteFeeds).flatMap(v=>v.feed.error?[`${v.symbol}：${v.feed.error}`]:[]);
    if(Object.keys(minuteFeeds).length<job.universe.length) feedErrors.push('部分五分钟行情未能读取');
    return {kind:"completed",result:{observedAt:now,target:row.symbol,universe:job.universe,market:{...job.market,observedAt:now},packet,directCandidate,
      candidates,feedErrors,openedTradeId:null,openReason:directCandidate.counterEvidence[0]??"五分钟回踩信号已就绪，复核实时价格与风险",
      settings:{scanEnabled:job.settings.scanEnabled,coreSymbols:[...HISTORICAL_UNIVERSE],universeLimit:job.universe.length,trialCapitalUsdt:job.settings.trialCapitalUsdt}}};
  }
  // Checkpoints from an interrupted older phase restart at the bounded minute feed.
  return {kind:"progress",job:{...job,phase:"deep"}};
}

export async function getHte31RuntimeDashboard() {
  return getHte31Dashboard();
}
