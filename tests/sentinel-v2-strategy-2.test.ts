import assert from "node:assert/strict";
import test from "node:test";
import { buildSentinelV2MarketContext } from "../lib/sentinel-v2-core.ts";
import { evaluateSentinelV2Strategies } from "../lib/sentinel-v2-strategy.ts";
import type { Strategy2Input } from "../lib/strategy-2-engine.ts";
import type { UniverseTicker } from "../lib/gate-client.ts";
import type { Candle } from "../lib/signal-engine.ts";

const observedAt=Date.UTC(2026,7,26,5,0,0);
function universe(changes:number[]):UniverseTicker[]{return changes.map((changePercentage,i)=>({symbol:`C${i+10}_USDT`,price:100+i,changePercentage,volumeUsd:100_000_000,fundingRate:.0001,basisPct:0,coarseScore:Math.max(-1,Math.min(1,changePercentage/7)),confidence:60,state:"observing",stateLabel:"持续观察",side:"WAIT"}))}
function candles(count=90):Candle[]{const rows:Candle[]=[];for(let i=0;i<count;i++){const close=100+i*.05+Math.sin(i/4)*.06;const open=close-.02;rows.push({time:Math.floor((observedAt-(count-i)*300_000)/1000),open,high:Math.max(open,close)+.1,low:Math.min(open,close)-.1,close,volume:1000+(i%5)*50})}return rows}
function input(patch:Partial<Strategy2Input>={}):Strategy2Input{return {symbol:"SOL_USDT",observedAt,futuresPrice:104.4,volumeUsd:800_000_000,changePercentage:8.4,fundingRate:.0001,openInterestChangePct:1.5,spotCvdRatio:.08,orderBookImbalance:.1,liquidationImbalance:.05,multiTimeframeTrend:.75,benchmarkMomentum:1.1,macroEventRisk:.1,dataQuality:.95,candles5m:candles(),crossSectionRank:.96,rotationVelocity:.06,marketAdvancingRatio:.5,marketDecliningRatio:.5,...patch}}

test("Strategy 2.0 returns all 12 opportunities and never expands the 1% base risk ceiling",()=>{const market=buildSentinelV2MarketContext({observedAt,universe:universe([3,2.7,2.5,2.2,2,1.8,1.5,1.2,1,.8,.5,.3]),benchmarkMomentum:2.8,optionsIvPercentile:.45,macroEventRisk:.1});const result=evaluateSentinelV2Strategies(input(),{market,openTrades:[],experienceBook:{}});assert.equal(result.opportunities.length,12);assert.equal(result.signals.length,12);assert.ok(result.opportunities.every(o=>o.riskMultiplier>=0&&o.riskMultiplier<=1));});

test("Global regime is a risk background, not a veto on a strong asset-specific playbook",()=>{const market=buildSentinelV2MarketContext({observedAt,universe:universe([.4,.2,.1,0,-.1,-.2,.3,-.3,.2,-.2,.1,-.1]),benchmarkMomentum:.1,optionsIvPercentile:.35,macroEventRisk:.1});const result=evaluateSentinelV2Strategies(input(),{market,openTrades:[],experienceBook:{}});const relative=result.opportunities.find(o=>o.strategyId==="relative_strength");assert.ok(relative);assert.ok(relative!.environmentFit>=55);assert.ok(!relative!.rejectReasons.includes("REGIME_CONFLICT"));});

test("new valid cells trade in exploration mode with deliberately small risk",()=>{const market=buildSentinelV2MarketContext({observedAt,universe:universe([3.2,2.9,2.7,2.5,2.2,2,1.8,1.5,1.2,1,.8,.6]),benchmarkMomentum:2.5,optionsIvPercentile:.4,macroEventRisk:.1});const result=evaluateSentinelV2Strategies(input({changePercentage:6.5}),{market,openTrades:[],experienceBook:{}});const trades=result.opportunities.filter(o=>o.state==="TRADE");assert.ok(trades.length>=1,"expected at least one exploration trade in a strong valid setup");assert.ok(trades.some(o=>o.tradeMode==="exploration"));assert.ok(trades.filter(o=>o.tradeMode==="exploration").every(o=>o.riskMultiplier<=.27));});
