import { dataIsFresh, type BookSnapshot } from "./liquidity-core.ts";

type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
type RawBook={symbol:string;observedAt:number;sequence:number;bids:Array<{price:number;size:number}>;asks:Array<{price:number;size:number}>};
type Socket={readyState:number;accept():void;send(data:string):void;close(code?:number,reason?:string):void;
  addEventListener(type:string,listener:(event:{data?:unknown})=>void):void};
const ENDPOINT="https://fx-ws.gateio.ws/v4/ws/usdt";
const STREAM_CACHE_LIVENESS_MS=15_000;
const finite=(x:number)=>Number.isFinite(x);

/** One bounded, public Gate connection per primary runtime. No trading loops,
 * storage writes or credentials. The existing alarm owns reconnects and trading. */
export class GateStreamingFeed {
  private socket:Socket|null=null;
  private connecting:Promise<void>|null=null;
  private wanted=new Map<string,{channel:string;payload:string[]}>();
  private subscribed=new Set<string>();
  private books=new Map<string,RawBook>();
  private candles=new Map<string,Candle[]>();
  private retryAt=0;
  private failures=0;
  private lastPingAt=0;
  private lastMessageAt=0;
  private lastError:string|null=null;
  private connects=0;
  private acceptedBooks=0;
  private acceptedCandles=0;
  private rejected=0;
  private websocketUses=0;
  private restUses=0;

  ensure(books:string[],minutes:string[],structures:string[],now=Date.now()):Promise<void>{
    const wanted=new Map<string,{channel:string;payload:string[]}>();
    // Exposure is ordered first by the caller; no market-wide subscriptions.
    // Adaptive Ten only needs executable best bid/ask. Gate documents
    // futures.book_ticker as the realtime BBO channel; the legacy full order
    // book is intentionally not used for execution.
    for(const symbol of [...new Set(books)].slice(0,30))wanted.set(`book:${symbol}`,{channel:"futures.book_ticker",payload:[symbol]});
    for(const [interval,symbols] of [["1m",minutes.slice(0,11)],["5m",structures.slice(0,30)]] as const)
      for(const symbol of new Set(symbols))wanted.set(`${interval}:${symbol}`,{channel:"futures.candlesticks",payload:[interval,symbol]});
    this.wanted=wanted;
    for(const symbol of this.books.keys())if(!wanted.has(`book:${symbol}`))this.books.delete(symbol);
    for(const key of this.candles.keys())if(!wanted.has(key))this.candles.delete(key);
    if(this.socket&&(this.socket.readyState!==1||now-this.lastMessageAt>30_000))this.disconnect("Gate stream heartbeat expired",now);
    if(this.socket){
      try{
        this.syncSubscriptions(now);
        if(now-this.lastPingAt>=10_000){this.socket.send(JSON.stringify({time:Math.floor(now/1000),channel:"futures.ping"}));this.lastPingAt=now;}
      }catch{this.disconnect("Gate stream send failed",now);}
    }
    if(this.socket||this.connecting||now<this.retryAt||!wanted.size)return this.connecting??Promise.resolve();
    const task=this.connect(now);this.connecting=task;
    void task.finally(()=>{if(this.connecting===task)this.connecting=null;});
    return task;
  }

  private async connect(now:number){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5_000);
    try{
      const response=await fetch(ENDPOINT,{headers:{Upgrade:"websocket","X-Gate-Size-Decimal":"1"},signal:controller.signal});
      // In workerd an aborted upgrade request also closes its accepted socket.
      // The deadline belongs to the handshake, never the healthy connection.
      clearTimeout(timer);
      const socket=(response as unknown as {webSocket?:Socket}).webSocket;
      if(response.status!==101||!socket){await response.body?.cancel().catch(()=>undefined);throw new Error(`Gate stream handshake ${response.status}`);}
      this.socket=socket;this.subscribed.clear();this.books.clear();this.lastMessageAt=Date.now();this.lastPingAt=0;this.connects++;
      socket.addEventListener("message",event=>{if(this.socket===socket)this.ingest(event.data,Date.now());});
      socket.addEventListener("close",()=>{if(this.socket===socket)this.disconnect("Gate stream disconnected",Date.now());});
      socket.addEventListener("error",()=>{if(this.socket===socket)this.disconnect("Gate stream transport error",Date.now());});
      socket.accept();this.syncSubscriptions(Date.now());
    }catch(error){this.disconnect(error instanceof Error?error.message:"Gate stream connect failed",Math.max(now,Date.now()));}
    finally{clearTimeout(timer);}
  }

  private disconnect(reason:string,now:number){
    const socket=this.socket;this.socket=null;this.subscribed.clear();this.books.clear();
    this.lastError=reason;this.failures=Math.min(this.failures+1,5);this.retryAt=now+Math.min(30_000,2_000*2**(this.failures-1));
    try{socket?.close(1000,"reconnect");}catch{/* already closed */}
  }

  private syncSubscriptions(now:number){
    if(!this.socket)return;
    for(const key of this.subscribed){
      if(this.wanted.has(key))continue;
      const split=key.indexOf(":"),kind=key.slice(0,split),symbol=key.slice(split+1);
      this.socket.send(JSON.stringify({time:Math.floor(now/1000),channel:kind==="book"?"futures.book_ticker":"futures.candlesticks",
        event:"unsubscribe",payload:kind==="book"?[symbol]:[kind,symbol]}));
      this.subscribed.delete(key);
    }
    for(const [key,request] of this.wanted)if(!this.subscribed.has(key)){
      this.socket.send(JSON.stringify({time:Math.floor(now/1000),...request,event:"subscribe"}));this.subscribed.add(key);
    }
  }

  ingest(data:unknown,now:number){
    if(typeof data!=="string"||data.length>128_000){this.rejected++;return;}
    let message:Record<string,unknown>;
    try{message=JSON.parse(data);}catch{this.rejected++;return;}
    if(!message||typeof message!=="object")return;
    this.lastMessageAt=now;
    if(message.error){this.rejected++;this.disconnect("Gate stream subscription error",now);return;}
    if(message.channel==="futures.book_ticker"&&message.event==="update"){
      const row=message.result as Record<string,unknown>|null;
      const symbol=typeof row?.s==="string"?row.s:"";
      if(!row||!symbol||!this.wanted.has(`book:${symbol}`))return;
      const observedAt=Number(row.t),sequence=Number(row.u),bid=Number(row.b),ask=Number(row.a),bidSize=Number(row.B),askSize=Number(row.A);
      const previous=this.books.get(symbol);
      if(!dataIsFresh(observedAt,now)||!Number.isSafeInteger(sequence)||sequence<=0
        ||![bid,ask,bidSize,askSize].every(finite)||bid<=0||ask<=0||bid>=ask||bidSize<=0||askSize<=0
        ||(previous&&(observedAt<previous.observedAt||sequence<previous.sequence))){this.rejected++;return;}
      this.books.set(symbol,{symbol,observedAt,sequence,bids:[{price:bid,size:bidSize}],asks:[{price:ask,size:askSize}]});
      this.acceptedBooks++;this.failures=0;this.lastError=null;
    }else if(message.channel==="futures.order_book"&&message.event==="all"){
      const row=message.result as Record<string,unknown>|null;
      if(!row||typeof row.contract!=="string"||!this.wanted.has(`book:${row.contract}`))return;
      const observedAt=Number(row.t),sequence=Number(row.id);
      const levels=(input:unknown)=>Array.isArray(input)?input.map(item=>({price:Number(item?.p),size:Number(item?.s)}))
        .filter(item=>finite(item.price)&&finite(item.size)&&item.price>0&&item.size>0):[];
      const bids=levels(row.bids).sort((a,b)=>b.price-a.price).slice(0,20),asks=levels(row.asks).sort((a,b)=>a.price-b.price).slice(0,20);
      const previous=this.books.get(row.contract);
      if(!dataIsFresh(observedAt,now)||!Number.isSafeInteger(sequence)||sequence<=0||!bids.length||!asks.length||bids[0]!.price>=asks[0]!.price
        ||(previous&&(observedAt<previous.observedAt||sequence<previous.sequence))){this.rejected++;return;}
      this.books.set(row.contract,{symbol:row.contract,observedAt,sequence,bids,asks});this.acceptedBooks++;
      this.failures=0;this.lastError=null;
    }else if(message.channel==="futures.candlesticks"&&message.event==="update"&&Array.isArray(message.result)){
      for(const row of message.result){
        if(typeof row?.n!=="string")continue;
        const split=row.n.indexOf("_"),interval=row.n.slice(0,split),symbol=row.n.slice(split+1),key=`${interval}:${symbol}`;
        if(!this.wanted.has(key)||!["1m","5m"].includes(interval))continue;
        const candle={time:Number(row.t),open:Number(row.o),high:Number(row.h),low:Number(row.l),close:Number(row.c),volume:Number(row.v)};
        const duration=interval==="1m"?60:300;
        // A wall-clock rollover cannot turn a partially received candle into a
        // complete one. Only Gate's explicit closed-window message is accepted.
        if(row.w!==true)continue;
        if(!Object.values(candle).every(finite)||candle.time%duration!==0||candle.low<=0||candle.volume<0
          ||candle.high<Math.max(candle.open,candle.close)||candle.low>Math.min(candle.open,candle.close)
          ||(candle.time+duration)*1000>now){this.rejected++;continue;}
        const rows=[...new Map([...(this.candles.get(key)??[]),candle].map(item=>[item.time,item])).values()]
          .sort((a,b)=>a.time-b.time).slice(interval==="1m"?-90:-12);
        this.candles.set(key,rows);this.acceptedCandles++;
      }
    }
  }

  private streamBackedBookFresh(symbol:string,book:RawBook,now:number){
    const direct=dataIsFresh(book.observedAt,now);
    if(direct)return{fresh:true,observedAt:book.observedAt};
    const connected=this.socket?.readyState===1,subscribed=this.subscribed.has(`book:${symbol}`);
    const transportFresh=connected&&subscribed&&this.lastMessageAt>0&&now>=this.lastMessageAt&&now-this.lastMessageAt<=STREAM_CACHE_LIVENESS_MS;
    return{fresh:transportFresh,observedAt:transportFresh?this.lastMessageAt:book.observedAt};
  }
  book(symbol:string,tickSize:number,multiplier:number,now=Date.now()):BookSnapshot|null{
    const book=this.books.get(symbol);if(!book||!(multiplier>0))return null;
    const freshness=this.streamBackedBookFresh(symbol,book,now);if(!freshness.fresh)return null;
    return{...book,observedAt:freshness.observedAt,tickSize,bids:book.bids.map(row=>({...row,size:row.size*row.price*multiplier})),
      asks:book.asks.map(row=>({...row,size:row.size*row.price*multiplier}))};
  }
  path(symbol:string,interval:"1m"|"5m"){return this.candles.get(`${interval}:${symbol}`)??[];}
  used(source:"websocket"|"rest"){if(source==="websocket")this.websocketUses++;else this.restUses++;}
  status(now=Date.now()){
    return{version:"gate-dual-transport-v1",connected:this.socket?.readyState===1,lastMessageAt:this.lastMessageAt||null,
      lastError:this.lastError,retryAt:this.retryAt>now?this.retryAt:null,connections:this.connects,
      subscriptions:this.wanted.size,acceptedBooks:this.acceptedBooks,acceptedCandles:this.acceptedCandles,rejected:this.rejected,
      websocketUses:this.websocketUses,restUses:this.restUses,
      freshBooks:[...this.books.entries()].filter(([symbol,row])=>this.streamBackedBookFresh(symbol,row,now).fresh).length};
  }
}
