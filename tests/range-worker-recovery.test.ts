import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return{shortCircuit:true,url:'data:text/javascript,export class DurableObject {}'};
  if(specifier==='vinext/server/app-router-entry')return{shortCircuit:true,url:'data:text/javascript,export default {}'};
  return next(specifier,context);
}});
const workerSpecifier='../worker/index-clean.ts?range-capacity-recovery';
const {MarketStream}=await import(workerSpecifier);
const T=1_800_000_000_000;
function harness(count:number){
  const stream=Object.create(MarketStream.prototype),symbols=Array.from({length:count},(_,i)=>`X${i}_USDT`),calls:string[]=[];
  stream.runtime={liquidUniverse:symbols,strategyCandleFailures:{}};stream.strategyCandles={};stream.forwardMinuteCandles={};
  stream.strategyPathSymbols=()=>symbols;stream.gateStream={path:()=>[]};
  stream.marketHub={coverage:()=>({sourceCount:2,disagreementRate:0}),quote:()=>null,
    pinnedCandles:async(symbol:string)=>{calls.push(symbol);return null;}};
  return{stream,symbols,calls};
}
test('real Worker 5m refresh attempts all30 seats despite persistent source failures; each batch stays five',async()=>{
  const {stream,symbols,calls}=harness(30);
  for(let n=0;n<6;n++)assert.equal(await stream.refreshAdaptiveCandles(T+n*5000),5);
  assert.equal(calls.length,30);assert.deepEqual(new Set(calls),new Set(symbols));
  assert.equal(Object.keys(stream.strategyCandles).length,0,'failed sources never fabricate completed bars');
});
test('real Worker 1m refresh attempts later urgent seats after failed first four; each batch stays four',async()=>{
  const {stream,symbols,calls}=harness(10);
  stream.forwardState={positions:[],directStrategy:{anomalyRange:{version:'anomaly-range-v1'},rangeResearch:{events:
    Object.fromEntries(symbols.map(symbol=>[symbol,{symbol,phase:'CONFIRMING',score:90}]))}}};
  for(let n=0;n<3;n++)assert.equal(await stream.refreshForwardUrgentMinutes(T+n*5000),4);
  assert.deepEqual(new Set(calls),new Set(symbols));assert.equal(Object.keys(stream.forwardMinuteCandles).length,0);
});
