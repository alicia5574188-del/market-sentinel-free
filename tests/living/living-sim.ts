/** Test-only: the living engine wired to advanceForward over the fixture, the way the worker wires it (onHub → plan → advanceForward → afterForward). */
import {advanceForward,initialForward,type ForwardState} from "../../lib/forward-relations.ts";
import {LivingEngine,type ForwardView} from "../../lib/living/engine.ts";
import {defaultLivingConfig,type LivingMode} from "../../lib/living/config.ts";
import type {TapePoint} from "../../lib/living/tape.ts";
import {livingFixture,segmentAt,priceAt,fixtureContracts} from "./fixture.ts";
import {GOLDEN_SYMBOLS,simInputs} from "./forward-sim.ts";

export function fixturePoints(at:number):TapePoint[]{
  const fx=livingFixture(),seg=segmentAt(at);
  return fx.volumeRank.flatMap((s,i)=>{const rows=seg.bars[s];if(!rows)return[];const p=priceAt(rows,at,true);
    return p?[{symbol:s,mid:p,at:at-200,spread:.0002,disagreement:.0005,sources:3,volume24hUsd:2e9/(1+i*.15),change24h:0,imbalance:0}]:[];});
}
export function runLiving(opts:{from:number;to:number;stepMs:number;mode:LivingMode;warmMs?:number;engine?:LivingEngine;
  onTick?:(state:ForwardState,engine:LivingEngine,now:number)=>void}){
  livingFixture();
  const contracts=fixtureContracts();
  const engine=opts.engine??new LivingEngine(opts.from,{...defaultLivingConfig(opts.from),mode:opts.mode});
  if(!engine.loaded)engine.restore(new Map([["living:v1:config",{...defaultLivingConfig(opts.from),mode:opts.mode}]]),opts.from);
  const warmFrom=opts.from-(opts.warmMs??6*3_600_000);
  for(let at=warmFrom;at<opts.from;at+=at<opts.from-15*60_000?10_000:2_000)engine.onHub(fixturePoints(at),at,()=>true);
  let state=initialForward(opts.from-600_000);const cache={};
  const funding:Record<string,number>={};
  let opened=0;
  for(let now=opts.from;now<opts.to;now+=opts.stepMs){
    // hub refreshes every 2s between forward ticks
    for(let at=now-opts.stepMs+2_000;at<=now;at+=2_000)engine.onHub(fixturePoints(at),at,()=>true);
    const inp=simInputs(state,now,GOLDEN_SYMBOLS,cache);
    const directive=engine.plan({now,forward:state as unknown as ForwardView,quotes:inp.quotes,contracts:Object.fromEntries(Object.entries(contracts).map(([k,c])=>[k,c])),
      funding,candles:inp.paths});
    const res=advanceForward({state,now,paths:inp.paths,minutePaths:inp.minutePaths,quotes:inp.quotes,analysisQuotes:inp.quotes,
      contracts:inp.contracts,entrySymbols:GOLDEN_SYMBOLS,allowDataCycle:inp.allowDataCycle,btc1hPct:inp.btc1hPct,
      referenceMids:{BTC_USDT:inp.mids.BTC_USDT??null,ETH_USDT:inp.mids.ETH_USDT??null},living:directive});
    state=res.state;
    if(res.living)opened+=res.living.opened.length;
    engine.afterForward(res.living,state as unknown as ForwardView,now);
    opts.onTick?.(state,engine,now);
  }
  return {state,engine,opened};
}
