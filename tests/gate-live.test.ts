import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveEntryIntent, buildLiveStopIntent, gateUnknownSubmissionCanResolve, GateEntryCancelledError, GateLiveClient, GateReadTimeoutError, LiveEntrySizingError, liveEntryDisposition, liveOrderId, liveStopPriceForTick } from "../lib/gate-live.ts";
import type { PaperPlan } from "../lib/liquidity-core.ts";

function plan(marketState: PaperPlan["marketState"], side: PaperPlan["side"]): PaperPlan {
  return {
    id: `BTC_USDT:${marketState}:${side}`, symbol: "BTC_USDT", observedAt: Date.now(), marketState, side,
    entryTrigger: 100, invalidation: side === "LONG" ? 99 : 101, target: side === "LONG" ? 103 : 97,
    targetIdentity: "BOOK:target", score: 2, oppositeScore: 1, reason: ["test"], state: "PREPARED",
    createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, plannedRisk: 20, notional: 2_000,
  };
}

class FakeTradeSocket {
  readyState=1;
  accepted=false;
  sent:Record<string,unknown>[]=[];
  listeners=new Map<string,(event:{data?:unknown})=>void>();
  orderResult:Record<string,unknown>|null={id_string:"123456789012345678",text:"t-ms-e-test",status:"finished",finish_as:"filled",size:"1",left:"0",fill_price:"100"};
  accept(){this.accepted=true;}
  close(){this.readyState=3;}
  addEventListener(type:string,listener:(event:{data?:unknown})=>void){this.listeners.set(type,listener);}
  send(data:string){
    const message=JSON.parse(data) as Record<string,unknown>;this.sent.push(message);
    const channel=String(message.channel??""),payload=(message.payload??{}) as Record<string,unknown>,reqId=String(payload.req_id??"");
    if(channel==="futures.login"){
      queueMicrotask(()=>this.message({request_id:reqId,ack:false,header:{status:"200",channel:"futures.login",event:"api"},
        data:{result:{status:"success"}}}));
    }else if(channel==="futures.order_place"&&this.orderResult){
      const result={...this.orderResult,text:((payload.req_param??{}) as Record<string,unknown>).text??this.orderResult.text};
      queueMicrotask(()=>this.message({request_id:reqId,ack:true,header:{status:"200",channel:"futures.order_place",event:"api"},data:{result:{req_id:reqId}}}));
      queueMicrotask(()=>this.message({request_id:reqId,ack:false,header:{status:"200",channel:"futures.order_place",event:"api"},data:{result}}));
    }
  }
  message(value:unknown){this.listeners.get("message")?.({data:JSON.stringify(value)});}
}

test("a confirmed breakout becomes an IOC market order sized from its current entry", () => {
  const intent = buildLiveEntryIntent({ plan: plan("BREAKOUT", "LONG"), entryPrice: 100.25,
    equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
  assert.equal(intent.kind, "MARKET");
  assert.ok(intent.plannedRisk > 0 && intent.plannedRisk <= 50);
  assert.ok(intent.notional <= 4_000);
  assert.ok(intent.notional * 0.0018 <= 7.2);
  assert.ok(intent.margin <= 200.01);
  assert.equal(intent.body.price, "0");
  assert.equal(intent.body.tif, "ioc");
  assert.equal(intent.body.reduce_only, false);
  assert.equal(intent.body.trigger, undefined);
});

test("entry intent is rechecked after asynchronous signing before any private fetch",async()=>{
  const original=globalThis.fetch;let requests=0,allowed=true,guardCalls=0;
  globalThis.fetch=async()=>{requests++;throw new Error("unexpected private network call");};
  try {
    const intent=buildLiveEntryIntent({plan:plan("BREAKOUT","LONG"),entryPrice:100.25,
      equity:1000,available:1000,openRisk:0,quantoMultiplier:.001,leverageMax:50});
    const client=new GateLiveClient({apiKey:"test-only-key",apiSecret:"test-only-secret",environment:"testnet"});
    const pending=client.createEntry(intent,()=>{guardCalls++;return allowed;});
    allowed=false;
    await assert.rejects(pending,GateEntryCancelledError);
    assert.equal(guardCalls,1);assert.equal(requests,0);
  }finally{globalThis.fetch=original;}
});

test("confirmed retest and failed-break entries both use realtime IOC", () => {
  const retest = buildLiveEntryIntent({ plan: { ...plan("BREAKOUT", "LONG"), routeKind: "BREAKOUT_RETEST" },
    entryPrice: 100.2, equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
  assert.equal(retest.kind, "MARKET");
  const failed = buildLiveEntryIntent({ plan: { ...plan("REVERSAL", "SHORT"), routeKind: "FAILED_BREAKOUT_REVERSAL" },
    entryPrice: 99.8, equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
  assert.equal(failed.kind, "MARKET");
  assert.equal(failed.body.tif, "ioc");
});

test("LIVE ignores a legacy farther target and rejects an uneconomic short-term target", () => {
  const staged = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8, target: 100.6, nextTarget: 101,
    routeKind: "LOCAL_BREAKOUT" as const, confirmationScore: 0.9, fakeoutRisk: 0.1, economicTarget: 101 };
  assert.throws(() => buildLiveEntryIntent({ plan: staged, entryPrice: 100, equity: 1_000, available: 1_000,
    openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 }),
  (error) => error instanceof LiveEntrySizingError && error.code === "ECONOMICS");
  assert.equal(staged.target, 100.6);
});

test("a selected account order mirrors its proportional notional only after fresh LIVE economics pass", () => {
  const selected = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8, target: 103 };
  const intent = buildLiveEntryIntent({ plan: selected, entryPrice: 100, equity: 100, available: 100,
    openRisk: 0, quantoMultiplier: 0.01, leverageMax: 50, mirrorNotionalFraction: 0.3, modeledCostRate: 0.0012 });
  assert.equal(intent.notional, 30);
  assert.equal(intent.contracts, 30);
  assert.ok(Math.abs(intent.plannedRisk - 0.096) < 1e-9, "LIVE must use the selected account order's modeled cost");
  assert.ok(intent.plannedRisk <= 6.5);
});

test("LIVE preserves leveraged PAPER notional as the same equity fraction", () => {
  const selected = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8, target: 103 };
  const intent = buildLiveEntryIntent({ plan: selected, entryPrice: 100, equity: 10, available: 10,
    openRisk: 0, quantoMultiplier: 0.01, leverageMax: 50, mirrorNotionalFraction: 3,
    modeledCostRate: 0.0012 });
  assert.equal(intent.notional, 30, "a 3000 U PAPER order on 1000 U must become 30 U on a 10 U LIVE account");
  assert.equal(intent.contracts, 30);
});

test("a 10 U LIVE account uses Gate's one-contract lot when its actual stop risk fits total and correlated caps", () => {
  const scaled = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8 };
  const intent = buildLiveEntryIntent({ plan: scaled, equity: 10, available: 5.88, openRisk: 0, quantoMultiplier: 1, leverageMax: 50 });
  assert.equal(intent.contracts, 1);
  assert.equal(intent.notional, 100);
  assert.equal(intent.leverage, 50);
  assert.ok(intent.margin <= 5.88);
  assert.ok(intent.plannedRisk <= 0.65);
});

test("an indivisible Gate lot is rejected when its real correlated risk or margin cannot fit", () => {
  assert.throws(
    () => buildLiveEntryIntent({ plan: plan("BREAKOUT", "LONG"), equity: 10, available: 5.88, openRisk: 0, quantoMultiplier: 1, leverageMax: 50 }),
    (error) => error instanceof LiveEntrySizingError && error.code === "RISK_CAP",
  );
  const scaled = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8 };
  assert.throws(
    () => buildLiveEntryIntent({ plan: scaled, equity: 10, available: 0.01, openRisk: 0, quantoMultiplier: 1, leverageMax: 50 }),
    (error) => error instanceof LiveEntrySizingError && error.code === "MARGIN",
  );
});

test("reversal and range submit only realtime IOC after internal confirmation", () => {
  for (const state of ["REVERSAL", "RANGE"] as const) {
    const intent = buildLiveEntryIntent({ plan: plan(state, "SHORT"), equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
    assert.equal(intent.kind, "MARKET");
    assert.equal(intent.body.price, "0");
    assert.equal(intent.body.tif, "ioc");
    assert.ok(Number(intent.body.size) < 0);
  }
});

test("protective stop is close-only and cannot reverse the account", () => {
  const stop = buildLiveStopIntent({ id: "position-1", symbol: "SOL_USDT", side: "LONG", currentStop: 99 });
  const initial = stop.body.initial as { size: number; price: string; close: boolean; reduce_only: boolean };
  const trigger = stop.body.trigger as { rule: number; price: string };
  assert.deepEqual(initial, { contract: "SOL_USDT", size: 0, price: "0", tif: "ioc", close: true, reduce_only: true, text: stop.tag });
  assert.equal(trigger.rule, 2);
  assert.equal(trigger.price, "99");
  assert.equal((stop.body.trigger as { expiration: number }).expiration, 86_400 * 30);
});

test("LIVE protective stops align outward to Gate's contract tick without exiting before PAPER", () => {
  assert.equal(liveStopPriceForTick("SHORT", 736.135, 0.05), 736.15);
  assert.equal(liveStopPriceForTick("LONG", 1123.721, 0.01), 1123.72);

  const short = buildLiveStopIntent({ id: "bnb", symbol: "BNB_USDT", side: "SHORT", currentStop: 736.135 }, 0.05);
  const long = buildLiveStopIntent({ id: "zec", symbol: "ZEC_USDT", side: "LONG", currentStop: 1123.721 }, 0.01);
  assert.equal((short.body.trigger as { price: string }).price, "736.15");
  assert.equal((long.body.trigger as { price: string }).price, "1123.72");
  assert.equal(short.price % 0.05 < 1e-9 || 0.05 - short.price % 0.05 < 1e-9, true);
  assert.equal(long.price % 0.01 < 1e-9 || 0.01 - long.price % 0.01 < 1e-9, true);
  assert.ok(short.price >= 736.135);
  assert.ok(long.price <= 1123.721);
});

test("scientific decimal ticks retain their mantissa precision without tightening source stops", () => {
  for (const tick of [2.5e-7, 1.25e-7, 2.5e-8]) {
    const exact = 41 * tick;
    for (const side of ["LONG", "SHORT"] as const) {
      const stop = buildLiveStopIntent({ id: `tiny-${side}`, symbol: "SMALL_USDT", side, currentStop: exact }, tick);
      assert.ok(Math.abs(stop.price - exact) < tick * 1e-8);
      assert.ok(Math.abs(Number((stop.body.trigger as { price: string }).price) / tick - 41) < 1e-8);
    }
    const between = 41.4 * tick;
    assert.ok(Math.abs(liveStopPriceForTick("LONG", between, tick) / tick - 41) < 1e-8);
    assert.ok(Math.abs(liveStopPriceForTick("SHORT", between, tick) / tick - 42) < 1e-8);
  }
});

test("terminal Gate orders are classified without ever replaying a successful entry", () => {
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "filled" }, "LIMIT"), "FILLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "filled" }, "MARKET"), "FILLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "ioc" }, "MARKET"), "CANCELLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "cancelled" }, "LIMIT"), "CANCELLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "succeeded" }, "PRICE_TRIGGER"), "FILLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "failed" }, "PRICE_TRIGGER"), "ERROR");
  assert.equal(liveEntryDisposition({ status: "inactive" }, "PRICE_TRIGGER"), "ERROR");
});

test("private Gate requests are signed and order IDs remain strings", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request);
    return Response.json({ id_string: "9223372036854775807" });
  };
  try {
    const client = new GateLiveClient({ apiKey: "abcdefgh12345678", apiSecret: "secret-value-12345678", environment: "live" });
    const intent = buildLiveEntryIntent({ plan: plan("BREAKOUT", "LONG"), equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
    assert.equal(await client.createEntry(intent), "9223372036854775807");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.get("KEY"), "abcdefgh12345678");
    assert.match(seen[0].headers.get("SIGN") ?? "", /^[0-9a-f]{128}$/);
    assert.equal(seen[0].url.includes("secret-value"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an IOC market entry is inspected through Gate's regular futures-order endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request);
    return Response.json({ id_string: "123", status: "finished", finish_as: "filled" });
  };
  try {
    const client = new GateLiveClient({ apiKey: "abcdefgh12345678", apiSecret: "secret-value-12345678", environment: "live" });
    const order = await client.inspectEntry("MARKET", "BTC_USDT", "t-ms-e-market", "123");
    assert.equal(order?.finish_as, "filled");
    assert.equal(new URL(seen[0].url).pathname, "/api/v4/futures/usdt/orders/123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("int64 order IDs from Gate snapshots survive JSON parsing and cancellation unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request);
    const path = new URL(request.url).pathname;
    if (request.method === "DELETE") return new Response("{}", { headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/accounts")) return new Response('{"user":1,"total":"10","available":"5"}');
    if (path.endsWith("/positions")) return new Response("[]");
    if (path.endsWith("/price_orders")) return new Response("[]");
    return new Response('[{"id":9223372036854775807,"text":"t-ms-e-stale","contract":"BTC_USDT"}]');
  };
  try {
    const client = new GateLiveClient({ apiKey: "abcdefgh12345678", apiSecret: "secret-value-12345678", environment: "live" });
    const snapshot = await client.snapshot();
    assert.equal(liveOrderId(snapshot.orders[0]), "9223372036854775807");
    await client.cancelOrder("LIMIT", liveOrderId(snapshot.orders[0])!);
    assert.equal(new URL(seen.at(-1)!.url).pathname.endsWith("/orders/9223372036854775807"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Gate LIVE hedges a timed-out read and still returns a complete snapshot without duplicating any write",async()=>{
  const real=globalThis.fetch;
  const attempts=new Map<string,number>();
  globalThis.fetch=async(input,init)=>{
    const req=new Request(input,init),path=new URL(req.url).pathname;
    attempts.set(path,(attempts.get(path)??0)+1);
    if(path.endsWith("/accounts")&&(attempts.get(path)??0)===1){
      const error=new Error("The operation was aborted due to timeout");error.name="TimeoutError";throw error;
    }
    if(path.endsWith("/accounts"))return Response.json({user:1,total:"100",available:"100",unrealised_pnl:"0",in_dual_mode:false});
    return Response.json([]);
  };
  try{
    const client=new GateLiveClient({apiKey:"abcdefgh12345678",apiSecret:"secret-value-12345678",environment:"live"});
    const snapshot=await client.snapshot();
    assert.equal(snapshot.account.total,"100");
    assert.equal(snapshot.positions.length,0);
    assert.equal(attempts.get("/api/v4/futures/usdt/accounts"),2);
    assert.equal(client.requestCount,5,"four normal reads plus one safe hedge");
  }finally{globalThis.fetch=real;}
});

test("Gate LIVE never retries a timed-out write because the exchange may already have accepted it",async()=>{
  const real=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;const error=new Error("The operation was aborted due to timeout");error.name="TimeoutError";throw error;};
  try{
    const client=new GateLiveClient({apiKey:"abcdefgh12345678",apiSecret:"secret-value-12345678",environment:"live"});
    await assert.rejects(client.setLeverage("BTC_USDT",10),error=>error instanceof Error
      &&/提交结果可能不明确/.test(error.message)&&!/The operation was aborted due to timeout/.test(error.message));
    assert.equal(requests,1);
    assert.equal(client.requestCount,1);
  }finally{globalThis.fetch=real;}
});

test("a fully timed-out Gate read surfaces a typed Chinese read-timeout instead of the platform English exception",async()=>{
  const real=globalThis.fetch;
  globalThis.fetch=async()=>{const error=new Error("The operation was aborted due to timeout");error.name="TimeoutError";throw error;};
  try{
    const client=new GateLiveClient({apiKey:"abcdefgh12345678",apiSecret:"secret-value-12345678",environment:"live"});
    await assert.rejects(client.snapshot(),error=>error instanceof GateReadTimeoutError
      &&/Gate只读核对超时/.test(error.message)&&!/The operation was aborted due to timeout/.test(error.message));
  }finally{globalThis.fetch=real;}
});

test("private read races the complete body through Gate's independent futures route and cancels the stalled loser",async()=>{
  const real=globalThis.fetch,hosts:string[]=[];let stalledSignal:AbortSignal|undefined;
  globalThis.fetch=async(input,init)=>{
    const host=new URL(String(input)).hostname;hosts.push(host);
    assert.equal(init?.redirect,"manual");
    if(host==="api.gateio.ws"){
      stalledSignal=init?.signal??undefined;
      return new Response(new ReadableStream({start(){/* Headers succeed, body never finishes. */}}));
    }
    return Response.json({id:"90071992547409931",status:"finished",fill_price:"100"});
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    const order=await client.inspectEntry("MARKET","BTC_USDT","t-fixture","90071992547409931");
    assert.equal(order?.id,"90071992547409931");
    assert.deepEqual(hosts,["api.gateio.ws","fx-api.gateio.ws"]);
    assert.equal(stalledSignal?.aborted,true);assert.equal(client.readTransport.recovered,1);
  }finally{globalThis.fetch=real;}
});

test("manual redirect mode rejects 3xx without following the signed location and safely hedges GET only",async()=>{
  const real=globalThis.fetch,urls:string[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=String(input);urls.push(url);assert.equal(init?.redirect,"manual");
    if(new URL(url).hostname==="api.gateio.ws")return new Response(null,{status:302,headers:{Location:"https://attacker.invalid/private"}});
    return Response.json({id:"123",status:"finished"});
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    assert.equal((await client.inspectEntry("MARKET","BTC_USDT","t-fixture","123"))?.id,"123");
    assert.deepEqual(urls.map(url=>new URL(url).hostname),["api.gateio.ws","fx-api.gateio.ws"]);
    assert.equal(urls.some(url=>url.includes("attacker.invalid")),false);
  }finally{globalThis.fetch=real;}
});

test("a redirected mutation remains one unknown-safe submission and is never replayed",async()=>{
  const real=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_input,init)=>{calls++;assert.equal(init?.redirect,"manual");
    return new Response(null,{status:307,headers:{Location:"https://attacker.invalid/write"}});};
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    await assert.rejects(client.setLeverage("BTC_USDT",10),/Gate 307 REDIRECT_REJECTED/);
    assert.equal(calls,1);assert.equal(client.readTransport.hedges,0);
  }finally{globalThis.fetch=real;}
});

test("server failures and malformed read bodies use the alternate immediately, while auth and rate limits stay definitive",async()=>{
  const real=globalThis.fetch;
  try{for(const failure of ["server","json","auth","rate"]){
    const hosts:string[]=[];
    globalThis.fetch=async(input)=>{
      const host=new URL(String(input)).hostname;hosts.push(host);
      if(host==="fx-api.gateio.ws")return Response.json({id:"123",status:"finished"});
      if(failure==="server")return new Response("unavailable",{status:503});
      if(failure==="json")return new Response("{broken");
      return Response.json({label:failure==="auth"?"INVALID_KEY":"TOO_MANY_REQUESTS"},{status:failure==="auth"?401:429});
    };
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    if(failure==="auth"||failure==="rate"){
      await assert.rejects(client.inspectEntry("MARKET","BTC_USDT","t-fixture","123"),/Gate (401|429)/);
      assert.equal(hosts.length,1);
    }else{
      assert.equal((await client.inspectEntry("MARKET","BTC_USDT","t-fixture","123"))?.id,"123");
      assert.deepEqual(hosts,["api.gateio.ws","fx-api.gateio.ws"]);
    }
  }}finally{globalThis.fetch=real;}
});

test("testnet hedges never send private credentials to production",async()=>{
  const real=globalThis.fetch,hosts:string[]=[];
  globalThis.fetch=async(input)=>{
    hosts.push(new URL(String(input)).hostname);
    if(hosts.length===1)throw new TypeError("network outage");
    return Response.json({id:"123"});
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"testnet"});
    await client.inspectEntry("MARKET","BTC_USDT","t-fixture","123");
    assert.deepEqual(hosts,["api-testnet.gateapi.io","api-testnet.gateapi.io"]);
  }finally{globalThis.fetch=real;}
});

test("a mutation body timeout is an unknown single submission, never a replay",async()=>{
  const real=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(controller){
    controller.error(new DOMException("body timed out","TimeoutError"));
  }}));};
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    await assert.rejects(client.setLeverage("BTC_USDT",10),/提交结果可能不明确/);
    assert.equal(calls,1);assert.equal(client.readTransport.hedges,0);
  }finally{globalThis.fetch=real;}
});

test("both private routes hanging remain bounded and public diagnostics omit the private order ID",async()=>{
  const real=globalThis.fetch,signals:AbortSignal[]=[];
  globalThis.fetch=async(_input,init)=>{signals.push(init!.signal!);return new Promise<Response>(()=>{});};
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    await assert.rejects(client.inspectEntry("MARKET","BTC_USDT","t-fixture","90071992547409931"),GateReadTimeoutError);
    assert.equal(signals.length,2);assert.ok(signals.every(s=>s.aborted));
    assert.equal(client.readTransport.timeouts,1);
    assert.equal(client.readTransport.lastTimeoutPath,"/futures/usdt/orders");
  }finally{globalThis.fetch=real;}
});


test("live market entry uses authenticated Gate futures WebSocket and receives the real order id",async()=>{
  const real=globalThis.fetch,socket=new FakeTradeSocket(),fetches:string[]=[];
  globalThis.fetch=async(input,init)=>{
    fetches.push(String(input));
    assert.equal(String(input),"https://fx-ws.gateio.ws/v4/ws/usdt");
    assert.equal(new Headers(init?.headers).get("Upgrade"),"websocket");
    assert.equal(new Headers(init?.headers).get("X-Gate-Size-Decimal"),"1");
    return{status:101,webSocket:socket} as unknown as Response;
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    const id=await client.createEntry({kind:"MARKET",tag:"t-ms-e-test",size:1,contracts:1,notional:100,plannedRisk:2,leverage:10,margin:10,
      body:{contract:"BTC_USDT",size:"1",price:"0",tif:"ioc",text:"t-ms-e-test",reduce_only:false}});
    assert.equal(id,"123456789012345678");assert.equal(fetches.length,1);assert.ok(socket.accepted);
    const [login,order]=socket.sent;
    assert.equal(login?.channel,"futures.login");assert.equal(order?.channel,"futures.order_place");
    const loginPayload=login?.payload as Record<string,unknown>;
    assert.equal(loginPayload.api_key,"fixture-key");assert.match(String(loginPayload.signature),/^[0-9a-f]{128}$/);
    assert.deepEqual((order?.payload as Record<string,unknown>).req_param,
      {contract:"BTC_USDT",size:"1",price:"0",tif:"ioc",text:"t-ms-e-test",reduce_only:false});
    assert.equal(client.writeTransport.orderRequests,1);assert.equal(client.writeTransport.orderAcks,1);
    assert.equal(client.writeTransport.orderResults,1);assert.equal(client.writeTransport.loggedIn,true);
  }finally{globalThis.fetch=real;}
});

test("WebSocket handshake failure is a definite pre-send cancellation, not a fake 60-second unknown order",async()=>{
  const real=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("ws network unavailable");};
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    await assert.rejects(()=>client.createEntry({kind:"MARKET",tag:"t-ms-e-nosend",size:1,contracts:1,notional:100,plannedRisk:2,leverage:10,margin:10,
      body:{contract:"BTC_USDT",size:"1",price:"0",tif:"ioc",text:"t-ms-e-nosend",reduce_only:false}}),
      error=>error instanceof GateEntryCancelledError&&/未发送订单/.test(error.message));
    assert.equal(calls,1);assert.equal(client.writeTransport.orderRequests,0);
  }finally{globalThis.fetch=real;}
});

test("live market close uses the same authenticated WebSocket order channel",async()=>{
  const real=globalThis.fetch,socket=new FakeTradeSocket();socket.orderResult={id_string:"998877665544332211",status:"finished",finish_as:"filled",size:"0",left:"0"};
  globalThis.fetch=async()=>({status:101,webSocket:socket}) as unknown as Response;
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    const id=await client.closePosition("BTC_USDT","t-ms-x-close");
    assert.equal(id,"998877665544332211");
    const order=socket.sent.find(row=>row.channel==="futures.order_place")!;
    assert.deepEqual((order.payload as Record<string,unknown>).req_param,
      {contract:"BTC_USDT",size:0,price:"0",tif:"ioc",close:true,reduce_only:true,text:"t-ms-x-close"});
  }finally{globalThis.fetch=real;}
});

test("unknown submission is only final after Gate custom-text no-fill lookup window plus grace",()=>{
  const submitted=1_000_000;
  assert.equal(gateUnknownSubmissionCanResolve(submitted,submitted+64_999),false);
  assert.equal(gateUnknownSubmissionCanResolve(submitted,submitted+65_000),true);
});


test("routine core snapshot is independent from slow open-order list endpoints",async()=>{
  const real=globalThis.fetch,paths:string[]=[];
  globalThis.fetch=async(input)=>{
    const url=new URL(String(input));paths.push(url.pathname);
    if(url.pathname.endsWith("/accounts"))return Response.json({user:1,total:"100",available:"100",unrealised_pnl:"0",in_dual_mode:false});
    if(url.pathname.endsWith("/positions"))return Response.json([]);
    throw new Error("order list must not be touched by snapshotCore");
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    const core=await client.snapshotCore();
    assert.equal(core.account.total,"100");assert.deepEqual(core.positions,[]);
    assert.deepEqual(paths.sort(),["/api/v4/futures/usdt/accounts","/api/v4/futures/usdt/positions"].sort());
  }finally{globalThis.fetch=real;}
});

test("a recovered futures read path is preferred on the next read for the same endpoint",async()=>{
  const real=globalThis.fetch,hosts:string[]=[];let primaryCalls=0;
  globalThis.fetch=async(input)=>{
    const host=new URL(String(input)).hostname;hosts.push(host);
    if(host==="api.gateio.ws"&&primaryCalls++===0)return new Promise<Response>(()=>{});
    return Response.json({id:"123",status:"finished",fill_price:"100"});
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    await client.inspectEntry("MARKET","BTC_USDT","t-fixture","123");
    const before=hosts.length;
    await client.inspectEntry("MARKET","BTC_USDT","t-fixture","123");
    assert.equal(hosts[0],"api.gateio.ws");assert.equal(hosts[1],"fx-api.gateio.ws");
    assert.equal(hosts[before],"fx-api.gateio.ws","the recovered futures host should become first choice for that read path");
    assert.ok(client.readTransport.preferredAlternatePaths>=1);
  }finally{globalThis.fetch=real;}
});


test("remaining REST account-setting mutations inherit the currently healthy official futures route and submit once",async()=>{
  const real=globalThis.fetch,hosts:string[]=[],methods:string[]=[];let firstPrimary=true;
  globalThis.fetch=async(input,init)=>{
    const req=new Request(input,init),host=new URL(req.url).hostname;hosts.push(host);methods.push(req.method);
    if(req.method==="GET"&&host==="api.gateio.ws"&&firstPrimary){
      firstPrimary=false;return new Promise<Response>(()=>{});
    }
    if(req.method==="GET")return Response.json({id:"123",status:"finished",fill_price:"100"});
    assert.equal(req.method,"POST");return Response.json({});
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    await client.inspectEntry("MARKET","BTC_USDT","t-fixture","123");
    assert.equal(client.readTransport.preferredAlternatePaths,1);
    assert.equal(client.readTransport.preferredMutationHost,"fx-api.gateio.ws");
    const before=hosts.length;
    await client.setLeverage("BTC_USDT",10);
    assert.deepEqual(methods.slice(before),["POST"],"mutation must remain one-shot");
    assert.deepEqual(hosts.slice(before),["fx-api.gateio.ws"],"the already-proven futures alternate should own the one mutation");
  }finally{globalThis.fetch=real;}
});

test("a remaining REST mutation timeout on the selected alternate is never replayed to primary",async()=>{
  const real=globalThis.fetch,posts:string[]=[];let firstPrimary=true;
  globalThis.fetch=async(input,init)=>{
    const req=new Request(input,init),host=new URL(req.url).hostname;
    if(req.method==="GET"&&host==="api.gateio.ws"&&firstPrimary){
      firstPrimary=false;return new Promise<Response>(()=>{});
    }
    if(req.method==="GET")return Response.json({id:"123",status:"finished"});
    posts.push(host);const error=new Error("The operation was aborted due to timeout");error.name="TimeoutError";throw error;
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    await client.inspectEntry("MARKET","BTC_USDT","t-fixture","123");
    await assert.rejects(()=>client.setLeverage("BTC_USDT",10),/提交结果可能不明确/);
    assert.deepEqual(posts,["fx-api.gateio.ws"],"unknown writes must never fail over after crossing the network boundary");
  }finally{globalThis.fetch=real;}
});

test("leverage precheck skips an unnecessary mutation before LIVE entry",async()=>{
  const real=globalThis.fetch;let reads=0,writes=0;
  globalThis.fetch=async(input,init)=>{
    const req=new Request(input,init),url=new URL(req.url);
    if(req.method==="GET"&&url.pathname.endsWith("/positions/SOL_USDT")){
      reads++;return Response.json({contract:"SOL_USDT",size:0,leverage:"10"});
    }
    if(req.method==="POST"&&url.pathname.endsWith("/positions/SOL_USDT/leverage")){
      writes++;throw new Error("leverage write should not be sent");
    }
    throw new Error(`unexpected ${req.method} ${url.pathname}`);
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    const result=await client.ensureLeverage("SOL_USDT",10);
    assert.equal(result.verified,true);assert.equal(result.already,true);assert.equal(result.recovered,false);
    assert.equal(reads,1);assert.equal(writes,0);
  }finally{globalThis.fetch=real;}
});

test("timed-out leverage mutation is verified by safe readback and never replayed",async()=>{
  const real=globalThis.fetch;let reads=0,writes=0;
  globalThis.fetch=async(input,init)=>{
    const req=new Request(input,init),url=new URL(req.url);
    if(req.method==="GET"&&url.pathname.endsWith("/positions/LSK_USDT")){
      reads++;
      return Response.json({contract:"LSK_USDT",size:0,leverage:reads===1?"5":"10"});
    }
    if(req.method==="POST"&&url.pathname.endsWith("/positions/LSK_USDT/leverage")){
      writes++;const error=new Error("The operation was aborted due to timeout");error.name="TimeoutError";throw error;
    }
    throw new Error(`unexpected ${req.method} ${url.pathname}`);
  };
  try{
    const client=new GateLiveClient({apiKey:"fixture-key",apiSecret:"fixture-secret",environment:"live"});
    const result=await client.ensureLeverage("LSK_USDT",10);
    assert.equal(result.verified,true);assert.equal(result.recovered,true);assert.equal(result.actual,10);
    assert.equal(writes,1,"ambiguous leverage writes are never replayed");
    assert.equal(reads,2,"one precheck plus one post-timeout readback proves the resulting Gate state");
  }finally{globalThis.fetch=real;}
});
