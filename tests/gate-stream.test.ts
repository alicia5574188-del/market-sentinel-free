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
const message=(at=now,id=10)=>({channel:"futures.order_book",event:"all",result:{contract:"BTC_USDT",t:at,id,
  bids:[{p:"100",s:"2.5"},{p:"99",s:"3"}],asks:[{p:"101",s:"1.25"},{p:"102",s:"4"}]}});
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

test("Gate stream subscribes bounded full depth and closed candle channels without private credentials",()=>fixture(async(feed,sockets)=>{
  assert.ok(sockets[0]!.accepted);
  const requests=sockets[0]!.sent.map(row=>JSON.parse(row));
  assert.deepEqual(requests.map(row=>row.payload),[["BTC_USDT","20","0"],["1m","BTC_USDT"],["5m","BTC_USDT"]]);
  assert.ok(requests.every(row=>!row.auth));
  sockets[0]!.message(message());
  const book=feed.book("BTC_USDT",.1,.01,now)!;
  assert.equal(book.observedAt,now);assert.equal(book.sequence,10);assert.equal(book.bids.length,2);
  assert.equal(book.bids[0]!.size,2.5);assert.equal(book.asks[0]!.size,1.2625);
  assert.equal(feed.status(now).freshBooks,1);
}));

test("partial delta, crossed, stale, future and out-of-order messages cannot replace a valid Gate book",()=>fixture(async(feed,sockets)=>{
  const socket=sockets[0]!;socket.message(message());
  socket.message({...message(now+1,11),event:"update"});
  socket.message(message(now-6000,12));socket.message(message(now+2000,13));socket.message(message(now,9));
  const crossed=message(now,14);crossed.result.bids[0]!.p="102";socket.message(crossed);
  assert.equal(feed.book("BTC_USDT",.1,1,now)?.sequence,10);
  assert.equal(feed.book("BTC_USDT",.1,1,now+5001),null,"unchanged local cache must not refresh exchange time");
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
