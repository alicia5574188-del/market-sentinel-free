import assert from "node:assert/strict";
import test from "node:test";
import { GateStreamingFeed } from "../lib/gate-stream.ts";

const now=1_800_000_000_000;
class FakeSocket {
  readyState=1;sent:string[]=[];accepted=false;
  listeners=new Map<string,(event:{data?:unknown})=>void>();
  accept(){this.accepted=true;}
  send(data:string){this.sent.push(data);}
  close(){this.readyState=3;}
  addEventListener(type:string,listener:(event:{data?:unknown})=>void){this.listeners.set(type,listener);}
  message(data:unknown){this.listeners.get("message")?.({data:JSON.stringify(data)});}
}
const message=(at=now,id=10)=>({channel:"futures.book_ticker",event:"update",result:{s:"BTC_USDT",t:at,u:id,
  b:"100",B:"2.5",a:"101",A:"1.25"}});
async function fixture(run:(feed:GateStreamingFeed,sockets:FakeSocket[],clock:(at:number)=>void)=>Promise<void>){
  const prior=globalThis.fetch,oldNow=Date.now,sockets:FakeSocket[]=[];let at=now;
  Date.now=()=>at;
  globalThis.fetch=async(input,init)=>{
    assert.equal(String(input),"https://fx-ws.gateio.ws/v4/ws/usdt");
    assert.equal(new Headers(init?.headers).get("X-Gate-Size-Decimal"),"1");
    const socket=new FakeSocket();sockets.push(socket);
    return{status:101,webSocket:socket} as unknown as Response;
  };
  try{const feed=new GateStreamingFeed();await feed.ensure(["BTC_USDT"],["BTC_USDT"],["BTC_USDT"],now);await run(feed,sockets,value=>at=value);}
  finally{globalThis.fetch=prior;Date.now=oldNow;}
}

test("Gate stream subscribes realtime best bid/ask and closed candle channels without private credentials",()=>fixture(async(feed,sockets)=>{
  assert.ok(sockets[0]!.accepted);
  const requests=sockets[0]!.sent.map(row=>JSON.parse(row));
  assert.deepEqual(requests.map(row=>row.payload),[["BTC_USDT"],["1m","BTC_USDT"],["5m","BTC_USDT"]]);
  assert.equal(requests[0]!.channel,"futures.book_ticker");
  assert.ok(requests.every(row=>!row.auth));
  sockets[0]!.message(message());
  const book=feed.book("BTC_USDT",.1,.01,now)!;
  assert.equal(book.observedAt,now);assert.equal(book.sequence,10);assert.equal(book.bids.length,1);
  assert.equal(book.bids[0]!.size,2.5);assert.equal(book.asks[0]!.size,1.2625);
  assert.equal(feed.status(now).freshBooks,1);
}));

test("crossed, stale, future and out-of-order BBO updates cannot replace a valid Gate book",()=>fixture(async(feed,sockets)=>{
  const socket=sockets[0]!;socket.message(message());
  socket.message(message(now-6000,12));socket.message(message(now+2000,13));socket.message(message(now,9));
  const crossed=message(now,14);crossed.result.b="102";socket.message(crossed);
  assert.equal(feed.book("BTC_USDT",.1,1,now)?.sequence,10);
  const unchanged=feed.book("BTC_USDT",.1,1,now+5001);
  assert.equal(unchanged?.sequence,10,"unchanged BBO stays executable while the subscribed Gate stream is live");
  assert.equal(unchanged?.observedAt,now,"transport liveness must not rewrite the exchange timestamp itself");
  assert.equal(feed.status(now+5001).freshBooks,1);
  assert.equal(feed.book("BTC_USDT",.1,1,now+15001),null,"cached BBO expires when stream liveness evidence ages out");
}));

test("other subscribed market traffic keeps an unchanged BBO executable on the same live socket",()=>fixture(async(feed,sockets,clock)=>{
  const socket=sockets[0]!;socket.message(message());
  await feed.ensure(["BTC_USDT","ETH_USDT"],[],[],now);
  clock(now+6000);
  socket.message({channel:"futures.book_ticker",event:"update",result:{s:"ETH_USDT",t:now+6000,u:20,b:"200",B:"3",a:"201",A:"4"}});
  const btc=feed.book("BTC_USDT",.1,1,now+6000);
  assert.equal(btc?.sequence,10);
  assert.equal(btc?.observedAt,now+6000,"effective freshness follows the live Gate transport, not a forced BTC price change");
  assert.equal(feed.status(now+6000).freshBooks,2);
}));

test("only explicitly closed and already complete Gate candles enter confirmation paths",()=>fixture(async(feed,sockets)=>{
  const send=(row:object)=>sockets[0]!.message({channel:"futures.candlesticks",event:"update",result:[row]});
  const row={n:"1m_BTC_USDT",t:now/1000-60,o:"100",h:"103",l:"99",c:"102",v:"5.5"};
  send(row);send({...row,w:false});assert.equal(feed.path("BTC_USDT","1m").length,0);
  send({...row,w:true,t:now/1000});assert.equal(feed.path("BTC_USDT","1m").length,0);
  send({...row,w:true});assert.equal(feed.path("BTC_USDT","1m").length,1);
  assert.equal(feed.path("BTC_USDT","1m")[0]!.volume,5.5);
  send({...row,n:"1m_OTHER_USDT",w:true});assert.equal(feed.path("OTHER_USDT","1m").length,0);
}));

test("disconnect clears executable books and reconnect ignores late events from old socket",()=>fixture(async(feed,sockets,clock)=>{
  const old=sockets[0]!;old.message(message());old.listeners.get("close")?.({});
  assert.equal(feed.book("BTC_USDT",.1,1,now),null);
  await feed.ensure(["BTC_USDT"],["BTC_USDT"],[],now+1000);assert.equal(sockets.length,1);
  clock(now+2000);await feed.ensure(["BTC_USDT"],["BTC_USDT"],[],now+2000);assert.equal(sockets.length,2);
  old.message(message(now+2000,200));assert.equal(feed.book("BTC_USDT",.1,1,now+2000),null);
  sockets[1]!.message(message(now+2000,201));assert.equal(feed.book("BTC_USDT",.1,1,now+2000)?.sequence,201);
}));

test("Gate BBO stream accepts the full 30-market execution set while 1m confirmation remains separately bounded",async()=>{
  const prior=globalThis.fetch,oldNow=Date.now,sockets:FakeSocket[]=[];Date.now=()=>now;
  globalThis.fetch=async(_input,init)=>{assert.equal(new Headers(init?.headers).get("X-Gate-Size-Decimal"),"1");const socket=new FakeSocket();sockets.push(socket);
    return{status:101,webSocket:socket} as unknown as Response;};
  try{
    const feed=new GateStreamingFeed(),books=Array.from({length:35},(_,i)=>`S${i}_USDT`),minutes=Array.from({length:20},(_,i)=>`M${i}_USDT`);
    await feed.ensure(books,minutes,[],now);
    const requests=sockets[0]!.sent.map(row=>JSON.parse(row)),bookSubs=requests.filter(row=>row.channel==="futures.book_ticker"&&row.event==="subscribe"),
      minuteSubs=requests.filter(row=>row.channel==="futures.candlesticks"&&row.payload?.[0]==="1m"&&row.event==="subscribe");
    assert.equal(bookSubs.length,30);assert.equal(minuteSubs.length,11);
  }finally{globalThis.fetch=prior;Date.now=oldNow;}
});

test("subscription churn removes departed books and uses one connection",()=>fixture(async(feed,sockets)=>{
  sockets[0]!.message(message());
  await feed.ensure(["ETH_USDT"],["ETH_USDT"],["ETH_USDT"],now);
  assert.equal(sockets.length,1);assert.equal(feed.book("BTC_USDT",.1,1,now),null);
  assert.equal(sockets[0]!.sent.map(row=>JSON.parse(row)).filter(row=>row.event==="unsubscribe").length,3);
  sockets[0]!.message(message(now,11));assert.equal(feed.book("BTC_USDT",.1,1,now),null);
}));

test("quiet broken transport reconnects on alarm without inventing fresh prices",()=>fixture(async(feed,sockets,clock)=>{
  clock(now+31000);await feed.ensure(["BTC_USDT"],[],[],now+31000);
  assert.equal(sockets[0]!.readyState,3);assert.equal(feed.status(now+31000).connected,false);
  clock(now+33000);await feed.ensure(["BTC_USDT"],[],[],now+33000);assert.equal(sockets.length,2);
}));

test("handshake failure is contained and retries are bounded without blocking the caller",async()=>{
  const prior=globalThis.fetch,oldNow=Date.now;let calls=0;Date.now=()=>now;
  globalThis.fetch=async()=>{calls++;throw new Error("timeout");};
  try{const feed=new GateStreamingFeed();await feed.ensure(["BTC_USDT"],[],[],now);await feed.ensure(["BTC_USDT"],[],[],now+1000);
    assert.equal(calls,1);assert.equal(feed.status(now).connected,false);assert.equal(feed.book("BTC_USDT",.1,1,now),null);
  }finally{globalThis.fetch=prior;Date.now=oldNow;}
});
