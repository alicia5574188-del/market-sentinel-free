import { loadMinuteFeed, nextMinuteScan, type MinuteCache } from "../lib/scalp-feed";
import { evaluateScalpPosition, scalpCostBps } from "../lib/scalp-strategy";
import { buildHistoricalForecast, type HistoricalForecast } from "../lib/historical-forecast";
/// <reference types="@cloudflare/workers-types" />

import { loadHistoricalForecastCandles } from "../lib/historical-forecast-cache";
import { DurableObject } from "cloudflare:workers";
import { setRuntimeDb } from "../db";
import { setRuntimeBindings } from "../lib/runtime-bindings";
import { fetchGateChartCandles, fetchGateMinuteCandles, fetchGatePositionQuotes, SYMBOL_PATTERN } from "../lib/gate-client";
import {
  applyHte31PositionQuote,
  completeHte31PostExitObservation,
  finalizePendingHte31PaperCapitalReset,
  getHte31PaperResetState,
  listHte31OpenTrades,
  markHte31PostExitObservationUnavailable,
  nextHte31PostExitObservation,
} from "../lib/hte31-repository";
import { ensureDirectMarketReleaseCutover } from "../lib/direct-market-release";
import {
  createHte31ScanJob,
  hte31PhaseLabel,
  runHte31ScanStep,
  type Hte31ScanCompleted,
  type Hte31ScanJob,
} from "../lib/hte31-scanner";
import { getSettings } from "../lib/settings-repository";
import { openDirectMarketTrade, scalpAccountRisk } from "../lib/direct-market-execution";
import {
  evaluateDirectPosition,
  hasAdaptivePositionPolicy,
  type DirectPositionDecision,
} from "../lib/direct-market-position-brain";
import type { SchedulerWorkerStatus } from "../lib/background-scheduler";
import {
  emptyDirectTwelveHourActivity,
  recordDirectTwelveHourActivity,
  type DirectTwelveHourActivityState,
} from "../lib/direct-market-activity";
import {
  DIRECT_MARKET_BRAIN_VERSION,
  type DirectCoreSetup,
  type DirectMarketCandidate,
  type DirectMarketRadarItem,
} from "../lib/direct-market-types";
import type { CloudflareEnv } from "./index";

// This generation bump resets only Durable Object scheduler/checkpoint state.
// D1 trades, learning, simulation epochs, live credentials and live-order
// lineage remain untouched.
const CLEAN_RUNTIME_VERSION = DIRECT_MARKET_BRAIN_VERSION;
const SCANNER_CYCLE_INTERVAL_MS = 60_000;
const TRADE_MANAGER_ACTIVE_INTERVAL_MS = 15_000;
const TRADE_MANAGER_IDLE_INTERVAL_MS = 60_000;
const TRADE_MANAGER_ACTIVE_HEARTBEAT_MS = 60_000;
const TRADE_MANAGER_IDLE_HEARTBEAT_MS = 5 * 60_000;

type ScannerRuntime = {
  version: 4;
  rotationOffset: number;
  job: Hte31ScanJob | null;
  readModel: Hte31ScanCompleted | null;
  directBySymbol?: Record<string, Omit<DirectMarketCandidate, "candles5m">>;
  directHistory?: { symbol: string; observedAt: number; referencePrice: number | null; location: string; decision: string; paths: DirectMarketCandidate["paths"]; riskClusterId: string }[];
  activity12h?: DirectTwelveHourActivityState;
  status: SchedulerWorkerStatus;
};

type TradeManagerRuntime = {
  version: 2;
  positionReviewBuckets: Record<string, number>;
  status: SchedulerWorkerStatus;
};

function baseStatus(): SchedulerWorkerStatus {
  return {
    state: "starting",
    lastRunAt: null,
    nextRunAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
}

function baseScannerRuntime(): ScannerRuntime {
  return {
    version: 4,
    rotationOffset: 0,
    job: null,
    readModel: null,
    directBySymbol: {},
    directHistory: [],
    activity12h: { current: emptyDirectTwelveHourActivity(Date.now()), lastCompleted: null },
    status: baseStatus(),
  };
}

function baseTradeManagerRuntime(): TradeManagerRuntime {
  return { version: 2, positionReviewBuckets: {}, status: baseStatus() };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown Resonance runtime error";
}

function initialize(env: CloudflareEnv) {
  setRuntimeDb(env.DB);
  setRuntimeBindings(env);
}

function withoutCandles(candidate: DirectMarketCandidate): Omit<DirectMarketCandidate, "candles5m"> {
  const { candles5m: _candles, forecast: _forecast, ...compact } = candidate;
  void _forecast;
  void _candles;
  return compact;
}

function buildDirectRadar(result: Hte31ScanCompleted, directBySymbol: Record<string, Omit<DirectMarketCandidate, "candles5m">>): DirectMarketRadarItem[] {
  const now = Date.now();
  return result.universe.map((row, index) => {
    const candidate = directBySymbol[row.symbol] ?? null;
    const freshCandidate = candidate && now - candidate.observedAt <= 3 * 60_000 ? candidate : null;
    return {
      symbol: row.symbol,
      observedAt: freshCandidate?.observedAt ?? result.observedAt,
      volumeRank: index + 1,
      volumeUsd: row.volumeUsd,
      changePercentage: row.changePercentage,
      scanStage: freshCandidate ? "DEEP" : "LIGHT",
      freshness: freshCandidate ? (now - freshCandidate.observedAt <= 90_000 ? "FRESH" : "STALE") : "FRESH",
      candidate: freshCandidate,
    };
  });
}

class Hte31ScanSliceError extends Error {
  constructor(readonly job: Hte31ScanJob, cause: unknown) {
    super(errorMessage(cause));
    this.name = "Hte31ScanSliceError";
  }
}

export class HTE31MarketScanner extends DurableObject<CloudflareEnv> {
  private readonly intervalMs = SCANNER_CYCLE_INTERVAL_MS;

  private async generationReset() {
    const generation = await this.ctx.storage.get<string>("generation");
    if (generation === CLEAN_RUNTIME_VERSION) return;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("generation", CLEAN_RUNTIME_VERSION);
  }

  private async runtime() {
    return await this.ctx.storage.get<ScannerRuntime>("runtime") ?? baseScannerRuntime();
  }

  private async saveRuntime(runtime: ScannerRuntime) {
    await this.ctx.storage.put("runtime", runtime);
  }

  async ensure(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const runtime = await this.runtime();
    const status = runtime.status;
    const now = Date.now();
    let alarm = await this.ctx.storage.getAlarm();
    if (status.circuitOpen && status.retryAfter && status.retryAfter > now) {
      if (alarm !== status.retryAfter) await this.ctx.storage.setAlarm(status.retryAfter);
      return { ...status, nextRunAt: status.retryAfter };
    }
    if (alarm == null || alarm < now - 5_000 || alarm > now + 180_000) {
      alarm = now + 1_000;
      await this.ctx.storage.setAlarm(alarm);
    }
    return { ...status, nextRunAt: alarm };
  }

  async status(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const runtime = await this.runtime();
    return { ...runtime.status, nextRunAt: await this.ctx.storage.getAlarm() ?? runtime.status.nextRunAt };
  }

  async wake(): Promise<{ ok: true; nextRunAt: number }> {
    await this.generationReset();
    const runtime = await this.runtime();
    const now = Date.now();
    const nextRunAt = runtime.status.circuitOpen && runtime.status.retryAfter && runtime.status.retryAfter > now
      ? runtime.status.retryAfter
      : now + 1_000;
    await this.ctx.storage.setAlarm(nextRunAt);
    return { ok: true, nextRunAt };
  }

  async readModel(): Promise<Hte31ScanCompleted | null> {
    await this.generationReset();
    return (await this.runtime()).readModel;
  }

  async marketSnapshot(symbol: string) {
    if (!SYMBOL_PATTERN.test(symbol)) return { readModel: null, deep: null };
    const readModel = await this.readModel();
    return {
      readModel,
      deep: readModel?.packet?.symbol === symbol ? { savedAt: readModel.packet.observedAt, packet: readModel.packet } : null,
    };
  }

  async minuteSnapshot(symbol:string) {
    if(!SYMBOL_PATTERN.test(symbol)) return [];
    return (await this.ctx.storage.get<MinuteCache>(`minute:${symbol}`))?.rows ?? [];
  }

  private async enrichHistory(symbol:string,costBps:number) {
    const now=Date.now(), prior=await this.ctx.storage.get<number>("auxiliary-at")??0;
    if(now-prior<5*60_000) return;
    await this.ctx.storage.put("auxiliary-at",now);
    try {
      const recent=await loadHistoricalForecastCandles(this.ctx.storage,fetchGateChartCandles,symbol,now);
      const history=this.env.HISTORICAL_ARCHIVE ? await this.env.HISTORICAL_ARCHIVE.getByName(`history:${symbol}`).history(symbol,now,recent) : null;
      const forecast=buildHistoricalForecast({candles:history?.candles??recent,now,costBps:scalpCostBps(costBps),stopPct:0.3});
      forecast.archive=history?.archive;
      await this.ctx.storage.put(`auxiliary:${symbol}`,forecast);
    } catch { /* Auxiliary outage cannot pause minute entries or position protection. */ }
  }

  private async runSlice(job: Hte31ScanJob) {
    const maxSteps = job.phase === "config" || job.phase === "deep" || job.phase === "candles" ? 2 : 1;
    let current = job;
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      try {
        const step = await runHte31ScanStep(current, (symbol,now)=>loadMinuteFeed(this.ctx.storage,fetchGateMinuteCandles,symbol,now),
          symbol=>this.ctx.storage.get<HistoricalForecast>(`auxiliary:${symbol}`));
        if (step.kind !== "progress") return step;
        current = step.job;
      } catch (error) {
        throw new Hte31ScanSliceError(current, error);
      }
    }
    return { kind: "progress" as const, job: current };
  }

  private inFlight: Promise<SchedulerWorkerStatus> | null = null;
  private runCycle(initialRuntime?: ScannerRuntime): Promise<SchedulerWorkerStatus> {
    if(this.inFlight) return this.inFlight;
    this.inFlight=this.runCycleOnce(initialRuntime).finally(()=>{this.inFlight=null});
    return this.inFlight;
  }
  private async runCycleOnce(initialRuntime?: ScannerRuntime): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    let runtime = initialRuntime ?? await this.runtime();
    const now = Date.now();
    let previous = runtime.status;

    if (previous.circuitOpen && previous.retryAfter && previous.retryAfter > now) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm !== previous.retryAfter) await this.ctx.storage.setAlarm(previous.retryAfter);
      return { ...previous, nextRunAt: previous.retryAfter };
    }
    if (previous.lastRunAt && now - previous.lastRunAt < 750) return previous;
    if (previous.nextRunAt != null && previous.nextRunAt > now + 250 && now - (previous.lastRunAt ?? 0) < 90_000) {
      return previous;
    }

    const lastObservedAt = Object.fromEntries(Object.entries(runtime.directBySymbol ?? {}).map(([symbol, candidate]) => [symbol, candidate.observedAt]));
    let job = runtime.job ?? createHte31ScanJob(runtime.rotationOffset, runtime.readModel?.market ?? null, lastObservedAt);
    if (job.rotationOffset !== runtime.rotationOffset) {
      job = createHte31ScanJob(runtime.rotationOffset, runtime.readModel?.market ?? null, lastObservedAt);
    }

    if (previous.circuitOpen && previous.retryAfter && previous.retryAfter <= now) {
      job = {
        ...job,
        attempts: { ...job.attempts, [job.phase]: 0 },
      };
      previous = { ...previous, circuitOpen: false, retryAfter: null, lastError: null };
    }

    const priorAttempt = job.attempts[job.phase] ?? 0;
    if (priorAttempt >= 3) {
      const retryAfter = now + 5 * 60_000;
      const status: SchedulerWorkerStatus = {
        ...previous,
        state: "degraded",
        nextRunAt: retryAfter,
        lastError: `Resonance 阶段「${hte31PhaseLabel(job.phase)}」连续 3 次未完成，熔断 5 分钟。`,
        phase: hte31PhaseLabel(job.phase),
        phaseAttempt: priorAttempt,
        circuitOpen: true,
        retryAfter,
        jobId: job.id,
      };
      runtime = { ...runtime, job, status };
      await this.saveRuntime(runtime);
      await this.ctx.storage.setAlarm(retryAfter);
      return status;
    }

    const attemptPhase = job.phase;
    const attempt = priorAttempt + 1;
    job = { ...job, attempts: { ...job.attempts, [job.phase]: attempt } };
    const startingStatus: SchedulerWorkerStatus = {
      ...previous,
      state: "starting",
      lastRunAt: now,
      nextRunAt: null,
      lastError: null,
      phase: hte31PhaseLabel(job.phase),
      phaseAttempt: attempt,
      circuitOpen: false,
      retryAfter: null,
      jobId: job.id,
    };
    runtime = { ...runtime, job, status: startingStatus };
    await this.saveRuntime(runtime);

    initialize(this.env);
    try {
      const step = await this.runSlice(job);
      if (step.kind === "paused") {
        const nextRunAt = Date.now() + TRADE_MANAGER_IDLE_INTERVAL_MS;
        const status: SchedulerWorkerStatus = {
          state: "paused",
          lastRunAt: now,
          nextRunAt,
          lastSuccessAt: previous.lastSuccessAt,
          lastError: null,
          analyzed: 0,
          symbols: [],
          phase: null,
          phaseAttempt: 0,
          circuitOpen: false,
          retryAfter: null,
          jobId: null,
        };
        await this.saveRuntime({ ...runtime, job: null, status });
        await this.ctx.storage.setAlarm(nextRunAt);
        return status;
      }

      if (step.kind === "progress") {
        const nextRunAt = Date.now() + 1_000;
        const status: SchedulerWorkerStatus = {
          ...previous,
          state: "starting",
          lastRunAt: now,
          nextRunAt,
          lastError: null,
          phase: hte31PhaseLabel(step.job.phase),
          phaseAttempt: step.job.attempts[step.job.phase] ?? 0,
          circuitOpen: false,
          retryAfter: null,
          jobId: step.job.id,
        };
        await this.saveRuntime({ ...runtime, job: step.job, status });
        await this.ctx.storage.setAlarm(nextRunAt);
        return status;
      }

      let result = step.result;
      const activeSymbols = new Set(result.universe.map((row) => row.symbol));
      const directBySymbol = Object.fromEntries([
        ...Object.entries(runtime.directBySymbol ?? {}).filter(([symbol]) => activeSymbols.has(symbol)),
        ...(result.candidates??[result.directCandidate]).map(c=>[c.symbol,withoutCandles(c)] as const),
      ]);
      const directHistory = [{
        symbol: result.directCandidate.symbol,
        observedAt: result.directCandidate.observedAt,
        referencePrice: result.directCandidate.entryZone ? (result.directCandidate.entryZone[0] + result.directCandidate.entryZone[1]) / 2 : result.packet.market.futuresPrice,
        location: result.directCandidate.location,
        decision: result.directCandidate.decision,
        paths: result.directCandidate.paths,
        riskClusterId: result.directCandidate.riskClusterId,
      }, ...(runtime.directHistory ?? [])].slice(0, 96);
      const batch=result.candidates??[result.directCandidate];
      const settings=await getSettings();
      const executable=batch.filter(c=>c.decision!=="WAIT").sort((a,b)=>b.setupScore-a.setupScore);
      const quotes=executable.length?await fetchGatePositionQuotes(executable.map(c=>c.symbol)):[];
      let activity12h=runtime.activity12h??{current:emptyDirectTwelveHourActivity(result.observedAt),lastCompleted:null};
      let firstOpened: string|null=null;
      for(const candidate of batch) {
        let openedSetup:DirectCoreSetup|null=null, openReason=candidate.counterEvidence[0]??"等待一分钟入场确认";
        if(candidate.decision!=="WAIT") {
          const opened=await openDirectMarketTrade({candidate,universe:result.universe.map(r=>r.symbol),settings,
            freshQuote:quotes.find(q=>q.symbol===candidate.symbol)??null,portfolioRank:executable.indexOf(candidate)+1});
          openedSetup=opened.opened?candidate.setup:null; openReason=opened.reason;
          firstOpened=firstOpened??opened.opened?.id??null;
        }
        activity12h=recordDirectTwelveHourActivity({activity:activity12h,candidate,openedSetup,openReason,expectedIntervalMs:SCANNER_CYCLE_INTERVAL_MS});
        if(candidate.symbol===result.target) result={...result,openReason};
      }
      result={...result,openedTradeId:firstOpened};
      if(firstOpened) await this.env.POSITION_MONITOR?.getByName("position-monitor").wake();
      // Background auxiliary work has its own keys; it never overwrites scan state.
      const historySymbol=result.universe[runtime.rotationOffset%result.universe.length].symbol;
      // Live minute data takes priority over optional historical traffic.
      if (!result.feedErrors?.length) this.ctx.waitUntil(this.enrichHistory(historySymbol,settings.roundTripCostBps));
      const readModel = { ...result, candidates: undefined, directRadar: buildDirectRadar(result, directBySymbol), activity12h };
      const nextRunAt = nextMinuteScan(Date.now());
      const status: SchedulerWorkerStatus = {
        state: result.feedErrors?.length ? "degraded" : "live",
        lastRunAt: now,
        nextRunAt,
        lastSuccessAt: result.feedErrors?.length===result.universe.length ? previous.lastSuccessAt : result.observedAt,
        lastError: result.feedErrors?.join("；") || null,
        analyzed: batch.filter(c=>c.freshness==='FRESH').length,
        symbols: batch.map(c=>c.symbol),
        phase: null,
        phaseAttempt: 0,
        circuitOpen: false,
        retryAfter: null,
        jobId: null,
      };
      await this.saveRuntime({
        ...runtime,
        rotationOffset: runtime.rotationOffset + 1,
        job: null,
        readModel,
        directBySymbol,
        directHistory,
        activity12h,
        status,
      });
      await this.ctx.storage.setAlarm(nextRunAt);
      return status;
    } catch (error) {
      let failedJob = error instanceof Hte31ScanSliceError ? error.job : job;
      if (failedJob.phase !== attemptPhase) {
        failedJob = {
          ...failedJob,
          attempts: {
            ...failedJob.attempts,
            [failedJob.phase]: (failedJob.attempts[failedJob.phase] ?? 0) + 1,
          },
        };
      }
      const phaseAttempt = failedJob.attempts[failedJob.phase] ?? attempt;
      const nextRunAt = Date.now() + 10_000;
      const status: SchedulerWorkerStatus = {
        ...previous,
        state: "error",
        lastRunAt: now,
        nextRunAt,
        lastError: `Resonance 阶段「${hte31PhaseLabel(failedJob.phase)}」失败：${errorMessage(error)}`,
        phase: hte31PhaseLabel(failedJob.phase),
        phaseAttempt,
        circuitOpen: false,
        retryAfter: null,
        jobId: failedJob.id,
      };
      await this.saveRuntime({ ...runtime, job: failedJob, status });
      await this.ctx.storage.setAlarm(nextRunAt);
      return status;
    }
  }

  async runIfDue() {
    await this.generationReset();
    const runtime = await this.runtime();
    const now = Date.now();
    if (runtime.status.nextRunAt != null && runtime.status.nextRunAt > now + 1_000) return runtime.status;
    return this.runCycle(runtime);
  }

  async alarm() { await this.runCycle(); }
}

export class HTE31TradeManager extends DurableObject<CloudflareEnv> {
  private async generationReset() {
    const generation = await this.ctx.storage.get<string>("generation");
    if (generation === CLEAN_RUNTIME_VERSION) return;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("generation", CLEAN_RUNTIME_VERSION);
  }

  private async runtime() {
    return await this.ctx.storage.get<TradeManagerRuntime>("runtime") ?? baseTradeManagerRuntime();
  }

  private async saveRuntime(runtime: TradeManagerRuntime) {
    await this.ctx.storage.put("runtime", runtime);
  }

  async ensure(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const runtime = await this.runtime();
    const now = Date.now();
    let alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm < now - 5_000 || alarm > now + 180_000) {
      alarm = now + 1_000;
      await this.ctx.storage.setAlarm(alarm);
    }
    return { ...runtime.status, nextRunAt: alarm };
  }

  async status(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const runtime = await this.runtime();
    return { ...runtime.status, nextRunAt: await this.ctx.storage.getAlarm() ?? runtime.status.nextRunAt };
  }

  async wake() {
    await this.generationReset();
    const nextRunAt = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(nextRunAt);
    return { ok: true as const, nextRunAt };
  }

  async alarm(): Promise<void> {
    await this.generationReset();
    const startedAt = Date.now();
    const runtime = await this.runtime();
    const previous = runtime.status;
    initialize(this.env);
    await this.ctx.storage.setAlarm(startedAt + TRADE_MANAGER_IDLE_INTERVAL_MS);

    try {
      const settings = await getSettings();
      await ensureDirectMarketReleaseCutover(settings.trialCapitalUsdt, startedAt);
      const open = await listHte31OpenTrades();
      const paperReset = await getHte31PaperResetState(open.length);
      const forceArchiveForReset = paperReset.status === "pending" && paperReset.resetMode === "force_archive";
      let refreshed = 0;
      const failures: string[] = [];
      const activeIds = new Set(open.map((trade) => trade.id));
      const positionReviewBuckets = Object.fromEntries(
        Object.entries(runtime.positionReviewBuckets ?? {}).filter(([tradeId]) => activeIds.has(tradeId)),
      );
      const completedFiveMinuteBucket = Math.floor(startedAt / 60_000) - 1;
      const reviewCandles = new Map<string, Awaited<ReturnType<typeof fetchGateChartCandles>>>();
      const reviewDue = forceArchiveForReset ? [] : open.filter((trade) => trade.decisionAuthority === "direct_market_brain"
        && (trade.setupId === "MINUTE_PULLBACK" || hasAdaptivePositionPolicy(trade.decisionSnapshotJson))
        && positionReviewBuckets[trade.id] !== completedFiveMinuteBucket);
      const reviewResults = await Promise.allSettled(reviewDue.map((trade) => {
        if(trade.setupId === "MINUTE_PULLBACK") return this.env.MARKET_SCANNER?.getByName("market-scanner").minuteSnapshot(trade.symbol) ?? Promise.resolve([]);
        const reviewTo = Math.floor(startedAt/300_000)*300_000-1;
        const reviewFrom = Math.max(trade.entryAt, reviewTo - 3 * 60 * 60_000);
        return fetchGateChartCandles(trade.symbol, reviewFrom, reviewTo);
      }));
      reviewDue.forEach((trade, index) => {
        const review = reviewResults[index];
        if (review.status === "fulfilled") {
          reviewCandles.set(trade.id, review.value);
          positionReviewBuckets[trade.id] = completedFiveMinuteBucket;
        } else {
          failures.push(`${trade.symbol} 持仓复核K线：${errorMessage(review.reason)}`);
        }
      });
      if (open.length) {
        const quotes = await fetchGatePositionQuotes(open.map((trade) => trade.symbol));
        const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
        for (const trade of open) {
          const quote = bySymbol.get(trade.symbol);
          if (!quote) {
            failures.push(`${trade.symbol}: quote missing`);
            continue;
          }
          try {
            const candles5m = reviewCandles.get(trade.id);
            const scalp=trade.setupId==='MINUTE_PULLBACK' ? JSON.parse(trade.decisionSnapshotJson)?.candidate?.scalp : null;
            const positionDecision: DirectPositionDecision | null = scalp
              ? evaluateScalpPosition({side:trade.side,entryPrice:trade.entryPrice,initialStopPrice:trade.initialStopPrice,currentStopPrice:trade.currentStopPrice,
                entryAt:trade.entryAt,currentPrice:quote.price,observedAt:quote.observedAt,roundTripCostBps:scalp.costBps,
                confirmationPrice:scalp.confirmationPrice,candles:candles5m??[]})
              : candles5m ? evaluateDirectPosition({
                side: trade.side,
                entryPrice: trade.entryPrice,
                initialStopPrice: trade.initialStopPrice,
                currentStopPrice: trade.currentStopPrice,
                takeProfit1Price: trade.takeProfit1Price,
                target1HitAt: trade.target1HitAt,
                entryAt: trade.entryAt,
                maxHoldingMinutes: trade.maxHoldingMinutes,
                currentPrice: quote.price,
                observedAt: quote.observedAt,
                roundTripCostBps: settings.roundTripCostBps,
                candles5m,
              })
              : null;
            await applyHte31PositionQuote(quote, settings, positionDecision, { forceArchiveForReset });
            refreshed += 1;
          } catch (error) {
            failures.push(`${trade.symbol}: ${errorMessage(error)}`);
          }
        }
      }

      if(open.some(t=>t.setupId==='MINUTE_PULLBACK') && startedAt-(runtime.status.lastSuccessAt??0)>=60_000) {
        await scalpAccountRisk(settings.trialCapitalUsdt,settings.roundTripCostBps,Date.now());
      }
      const due = await nextHte31PostExitObservation(Date.now());
      if (due?.trade.exitAt) {
        try {
          const to = Math.min(Date.now(), due.trade.exitAt + Math.max(5, due.observation.horizonMinutes + 5) * 60_000);
          const from = Math.max(due.trade.entryAt - 90 * 60_000, to - 70 * 60 * 60_000);
          const candles = await fetchGateChartCandles(due.trade.symbol, from, to);
          await completeHte31PostExitObservation(due.trade, due.observation.horizonMinutes, candles, settings.roundTripCostBps, Date.now());
          refreshed += 1;
        } catch (error) {
          await markHte31PostExitObservationUnavailable(due.trade.id, due.observation.horizonMinutes, error, Date.now());
          failures.push(`post-exit ${due.trade.symbol}: ${errorMessage(error)}`);
        }
      }

      // Normal owner resets preserve every open position's lifecycle. A major
      // brain release archives paper positions at fresh quotes, then starts the
      // new version in one clean epoch. Gate/live positions are never touched.
      await finalizePendingHte31PaperCapitalReset(Date.now());

      const active = open.length > 0 || Boolean(due);
      const nextRunAt = Date.now() + (active ? TRADE_MANAGER_ACTIVE_INTERVAL_MS : TRADE_MANAGER_IDLE_INTERVAL_MS);
      const lastError = failures.length ? failures.join("; ") : null;
      const state = failures.length ? "degraded" : "live";
      const heartbeatMs = active ? TRADE_MANAGER_ACTIVE_HEARTBEAT_MS : TRADE_MANAGER_IDLE_HEARTBEAT_MS;
      const heartbeatDue = previous.lastSuccessAt == null || startedAt - previous.lastSuccessAt >= heartbeatMs;
      const stateChanged = previous.state !== state || previous.lastError !== lastError;

      await this.ctx.storage.setAlarm(nextRunAt);
      const positionReviewChanged = JSON.stringify(positionReviewBuckets) !== JSON.stringify(runtime.positionReviewBuckets ?? {});
      if (stateChanged || heartbeatDue || positionReviewChanged) {
        await this.saveRuntime({
          version: 2,
          positionReviewBuckets,
          status: {
            state,
            lastRunAt: startedAt,
            nextRunAt,
            lastSuccessAt: Date.now(),
            lastError,
            refreshed,
          },
        });
      }
    } catch (error) {
      const nextRunAt = Date.now() + TRADE_MANAGER_IDLE_INTERVAL_MS;
      const lastError = `Resonance Trade Manager：${errorMessage(error)}`;
      await this.ctx.storage.setAlarm(nextRunAt);
      const stateChanged = previous.state !== "error" || previous.lastError !== lastError;
      const heartbeatDue = previous.lastRunAt == null || startedAt - previous.lastRunAt >= TRADE_MANAGER_IDLE_HEARTBEAT_MS;
      if (stateChanged || heartbeatDue) {
        await this.saveRuntime({
          version: 2,
          positionReviewBuckets: runtime.positionReviewBuckets ?? {},
          status: {
            ...previous,
            state: "error",
            lastRunAt: startedAt,
            nextRunAt,
            lastError,
          },
        });
      }
    }
  }
}
