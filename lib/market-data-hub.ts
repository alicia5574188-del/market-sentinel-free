/**
 * Multi-source public market data for Adaptive Ten.
 *
 * Analysis never depends on one venue. Gate remains the execution/account truth;
 * Bybit and Binance are independent public analysis feeds. Symbols are mapped
 * only by exact USDT contract name (FOO_USDT <-> FOOUSDT); no heuristic aliasing.
 */
export type MarketSource="BYBIT"|"BINANCE";
export type HubQuote={source:MarketSource;symbol:string;observedAt:number;last:number;bid:number;ask:number;
  volume24hUsd:number;change24hRate:number};
export type HubCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type ConsensusQuote={symbol:string;observedAt:number;mid:number;bid:number;ask:number;sources:MarketSource[];
  sourceCount:number;disagreementRate:number;volume24hUsd:number;change24hRate:number};
type SourceHealth={lastSuccessAt:number;lastFailureAt:number;failures:number;lastError:string|null;rows:number};

const BYBIT="https://api.bybit.com";
const BINANCE="https://fapi.binance.com";
const BULK_TIMEOUT_MS=1_200;
const CANDLE_TIMEOUT_MS=1_500;
const QUOTE_FRESH_MS=12_000;
const finite=(v:number)=>Number.isFinite(v);
const canonical=(external:string)=>external.endsWith("USDT")?external.slice(0,-4)+"_USDT":null;
export const externalSymbol=(gate:string)=>gate.endsWith("_USDT")?gate.slice(0,-5)+"USDT":null;

async function json<T>(url:string,timeoutMs:number):Promise<T>{
  const response=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok){await response.body?.cancel().catch(()=>undefined);throw new Error(`market source ${response.status}`);}
  return await response.json() as T;
}
function validQuote(q:HubQuote,now:number){return q.observedAt>0&&now>=q.observedAt&&now-q.observedAt<=QUOTE_FRESH_MS
  &&q.bid>0&&q.ask>q.bid&&q.last>0;}
function continuous(rows:HubCandle[],seconds:number){
  const valid=rows.filter(r=>r.time>0&&r.open>0&&r.close>0&&r.low>0&&r.high>=Math.max(r.open,r.close)
    &&r.low<=Math.min(r.open,r.close)&&r.volume>=0&&[r.time,r.open,r.high,r.low,r.close,r.volume].every(finite))
    .sort((a,b)=>a.time-b.time);
  const unique=[...new Map(valid.map(r=>[r.time,r])).values()];
  let start=unique.length?unique.length-1:0;while(start>0&&unique[start]!.time-unique[start-1]!.time===seconds)start--;
  return unique.slice(start);
}

export class MarketDataHub{
  private bybit=new Map<string,HubQuote>();
  private binance=new Map<string,HubQuote>();
  private health:Record<MarketSource,SourceHealth>={
    BYBIT:{lastSuccessAt:0,lastFailureAt:0,failures:0,lastError:null,rows:0},
    BINANCE:{lastSuccessAt:0,lastFailureAt:0,failures:0,lastError:null,rows:0},
  };
  private lastAttemptAt=0;
  private inFlight:Promise<void>|null=null;
  private candleSource=new Map<string,{source:MarketSource;at:number}>();

  launchRefresh(now:number){
    if(this.inFlight||now-this.lastAttemptAt<1_500)return null;
    this.lastAttemptAt=now;
    const task=this.refresh(now).finally(()=>{if(this.inFlight===task)this.inFlight=null;});
    this.inFlight=task;return task;
  }
  async refresh(now=Date.now()){
    const [bybit,binance]=await Promise.allSettled([this.fetchBybit(now),this.fetchBinance(now)]);
    if(bybit.status==="fulfilled"){this.bybit=bybit.value;this.ok("BYBIT",now,bybit.value.size);}
    else this.fail("BYBIT",now,bybit.reason);
    if(binance.status==="fulfilled"){this.binance=binance.value;this.ok("BINANCE",now,binance.value.size);}
    else this.fail("BINANCE",now,binance.reason);
    if(bybit.status==="rejected"&&binance.status==="rejected")throw new Error("Bybit/Binance public market data unavailable");
  }
  private ok(source:MarketSource,now:number,rows:number){this.health[source]={lastSuccessAt:now,lastFailureAt:this.health[source].lastFailureAt,
    failures:0,lastError:null,rows};}
  private fail(source:MarketSource,now:number,error:unknown){const prior=this.health[source];this.health[source]={...prior,lastFailureAt:now,
    failures:Math.min(99,prior.failures+1),lastError:error instanceof Error?error.message.slice(0,160):"unknown"};}

  private async fetchBybit(now:number){
    type Row={symbol?:string;lastPrice?:string;bid1Price?:string;ask1Price?:string;turnover24h?:string;price24hPcnt?:string};
    type Res={retCode?:number;result?:{list?:Row[]}};
    const body=await json<Res>(`${BYBIT}/v5/market/tickers?category=linear`,BULK_TIMEOUT_MS);
    if(body.retCode!==0||!Array.isArray(body.result?.list))throw new Error("Bybit ticker payload");
    const out=new Map<string,HubQuote>();
    for(const row of body.result!.list!){const symbol=canonical(row.symbol??"");if(!symbol)continue;
      const last=Number(row.lastPrice),bid=Number(row.bid1Price),ask=Number(row.ask1Price);
      if(!(last>0&&bid>0&&ask>bid))continue;
      out.set(symbol,{source:"BYBIT",symbol,observedAt:now,last,bid,ask,volume24hUsd:Math.max(0,Number(row.turnover24h??0)),
        change24hRate:Number(row.price24hPcnt??0)});
    }
    if(!out.size)throw new Error("Bybit empty ticker surface");return out;
  }
  private async fetchBinance(now:number){
    type Row={symbol?:string;bidPrice?:string;askPrice?:string;bidQty?:string;askQty?:string;time?:number};
    const body=await json<Row[]>(`${BINANCE}/fapi/v1/ticker/bookTicker`,BULK_TIMEOUT_MS);
    if(!Array.isArray(body))throw new Error("Binance ticker payload");
    const out=new Map<string,HubQuote>();
    for(const row of body){const symbol=canonical(row.symbol??"");if(!symbol)continue;const bid=Number(row.bidPrice),ask=Number(row.askPrice);
      if(!(bid>0&&ask>bid))continue;const observedAt=Number(row.time)>0?Number(row.time):now;
      out.set(symbol,{source:"BINANCE",symbol,observedAt,last:(bid+ask)/2,bid,ask,volume24hUsd:0,change24hRate:0});}
    if(!out.size)throw new Error("Binance empty ticker surface");return out;
  }

  quote(symbol:string,now=Date.now()):ConsensusQuote|null{
    const rows=[this.bybit.get(symbol),this.binance.get(symbol)].filter((q):q is HubQuote=>!!q&&validQuote(q,now));
    if(!rows.length)return null;
    const mids=rows.map(q=>(q.bid+q.ask)/2).sort((a,b)=>a-b),mid=mids.length===2?(mids[0]!+mids[1]!)/2:mids[0]!;
    const bid=Math.min(...rows.map(q=>q.bid)),ask=Math.max(...rows.map(q=>q.ask));
    const disagreement=rows.length>1?(Math.max(...mids)-Math.min(...mids))/Math.max(mid,1e-12):0;
    const bybit=rows.find(q=>q.source==="BYBIT");
    return{symbol,observedAt:Math.max(...rows.map(q=>q.observedAt)),mid,bid,ask,sources:rows.map(q=>q.source),sourceCount:rows.length,
      disagreementRate:disagreement,volume24hUsd:Math.max(...rows.map(q=>q.volume24hUsd)),
      change24hRate:bybit?.change24hRate??0};
  }
  coverage(symbol:string,now=Date.now()){const q=this.quote(symbol,now);return q?{sourceCount:q.sourceCount,sources:q.sources,disagreementRate:q.disagreementRate}
    :{sourceCount:0,sources:[] as MarketSource[],disagreementRate:0};}
  radarRows<T extends {symbol:string;last:number;volume24hUsd:number;fundingRate:number}>(gate:T[],now=Date.now()){
    return gate.map(row=>{const q=this.quote(row.symbol,now);return{symbol:row.symbol,last:q?.mid??row.last,
      volume24hUsd:Math.max(row.volume24hUsd,q?.volume24hUsd??0),high24h:q?.mid??row.last,low24h:q?.mid??row.last,
      change24hRate:q?.change24hRate??0,fundingRate:row.fundingRate,openInterest:0,sourceCount:q?.sourceCount??0};});
  }

  async candles(symbol:string,interval:"1m"|"5m",limit=120):Promise<{source:MarketSource;rows:HubCandle[]}|null>{
    const external=externalSymbol(symbol);if(!external)return null;
    const preferred=this.candleSource.get(`${symbol}:${interval}`)?.source;
    const order:MarketSource[]=preferred?[preferred,preferred==="BYBIT"?"BINANCE":"BYBIT"]:["BYBIT","BINANCE"];
    for(const source of order){
      try{const rows=source==="BYBIT"?await this.bybitCandles(external,interval,limit):await this.binanceCandles(external,interval,limit);
        if(rows.length>=Math.min(6,limit)){this.candleSource.set(`${symbol}:${interval}`,{source,at:Date.now()});return{source,rows};}}
      catch{/* try independent source */}
    }
    return null;
  }
  private async bybitCandles(symbol:string,interval:"1m"|"5m",limit:number){
    type Res={retCode?:number;result?:{list?:string[][]}};
    const i=interval==="1m"?"1":"5",n=Math.max(2,Math.min(1000,Math.floor(limit)));
    const body=await json<Res>(`${BYBIT}/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${i}&limit=${n}`,CANDLE_TIMEOUT_MS);
    if(body.retCode!==0||!Array.isArray(body.result?.list))throw new Error("Bybit kline payload");
    const seconds=interval==="1m"?60:300,completed=Math.floor(Date.now()/1000/seconds)*seconds;
    return continuous(body.result!.list!.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),
      close:Number(r[4]),volume:Number(r[5])})).filter(r=>r.time+seconds<=completed),seconds).slice(-n);
  }
  private async binanceCandles(symbol:string,interval:"1m"|"5m",limit:number){
    const n=Math.max(2,Math.min(1000,Math.floor(limit)));
    const body=await json<Array<[number,string,string,string,string,string,number,...unknown[]]>>(
      `${BINANCE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${n}`,CANDLE_TIMEOUT_MS);
    if(!Array.isArray(body))throw new Error("Binance kline payload");
    const seconds=interval==="1m"?60:300,completed=Math.floor(Date.now()/1000/seconds)*seconds;
    return continuous(body.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),
      close:Number(r[4]),volume:Number(r[5])})).filter(r=>r.time+seconds<=completed),seconds).slice(-n);
  }

  status(now=Date.now()){
    const sources=(["BYBIT","BINANCE"] as MarketSource[]).map(source=>({source,...this.health[source],
      fresh:this.health[source].lastSuccessAt>0&&now-this.health[source].lastSuccessAt<=15_000}));
    return{version:"multi-source-market-hub-v1",sources,healthySources:sources.filter(s=>s.fresh).length,
      lastSuccessAt:Math.max(...sources.map(s=>s.lastSuccessAt),0),lastAttemptAt:this.lastAttemptAt,inFlight:!!this.inFlight};
  }
}
