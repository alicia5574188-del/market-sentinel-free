/** One equity mark per minute. Recording only. Never read by an entry or an exit. */
import {beijingDayKey} from "./beijing-time.ts";

export type EquityMinute={
  ts:number;equity:number;realized:number;unrealized:number;
  open_notional:number;margin:number;positions:number;live_equity:number|null;
};
export const EQ_MIN_PREFIX="log:eqmin:";
const DAY_CAP=1_500;

export function equityMinuteKey(ts:number){return `${EQ_MIN_PREFIX}${beijingDayKey(ts)}`;}

export function sampleEquity(input:{
  now:number;balance:number;initial:number;liveEquity:number|null;
  positions:{side:"LONG"|"SHORT";entryPrice:number;quantity:number;notional:number;margin:number;lastPrice:number}[];
  quotes:Record<string,{bestBid?:number;bestAsk?:number}|undefined>;
  symbols:string[];
}):EquityMinute{
  let unrealized=0,notional=0,margin=0;
  for(let i=0;i<input.positions.length;i++){
    const p=input.positions[i]!,symbol=input.symbols[i]??"";
    const q=input.quotes[symbol];
    const bid=q?.bestBid??0,ask=q?.bestAsk??0;
    const mark=p.side==="LONG"?(bid>0?bid:p.lastPrice):(ask>0?ask:p.lastPrice);
    if(mark>0&&p.entryPrice>0&&p.quantity>0)unrealized+=(p.side==="LONG"?1:-1)*(mark-p.entryPrice)*p.quantity;
    if(p.notional>0)notional+=p.notional;
    if(p.margin>0)margin+=p.margin;
  }
  const realized=input.balance-input.initial;
  return {ts:Math.floor(input.now/60_000)*60_000,equity:Number((input.balance+unrealized).toFixed(4)),
    realized:Number(realized.toFixed(4)),unrealized:Number(unrealized.toFixed(4)),
    open_notional:Number(notional.toFixed(4)),margin:Number(margin.toFixed(4)),
    positions:input.positions.length,
    live_equity:typeof input.liveEquity==="number"&&Number.isFinite(input.liveEquity)?Number(input.liveEquity.toFixed(4)):null};
}

export function mergeEquityMinutes(prev:EquityMinute[]|null|undefined,next:EquityMinute[]){
  return collectEquityMinutes([Array.isArray(prev)?prev:[],next]).slice(-DAY_CAP);
}

/** 导出用。按天写入时才截 1500，拼多天时不能再用这个上限。 */
export function collectEquityMinutes(groups:Array<EquityMinute[]|null|undefined>){
  const by=new Map<number,EquityMinute>();
  for(const group of groups)for(const row of group??[]){
    if(!row||typeof row.ts!=="number"||typeof row.equity!=="number"||!Number.isFinite(row.equity))continue;
    by.set(row.ts,row);
  }
  return [...by.values()].sort((a,b)=>a.ts-b.ts);
}

export function summarizeEquity(points:EquityMinute[]){
  if(!points.length)return {max_drawdown_u:null,max_drawdown_pct:null,max_drawdown_from:null,max_drawdown_to:null,peak_equity:null,curve_since:null};
  let peak=points[0]!.equity,peakAt=points[0]!.ts,maxDd=0,from=peakAt,to=peakAt;
  for(const row of points){
    if(row.equity>=peak){peak=row.equity;peakAt=row.ts;}
    const dd=peak-row.equity;
    if(dd>maxDd){maxDd=dd;from=peakAt;to=row.ts;}
  }
  return {max_drawdown_u:Number(maxDd.toFixed(4)),
    max_drawdown_pct:peak>0?Number((maxDd/peak*100).toFixed(4)):null,
    max_drawdown_from:from,max_drawdown_to:to,peak_equity:Number(peak.toFixed(4)),curve_since:points[0]!.ts};
}
