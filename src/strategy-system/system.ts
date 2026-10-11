import { Ledger } from './ledger/ledger.ts';
import { RunLogger, type Funnel, type CurvePoint } from './logger/run-logger.ts';
import type { Executor } from './execution/executor.ts';
import { decide, type DecisionContext, type DecisionResult, type Action } from './decision/policy.ts';
import type { Fill, MarketSnapshot, Position, Regime, Signal, ThesisState, ThesisType } from './types.ts';
import { CONFIG } from './config.ts';

export interface SystemDeps {
  executor: Executor;
  getSnapshot: (symbol: string) => Promise<MarketSnapshot>;
  getEquity: () => Promise<number>;
  getMarkPrice: (symbol: string) => Promise<number>;
  symbols: string[];
  initialEquity: number;
  priorAdjustment?: number;
  now?: () => number;
}

export interface StrategyCapture {
  fills: Fill[];
  theses: { trace: string; thesis: ThesisType; score: number }[];
  contexts: [string, DecisionContext][];
  funnel: Funnel;
  signals: Signal[];
  equityCurve: CurvePoint[];
  traceCounter: number;
}

export interface SymbolView {
  symbol: string;
  result: DecisionResult;
}

export class StrategySystem {
  private ledger: Ledger;
  private logger: RunLogger;
  private deps: SystemDeps;
  private ctx = new Map<string, DecisionContext>();
  private running = false;
  private traceCounter = 0;
  private funnel: Funnel = { scans: 0, signals: 0, filled: 0, cancelled: 0, closed: 0, wins: 0 };
  private last: SymbolView[] = [];

  constructor(deps: SystemDeps) {
    this.deps = deps;
    this.ledger = new Ledger(deps.initialEquity, deps.priorAdjustment ?? 0);
    this.logger = new RunLogger();
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        console.error('[system] tick error', e);
      }
      await sleep(CONFIG.loopIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  async step(): Promise<void> {
    await this.tick();
  }

  lastViews(): SymbolView[] {
    return this.last;
  }

  capture(): StrategyCapture {
    const dumped = this.logger.dump();
    return {
      fills: this.ledger.allFills(),
      theses: this.ledger.allPositions().map((p) => ({ trace: p.trace, thesis: p.thesis, score: p.thesisScore })),
      contexts: [...this.ctx.entries()],
      funnel: this.getFunnel(),
      signals: dumped.signals,
      equityCurve: dumped.equityCurve,
      traceCounter: this.traceCounter,
    };
  }

  restore(state: StrategyCapture): void {
    for (const fill of state.fills) this.ledger.addFill(fill);
    for (const row of state.theses) this.ledger.updateThesis(row.trace, row.thesis, row.score);
    this.ctx = new Map(state.contexts);
    this.funnel = { ...state.funnel };
    this.traceCounter = state.traceCounter;
    this.logger.load(state.signals, state.equityCurve);
  }

  getFunnel(): Funnel {
    return { ...this.funnel };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async tick(): Promise<void> {
    const views: SymbolView[] = [];
    for (const symbol of this.deps.symbols) {
      this.funnel.scans++;
      const snap = await this.deps.getSnapshot(symbol);
      const pos = this.ledger.openPositions().find((p) => p.symbol === symbol) ?? null;
      const now = this.now();
      const ctx = this.ctx.get(symbol) ?? {
        thesisState: 'ALIVE' as ThesisState,
        thesisStateAt: now,
        regime: 'IDLE' as Regime,
      };

      const res = decide(pos, snap, ctx, now);
      this.ctx.set(symbol, res.newContext);
      views.push({ symbol, result: res });

      if (res.action.type === 'OPEN' || res.action.type === 'REVERSE') {
        this.funnel.signals++;
        const trace = this.nextTrace();
        const sig: Signal = {
          ts: now,
          symbol,
          side: res.action.direction,
          confidence: res.action.type === 'REVERSE' ? 0.8 : 0.7,
          reason: res.action.reason,
          trace,
          type: res.action.type === 'REVERSE' ? 'trend_reversal' : 'fake_breakout',
        };
        this.logger.recordSignal(sig);
        await this.execute(res.action, pos, snap, symbol, res.thesisScore, trace);
      } else {
        await this.execute(res.action, pos, snap, symbol, res.thesisScore);
      }
    }
    this.last = views;

    const equity = await this.deps.getEquity();
    const markPrices = new Map<string, number>();
    for (const p of this.ledger.openPositions()) {
      markPrices.set(p.symbol, await this.deps.getMarkPrice(p.symbol));
    }
    this.logger.snapshot(this.ledger, equity, markPrices, this.now());
  }

  private async execute(
    action: Action,
    pos: Position | null,
    snap: MarketSnapshot,
    symbol: string,
    thesisScore: number,
    openTrace?: string,
  ): Promise<void> {
    if (action.type === 'HOLD') return;

    if (action.type === 'CLOSE' && pos) {
      const f = await this.deps.executor.placeOrder({
        symbol,
        side: pos.side,
        qty: pos.qty,
        type: 'market',
        tag: 'close',
        trace: pos.trace,
        reason: action.reason,
      });
      this.ledger.addFill(f);
      this.noteClose(pos.side, pos.entry, f.price);
      return;
    }

    if (action.type === 'REVERSE' && pos) {
      const closeFill = await this.deps.executor.placeOrder({
        symbol,
        side: pos.side,
        qty: pos.qty,
        type: 'market',
        tag: 'close',
        trace: pos.trace,
        reason: action.reason,
      });
      this.ledger.addFill(closeFill);
      this.noteClose(pos.side, pos.entry, closeFill.price);

      const trace = openTrace ?? this.nextTrace();
      const openFill = await this.deps.executor.placeOrder({
        symbol,
        side: action.direction,
        qty: this.calcQty(snap.price, CONFIG.position.trendNotional),
        type: 'market',
        tag: 'open',
        trace,
        reason: action.reason,
      });
      this.ledger.addFill(openFill);
      this.ledger.updateThesis(trace, 'TREND', thesisScore);
      this.funnel.filled++;
      return;
    }

    if (action.type === 'OPEN') {
      const trace = openTrace ?? this.nextTrace();
      const f = await this.deps.executor.placeOrder({
        symbol,
        side: action.direction,
        qty: this.calcQty(snap.price, CONFIG.position.fakeBreakoutNotional),
        type: 'market',
        tag: 'open',
        trace,
        reason: action.reason,
      });
      this.ledger.addFill(f);
      this.ledger.updateThesis(trace, 'FAKE_BREAKOUT', 0);
      this.funnel.filled++;
    }
  }

  private noteClose(side: Position['side'], entry: number, exit: number): void {
    this.funnel.closed++;
    const win = (side === 'LONG' && exit > entry) || (side === 'SHORT' && exit < entry);
    if (win) this.funnel.wins++;
  }

  private calcQty(price: number, notional: number): number {
    return price > 0 ? notional / price : 0;
  }

  private nextTrace(): string {
    this.traceCounter++;
    return `s-${this.now().toString(36)}-${this.traceCounter}`;
  }

  async exportLog() {
    const equity = await this.deps.getEquity();
    const markPrices = new Map<string, number>();
    for (const p of this.ledger.openPositions()) {
      markPrices.set(p.symbol, await this.deps.getMarkPrice(p.symbol));
    }
    return this.logger.export(this.ledger, equity, markPrices, this.funnel);
  }

  getLedger(): Ledger {
    return this.ledger;
  }

  curve() {
    return this.logger.dump().equityCurve;
  }

  signals() {
    return this.logger.dump().signals;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
