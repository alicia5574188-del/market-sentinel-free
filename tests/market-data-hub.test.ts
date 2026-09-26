import test from "node:test";
import assert from "node:assert/strict";
import {MarketDataHub,externalSymbol,okxSymbol,kucoinSymbol} from "../lib/market-data-hub.ts";

const priorFetch=globalThis.fetch;
function withFetch(handler:(url:string)=>Promise<Response>|Response,run:()=>Promise<void>){
  globalThis.fetch=(input)=>handler(String(input));
  return run().finally(()=>{globalThis.fetch=priorFetch;});
}
const bybitSurface=(symbol="BTCUSDT",bid=99.9,ask=100.1,bidSize=12,askSize=12)=>({retCode:0,result:{list:Array.from({length:20},(_,i)=>({
  symbol:i===0?symbol:`X${i}USDT`,lastPrice:String(i===0?(bid+ask)/2:10+i),bid1Price:String(i===0?bid:9+i),
  ask1Price:String(i===0?ask:9.2+i),bid1Size:String(i===0?bidSize:10),ask1Size:String(i===0?askSize:10),
  turnover24h:"1000000",price24hPcnt:"0.01"
}))}});
const okxSurface=(instId="BTC-USDT-SWAP",bid=99.9,ask=100.1,time=1_000_000,bidSize=10,askSize=10)=>({code:"0",data:Array.from({length:20},(_,i)=>({
  instId:i===0?instId:`Z${i}-USDT-SWAP`,last:String(i===0?(bid+ask)/2:30+i),bidPx:String(i===0?bid:29+i),
  askPx:String(i===0?ask:29.2+i),bidSz:String(i===0?bidSize:10),askSz:String(i===0?askSize:10),
  volCcy24h:"1000",open24h:"99",ts:String(time)
}))});
const kucoinSurface=(symbol="XBTUSDTM",bid=99.9,ask=100.1,bidSize=8,askSize=8)=>({code:"200000",data:Array.from({length:20},(_,i)=>({
  symbol:i===0?symbol:`K${i}USDTM`,price:String(i===0?(bid+ask)/2:50+i),bestBidPrice:String(i===0?bid:49+i),
  bestAskPrice:String(i===0?ask:49.2+i),bestBidSize:String(i===0?bidSize:10),bestAskSize:String(i===0?askSize:10),ts:0
}))});

test("exact Gate-to-external symbol mapping never invents aliases",()=>{
  assert.equal(externalSymbol("BTC_USDT"),"BTCUSDT");
  assert.equal(externalSymbol("1000PEPE_USDT"),"1000PEPEUSDT");
  assert.equal(externalSymbol("BTC_USDC"),null);
  assert.equal(okxSymbol("BTC_USDT"),"BTC-USDT-SWAP");
  assert.equal(okxSymbol("BTC_USDC"),null);
  assert.equal(kucoinSymbol("BTC_USDT"),"XBTUSDTM");
  assert.equal(kucoinSymbol("ETH_USDT"),"ETHUSDTM");
  assert.equal(kucoinSymbol("BTC_USDC"),null);
});

test("Forward radar keeps Gate execution volume and Gate 24h range separate from external analysis liquidity",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface("BTCUSDT",99.9,100.1));
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const rows=hub.radarRows([{symbol:"BTC_USDT",last:100,volume24hUsd:50_000,high24h:120,low24h:80,change24hRate:.05,fundingRate:0,openInterest:10}],1_000_001);
    assert.equal(rows[0]?.volume24hUsd,1_000_000,"external volume may describe analysis liquidity");
    assert.equal(rows[0]?.executionVolume24hUsd,50_000,"Gate volume alone decides execution eligibility");
    assert.equal(rows[0]?.high24h,120);assert.equal(rows[0]?.low24h,80);assert.equal(rows[0]?.change24hRate,.05);
  });
});

test("one healthy venue keeps the market hub alive when the other fails",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface());
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("BTC_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,1);assert.deepEqual(q.sources,["BYBIT"]);
    assert.equal(hub.status(1_000_001).healthySources,1);
  });
});

test("OKX keeps analysis alive when Bybit, KuCoin, Bitget and Binance are unavailable",async()=>{
  await withFetch(url=>{
    if(url.includes("okx.com"))return Response.json(okxSurface());
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("BTC_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,1);assert.deepEqual(q.sources,["OKX"]);
    assert.equal(hub.status(1_000_001).healthySources,1);
  });
});

test("Bybit, OKX and KuCoin form a three-source consensus while Bitget and Binance are WAF-blocked",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface("ETHUSDT",99.9,100.1));
    if(url.includes("okx.com"))return Response.json(okxSurface("ETH-USDT-SWAP",100.0,100.2));
    if(url.includes("api-futures.kucoin.com"))return Response.json(kucoinSurface("ETHUSDTM",100.1,100.3));
    return new Response("WAF",{status:403});
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("ETH_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,3);
    assert.deepEqual(new Set(q.sources),new Set(["BYBIT","OKX","KUCOIN"]));
    assert.ok(q.mid>100&&q.mid<100.3);
    const status=hub.status(1_000_001);assert.equal(status.healthySources,3);
    for(const source of["BITGET","BINANCE"] as const){const row=status.sources.find(x=>x.source===source);
      assert.equal(row?.lastError,"market source 403");assert.ok((row?.nextRetryAt??0)>1_000_001);}
  });
});

test("two healthy venues still form consensus when the other sources fail",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface("ETHUSDT",99.9,100.1));
    if(url.includes("api-futures.kucoin.com"))return Response.json(kucoinSurface("ETHUSDTM",100.9,101.1));
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("ETH_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,2);
    assert.ok(q.disagreementRate>.009&&q.disagreementRate<.011);
  });
});

test("5m, 1m and 1d keep venue affinity and fail over from Bybit to KuCoin together",async()=>{
  let bybitOk=true;
  await withFetch(url=>{
    if(url.includes("/v5/market/kline")){
      if(!bybitOk)throw new DOMException("timeout","TimeoutError");
      const interval=new URL(url).searchParams.get("interval"),step=interval==="D"?86_400_000:interval==="5"?300_000:60_000,now=Math.floor(Date.now()/step)*step;
      return Response.json({retCode:0,result:{list:Array.from({length:8},(_,i)=>{
        const t=now-(i+2)*step;return[String(t),"100","101","99","100.5","10","0"];
      })}});
    }
    if(url.includes("okx.com"))throw new DOMException("timeout","TimeoutError");
    if(url.includes("api-futures.kucoin.com/api/v1/kline/query")){
      const granularity=Number(new URL(url).searchParams.get("granularity")),step=granularity*1000,now=Math.floor(Date.now()/step)*step;
      return Response.json({code:"200000",data:Array.from({length:8},(_,i)=>{
        const t=now-(8-i)*step;return[t,"200","201","199","200.5","10","2000"];
      })});
    }
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();
    const five=await hub.candles("BTC_USDT","5m",8);assert.equal(five?.source,"BYBIT");
    const one=await hub.candles("BTC_USDT","1m",8);assert.equal(one?.source,"BYBIT");
    const day=await hub.candles("BTC_USDT","1d",8);assert.equal(day?.source,"BYBIT");
    bybitOk=false;
    const switched=await hub.candles("BTC_USDT","5m",8);assert.equal(switched?.source,"KUCOIN");
    const oneAfter=await hub.candles("BTC_USDT","1m",8);assert.equal(oneAfter?.source,"KUCOIN");
    const dayAfter=await hub.candles("BTC_USDT","1d",8);assert.equal(dayAfter?.source,"KUCOIN");
  });
});

test("Bitget and Binance 403 enter WAF backoff without delaying three healthy primary sources",async()=>{
  let bitgetCalls=0,binanceCalls=0;
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface());
    if(url.includes("okx.com"))return Response.json(okxSurface());
    if(url.includes("api-futures.kucoin.com"))return Response.json(kucoinSurface());
    if(url.includes("api.bitget.com")){bitgetCalls++;return new Response("WAF",{status:403});}
    if(url.includes("fapi.binance.com")){binanceCalls++;return new Response("WAF",{status:403});}
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();
    await hub.refresh(1_000_000);assert.equal(bitgetCalls,1);assert.equal(binanceCalls,1);
    await hub.refresh(1_001_000);assert.equal(bitgetCalls,1);assert.equal(binanceCalls,1);
    const status=hub.status(1_001_001);assert.equal(status.healthySources,3);
    assert.equal(status.sources.find(row=>row.source==="BITGET")?.failures,1);
    assert.equal(status.sources.find(row=>row.source==="BINANCE")?.failures,1);
  });
});


test("existing bulk BBO feeds expose cross-venue liquidity imbalance and migration without extra symbol requests",async()=>{
  let phase=0;
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(phase===0
      ?bybitSurface("ETHUSDT",99.9,100.1,10,20):bybitSurface("ETHUSDT",100.1,100.3,20,10));
    if(url.includes("okx.com"))return Response.json(phase===0
      ?okxSurface("ETH-USDT-SWAP",99.95,100.15,phase?1_005_000:1_000_000,8,16)
      :okxSurface("ETH-USDT-SWAP",100.15,100.35,1_005_000,16,8));
    if(url.includes("api-futures.kucoin.com"))return Response.json(phase===0
      ?kucoinSurface("ETHUSDTM",100.0,100.2,6,12):kucoinSurface("ETHUSDTM",100.2,100.4,12,6));
    return new Response("WAF",{status:403});
  },async()=>{
    const hub=new MarketDataHub();
    await hub.refresh(1_000_000);
    const first=hub.quote("ETH_USDT",1_000_001);assert.ok(first);
    assert.equal(first.liquiditySourceCount,3);
    assert.ok(first.bookImbalance<-.25,"three venues begin ask-heavy");
    phase=1;await hub.refresh(1_005_000);
    const second=hub.quote("ETH_USDT",1_005_001);assert.ok(second);
    assert.equal(second.liquiditySourceCount,3);
    assert.ok(second.bookImbalance>.25,"three venues rotate bid-heavy");
    assert.ok(second.bidLiquidityChange>.5,"bid liquidity expanded versus the prior 4s anchor");
    assert.ok(second.askLiquidityChange<-.4,"ask liquidity withdrew versus the prior 4s anchor");
    assert.ok(second.spreadRate>0);
  });
});
