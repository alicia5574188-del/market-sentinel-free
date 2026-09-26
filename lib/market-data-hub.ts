/**
 * Multi-source public market data for Adaptive Ten.
 *
 * Analysis never depends on one venue. Gate remains the execution/account truth;
 * Bybit, OKX and Bitget are primary independent public analysis feeds; Binance is a best-effort fourth source behind WAF backoff. Symbols are mapped
 * only by exact USDT contract name (FOO_USDT <-> FOOUSDT); no heuristic aliasing.
 */
export type MarketSource="BYBIT"|"OKX"|"KUCOIN"|"BITGET"|"BINANCE";
export type HubQuote={source:MarketSource;symbol:string;observedAt:number;last:number;bid:number;ask:number;
  bidSize:number;askSize:number;volume24hUsd:number;change24hRate:number};
export type HubCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type ConsensusQuote={symbol:string;observedAt:number;mid:number;bid:number;ask:number;sources:MarketSource[];
  sourceCount:number;disagreementRate:number;volume24hUsd:number;change24hRate:number;
  sourceBreadth:number;directionalAgreement:number;medianShortMove:number;
  bookImbalance:number;bidLiquidityChange:number;askLiquidityChange:number;spreadRate:number;liquiditySourceCount:number};
type SourceHealth={lastSuccessAt:number;lastFailureAt:number;failures:number;lastError:string|null;rows:number;nextRetryAt:number};

const BYBIT="https://api.bybit.com";
const OKX="https://www.okx.com";
const KUCOIN="https://api-futures.kucoin.com";
const BITGET="https://api.bitget.com";
const BINANCE="https://fapi.binance.com";
const BULK_TIMEOUT_MS=1_200;
const CANDLE_TIMEOUT_MS=1_500;
const QUOTE_FRESH_MS=12_000;
const finite=(v:number)=>Number.isFinite(v);
const clip=(v:number,a=-1,b=1)=>Math.max(a,Math.min(b,v));
const median=(xs:number[])=>{const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;};
const canonical=(external:string)=>external.endsWith("USDT")?external.slice(0,-4)+"_USDT":null;
const canonicalOkx=(external:string)=>external.endsWith("-USDT-SWAP")?external.slice(0,-10)+"_USDT":null;
export const externalSymbol=(gate:string)=>gate.endsWith("_USDT")?gate.slice(0,-5)+"USDT":null;
export const okxSymbol=(gate:string)=>gate.endsWith("_USDT")?gate.slice(0,-5)+"-USDT-SWAP":null;
const canonicalKucoin=(external:string)=>{if(!external.endsWith("USDTM"))return null;let base=external.slice(0,-5);if(base==="XBT")base="BTC";return base+"_USDT";};
export const kucoinSymbol=(gate:string)=>{if(!gate.endsWith("_USDT"))return null;let base=gate.slice(0,-5);if(base==="BTC")base="XBT";return base+"USDTM";};

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
  private okx=new Map<string,HubQuote>();
  private kucoin=new Map<string,HubQuote>();
  private bitget=new Map<string,HubQuote>();
  private binance=new Map<string,HubQuote>();
  private health:Record<MarketSource,SourceHealth>={
    BYBIT:{lastSuccessAt:0,lastFailureAt:0,failures:0,lastError:null,rows:0,nextRetryAt:0},
    OKX:{lastSuccessAt:0,lastFailureAt:0,failures:0,lastError:null,rows:0,nextRetryAt:0},
    KUCOIN:{lastSuccessAt:0,lastFailureAt:0,failures:0,lastError:null,rows:0,nextRetryAt:0},
    BITGET:{lastSuccessAt:0,lastFailureAt:0,failures:0,lastError:null,rows:0,nextRetryAt:0},
    BINANCE:{lastSuccessAt:0,lastFailureAt:0,failures:0,lastError:null,rows:0,nextRetryAt:0},
  };
  private lastAttemptAt=0;
  private inFlight:Promise<void>|null=null;
  private candleSource=new Map<string,{source:MarketSource;at:number}>();
  private quoteHistory=new Map<string,Map<MarketSource,{at:number;mid:number;bidSize:number;askSize:number;imbalance:number;spread:number}[]>>();

  launchRefresh(now:number){
    if(this.inFlight)return this.inFlight;
    if(now-this.lastAttemptAt<1_500)return null;
    this.lastAttemptAt=now;
    const task=this.refresh(now).finally(()=>{if(this.inFlight===task)this.inFlight=null;});
    this.inFlight=task;return task;
  }
  async refresh(now=Date.now()){
    const bitgetDue=now>=this.health.BITGET.nextRetryAt,binanceDue=now>=this.health.BINANCE.nextRetryAt;
    const [bybit,okx,kucoin,bitget,binance]=await Promise.allSettled([
      this.fetchBybit(now),this.fetchOkx(now),this.fetchKucoin(now),
      bitgetDue?this.fetchBitget(now):Promise.resolve(null),binanceDue?this.fetchBinance(now):Promise.resolve(null),
    ]);
    if(bybit.status==="fulfilled"){this.bybit=bybit.value;this.ok("BYBIT",now,bybit.value.size);}else this.fail("BYBIT",now,bybit.reason);
    if(okx.status==="fulfilled"){this.okx=okx.value;this.ok("OKX",now,okx.value.size);}else this.fail("OKX",now,okx.reason);
    if(kucoin.status==="fulfilled"){this.kucoin=kucoin.value;this.ok("KUCOIN",now,kucoin.value.size);}else this.fail("KUCOIN",now,kucoin.reason);
    if(bitget.status==="fulfilled"&&bitget.value){this.bitget=bitget.value;this.ok("BITGET",now,bitget.value.size);}
    else if(bitget.status==="rejected")this.fail("BITGET",now,bitget.reason);
    if(binance.status==="fulfilled"&&binance.value){this.binance=binance.value;this.ok("BINANCE",now,binance.value.size);}
    else if(binance.status==="rejected")this.fail("BINANCE",now,binance.reason);
    // Never let one refresh failure stop the strategy loop. Cached rows remain
    // available until their freshness fence expires; freshQuote then prevents
    // execution from stale data. Health exposes the degraded sources separately.
  }
  private ok(source:MarketSource,now:number,rows:number){this.health[source]={lastSuccessAt:now,lastFailureAt:this.health[source].lastFailureAt,
    failures:0,lastError:null,rows,nextRetryAt:0};}
  private fail(source:MarketSource,now:number,error:unknown){const prior=this.health[source],message=error instanceof Error?error.message.slice(0,160):"unknown",
    failures=Math.min(99,prior.failures+1),isWaf=(source==="BINANCE"||source==="BITGET")&&/market source 403/.test(message),
    backoffMs=isWaf?Math.min(40*60_000,5*60_000*2**Math.min(3,Math.max(0,failures-1))):0;
    this.health[source]={...prior,lastFailureAt:now,failures,lastError:message,nextRetryAt:backoffMs?now+backoffMs:0};}

  private async fetchBybit(now:number){
    type Row={symbol?:string;lastPrice?:string;bid1Price?:string;ask1Price?:string;bid1Size?:string;ask1Size?:string;turnover24h?:string;price24hPcnt?:string};
    type Res={retCode?:number;result?:{list?:Row[]}};
    const body=await json<Res>(`${BYBIT}/v5/market/tickers?category=linear`,BULK_TIMEOUT_MS);
    if(body.retCode!==0||!Array.isArray(body.result?.list))throw new Error("Bybit ticker payload");
    const out=new Map<string,HubQuote>();
    for(const row of body.result!.list!){const symbol=canonical(row.symbol??"");if(!symbol)continue;
      const last=Number(row.lastPrice),bid=Number(row.bid1Price),ask=Number(row.ask1Price);
      if(!(last>0&&bid>0&&ask>bid))continue;
      out.set(symbol,{source:"BYBIT",symbol,observedAt:now,last,bid,ask,bidSize:Math.max(0,Number(row.bid1Size??0)),askSize:Math.max(0,Number(row.ask1Size??0)),
        volume24hUsd:Math.max(0,Number(row.turnover24h??0)),change24hRate:Number(row.price24hPcnt??0)});
    }
    if(out.size<20)throw new Error(`Bybit incomplete ticker surface: ${out.size}`);return out;
  }
  private async fetchOkx(now:number){
    type Row={instId?:string;last?:string;bidPx?:string;askPx?:string;bidSz?:string;askSz?:string;volCcy24h?:string;open24h?:string;ts?:string};
    type Res={code?:string;data?:Row[]};
    const body=await json<Res>(`${OKX}/api/v5/market/tickers?instType=SWAP`,BULK_TIMEOUT_MS);
    if(body.code!=="0"||!Array.isArray(body.data))throw new Error("OKX ticker payload");
    const out=new Map<string,HubQuote>();
    for(const row of body.data){const symbol=canonicalOkx(row.instId??"");if(!symbol)continue;
      const last=Number(row.last),bid=Number(row.bidPx),ask=Number(row.askPx),open=Number(row.open24h);
      if(!(last>0&&bid>0&&ask>bid))continue;
      const exchangeAt=Number(row.ts),observedAt=exchangeAt>0&&exchangeAt<=now+2_000?Math.min(exchangeAt,now):now;
      const volumeBase=Math.max(0,Number(row.volCcy24h??0));
      out.set(symbol,{source:"OKX",symbol,observedAt,last,bid,ask,bidSize:Math.max(0,Number(row.bidSz??0)),askSize:Math.max(0,Number(row.askSz??0)),
        volume24hUsd:volumeBase*last,change24hRate:open>0?last/open-1:0});
    }
    if(out.size<20)throw new Error(`OKX incomplete ticker surface: ${out.size}`);return out;
  }

  private async fetchKucoin(now:number){
    type Row={symbol?:string;price?:string;bestBidPrice?:string;bestAskPrice?:string;bestBidSize?:string;bestAskSize?:string;ts?:number|string};
    type Res={code?:string;data?:Row[]};
    const body=await json<Res>(`${KUCOIN}/api/v1/allTickers`,BULK_TIMEOUT_MS);
    if(body.code!=="200000"||!Array.isArray(body.data))throw new Error("KuCoin ticker payload");
    const out=new Map<string,HubQuote>();
    for(const row of body.data){const symbol=canonicalKucoin(row.symbol??"");if(!symbol)continue;
      const last=Number(row.price),bid=Number(row.bestBidPrice),ask=Number(row.bestAskPrice),rawTs=Number(row.ts);
      if(!(last>0&&bid>0&&ask>bid))continue;
      const exchangeMs=rawTs>1e15?rawTs/1e6:rawTs,observedAt=exchangeMs>0&&exchangeMs<=now+2_000?Math.min(exchangeMs,now):now;
      out.set(symbol,{source:"KUCOIN",symbol,observedAt,last,bid,ask,bidSize:Math.max(0,Number(row.bestBidSize??0)),askSize:Math.max(0,Number(row.bestAskSize??0)),
        volume24hUsd:0,change24hRate:0});
    }
    if(out.size<20)throw new Error(`KuCoin incomplete ticker surface: ${out.size}`);return out;
  }

  private async fetchBitget(now:number){
    type Row={symbol?:string;lastPr?:string;bidPr?:string;askPr?:string;bidSz?:string;askSz?:string;quoteVolume?:string;change24h?:string;ts?:string};
    type Res={code?:string;data?:Row[]};
    const body=await json<Res>(`${BITGET}/api/v2/mix/market/tickers?productType=USDT-FUTURES`,BULK_TIMEOUT_MS);
    if(body.code!=="00000"||!Array.isArray(body.data))throw new Error("Bitget ticker payload");
    const out=new Map<string,HubQuote>();
    for(const row of body.data){const symbol=canonical(row.symbol??"");if(!symbol)continue;
      const last=Number(row.lastPr),bid=Number(row.bidPr),ask=Number(row.askPr),exchangeAt=Number(row.ts);
      if(!(last>0&&bid>0&&ask>bid))continue;
      const observedAt=exchangeAt>0&&exchangeAt<=now+2_000?Math.min(exchangeAt,now):now;
      out.set(symbol,{source:"BITGET",symbol,observedAt,last,bid,ask,bidSize:Math.max(0,Number(row.bidSz??0)),askSize:Math.max(0,Number(row.askSz??0)),
        volume24hUsd:Math.max(0,Number(row.quoteVolume??0)),change24hRate:Number(row.change24h??0)});
    }
    if(out.size<20)throw new Error(`Bitget incomplete ticker surface: ${out.size}`);return out;
  }

  private async fetchBinance(now:number){
    type Row={symbol?:string;bidPrice?:string;askPrice?:string;bidQty?:string;askQty?:string;time?:number};
    const body=await json<Row[]>(`${BINANCE}/fapi/v1/ticker/bookTicker`,BULK_TIMEOUT_MS);
    if(!Array.isArray(body))throw new Error("Binance ticker payload");
    const out=new Map<string,HubQuote>();
    for(const row of body){const symbol=canonical(row.symbol??"");if(!symbol)continue;const bid=Number(row.bidPrice),ask=Number(row.askPrice);
      if(!(bid>0&&ask>bid))continue;
      const exchangeAt=Number(row.time),observedAt=exchangeAt>0&&exchangeAt<=now+2_000?Math.min(exchangeAt,now):now;
      out.set(symbol,{source:"BINANCE",symbol,observedAt,last:(bid+ask)/2,bid,ask,bidSize:Math.max(0,Number(row.bidQty??0)),askSize:Math.max(0,Number(row.askQty??0)),
        volume24hUsd:0,change24hRate:0});}
    if(out.size<20)throw new Error(`Binance incomplete ticker surface: ${out.size}`);return out;
  }

  quote(symbol:string,now=Date.now()):ConsensusQuote|null{
    const rows=[this.bybit.get(symbol),this.okx.get(symbol),this.kucoin.get(symbol),this.bitget.get(symbol),this.binance.get(symbol)]
      .filter((q):q is HubQuote=>!!q&&validQuote(q,now));
    if(!rows.length)return null;
    const mids=rows.map(q=>(q.bid+q.ask)/2).sort((a,b)=>a-b),mid=median(mids),
      bid=Math.min(...rows.map(q=>q.bid)),ask=Math.max(...rows.map(q=>q.ask)),
      disagreement=rows.length>1?(Math.max(...mids)-Math.min(...mids))/Math.max(mid,1e-12):0;
    let history=this.quoteHistory.get(symbol);if(!history){history=new Map();this.quoteHistory.set(symbol,history);}
    const moves:number[]=[],imbalances:number[]=[],spreads:number[]=[],bidChanges:number[]=[],askChanges:number[]=[];
    for(const q of rows){
      const qMid=(q.bid+q.ask)/2,total=q.bidSize+q.askSize,imbalance=total>0?(q.bidSize-q.askSize)/total:0,
        spread=qMid>0?(q.ask-q.bid)/qMid:0,series=history.get(q.source)??[],last=series.at(-1),
        anchor=[...series].reverse().find(x=>q.observedAt-x.at>=4_000)??series[0];
      if(anchor&&anchor.mid>0&&q.observedAt>anchor.at){
        moves.push(qMid/anchor.mid-1);
        if(q.bidSize>0&&anchor.bidSize>0)bidChanges.push(clip(q.bidSize/anchor.bidSize-1));
        if(q.askSize>0&&anchor.askSize>0)askChanges.push(clip(q.askSize/anchor.askSize-1));
      }
      if(total>0)imbalances.push(imbalance);spreads.push(spread);
      if(!last||last.at!==q.observedAt){
        series.push({at:q.observedAt,mid:qMid,bidSize:q.bidSize,askSize:q.askSize,imbalance,spread});
        while(series.length>8)series.shift();history.set(q.source,series);
      }
    }
    const up=moves.filter(v=>v>0.00002).length,down=moves.filter(v=>v<-0.00002).length,active=up+down,
      sourceBreadth=active?(up-down)/active:0,directionalAgreement=active?Math.max(up,down)/active:.5,
      medianShortMove=median(moves),bookImbalance=median(imbalances),bidLiquidityChange=median(bidChanges),
      askLiquidityChange=median(askChanges),spreadRate=median(spreads);
    const directional=rows.find(q=>q.source==="BYBIT")??rows.find(q=>q.source==="OKX")??rows.find(q=>q.source==="KUCOIN")??rows.find(q=>q.source==="BITGET");
    return{symbol,observedAt:Math.max(...rows.map(q=>q.observedAt)),mid,bid,ask,sources:rows.map(q=>q.source),sourceCount:rows.length,
      disagreementRate:disagreement,volume24hUsd:Math.max(...rows.map(q=>q.volume24hUsd)),change24hRate:directional?.change24hRate??0,
      sourceBreadth,directionalAgreement,medianShortMove,bookImbalance,bidLiquidityChange,askLiquidityChange,spreadRate,
      liquiditySourceCount:imbalances.length};
  }
  coverage(symbol:string,now=Date.now()){const q=this.quote(symbol,now);return q?{sourceCount:q.sourceCount,sources:q.sources,disagreementRate:q.disagreementRate}
    :{sourceCount:0,sources:[] as MarketSource[],disagreementRate:0};}
  supports(symbol:string){return this.bybit.has(symbol)||this.okx.has(symbol)||this.kucoin.has(symbol)||this.bitget.has(symbol)||this.binance.has(symbol);}
  radarRows<T extends {symbol:string;last:number;volume24hUsd:number;fundingRate:number;
    high24h?:number;low24h?:number;change24hRate?:number;openInterest?:number}>(gate:T[],now=Date.now()){
    return gate.map(row=>{const q=this.quote(row.symbol,now),gateHigh=Number(row.high24h),gateLow=Number(row.low24h),gateChange=Number(row.change24hRate);
      const last=q?.mid??row.last,high=Number.isFinite(gateHigh)&&gateHigh>0?gateHigh:last,low=Number.isFinite(gateLow)&&gateLow>0?gateLow:last;
      return{symbol:row.symbol,last,volume24hUsd:Math.max(row.volume24hUsd,q?.volume24hUsd??0),executionVolume24hUsd:Math.max(0,row.volume24hUsd),
        high24h:Math.max(high,low),low24h:Math.min(high,low),change24hRate:Number.isFinite(gateChange)?gateChange:q?.change24hRate??0,
        fundingRate:row.fundingRate,openInterest:Number.isFinite(Number(row.openInterest))?Number(row.openInterest):0,
        sourceCount:q?.sourceCount??0,sourceDisagreementRate:q?.disagreementRate??0};});
  }

  async candles(symbol:string,interval:"1m"|"5m"|"1d",limit=120):Promise<{source:MarketSource;rows:HubCandle[]}|null>{
    const external=externalSymbol(symbol),okxInst=okxSymbol(symbol),kucoinInst=kucoinSymbol(symbol);if(!external||!okxInst||!kucoinInst)return null;
    const preferred=this.candleSource.get(symbol)?.source,now=Date.now();
    const fetchOne=async(source:MarketSource)=>{
      if((source==="BINANCE"||source==="BITGET")&&now<this.health[source].nextRetryAt)throw new Error(source+" backoff");
      const rows=source==="BYBIT"?await this.bybitCandles(external,interval,limit)
        :source==="OKX"?await this.okxCandles(okxInst,interval,limit)
        :source==="KUCOIN"?await this.kucoinCandles(kucoinInst,interval,limit)
        :source==="BITGET"?await this.bitgetCandles(external,interval,limit)
        :await this.binanceCandles(external,interval,limit);
      if(rows.length<Math.min(6,limit))throw new Error(source+" incomplete candles");
      return{source,rows};
    };
    // Hedge the three normal public feeds in parallel. A slow/blocked venue can
    // no longer add its timeout to every other venue's timeout.
    const primary:MarketSource[]=["BYBIT","OKX","KUCOIN"];
    if(preferred&&primary.includes(preferred))primary.splice(primary.indexOf(preferred),1),primary.unshift(preferred);
    try{const hit=await Promise.any(primary.map(fetchOne));this.candleSource.set(symbol,{source:hit.source,at:Date.now()});return hit;}
    catch{/* bounded fallbacks below */}
    const fallback:MarketSource[]=["BITGET","BINANCE"];
    if(preferred&&fallback.includes(preferred))fallback.splice(fallback.indexOf(preferred),1),fallback.unshift(preferred);
    try{const hit=await Promise.any(fallback.map(fetchOne));this.candleSource.set(symbol,{source:hit.source,at:Date.now()});return hit;}
    catch{return null;}
  }
  private async bybitCandles(symbol:string,interval:"1m"|"5m"|"1d",limit:number){
    type Res={retCode?:number;result?:{list?:string[][]}};
    const i=interval==="1m"?"1":interval==="5m"?"5":"D",n=Math.max(2,Math.min(1000,Math.floor(limit)));
    const body=await json<Res>(`${BYBIT}/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${i}&limit=${n}`,CANDLE_TIMEOUT_MS);
    if(body.retCode!==0||!Array.isArray(body.result?.list))throw new Error("Bybit kline payload");
    const seconds=interval==="1m"?60:interval==="5m"?300:86400,completed=Math.floor(Date.now()/1000/seconds)*seconds;
    return continuous(body.result!.list!.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),
      close:Number(r[4]),volume:Number(r[5])})).filter(r=>r.time+seconds<=completed),seconds).slice(-n);
  }
  private async okxCandles(instId:string,interval:"1m"|"5m"|"1d",limit:number){
    type Res={code?:string;data?:string[][]};
    const n=Math.max(2,Math.min(300,Math.floor(limit))),bar=interval==="1d"?"1Dutc":interval;
    const body=await json<Res>(`${OKX}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${n}`,CANDLE_TIMEOUT_MS);
    if(body.code!=="0"||!Array.isArray(body.data))throw new Error("OKX kline payload");
    const seconds=interval==="1m"?60:interval==="5m"?300:86400,completed=Math.floor(Date.now()/1000/seconds)*seconds;
    return continuous(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),
      close:Number(r[4]),volume:Number(r[5])}))
      .filter((r,i)=>body.data![i]?.[8]==="1"&&r.time+seconds<=completed),seconds).slice(-n);
  }

  private async kucoinCandles(symbol:string,interval:"1m"|"5m"|"1d",limit:number){
    type Res={code?:string;data?:Array<[number|string,number|string,number|string,number|string,number|string,number|string,...unknown[]]>};
    const n=Math.max(6,Math.min(120,Math.floor(limit))),seconds=interval==="1m"?60:interval==="5m"?300:86400,now=Date.now(),
      from=now-(n+6)*seconds*1000;
    const body=await json<Res>(`${KUCOIN}/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${seconds}&from=${from}&to=${now}`,CANDLE_TIMEOUT_MS);
    if(body.code!=="200000"||!Array.isArray(body.data))throw new Error("KuCoin kline payload");
    const completed=Math.floor(now/1000/seconds)*seconds;
    return continuous(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),
      close:Number(r[4]),volume:Number(r[5])})).filter(r=>r.time+seconds<=completed),seconds).slice(-n);
  }

  private async bitgetCandles(symbol:string,interval:"1m"|"5m"|"1d",limit:number){
    type Res={code?:string;data?:string[][]};
    const n=Math.max(2,Math.min(1000,Math.floor(limit))),granularity=interval==="1d"?"1D":interval;
    const body=await json<Res>(`${BITGET}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&granularity=${granularity}&limit=${n}`,CANDLE_TIMEOUT_MS);
    if(body.code!=="00000"||!Array.isArray(body.data))throw new Error("Bitget kline payload");
    const seconds=interval==="1m"?60:interval==="5m"?300:86400,completed=Math.floor(Date.now()/1000/seconds)*seconds;
    return continuous(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),
      close:Number(r[4]),volume:Number(r[5])})).filter(r=>r.time+seconds<=completed),seconds).slice(-n);
  }

  private async binanceCandles(symbol:string,interval:"1m"|"5m"|"1d",limit:number){
    const n=Math.max(2,Math.min(1000,Math.floor(limit)));
    const body=await json<Array<[number,string,string,string,string,string,number,...unknown[]]>>(
      `${BINANCE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval==="1d"?"1d":interval}&limit=${n}`,CANDLE_TIMEOUT_MS);
    if(!Array.isArray(body))throw new Error("Binance kline payload");
    const seconds=interval==="1m"?60:interval==="5m"?300:86400,completed=Math.floor(Date.now()/1000/seconds)*seconds;
    return continuous(body.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),
      close:Number(r[4]),volume:Number(r[5])})).filter(r=>r.time+seconds<=completed),seconds).slice(-n);
  }

  status(now=Date.now()){
    const sources=(["BYBIT","OKX","KUCOIN","BITGET","BINANCE"] as MarketSource[]).map(source=>({source,...this.health[source],
      fresh:this.health[source].lastSuccessAt>0&&now-this.health[source].lastSuccessAt<=15_000}));
    return{version:"multi-source-market-hub-v4",sources,healthySources:sources.filter(s=>s.fresh).length,
      lastSuccessAt:Math.max(...sources.map(s=>s.lastSuccessAt),0),lastAttemptAt:this.lastAttemptAt,inFlight:!!this.inFlight};
  }
}
