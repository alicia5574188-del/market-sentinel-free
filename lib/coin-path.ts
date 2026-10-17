/** This coin's own completed 5m path, read before an order exists.
 * The background is the closed bars before the latest same-direction run.
 * The run is those trailing bars, at most eight. Review text only. It never
 * decides whether an order opens. */
export const COIN_PATH_VERSION="coin-path-v2" as const;
const BAR_SEC=300;
const MAX_BARS=96;
const MAX_RUN=8;
const MIN_BACKGROUND=12;

export type CoinBackground="UP"|"DOWN"|"RANGE"|"UNKNOWN";
export type CoinRecent="UP"|"DOWN"|"NONE"|"UNKNOWN";
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
  runBars:number;
  runMaxBarPct:number|null;
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
const body=(b:Bar)=>b.open>0?b.close/b.open-1:0;
const sign=(v:number)=>v>0?1:v<0?-1:0;

function unknown(bars:number):CoinPath{
  return {version:COIN_PATH_VERSION,cycle:"5m",background:"UNKNOWN",recent:"UNKNOWN",bars,backgroundBars:0,
    windowMin:0,backgroundPct:null,recentPct:null,typicalBarPct:null,runBars:0,runMaxBarPct:null,
    label:"5分钟图不够，看不清这段走势"};
}

function windowText(minutes:number){
  return minutes>=60?`近${Math.round(minutes/60)}小时`:`近${minutes}分钟`;
}

function driftText(shift:number,typical:number,gate:number,minutes:number){
  const way=shift>=0?"高":"低";
  const quiet=Math.abs(shift)<Math.max(0.003,typical);
  const judge=quiet?"几乎没挪。"
    :shift>=gate?"已经抬成上涨。"
    :shift<=-gate?"已经压成下跌。"
    :shift>0?"在慢慢抬，还没抬成趋势。"
    :"在慢慢压，还没压成趋势。";
  return `前面${windowText(minutes)}，后半段比前半段${way} ${Math.abs(pct(shift))}%，一根普通 5 分钟线晃 ${pct(typical)}%。${judge}`;
}

function runText(run:Bar[]){
  if(!run.length)return "进场前一根没有明确方向。";
  const dir=sign(body(run.at(-1)!));
  const word=dir>0?"涨":"跌";
  const move=Math.abs(run.at(-1)!.close/run[0]!.open-1);
  const biggest=Math.max(...run.map(b=>Math.abs(body(b))));
  if(run.length===1)return `进场前 1 根${word}了 ${pct(move)}%。`;
  return `进场前 ${run.length} 根一共${word}了 ${pct(move)}%，最大一根${word}了 ${pct(biggest)}%。`;
}

export function readCoinPath(input:{bars?:Bar[]|null;now:number}):CoinPath{
  const closed=(input.bars??[]).filter(b=>finite(b.time)&&b.time>0&&finite(b.open)&&finite(b.high)&&finite(b.low)&&finite(b.close)
    &&b.open>0&&b.close>0&&b.high>=Math.max(b.open,b.close)&&b.low>0&&b.low<=Math.min(b.open,b.close)
    &&b.time*1000+BAR_SEC*1000<=input.now).sort((a,b)=>a.time-b.time).slice(-MAX_BARS);
  if(closed.length<MIN_BACKGROUND+1)return unknown(closed.length);
  const last=sign(body(closed.at(-1)!));
  let runStart=closed.length;
  if(last!==0){
    runStart=closed.length-1;
    while(runStart>0&&closed.length-runStart<MAX_RUN&&sign(body(closed[runStart-1]!))===last)runStart--;
  }
  const run=last===0?[]:closed.slice(runStart);
  const background=closed.slice(0,runStart);
  const runDir:CoinRecent=last>0?"UP":last<0?"DOWN":"NONE";
  const runPct=run.length?pct(run.at(-1)!.close/run[0]!.open-1):null;
  const runMax=run.length?pct(Math.max(...run.map(b=>Math.abs(body(b))))):null;
  if(background.length<MIN_BACKGROUND){
    return {version:COIN_PATH_VERSION,cycle:"5m",background:"UNKNOWN",recent:runDir,bars:closed.length,
      backgroundBars:background.length,windowMin:0,backgroundPct:null,recentPct:runPct,typicalBarPct:null,
      runBars:run.length,runMaxBarPct:runMax,label:`进场前这几根之前的线不够，看不清前面怎么挪。${runText(run)}`};
  }
  const typical=median(background.map(b=>(b.high-b.low)/b.close));
  if(!(typical>0))return unknown(closed.length);
  const half=Math.floor(background.length/2);
  const first=median(background.slice(0,half).map(b=>b.close));
  const second=median(background.slice(half).map(b=>b.close));
  if(!(first>0&&second>0))return unknown(closed.length);
  const shift=second/first-1;
  const gate=Math.max(0.008,typical*4);
  const backgroundDir:CoinBackground=shift>=gate?"UP":shift<=-gate?"DOWN":"RANGE";
  const windowMin=background.length*5;
  return {version:COIN_PATH_VERSION,cycle:"5m",background:backgroundDir,recent:runDir,bars:closed.length,
    backgroundBars:background.length,windowMin,backgroundPct:pct(shift),recentPct:runPct,typicalBarPct:pct(typical),
    runBars:run.length,runMaxBarPct:runMax,label:`${driftText(shift,typical,gate,windowMin)}${runText(run)}`};
}

/** How this order sits against the recorded drift and the pre-entry run. Review text only. */
export function coinPathVersus(path:CoinPath|null|undefined,side:"LONG"|"SHORT"){
  if(!path||path.background==="UNKNOWN")return "背景看不清";
  const up=side==="LONG";
  const bg=path.background==="RANGE"?"背景还没成趋势"
    :(up&&path.background==="UP")||(!up&&path.background==="DOWN")?"顺着背景":"逆着背景";
  if(path.recent!=="UP"&&path.recent!=="DOWN")return bg;
  const withRun=(up&&path.recent==="UP")||(!up&&path.recent==="DOWN");
  return `${bg}，${withRun?"顺着":"逆着"}进场前这几根`;
}
