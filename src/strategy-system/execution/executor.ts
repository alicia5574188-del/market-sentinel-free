import type { Fill, Side } from '../types.ts';

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  price?: number;
  type: 'market' | 'limit';
  tag: 'open' | 'close';
  trace: string;
  reason?: string;
}

export interface Executor {
  placeOrder(req: OrderRequest): Promise<Fill>;
  getEquity(): Promise<number>;
  getMarkPrice(symbol: string): Promise<number>;
}
