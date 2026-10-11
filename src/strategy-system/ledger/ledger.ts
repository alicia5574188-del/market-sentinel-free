import type { Fill, Position, ThesisType } from '../types.ts';

export class Ledger {
  private fills: Fill[] = [];
  private positions = new Map<string, Position>();
  private initial: number;
  private priorAdjustment: number;

  constructor(initial: number, priorAdjustment = 0) {
    this.initial = initial;
    this.priorAdjustment = priorAdjustment;
  }

  addFill(fill: Fill): void {
    this.fills.push(fill);
    if (fill.tag === 'open') {
      const pos: Position = {
        id: fill.trace,
        symbol: fill.symbol,
        side: fill.side,
        entry: fill.price,
        exit: null,
        qty: fill.qty,
        notional: fill.notional,
        grossPnl: 0,
        fee: fill.fee,
        netPnl: null,
        holdSec: 0,
        exitReason: null,
        openedAt: fill.ts,
        closedAt: null,
        trace: fill.trace,
        thesis: 'FAKE_BREAKOUT',
        thesisScore: 0,
      };
      this.positions.set(fill.trace, pos);
      return;
    }
    const pos = this.positions.get(fill.trace);
    if (!pos) throw new Error(`close without open: ${fill.trace}`);
    if (pos.exit !== null) throw new Error(`duplicate close: ${fill.trace}`);
    pos.exit = fill.price;
    pos.closedAt = fill.ts;
    pos.holdSec = Math.floor((fill.ts - pos.openedAt) / 1000);
    pos.fee += fill.fee;
    const dir = pos.side === 'LONG' ? 1 : -1;
    pos.grossPnl = (fill.price - pos.entry) * pos.qty * dir;
    pos.netPnl = pos.grossPnl - pos.fee;
    pos.exitReason = fill.reason ?? 'closed';
  }

  updateThesis(trace: string, thesis: ThesisType, score: number): void {
    const p = this.positions.get(trace);
    if (p) {
      p.thesis = thesis;
      p.thesisScore = score;
    }
  }

  openPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.exit === null);
  }
  closedPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.exit !== null);
  }
  allPositions(): Position[] {
    return [...this.positions.values()];
  }
  allFills(): Fill[] {
    return [...this.fills];
  }

  closedPnlSum(): number {
    let s = 0;
    for (const p of this.positions.values()) if (p.netPnl != null) s += p.netPnl;
    return s;
  }

  unrealizedPnl(markPrices: Map<string, number>): number {
    let u = 0;
    for (const p of this.positions.values()) {
      if (p.exit !== null) continue;
      const m = markPrices.get(p.symbol);
      if (m == null) continue;
      const dir = p.side === 'LONG' ? 1 : -1;
      u += (m - p.entry) * p.qty * dir - p.fee;
    }
    return u;
  }

  identity(actualEquity: number, markPrices: Map<string, number>) {
    const closed = this.closedPnlSum();
    const unrealized = this.unrealizedPnl(markPrices);
    const computed = this.initial + this.priorAdjustment + closed + unrealized;
    return {
      equity: actualEquity,
      initial: this.initial,
      prior_adjustment: this.priorAdjustment,
      closed_pnl_sum: closed,
      unrealized_pnl: unrealized,
      identity_error: actualEquity - computed,
    };
  }
}
