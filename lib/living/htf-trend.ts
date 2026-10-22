/**
 * htf-donch20 (C1b, 2026-10-22): daily trend breakout, long only — rule 1 of the research layer's rulebook.
 *
 * Research (/workspace/living_research/htf, Binance public daily klines 2018-01..2026-10, 73 coins incl. 20 dead/declined,
 * fees 0.19% round trip + real funding; price %, never ROE). Frozen on 2018-01..2025-10-20 (dev), holdout 2025-10-21..2026-10-21
 * (partially seen):
 *  - regime: yesterday's BTC daily close > its 100-day SMA of closes
 *  - universe: the 30 most liquid coins; signal: yesterday's daily close > the highest high of the 20 days before it
 *  - entry: right after the daily close (00:00 UTC); initial stop = entry − 2 × ATR20 (daily, simple mean of true ranges)
 *  - exit: price touches max(initial stop, lowest low of the last 10 closed days), updated after each daily close; no time cap
 *  - size: 0.75% of equity at risk (notional = equity × 0.75% / stop distance, ≤ 1× equity), max 8 open, one per coin
 *  - dev: 440 trades (56/yr), +12.8%/trade mean, median −5.0%, win 40%, avg win +47%, avg loss −10%, CAGR +32.5%, max DD −20.6%,
 *    6/7 years positive; month-clustered 95% CI of the mean +4.6..+22.9%/trade. Holdout: 40 trades, +8.9%/trade, +30.7%, DD −7.4%.
 *  - median initial stop 11.5% (5%–95%: 5.7%–20.6%): at the account's fixed 10× isolated leverage the liquidation price would
 *    sit inside the stop, so these trades use the highest leverage ≤ 10× that keeps the stop within 40% of the liquidation
 *    distance (lib/paper-leverage.ts htfPaperLeverage). Margin only; risk and notional are unchanged by it.
 *
 * Live inputs: closed daily candles the worker already keeps (turnDaily, external venues Bybit/OKX/KuCoin, ≤120 rows) — coins
 * the external venues do not cover are skipped, never fetched from Gate; 24h volume from the hub's quotes; the live price feed.
 * Pure helpers only: no request, no state.
 */
export type DailyBar={time:number;open:number;high:number;low:number;close:number;volume?:number};
export const HTF={pb:"htf-donch20",label:"日线突破做多",entryN:20,exitN:10,atrN:20,stopAtr:2,regimeN:100,topLiquid:30,riskRate:.0075,
  maxOpen:8,notionalCap:1,
  /** a coin needs this many closed daily rows (stands in for the research's "listed ≥ 200 days", which 120 stored rows cannot show) */
  minRows:90,
  /** the daily check waits this long after 00:00 UTC, then for ≥ coverage of the universe to have yesterday's candle (or waitFullMin) */
  checkAfterMin:2,coverage:.8,waitFullMin:45,
  /** without BTC's closed candle by then, the day is skipped (logged) */
  btcDeadlineMin:180,
  /** a pick waits this long for a fresh Gate quote (no new request), then is dropped for the day */
  entryWindowMin:240,
  minStopRate:.004,maxStopRate:.35,stopLiqFraction:.40,
  /** planned hold written on the trade (display / rule horizon only; there is no time exit) */
  holdMin:30*1440,
} as const;
const DAY=86_400;
/** UTC day start (seconds) of a millisecond time */
export const dayStartSec=(ms:number)=>Math.floor(ms/86_400_000)*DAY;
export const dayKey=(ms:number)=>new Date(dayStartSec(ms)*1000).toISOString().slice(0,10);
/** closed daily rows only (bar end ≤ now), finite, sorted, de-duplicated */
export function closedDaily(rows:readonly DailyBar[]|undefined,nowMs:number):DailyBar[]{
  if(!rows?.length)return[];const lim=nowMs/1000,m=new Map<number,DailyBar>();
  for(const r of rows)if(r&&[r.time,r.open,r.high,r.low,r.close].every(Number.isFinite)&&r.close>0&&r.high>=r.low&&r.time+DAY<=lim)m.set(r.time,r);
  return[...m.values()].sort((a,b)=>a.time-b.time);
}
/** the last closed row is yesterday's (UTC) */
export const freshThrough=(rows:DailyBar[],nowMs:number)=>rows.at(-1)?.time===dayStartSec(nowMs)-DAY;
/** mean true range of the last n closed bars (simple average), null if not enough bars */
export function atrOf(rows:DailyBar[],n:number=HTF.atrN):number|null{
  if(rows.length<n+1)return null;let s=0;
  for(let i=rows.length-n;i<rows.length;i++){const r=rows[i]!,pc=rows[i-1]!.close;s+=Math.max(r.high-r.low,Math.abs(r.high-pc),Math.abs(r.low-pc));}
  return s/n;
}
/** highest high of the n bars before the last bar */
export function priorHigh(rows:DailyBar[],n:number=HTF.entryN):number|null{
  if(rows.length<n+1)return null;let m=-Infinity;for(let i=rows.length-1-n;i<rows.length-1;i++)m=Math.max(m,rows[i]!.high);return m;
}
/** lowest low of the last n closed bars */
export function trailLow(rows:DailyBar[],n:number=HTF.exitN):number|null{
  if(rows.length<n)return null;let m=Infinity;for(let i=rows.length-n;i<rows.length;i++)m=Math.min(m,rows[i]!.low);return m;
}
export function smaClose(rows:DailyBar[],n:number):number|null{
  if(rows.length<n)return null;let s=0;for(let i=rows.length-n;i<rows.length;i++)s+=rows[i]!.close;return s/n;
}
export type HtfRegime={on:boolean|null;close:number|null;sma:number|null;why:string};
/** BTC regime: last closed BTC daily close above its 100-day SMA */
export function bullRegime(btc:DailyBar[]):HtfRegime{
  const sma=smaClose(btc,HTF.regimeN),c=btc.at(-1)?.close??null;
  if(sma==null||c==null)return{on:null,close:c,sma:null,why:`BTC 日线不够 ${HTF.regimeN} 根（${btc.length}）`};
  const on=c>sma;
  return{on,close:c,sma,why:`BTC 日线收盘 ${fmt(c)} ${on?">":"≤"} 100 日均线 ${fmt(sma)}（${on?"+":""}${((c/sma-1)*100).toFixed(2)}%）`};
}
export type HtfCode="BREAK"|"NO_BREAK"|"STALE"|"SHORT"|"RANK"|"NO_DATA";
export type HtfSignal={sym:string;ok:boolean;code:HtfCode;why:string;close:number|null;breakout:number|null;atr:number|null;rank:number|null;vol:number|null};
/** entry check on one coin's closed daily bars (they must end with yesterday's bar) */
export function htfSignal(sym:string,rows:DailyBar[],rank:number|null,nowMs:number,vol:number|null=null):HtfSignal{
  const close=rows.at(-1)?.close??null,brk=priorHigh(rows),atr=atrOf(rows),base={sym,close,breakout:brk,atr,rank,vol};
  if(!rows.length)return{...base,ok:false,code:"NO_DATA",why:"没有外部日线（不向 Gate 补）"};
  if(!freshThrough(rows,nowMs))return{...base,ok:false,code:"STALE",why:`日线只到 ${new Date(rows.at(-1)!.time*1000).toISOString().slice(0,10)}，昨天的还没更新`};
  if(rows.length<HTF.minRows||close==null||brk==null||atr==null)return{...base,ok:false,code:"SHORT",why:`日线只有 ${rows.length} 根（要 ${HTF.minRows}）`};
  if(rank==null||rank>HTF.topLiquid)return{...base,ok:false,code:"RANK",why:`24 小时成交额排第 ${rank??"-"}，不在前 ${HTF.topLiquid}`};
  if(!(close>brk))return{...base,ok:false,code:"NO_BREAK",why:`收盘 ${fmt(close)} 没过前 ${HTF.entryN} 日最高 ${fmt(brk)}（差 ${((brk/close-1)*100).toFixed(2)}%）`};
  return{...base,ok:true,code:"BREAK",why:`日线收盘 ${fmt(close)} 突破前 ${HTF.entryN} 日最高 ${fmt(brk)}（+${((close/brk-1)*100).toFixed(2)}%），ATR20 ${fmt(atr)}（${(atr/close*100).toFixed(2)}%）`};
}
/** initial stop and risk-based size at a given entry price */
export function htfOrder(entry:number,atr:number,equity:number){
  const stop=entry-HTF.stopAtr*atr,dist=(entry-stop)/entry;
  if(!(dist>0)||!(dist<1)||!(equity>0))return null;
  const notional=Math.min(equity*HTF.riskRate/dist,equity*HTF.notionalCap);
  return{stop,stopRate:dist,notional,riskUsd:notional*dist};
}
/**
 * Exit level for an open long: max(initial stop, lowest low of the last 10 closed days). `closed` = closed daily bars (may include
 * days before entry, as in the research); before the first closed day on/after the entry day only the initial stop applies.
 * Never lower than prevLevel.
 */
export function htfExitLevel(initialStop:number,closed:DailyBar[],entryTimeSec:number,prevLevel:number|null=null){
  const entryDay=Math.floor(entryTimeSec/DAY)*DAY,after=closed.filter(r=>r.time>=entryDay).length;
  const tl=after>=1?trailLow(closed,HTF.exitN):null;
  return Math.max(initialStop,prevLevel??-Infinity,tl??-Infinity);
}
/** volume rank (1 = largest 24h volume) among the given coins; coins without a volume get no rank */
export function volumeRanks(vol:Record<string,number|null|undefined>){
  const xs=Object.entries(vol).filter((e):e is [string,number]=>typeof e[1]==="number"&&Number.isFinite(e[1])&&e[1]>0).sort((a,b)=>b[1]-a[1]);
  return new Map(xs.map(([s],i)=>[s,i+1]));
}
export type HtfCheck={day:string;regime:HtfRegime;rows:HtfSignal[];picks:HtfSignal[];skipped:{sym:string;why:string}[];
  universe:number;fresh:number;slots:number};
/**
 * The once-a-day check (pure): regime, every coin's verdict, and the picks for the free slots (most liquid first, one per coin,
 * coins already held skipped). Regime off → no picks (every breakout is still listed).
 */
export function dailyCheck(input:{nowMs:number;btc:DailyBar[];coins:{sym:string;rows:DailyBar[];vol:number|null}[];held:Set<string>;open:number}):HtfCheck{
  const regime=bullRegime(input.btc),rank=volumeRanks(Object.fromEntries(input.coins.map(c=>[c.sym,c.vol])));
  const rows=input.coins.map(c=>htfSignal(c.sym,c.rows,rank.get(c.sym)??null,input.nowMs,c.vol)).sort((a,b)=>(a.rank??999)-(b.rank??999));
  const slots=Math.max(0,HTF.maxOpen-input.open),picks:HtfSignal[]=[],skipped:{sym:string;why:string}[]=[];
  for(const s of rows){
    if(!s.ok)continue;
    if(regime.on!==true){skipped.push({sym:s.sym,why:regime.on==null?`BTC 均线算不出：${regime.why}`:`BTC 在 100 日均线下：${regime.why}`});continue;}
    if(input.held.has(s.sym)){skipped.push({sym:s.sym,why:"这个币已有持仓（一币一笔），或日线突破单就在信号那天平掉（研究里那天的信号不算）"});continue;}
    if(picks.length>=slots){skipped.push({sym:s.sym,why:`日线突破单已占 ${input.open} 个名额，最多 ${HTF.maxOpen}`});continue;}
    picks.push(s);
  }
  return{day:new Date(Math.floor(input.nowMs/86_400_000)*86_400_000).toISOString().slice(0,10),regime,rows,picks,skipped,
    universe:input.coins.length,fresh:input.coins.filter(c=>freshThrough(c.rows,input.nowMs)).length,slots};
}
/** one compact text line per coin for the logs: "SOL 1 brk:+1.2% atr6.1% #3" */
export function signalCell(s:HtfSignal){
  const nm=s.sym.replace("_USDT",""),gap=s.close!=null&&s.breakout!=null?`${s.close>s.breakout?"+":""}${((s.close/s.breakout-1)*100).toFixed(1)}%`:"-",
    a=s.atr!=null&&s.close?`${(s.atr/s.close*100).toFixed(1)}%`:"-";
  return`${nm} #${s.rank??"-"} 距突破${gap} ATR${a} ${s.code}`;
}
function fmt(v:number){return Number(v.toPrecision(6)).toString();}
