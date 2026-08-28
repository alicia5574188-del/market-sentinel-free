/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { setRuntimeDb } from "../db";
import { setRuntimeBindings } from "../lib/runtime-bindings";
import { fetchGateChartCandles, fetchGatePositionQuotes, SYMBOL_PATTERN } from "../lib/gate-client";
import {
  applyHte31PositionQuote,
  completeHte31PostExitObservation,
  listHte31OpenTrades,
  nextHte31PostExitObservation,
} from "../lib/hte31-repository";
import {
  createHte31ScanJob,
  hte31PhaseLabel,
  runHte31ScanStep,
  type Hte31ScanCompleted,
  type Hte31ScanJob,
} from "../lib/hte31-scanner";
import { getSettings } from "../lib/repository";
import type { SchedulerWorkerStatus } from "../lib/background-scheduler";
import type { CloudflareEnv } from "./index";

const CLEAN_RUNTIME_VERSION = "hte31-clean-1";

function baseStatus(): SchedulerWorkerStatus {
  return {
    state: "starting",
    lastRunAt: null,
    nextRunAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown clean runtime error";
}

function initialize(env: CloudflareEnv) {
  setRuntimeDb(env.DB);
  setRuntimeBindings(env);
}

export class HTE31MarketScanner extends DurableObject<CloudflareEnv> {
  private readonly intervalMs = 20_000;

  private async generationReset() {
    const generation = await this.ctx.storage.get<string>("generation");
    if (generation === CLEAN_RUNTIME_VERSION) return;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("generation", CLEAN_RUNTIME_VERSION);
  }

  async ensure(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? baseStatus();
    const now = Date.now();
    let alarm = await this.ctx.storage.getAlarm();
    if (status.circuitOpen && status.retryAfter && status.retryAfter > now) {
      if (alarm !== status.retryAfter) await this.ctx.storage.setAlarm(status.retryAfter);
      return { ...status, nextRunAt: status.retryAfter };
    }
    if (alarm == null || alarm < now - 5_000 || alarm > now + 120_000) {
      alarm = now + 1_000;
      await this.ctx.storage.setAlarm(alarm);
    }
    return { ...status, nextRunAt: alarm };
  }

  async status(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? baseStatus();
    return { ...status, nextRunAt: await this.ctx.storage.getAlarm() ?? status.nextRunAt };
  }

  async wake(): Promise<{ ok: true; nextRunAt: number }> {
    await this.generationReset();
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? baseStatus();
    const now = Date.now();
    const nextRunAt = status.circuitOpen && status.retryAfter && status.retryAfter > now ? status.retryAfter : now + 1_000;
    await this.ctx.storage.setAlarm(nextRunAt);
    return { ok: true, nextRunAt };
  }

  async readModel(): Promise<Hte31ScanCompleted | null> {
    await this.generationReset();
    return await this.ctx.storage.get<Hte31ScanCompleted>("readModel") ?? null;
  }

  async marketSnapshot(symbol: string) {
    if (!SYMBOL_PATTERN.test(symbol)) return { readModel: null, deep: null };
    const readModel = await this.readModel();
    return {
      readModel,
      deep: readModel?.packet?.symbol === symbol ? { savedAt: readModel.packet.observedAt, packet: readModel.packet } : null,
    };
  }

  private async runCycle(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const now = Date.now();
    const previous = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? baseStatus();
    if (previous.circuitOpen && previous.retryAfter && previous.retryAfter > now) {
      await this.ctx.storage.setAlarm(previous.retryAfter);
      return { ...previous, nextRunAt: previous.retryAfter };
    }
    if (previous.lastRunAt && now - previous.lastRunAt < 750) return previous;

    const rotationOffset = await this.ctx.storage.get<number>("rotationOffset") ?? 0;
    let job = await this.ctx.storage.get<Hte31ScanJob>("job") ?? createHte31ScanJob(rotationOffset);
    if (job.rotationOffset !== rotationOffset) job = createHte31ScanJob(rotationOffset);
    const priorAttempt = job.attempts[job.phase] ?? 0;
    if (priorAttempt >= 3) {
      const retryAfter = now + 5 * 60_000;
      const status: SchedulerWorkerStatus = {
        ...previous,
        state: "degraded",
        lastRunAt: previous.lastRunAt,
        nextRunAt: retryAfter,
        lastError: `HTE 3.1 Clean 阶段「${hte31PhaseLabel(job.phase)}」连续 3 次未完成，熔断 5 分钟。`,
        phase: hte31PhaseLabel(job.phase),
        phaseAttempt: priorAttempt,
        circuitOpen: true,
        retryAfter,
        jobId: job.id,
      };
      await this.ctx.storage.put("status", status);
      await this.ctx.storage.setAlarm(retryAfter);
      return status;
    }

    const attempt = priorAttempt + 1;
    job = { ...job, attempts: { ...job.attempts, [job.phase]: attempt } };
    await this.ctx.storage.put("job", job);
    const fallback = now + 30_000;
    await this.ctx.storage.setAlarm(fallback);
    await this.ctx.storage.put<SchedulerWorkerStatus>("status", {
      ...previous,
      state: "starting",
      lastRunAt: now,
      nextRunAt: fallback,
      lastError: null,
      phase: hte31PhaseLabel(job.phase),
      phaseAttempt: attempt,
      circuitOpen: false,
      retryAfter: null,
      jobId: job.id,
    });

    initialize(this.env);
    try {
      const step = await runHte31ScanStep(job);
      if (step.kind === "paused") {
        await this.ctx.storage.delete("job");
        const nextRunAt = Date.now() + 60_000;
        await this.ctx.storage.setAlarm(nextRunAt);
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
        await this.ctx.storage.put("status", status);
        return status;
      }
      if (step.kind === "progress") {
        await this.ctx.storage.put("job", step.job);
        const nextRunAt = Date.now() + 1_000;
        await this.ctx.storage.setAlarm(nextRunAt);
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
        await this.ctx.storage.put("status", status);
        return status;
      }

      const result = step.result;
      await this.ctx.storage.put("readModel", result);
      await this.ctx.storage.put("rotationOffset", rotationOffset + 1);
      await this.ctx.storage.delete("job");
      const nextRunAt = Math.max(Date.now() + 5_000, now + this.intervalMs);
      await this.ctx.storage.setAlarm(nextRunAt);
      const status: SchedulerWorkerStatus = {
        state: "live",
        lastRunAt: now,
        nextRunAt,
        lastSuccessAt: result.observedAt,
        lastError: null,
        analyzed: 1,
        symbols: [result.target],
        phase: null,
        phaseAttempt: 0,
        circuitOpen: false,
        retryAfter: null,
        jobId: null,
      };
      await this.ctx.storage.put("status", status);
      return status;
    } catch (error) {
      const nextRunAt = Date.now() + 8_000;
      await this.ctx.storage.setAlarm(nextRunAt);
      const status: SchedulerWorkerStatus = {
        ...previous,
        state: "error",
        lastRunAt: now,
        nextRunAt,
        lastError: `HTE 3.1 Clean 阶段「${hte31PhaseLabel(job.phase)}」失败：${errorMessage(error)}`,
        phase: hte31PhaseLabel(job.phase),
        phaseAttempt: attempt,
        circuitOpen: false,
        retryAfter: null,
        jobId: job.id,
      };
      await this.ctx.storage.put("status", status);
      return status;
    }
  }

  async runIfDue() { return this.runCycle(); }
  async alarm() { await this.runCycle(); }
}

export class HTE31TradeManager extends DurableObject<CloudflareEnv> {
  private readonly intervalMs = 15_000;

  private async generationReset() {
    const generation = await this.ctx.storage.get<string>("generation");
    if (generation === CLEAN_RUNTIME_VERSION) return;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("generation", CLEAN_RUNTIME_VERSION);
  }

  async ensure(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? baseStatus();
    const now = Date.now();
    let alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm < now - 5_000 || alarm > now + 120_000) {
      alarm = now + 1_000;
      await this.ctx.storage.setAlarm(alarm);
    }
    return { ...status, nextRunAt: alarm };
  }

  async status(): Promise<SchedulerWorkerStatus> {
    await this.generationReset();
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? baseStatus();
    return { ...status, nextRunAt: await this.ctx.storage.getAlarm() ?? status.nextRunAt };
  }

  async wake() {
    const nextRunAt = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(nextRunAt);
    return { ok: true as const, nextRunAt };
  }

  async alarm(): Promise<void> {
    await this.generationReset();
    const startedAt = Date.now();
    const previous = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? baseStatus();
    const fallback = startedAt + 30_000;
    await this.ctx.storage.setAlarm(fallback);
    initialize(this.env);
    try {
      const settings = await getSettings();
      const open = await listHte31OpenTrades();
      let refreshed = 0;
      const failures: string[] = [];
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
            await applyHte31PositionQuote(quote, settings);
            refreshed += 1;
          } catch (error) {
            failures.push(`${trade.symbol}: ${errorMessage(error)}`);
          }
        }
      }

      const due = await nextHte31PostExitObservation(Date.now());
      if (due?.trade.exitAt) {
        try {
          const to = Math.min(Date.now(), due.trade.exitAt + Math.max(5, due.observation.horizonMinutes + 5) * 60_000);
          const from = Math.max(due.trade.entryAt - 90 * 60_000, to - 70 * 60 * 60_000);
          const candles = await fetchGateChartCandles(due.trade.symbol, from, to);
          await completeHte31PostExitObservation(due.trade, due.observation.horizonMinutes, candles, Date.now());
          refreshed += 1;
        } catch (error) {
          failures.push(`post-exit ${due.trade.symbol}: ${errorMessage(error)}`);
        }
      }

      const nextRunAt = Date.now() + (open.length || due ? this.intervalMs : 30_000);
      await this.ctx.storage.setAlarm(nextRunAt);
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", {
        state: failures.length ? "degraded" : "live",
        lastRunAt: startedAt,
        nextRunAt,
        lastSuccessAt: Date.now(),
        lastError: failures.length ? failures.join("; ") : null,
        refreshed,
      });
    } catch (error) {
      const nextRunAt = Date.now() + 10_000;
      await this.ctx.storage.setAlarm(nextRunAt);
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", {
        ...previous,
        state: "error",
        lastRunAt: startedAt,
        nextRunAt,
        lastError: `HTE 3.1 Trade Manager：${errorMessage(error)}`,
      });
    }
  }
}
