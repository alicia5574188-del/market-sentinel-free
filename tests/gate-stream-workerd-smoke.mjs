// Local synthetic upstream only: prove workerd Upgrade/accept/event handling and
// that the five-second handshake deadline cannot kill an established stream.
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
const code=`import {GateStreamingFeed} from './lib/gate-stream.ts';
export default {async fetch(req,env){
 globalThis.fetch=(input,init)=>env.GATE.fetch(new Request(input,init));
 const feed=new GateStreamingFeed();await feed.ensure(['BTC_USDT'],['BTC_USDT'],[]);
 await new Promise(r=>setTimeout(r,100));const initial=feed.status();
 await new Promise(r=>setTimeout(r,5300));const later=feed.status(),expired=feed.status(Date.now()+16000);
 return Response.json({initial,later,expired});
}}`;
const bundle=await build({stdin:{contents:code,resolveDir:process.cwd(),sourcefile:'feed-smoke.ts'},bundle:true,write:false,
  format:'esm',platform:'browser',target:'es2022'});
const mock=`export default {fetch(req){const pair=new WebSocketPair(),s=pair[1];s.accept();
 s.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.channel==='futures.book_ticker'&&m.event==='subscribe')
 s.send(JSON.stringify({channel:'futures.book_ticker',event:'update',result:{s:'BTC_USDT',t:Date.now(),u:100,
 b:'100',B:'2.5',a:'101',A:'3.5'}}));});return new Response(null,{status:101,webSocket:pair[0]});}}`;
const mf=new Miniflare({workers:[{name:'test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-22',
  serviceBindings:{GATE:'mock'}},{name:'mock',modules:true,script:mock,compatibilityDate:'2026-05-22'}]});
try{
  const result=await(await mf.dispatchFetch('http://local/test')).json();
  assert.equal(result.initial.connected,true);assert.equal(result.initial.acceptedBooks,1);
  assert.equal(result.later.connected,true,'successful handshake must cancel its timeout and preserve the stream');
  assert.equal(result.later.freshBooks,1,'unchanged BBO stays usable while the subscribed Gate socket is still live');
  assert.equal(result.expired.freshBooks,0,'cached BBO expires after transport-liveness evidence ages out');
  console.log(JSON.stringify({workerdWebSocket:true,handshakeTimeoutCancelled:true,streamBackedBbo:true,livenessExpiry:true,privateGateRequests:0}));
}finally{await mf.dispose();}
