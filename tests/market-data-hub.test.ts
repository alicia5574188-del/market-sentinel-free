import test from "node:test";
import assert from "node:assert/strict";
import {MarketDataHub,externalSymbol} from "../lib/market-data-hub.ts";

const priorFetch=globalThis.fetch;
function withFetch(handler:(url:string)=>Promise<Response>|Response,run:()=>Promise<void>){
  globalThis.fetch=(input)=>handler(String(input));
  return run().finally(()=>{globalThis.fetch=priorFetch;});
}

test("exact Gate-to-external symbol mapping never invents aliases",()=>{
  assert.equal(externalSymbol("BTC_USDT"),"BTCUSDT");
  assert.equal(externalSymbol("1000PEPE_USDT"),"1000PEPEUSDT");
  assert.equal(externalSymbol("BTC_USDC"),null);
});

test("one healthy venue keeps the market hub alive when the other fails",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json({retCode:0,result:{list:[
      {symbol:"BTCUSDT",lastPrice:"100",bid1Price:"99.9",ask1Price:"100.1",turnover24h:"1000000",price24hPcnt:"0.01"}
    ]}});
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("BTC_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,1);assert.deepEqual(q.sources,["BYBIT"]);
    assert.equal(hub.status(1_000_001).healthySources,1);
  });
});

test("two venues form consensus and expose disagreement instead of averaging it away",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json({retCode:0,result:{list:[
      {symbol:"ETHUSDT",lastPrice:"100",bid1Price:"99.9",ask1Price:"100.1",turnover24h:"500000",price24hPcnt:"0.02"}
    ]}});
    return Response.json([{symbol:"ETHUSDT",bidPrice:"100.9",askPrice:"101.1",time:1_000_000}]);
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("ETH_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,2);
    assert.ok(q.disagreementRate>.009&&q.disagreementRate<.011);
  });
});

test("5m then 1m use one venue affinity and fail over together",async()=>{
  const urls:string[]=[];let bybitOk=true;
  await withFetch(url=>{
    urls.push(url);
    if(url.includes("/v5/market/kline")){
      if(!bybitOk)throw new DOMException("timeout","TimeoutError");
      const interval=new URL(url).searchParams.get("interval"),step=interval==="5"?300_000:60_000,now=Math.floor(Date.now()/step)*step;
      return Response.json({retCode:0,result:{list:Array.from({length:8},(_,i)=>{
        const t=now-(i+2)*step;return[String(t),"100","101","99","100.5","10","0"];
      })}});
    }
    if(url.includes("fapi.binance.com/fapi/v1/klines")){
      const step=url.includes("interval=5m")?300_000:60_000,now=Math.floor(Date.now()/step)*step;
      return Response.json(Array.from({length:8},(_,i)=>{
        const t=now-(8-i)*step;return[t,"200","201","199","200.5","10",t+step-1,"0",0,"0","0","0"];
      }));
    }
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();
    const five=await hub.candles("BTC_USDT","5m",8);assert.equal(five?.source,"BYBIT");
    const one=await hub.candles("BTC_USDT","1m",8);assert.equal(one?.source,"BYBIT");
    bybitOk=false;
    const switched=await hub.candles("BTC_USDT","5m",8);assert.equal(switched?.source,"BINANCE");
    const oneAfter=await hub.candles("BTC_USDT","1m",8);assert.equal(oneAfter?.source,"BINANCE");
  });
});
