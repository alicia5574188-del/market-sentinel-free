import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStrategy2Pool, type Strategy2Input } from "../lib/strategy-2-engine.ts";
import type { Candle } from "../lib/signal-engine.ts";

const observedAt = Date.UTC(2026, 7, 26, 4, 0, 0);
function candles(count=90):Candle[]{const rows:Candle[]=[];for(let i=0;i<count;i++){const close=100+i*.045+Math.sin(i/3)*.07;const open=close-.018;rows.push({time:Math.floor((observedAt-(count-i)*300_000)/1000),open,high:Math.max(open,close)+.11,low:Math.min(open,close)-.11,close,volume:1000+(i%6)*45})}return rows}
function input(patch:Partial<Strategy2Input>={}):Strategy2Input{return {symbol:"SOL_USDT",observedAt,futuresPrice:104,volumeUsd:700_000_000,changePercentage:8, fundingRate:.0001,openInterestChangePct:1.4,spotCvdRatio:.07,orderBookImbalance:.08,liquidationImbalance:.08,multiTimeframeTrend:.72,benchmarkMomentum:1.2,macroEventRisk:.1,dataQuality:.93,candles5m:candles(),crossSectionRank:.94,rotationVelocity:.05,marketAdvancingRatio:.55,marketDecliningRatio:.45,...patch}}

test("Strategy 2.0 evaluates the complete 12-playbook pool on every deep symbol",()=>{const signals=evaluateStrategy2Pool(input());assert.equal(signals.length,12);assert.equal(new Set(signals.map(s=>s.strategyId)).size,12);assert.deepEqual(signals.map(s=>s.strategyMeta.playbookId),["P1_TREND_PULLBACK","P2_TREND_BREAKOUT","P3_RANGE_REVERSAL","P4_COMPRESSION_BREAKOUT","P5_EXPANSION_MOMENTUM","P6_LIQUIDATION_REVERSAL","P7_LIQUIDATION_CONTINUATION","P8_EXHAUSTION_REVERSAL","P9_RELATIVE_STRENGTH","P10_ROTATION_LEADERSHIP","P11_FAILED_BREAKOUT","P12_FLOW_DIVERGENCE"])});

test("hard safety gates still block the whole pool",()=>{const signals=evaluateStrategy2Pool(input({macroEventRisk:.99}));assert.ok(signals.every(s=>s.state==="blocked"));assert.ok(signals.every(s=>s.side==="WAIT"));assert.ok(signals.every(s=>s.blockers.includes("EMERGENCY_EVENT_RISK")))});

test("one market can expose several competing playbook theses at the same time",()=>{const signals=evaluateStrategy2Pool(input());const triggered=signals.filter(s=>s.strategyMeta.triggerActive);assert.ok(triggered.length>=2,`expected multiple triggers, got ${triggered.map(s=>s.strategyId).join(",")}`);assert.ok(triggered.some(s=>s.strategyId==="relative_strength"||s.strategyId==="rotation_leadership"))});

test("trend breakout does not become ready when spot flow points against the proposed direction",()=>{const signals=evaluateStrategy2Pool(input({spotCvdRatio:-.06}));const p2=signals.find(s=>s.strategyId==="trend_breakout");assert.ok(p2);assert.equal(p2!.strategyMeta.triggerActive,true);assert.equal(p2!.state,"watching");const flow=p2!.entryPlan?.checks.find(c=>c.key==="flow");assert.ok(flow);assert.equal(flow!.required,true);assert.equal(flow!.passed,false);assert.ok(p2!.blockers.some(reason=>reason.includes("现货流方向确认不足")))});

test("legacy relative-strength keeps its critical trend and spot-flow direction gates",()=>{const signals=evaluateStrategy2Pool(input({spotCvdRatio:-.02}));const p9=signals.find(s=>s.strategyId==="relative_strength");assert.ok(p9);assert.equal(p9!.strategyMeta.triggerActive,true);assert.equal(p9!.state,"watching");const flow=p9!.entryPlan?.checks.find(c=>c.key==="spot-flow");const trend=p9!.entryPlan?.checks.find(c=>c.key==="trend");assert.ok(flow&&trend);assert.equal(flow!.required,true);assert.equal(flow!.passed,false);assert.equal(trend!.required,true)});
