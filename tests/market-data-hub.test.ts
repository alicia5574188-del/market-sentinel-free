import test from "node:test";
import assert from "node:assert/strict";
import {MarketDataHub,externalSymbol,okxSymbol} from "../lib/market-data-hub.ts";

const priorFetch=globalThis.fetch;
function withFetch(handler:(url:string)=>Promise<Response>|Response,run:()=>Promise<void>){
  globalThis.fetch=(input)=>handler(String(input));
  return run().finally(()=>{globalThis.fetch=priorFetch;});
}
const bybitSurface=(symbol="BTCUSDT",bid=99.9,ask=100.1)=>({retCode:0,result:{list:Array.from({length:20},(_,i)=>({
  symbol:i===0?symbol:`X${i}USDT`,lastPrice:String(i===0?(bid+ask)/2:10+i),bid1Price:String(i===0?bid:9+i),
  ask1Price:String(i===0?ask:9.2+i),turnover24h:"1000000",price24hPcnt:"0.01"
}))}});
const binanceSurface=(symbol="BTCUSDT",bid=99.9,ask=100.1,time=1_000_000)=>Array.from({length:20},(_,i)=>({
  symbol:i===0?symbol:`Y${i}USDT`,bidPrice:String(i===0?bid:19+i),askPrice:String(i===0?ask:19.2+i),time
}));
const okxSurface=(instId="BTC-USDT-SWAP",bid=99.9,ask=100.1,time=1_000_000)=>({code:"0",data:Array.from({length:20},(_,i)=>({
  instId:i===0?instId:`Z${i}-USDT-SWAP`,last:String(i===0?(bid+ask)/2:30+i),bidPx:String(i===0?bid:29+i),
  askPx:String(i===0?ask:29.2+i),volCcy24h:"1000",open24h:"99",ts:String(time)
}))});
const bitgetSurface=(symbol="BTCUSDT",bid=99.9,ask=100.1,time=1_000_000)=>({code:"00000",data:Array.from({length:20},(_,i)=>({
  symbol:i===0?symbol:`B${i}USDT`,lastPr:String(i===0?(bid+ask)/2:40+i),bidPr:String(i===0?bid:39+i),
  askPr:String(i===0?ask:39.2+i),quoteVolume:"2000000",change24h:"0.02",ts:String(time)
}))});
const mexcSurface=(symbol="BTC_USDT",bid=99.9,ask=100.1,time=1_000_000)=>({success:true,code:0,data:Array.from({length:20},(_,i)=>({
  symbol:i===0?symbol:`M${i}_USDT`,lastPrice:i===0?(bid+ask)/2:50+i,bid1:i===0?bid:49+i,ask1:i===0?ask:49.2+i,
  amount24:3000000,riseFallRate:.03,timestamp:time
}))});

test("exact Gate-to-external symbol mapping never invents aliases",()=>{
  assert.equal(externalSymbol("BTC_USDT"),"BTCUSDT");
  assert.equal(externalSymbol("1000PEPE_USDT"),"1000PEPEUSDT");
  assert.equal(externalSymbol("BTC_USDC"),null);
  assert.equal(okxSymbol("BTC_USDT"),"BTC-USDT-SWAP");
  assert.equal(okxSymbol("BTC_USDC"),null);
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

test("OKX keeps analysis alive when Bybit, MEXC, Bitget and Binance are unavailable",async()=>{
  await withFetch(url=>{
    if(url.includes("okx.com"))return Response.json(okxSurface());
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("BTC_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,1);assert.deepEqual(q.sources,["OKX"]);
    assert.equal(hub.status(1_000_001).healthySources,1);
  });
});

test("Bybit, OKX and MEXC form a three-source consensus while WAF fallbacks are blocked",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface("ETHUSDT",99.9,100.1));
    if(url.includes("okx.com"))return Response.json(okxSurface("ETH-USDT-SWAP",100.0,100.2));
    if(url.includes("api.mexc.com"))return Response.json(mexcSurface("ETH_USDT",100.1,100.3));
    if(url.includes("api.bitget.com")||url.includes("fapi.binance.com"))return new Response("WAF",{status:403});
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("ETH_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,3);
    assert.deepEqual(new Set(q.sources),new Set(["BYBIT","OKX","MEXC"]));
    assert.ok(q.mid>100&&q.mid<100.3);
    const status=hub.status(1_000_001);assert.equal(status.healthySources,3);
    const bitget=status.sources.find(row=>row.source==="BITGET"),binance=status.sources.find(row=>row.source==="BINANCE");
    assert.equal(bitget?.lastError,"market source 403");assert.equal(binance?.lastError,"market source 403");
    assert.ok((bitget?.nextRetryAt??0)>1_000_001);assert.ok((binance?.nextRetryAt??0)>1_000_001);
  });
});

test("two healthy venues still form consensus when the other sources fail",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface("ETHUSDT",99.9,100.1));
    if(url.includes("api.mexc.com"))return Response.json(mexcSurface("ETH_USDT",100.9,101.1));
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("ETH_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,2);
    assert.ok(q.disagreementRate>.009&&q.disagreementRate<.011);
  });
});

test("5m then 1m keep venue affinity and fail over from Bybit to MEXC together",async()=>{
  let bybitOk=true;
  await withFetch(url=>{
    if(url.includes("/v5/market/kline")){
      if(!bybitOk)throw new DOMException("timeout","TimeoutError");
      const interval=new URL(url).searchParams.get("interval"),step=interval==="5"?300_000:60_000,now=Math.floor(Date.now()/step)*step;
      return Response.json({retCode:0,result:{list:Array.from({length:8},(_,i)=>{
        const t=now-(i+2)*step;return[String(t),"100","101","99","100.5","10","0"];
      })}});
    }
    if(url.includes("okx.com"))throw new DOMException("timeout","TimeoutError");
    if(url.includes("api.mexc.com/api/v1/contract/kline/")){
      const interval=new URL(url).searchParams.get("interval"),step=interval==="Min5"?300:60,now=Math.floor(Date.now()/1000/step)*step;
      const times=Array.from({length:8},(_,i)=>now-(8-i)*step);
      return Response.json({success:true,code:0,data:{time:times,open:times.map(()=>200),high:times.map(()=>201),
        low:times.map(()=>199),close:times.map(()=>200.5),vol:times.map(()=>10)}});
    }
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();
    const five=await hub.candles("BTC_USDT","5m",8);assert.equal(five?.source,"BYBIT");
    const one=await hub.candles("BTC_USDT","1m",8);assert.equal(one?.source,"BYBIT");
    bybitOk=false;
    const switched=await hub.candles("BTC_USDT","5m",8);assert.equal(switched?.source,"MEXC");
    const oneAfter=await hub.candles("BTC_USDT","1m",8);assert.equal(oneAfter?.source,"MEXC");
  });
});

test("Bitget and Binance 403 enter WAF backoff without delaying three healthy primaries",async()=>{
  let bitgetCalls=0,binanceCalls=0;
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface());
    if(url.includes("okx.com"))return Response.json(okxSurface());
    if(url.includes("api.mexc.com"))return Response.json(mexcSurface());
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
