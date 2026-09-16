import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { numberText, signedText, holdingTime, livePositionMark, operatorRequest, OperatorRequestError,
  type LivePosition, type OperatorRuntime } from "../lib/operator-ui.ts";

const position={id:"t",symbol:"BTC_USDT",side:"LONG",status:"OPEN",entryPrice:100,notional:1000} as LivePosition;
const runtime:OperatorRuntime={generatedAt:100_000,lastSuccessAt:100_000,liveMode:{requestedEnabled:false,operational:false},
  evidence:{BTC_USDT:{bestBid:101,bestAsk:102,observedAt:100_000,fresh:true}}};
test("unknown and invalid real balances never become zero",()=>{
  for(const value of [undefined,null,NaN,Infinity])assert.equal(numberText(value),"—");
  assert.equal(signedText(null),"—");assert.equal(numberText(0),"0.00");
});
test("LIVE PnL uses the executable bid for a long, ask for a short",()=>{
  assert.ok(Math.abs(livePositionMark(position,runtime,101_000).pnl!-10)<1e-9);
  assert.ok(Math.abs(livePositionMark({...position,side:"SHORT"},runtime,101_000).pnl!+20)<1e-9);
});
test("stale, missing and future quotes do not produce invented zero LIVE PnL",()=>{
  assert.equal(livePositionMark(position,runtime,116_000).pnl,null);
  assert.equal(livePositionMark(position,runtime,90_000).pnl,null);
  assert.equal(livePositionMark(position,null,101_000).pnl,null);
});
test("holding duration never becomes negative or a fake historical timestamp",()=>{
  assert.equal(holdingTime(undefined,1000),"—");assert.equal(holdingTime(2000,1000),"0分钟");
  assert.equal(holdingTime(1,3_720_001),"1小时2分");
});
test("owner mutation uses one same-origin request, no retries or optimistic result",async()=>{
  const original=globalThis.fetch;let calls=0;let options:RequestInit|undefined;
  globalThis.fetch=async(_input,init)=>{calls++;options=init;return Response.json({live:{requestedEnabled:false}});};
  try{const value=await operatorRequest<{live:{requestedEnabled:boolean}}>("/api/live/mode","POST",{enabled:false});
    assert.equal(calls,1);assert.equal(options?.credentials,"same-origin");assert.equal(options?.body,'{"enabled":false}');assert.equal(value.live.requestedEnabled,false);
  }finally{globalThis.fetch=original;}
});
test("unauthorized mutations fail and are never automatically replayed",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:"请先登录"},{status:401});};
  try{await assert.rejects(()=>operatorRequest("/api/live/mode","POST",{enabled:true}),e=>e instanceof OperatorRequestError&&e.status===401);assert.equal(calls,1);}
  finally{globalThis.fetch=original;}
});
test("network failure is not interpreted as confirmed OFF or a successful API save",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("network unavailable");};
  try{await assert.rejects(()=>operatorRequest("/api/live/mode","POST",{enabled:false}),/network unavailable/);assert.equal(calls,1);}
  finally{globalThis.fetch=original;}
});
test("Worker, LIVE execution, authentication and deployment remain byte-identical to the UI release",()=>{
  const frozen=JSON.parse(readFileSync(new URL("./ui-authority-baseline.json",import.meta.url),"utf8")) as Record<string,string>;
  for(const[path,sha]of Object.entries(frozen))assert.equal(createHash("sha256").update(readFileSync(new URL(`../${path}`,import.meta.url))).digest("hex"),sha,path);
});