import { Ledger } from '../ledger/ledger.ts';
import type { Signal } from '../types.ts';

export interface Funnel {
  scans: number;
  signals: number;
  filled: number;
  cancelled: number;
  closed: number;
  wins: number;
}

export interface CurvePoint {
  ts: number;
  equity: number;
  closed_pnl: number;
  unrealized_pnl: number;
  positions: number;
}

export class RunLogger {
  private signals: Signal[] = [];
  private equityCurve: CurvePoint[] = [];

  recordSignal(s: Signal): void {
    this.signals.push(s);
  }

  snapshot(ledger: Ledger, actualEquity: number, markPrices: Map<string, number>, ts = Date.now()): void {
    const inv = ledger.identity(actualEquity, markPrices);
    this.equityCurve.push({
      ts,
      equity: actualEquity,
      closed_pnl: inv.closed_pnl_sum,
      unrealized_pnl: inv.unrealized_pnl,
      positions: ledger.openPositions().length,
    });
  }

  dump() {
    return { signals: [...this.signals], equityCurve: [...this.equityCurve] };
  }

  load(signals: Signal[], curve: CurvePoint[]): void {
    this.signals = signals.slice(-400);
    this.equityCurve = curve.slice(-480);
  }

  export(ledger: Ledger, actualEquity: number, markPrices: Map<string, number>, funnel: Funnel) {
    const inv = ledger.identity(actualEquity, markPrices);
    const fillFees = ledger.allFills().reduce((s, f) => s + f.fee, 0);
    const posFees = ledger.allPositions().reduce((s, p) => s + p.fee, 0);
    const opens = ledger.allFills().filter((f) => f.tag === 'open');
    const positions = ledger.allPositions();
    const positionsSumMatch =
      opens.length === positions.length &&
      opens.every((o) => positions.some((p) => p.trace === o.trace && Math.abs(p.qty - o.qty) < 1e-9));
    return {
      version: 'lsr-run-log-v3',
      exportedAt: Date.now(),
      funnel,
      signals: this.signals,
      invariants: {
        ...inv,
        checks: {
          fees_match: Math.abs(fillFees - posFees) < 1e-6,
          positions_sum_match: positionsSumMatch,
          no_gap_in_equity_curve: Math.abs(inv.identity_error) < 0.5,
        },
      },
      positions: ledger.allPositions(),
      fills: ledger.allFills(),
      equity_curve: this.equityCurve,
    };
  }
}
