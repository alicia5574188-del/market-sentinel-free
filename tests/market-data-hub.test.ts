import test from "node:test";
import assert from "node:assert/strict";
import {MarketDataHub,externalSymbol,okxSymbol,kucoinSymbol,mexcSymbol,htxSymbol} from "../lib/market-data-hub.ts";

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
const mexcSurface=(symbol="BTC_USDT",bid=99.9,ask=100.1,time=1_000_000)=>({success:true,code:0,data:Array.from({length:20},(_,i)=>({
  symbol:i===0?symbol:`M${i}_USDT`,lastPrice:i===0?(bid+ask)/2:70+i,bid1:i===0?bid:69+i,ask1:i===0?ask:69.2+i,
  amount24:2_000_000,riseFallRate:.02,timestamp:time
}))});
const htxSurface=(contractCode="BTC-USDT",bid=99.9,ask=100.1,time=1_000_000,bidSize=7,askSize=7)=>({status:"ok",ticks:Array.from({length:20},(_,i)=>({
  contract_code:i===0?contractCode:`H${i}-USDT`,close:i===0?(bid+ask)/2:90+i,open:i===0?99:89+i,
  bid:[i===0?bid:89+i,i===0?bidSize:10],ask:[i===0?ask:89.2+i,i===0?askSize:10],trade_turnover:3_000_000,ts:time
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
  assert.equal(mexcSymbol("BTC_USDT"),"BTC_USDT");
  assert.equal(mexcSymbol("BTC_USDC"),null);
  assert.equal(htxSymbol("BTC_USDT"),"BTC-USDT");
  assert.equal(htxSymbol("BTC_USDC"),null);
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

test("Gate-only radar keeps its 15-second short impulse when no external venue lists the symbol",()=>{
  const hub=new MarketDataHub(),rows=hub.radarRows([{
    symbol:"GATEONLY_USDT",last:10,volume24hUsd:2_500_000,high24h:10.5,low24h:9.2,change24hRate:.04,
    fundingRate:0,openInterest:100,shortMoveRate:.0035,directionalAgreement:1,sourceBreadth:1,sourceCount:1
  }],1_000_001);
  assert.equal(rows.length,1);
  assert.equal(rows[0]?.sourceCount,1);
  assert.equal(rows[0]?.shortMoveRate,.0035);
  assert.equal(rows[0]?.directionalAgreement,1);
  assert.equal(rows[0]?.sourceBreadth,1);
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

test("OKX keeps analysis alive when Bybit, KuCoin, MEXC and HTX are unavailable",async()=>{
  await withFetch(url=>{
    if(url.includes("okx.com"))return Response.json(okxSurface());
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("BTC_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,1);assert.deepEqual(q.sources,["OKX"]);
    assert.equal(hub.status(1_000_001).healthySources,1);
  });
});

test("Bybit, OKX, KuCoin, MEXC and HTX form a five-source consensus",async()=>{
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface("ETHUSDT",99.9,100.1));
    if(url.includes("okx.com"))return Response.json(okxSurface("ETH-USDT-SWAP",100.0,100.2));
    if(url.includes("api-futures.kucoin.com"))return Response.json(kucoinSurface("ETHUSDTM",100.1,100.3));
    if(url.includes("api.mexc.com"))return Response.json(mexcSurface("ETH_USDT",100.2,100.4));
    if(url.includes("api.hbdm.com"))return Response.json(htxSurface("ETH-USDT",100.3,100.5));
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);
    const q=hub.quote("ETH_USDT",1_000_001);assert.ok(q);assert.equal(q.sourceCount,5);
    assert.deepEqual(new Set(q.sources),new Set(["BYBIT","OKX","KUCOIN","MEXC","HTX"]));
    assert.ok(q.mid>100&&q.mid<100.5);
    const status=hub.status(1_000_001);assert.equal(status.healthySources,5);
    assert.equal(status.version,"multi-source-market-hub-v5");
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

test("MEXC and HTX 403 enter bounded backoff without delaying three healthy primary sources",async()=>{
  let mexcCalls=0,htxCalls=0;
  await withFetch(url=>{
    if(url.includes("api.bybit.com"))return Response.json(bybitSurface());
    if(url.includes("okx.com"))return Response.json(okxSurface());
    if(url.includes("api-futures.kucoin.com"))return Response.json(kucoinSurface());
    if(url.includes("api.mexc.com")){mexcCalls++;return new Response("WAF",{status:403});}
    if(url.includes("api.hbdm.com")){htxCalls++;return new Response("WAF",{status:403});}
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();
    await hub.refresh(1_000_000);assert.equal(mexcCalls,1);assert.equal(htxCalls,1);
    await hub.refresh(1_001_000);assert.equal(mexcCalls,1);assert.equal(htxCalls,1);
    const status=hub.status(1_001_001);assert.equal(status.healthySources,3);
    assert.equal(status.sources.find(row=>row.source==="MEXC")?.failures,1);
    assert.equal(status.sources.find(row=>row.source==="HTX")?.failures,1);
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
    if(url.includes("api.mexc.com"))return Response.json(phase===0
      ?mexcSurface("ETH_USDT",100.05,100.25,1_000_000):mexcSurface("ETH_USDT",100.25,100.45,1_005_000));
    if(url.includes("api.hbdm.com"))return Response.json(phase===0
      ?htxSurface("ETH-USDT",100.02,100.22,1_000_000,7,14):htxSurface("ETH-USDT",100.22,100.42,1_005_000,14,7));
    throw new Error("unexpected");
  },async()=>{
    const hub=new MarketDataHub();
    await hub.refresh(1_000_000);
    const first=hub.quote("ETH_USDT",1_000_001);assert.ok(first);
    assert.equal(first.liquiditySourceCount,4);
    assert.ok(first.bookImbalance<-.25,"three venues begin ask-heavy");
    phase=1;await hub.refresh(1_005_000);
    const second=hub.quote("ETH_USDT",1_005_001);assert.ok(second);
    assert.equal(second.liquiditySourceCount,4);
    assert.ok(second.bookImbalance>.25,"three venues rotate bid-heavy");
    assert.ok(second.bidLiquidityChange>.5,"bid liquidity expanded versus the prior 4s anchor");
    assert.ok(second.askLiquidityChange<-.4,"ask liquidity withdrew versus the prior 4s anchor");
    assert.ok(second.spreadRate>0);
    const radar=hub.radarRows([{symbol:"ETH_USDT",last:100,volume24hUsd:2_000_000,high24h:105,low24h:95,
      change24hRate:.02,fundingRate:0,openInterest:10}],1_005_001);
    assert.ok((radar[0]?.shortMoveRate??0)>.001,"whole-market radar receives the same realtime consensus move");
    assert.ok((radar[0]?.directionalAgreement??0)>=.5);
  });
});


test("MEXC and HTX provide complete candle fallback when the three primary candle venues fail",async()=>{
  let fallback:"MEXC"|"HTX"="MEXC";
  await withFetch(url=>{
    if(url.includes("api.bybit.com")||url.includes("okx.com")||url.includes("api-futures.kucoin.com"))
      throw new DOMException("timeout","TimeoutError");
    const parsed=new URL(url),interval=parsed.searchParams.get("interval"),period=parsed.searchParams.get("period");
    const isMexc=url.includes("api.mexc.com");
    if(isMexc&&fallback==="MEXC"){
      const step=interval==="Day1"?86_400:interval==="Min5"?300:60,now=Math.floor(Date.now()/1000/step)*step;
      const rows=Array.from({length:10},(_,i)=>now-(10-i)*step);
      return Response.json({success:true,code:0,data:{time:rows,open:rows.map(()=>100),high:rows.map(()=>101),low:rows.map(()=>99),
        close:rows.map(()=>100.5),vol:rows.map(()=>10)}});
    }
    if(url.includes("api.hbdm.com")&&fallback==="HTX"){
      const step=period==="1day"?86_400:period==="5min"?300:60,now=Math.floor(Date.now()/1000/step)*step;
      return Response.json({status:"ok",data:Array.from({length:10},(_,i)=>({id:now-(10-i)*step,open:200,high:201,low:199,close:200.5,amount:10}))});
    }
    throw new DOMException("timeout","TimeoutError");
  },async()=>{
    const hub=new MarketDataHub();
    const mexc=await hub.candles("BTC_USDT","5m",8);assert.equal(mexc?.source,"MEXC");assert.ok((mexc?.rows.length??0)>=6);
    fallback="HTX";
    const htx=await hub.candles("ETH_USDT","1m",8);assert.equal(htx?.source,"HTX");assert.ok((htx?.rows.length??0)>=6);
  });
});
