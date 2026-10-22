/**
 * research-htf-v1 (2026-10-22, NOT wired, NOT deployed): daily trend breakout for the research layer.
 *
 * Rule A, frozen on 2018-01..2025-10-20, then tested once on the 2025-10-21..2026-10-21 holdout
 * (research in /workspace/living_research/htf, Binance public daily klines, 73 coins incl. 20 dead/declined ones,
 * fees 0.19% + real funding; price %, never ROE):
 *  - entry: yesterday's daily close > the prior 20 daily highs, BTC daily close > its 200-day SMA, coin in the top 25 by volume;
 *    enter at the next daily open (00:00 UTC)
 *  - initial stop: entry − 2 × ATR20; exit when price touches max(initial stop, lowest low of the previous 10 closed days)
 *  - size: risk 1% of equity per trade (notional = equity × 1% / stop distance, ≤ 1× equity), max 5 open, one per coin
 *  - dev: 293 portfolio trades (3.7/month), mean +9.4%/trade, median −5.4%, win 39%, avg win +41%, avg loss −11%,
 *    portfolio CAGR +23.5%, max drawdown −22.9%; holdout: 14 trades, +10.1%/trade, portfolio +20.0%, max DD −6.3% (small sample)
 *
 * Pure helpers only: no request, no state. Inputs are closed daily bars the worker already stores (turnDaily, external venues).
 */
export type DailyBar={time:number;open:number;high:number;low:number;close:number;volume?:number};
export const HTF={pb:"htf-donch20",entryN:20,exitN:10,atrN:20,stopAtr:2,regimeN:200,topLiquid:25,riskRate:.01,maxOpen:5,notionalCap:1} as const;
export type HtfSignal={sym:string;ok:boolean;why:string;breakout:number|null;atr:number|null;close:number|null};
/** mean true range of the last n closed bars (Wilder TR, simple average), null if not enough bars */
export function atrOf(rows:DailyBar[],n:number=HTF.atrN):number|null{
  if(rows.length<n+1)return null;let s=0;
  for(let i=rows.length-n;i<rows.length;i++){const r=rows[i]!,pc=rows[i-1]!.close;s+=Math.max(r.high-r.low,Math.abs(r.high-pc),Math.abs(r.low-pc));}
  return s/n;
}
/** highest high of the n bars before the last bar */
export function priorHigh(rows:DailyBar[],n:number=HTF.entryN):number|null{
  if(rows.length<n+1)return null;let m=-Infinity;for(let i=rows.length-1-n;i<rows.length-1;i++)m=Math.max(m,rows[i]!.high);return m;
}
/** lowest low of the last n closed bars (all of them closed: the trail for the current day) */
export function trailLow(rows:DailyBar[],n:number=HTF.exitN):number|null{
  if(rows.length<n)return null;let m=Infinity;for(let i=rows.length-n;i<rows.length;i++)m=Math.min(m,rows[i]!.low);return m;
}
export function smaClose(rows:DailyBar[],n:number):number|null{
  if(rows.length<n)return null;let s=0;for(let i=rows.length-n;i<rows.length;i++)s+=rows[i]!.close;return s/n;
}
/** BTC regime: last closed BTC daily close above its 200-day SMA */
export function bullRegime(btc:DailyBar[]):{ok:boolean|null;why:string}{
  const sma=smaClose(btc,HTF.regimeN),c=btc.at(-1)?.close;
  if(sma==null||c==null)return{ok:null,why:`BTC 日线不够 ${HTF.regimeN} 根（${btc.length}）`};
  return{ok:c>sma,why:`BTC 收盘 ${c.toFixed(0)} ${c>sma?">":"≤"} 200 日均线 ${sma.toFixed(0)}`};
}
/** entry check on closed daily bars of one coin (rows end with yesterday's closed bar) */
export function htfSignal(sym:string,rows:DailyBar[],liquidRank:number|null):HtfSignal{
  const close=rows.at(-1)?.close??null,brk=priorHigh(rows),atr=atrOf(rows);
  const base={sym,breakout:brk,atr,close};
  if(close==null||brk==null||atr==null)return{...base,ok:false,why:"日线不够"};
  if(liquidRank==null||liquidRank>HTF.topLiquid)return{...base,ok:false,why:`成交额排名 ${liquidRank??"-"} 不在前 ${HTF.topLiquid}`};
  if(!(close>brk))return{...base,ok:false,why:`收盘 ${close} 没有突破前 ${HTF.entryN} 日最高 ${brk}`};
  return{...base,ok:true,why:`日线收盘 ${close} 突破前 ${HTF.entryN} 日最高 ${brk}`};
}
/** initial stop and risk-based size; entry = next daily open (or the live price at entry time) */
export function htfOrder(entry:number,atr:number,equity:number){
  const stop=entry-HTF.stopAtr*atr,dist=(entry-stop)/entry;
  if(!(dist>0)||!(equity>0))return null;
  const notional=Math.min(equity*HTF.riskRate/dist,equity*HTF.notionalCap);
  return{stop,stopRate:dist,notional,riskUsd:notional*dist};
}
/**
 * current exit level for an open long: max(initial stop, lowest low of the last 10 closed days). `closed` = closed daily bars
 * ending yesterday (may include days before entry, as in the research); before the first closed day after entry only the
 * initial stop applies. Only ratchets up.
 */
export function htfExitLevel(initialStop:number,closed:DailyBar[],entryTime:number,prevLevel:number|null=null){
  const after=closed.filter(r=>r.time>=entryTime).length;
  const tl=after>=1?trailLow(closed,HTF.exitN):null;
  return Math.max(initialStop,prevLevel??-Infinity,tl??-Infinity);
}
/** pick at most `slots` of today's signals, most liquid first, skipping coins already held */
export function htfPick(sigs:HtfSignal[],rank:(s:string)=>number,held:Set<string>,openCount:number){
  const slots=Math.max(0,HTF.maxOpen-openCount);
  return sigs.filter(s=>s.ok&&!held.has(s.sym)).sort((a,b)=>rank(a.sym)-rank(b.sym)).slice(0,slots);
}
