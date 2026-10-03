import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {initialForward} from '../lib/forward-relations.ts';
import {runtimeStatusLabel} from '../lib/runtime-health.ts';
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
  stream.runtime={liquidUniverse:symbols,strategyCandleFailures:{}};stream.strategyCandles={};stream.forwardMinuteCandles={};stream.contractCatalog=new Map();
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
test('owner and shared member view expose the same actual successful protection commit as health',()=>{
  const {stream}=harness(0);stream.forwardState=initialForward(T);stream.forwardState.lastCycleAt=T;
  stream.forwardState.storage.persistedAt=T-60*60_000;stream.forwardError=null;
  stream.forwardProtectionBudget={lastCommittedAt:T-10_000};stream.regimeQuotes=()=>({});stream.liveMirrorView=()=>null;
  const view=stream.forwardView(T),health=stream.forwardHealth();
  assert.equal(view.storage.persistedAt,T-60*60_000);assert.equal(view.storage.protectionPersistedAt,T-10_000);
  assert.equal(health.storage.protectionPersistedAt,view.storage.protectionPersistedAt);
  assert.equal(runtimeStatusLabel({state:'LIVE',stale:false,authorityReady:true,lastSuccessAt:T,forward:view}),'后台运行中');
});
