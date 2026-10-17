/** This coin's own completed 5m path, read before an order exists.
 * The last two closed bars are the fresh impulse. Everything older in the
 * available window, at most eight hours, is the background. Labels are for
 * review only and never decide whether an order opens. */
export const COIN_PATH_VERSION="coin-path-v1" as const;
const BAR_SEC=300;
const MAX_BARS=96;
const RECENT_BARS=2;
const MIN_BACKGROUND=12;

export type CoinBackground="UP"|"DOWN"|"RANGE"|"UNKNOWN";
export type CoinRecent="SPIKE_UP"|"SPIKE_DOWN"|"NONE"|"UNKNOWN";
export type CoinPath={
  version:typeof COIN_PATH_VERSION;
  cycle:"5m";
  background:CoinBackground;
  recent:CoinRecent;
  bars:number;
  backgroundBars:number;
  windowMin:number;
  backgroundPct:number|null;
  recentPct:number|null;
  typicalBarPct:number|null;
  label:string;
};
type Bar={time:number;open:number;high:number;low:number;close:number};

const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const median=(xs:number[])=>{
  const a=xs.filter(finite).sort((x,y)=>x-y);
  if(!a.length)return 0;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;
};
const pct=(v:number)=>Math.round(v*10_000)/100;

function unknown(bars:number):CoinPath{
  return {version:COIN_PATH_VERSION,cycle:"5m",background:"UNKNOWN",recent:"UNKNOWN",bars,backgroundBars:0,
    windowMin:0,backgroundPct:null,recentPct:null,typicalBarPct:null,label:"5分钟图不够，看不清这段走势"};
}

export function readCoinPath(input:{bars?:Bar[]|null;now:number}):CoinPath{
  const closed=(input.bars??[]).filter(b=>finite(b.time)&&b.time>0&&finite(b.open)&&finite(b.high)&&finite(b.low)&&finite(b.close)
    &&b.open>0&&b.close>0&&b.high>=Math.max(b.open,b.close)&&b.low>0&&b.low<=Math.min(b.open,b.close)
    &&b.time*1000+BAR_SEC*1000<=input.now).sort((a,b)=>a.time-b.time).slice(-MAX_BARS);
  if(closed.length<MIN_BACKGROUND+RECENT_BARS)return unknown(closed.length);
  const recent=closed.slice(-RECENT_BARS);
  const background=closed.slice(0,-RECENT_BARS);
  const typical=median(background.map(b=>(b.high-b.low)/b.close));
  if(!(typical>0))return unknown(closed.length);
  const half=Math.floor(background.length/2);
  const first=median(background.slice(0,half).map(b=>b.close));
  const second=median(background.slice(half).map(b=>b.close));
  if(!(first>0&&second>0))return unknown(closed.length);
  const shift=second/first-1;
  const trendGate=Math.max(0.008,typical*4);
  const backgroundDir:CoinBackground=shift>=trendGate?"UP":shift<=-trendGate?"DOWN":"RANGE";
  const origin=recent[0]!.open;
  const move=origin>0?recent[recent.length-1]!.close/origin-1:0;
  const biggest=Math.max(...recent.map(b=>Math.abs(b.close/b.open-1)));
  const spikeGate=Math.max(0.012,typical*3);
  const barGate=Math.max(0.006,typical*2);
  const recentDir:CoinRecent=move>=spikeGate&&biggest>=barGate?"SPIKE_UP"
    :move<=-spikeGate&&biggest>=barGate?"SPIKE_DOWN":"NONE";
  const windowMin=background.length*5;
  const window=windowMin>=60?`近${Math.round(windowMin/60)}小时`:`近${windowMin}分钟`;
  const bg=backgroundDir==="UP"?"上涨趋势":backgroundDir==="DOWN"?"下跌趋势":"震荡";
  const label=recentDir==="NONE"?`5分钟图，${window}是${bg}`
    :`5分钟图，${window}是${bg}，最近两根${recentDir==="SPIKE_UP"?"暴涨":"暴跌"}`;
  return {version:COIN_PATH_VERSION,cycle:"5m",background:backgroundDir,recent:recentDir,bars:closed.length,
    backgroundBars:background.length,windowMin,backgroundPct:pct(shift),recentPct:pct(move),typicalBarPct:pct(typical),label};
}

/** How this order sits against the coin's own path. Review text only. */
export function coinPathVersus(path:CoinPath|null|undefined,side:"LONG"|"SHORT"){
  if(!path||path.background==="UNKNOWN")return "背景看不清";
  const sideUp=side==="LONG";
  const withBg=(sideUp&&path.background==="UP")||(!sideUp&&path.background==="DOWN");
  const withSpike=(sideUp&&path.recent==="SPIKE_UP")||(!sideUp&&path.recent==="SPIKE_DOWN");
  const againstSpike=(sideUp&&path.recent==="SPIKE_DOWN")||(!sideUp&&path.recent==="SPIKE_UP");
  if(path.background==="RANGE"){
    if(withSpike)return "背景是震荡，这笔顺着刚发生的异动";
    if(againstSpike)return "背景是震荡，这笔逆着刚发生的异动";
    return "背景是震荡";
  }
  if(withSpike&&!withBg)return "逆着这段趋势，只顺着刚发生的异动";
  if(withBg&&againstSpike)return "顺着这段趋势，逆着刚发生的异动";
  if(withBg)return "顺着这段趋势";
  return "逆着这段趋势";
}
