import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { numberText, signedText, holdingTime, livePositionMark, operatorRequest, OperatorRequestError, contractText,
  type LivePosition, type OperatorRuntime } from "../lib/operator-ui.ts";

const position={id:"t",symbol:"BTC_USDT",side:"LONG",status:"OPEN",entryPrice:100,notional:1000} as LivePosition;
const runtime:OperatorRuntime={generatedAt:100_000,lastSuccessAt:100_000,liveMode:{requestedEnabled:false,operational:false},
  evidence:{BTC_USDT:{bestBid:101,bestAsk:102,observedAt:100_000,fresh:true}}};
test("unknown and invalid real balances never become zero",()=>{
  for(const value of [undefined,null,NaN,Infinity])assert.equal(numberText(value),"—");
  assert.equal(signedText(null),"—");assert.equal(numberText(0),"0.00");
});
test("LIVE PnL uses Gate's actual signed value, never public bid/ask or PAPER profit",()=>{
  const p={...position,exchangeUnrealisedPnl:-1.25,exchangeMarkPrice:100.1,exchangePnlMargin:5,exchangePnlAt:100000};
  assert.equal(livePositionMark(p,runtime,101000).pnl,-1.25);
  assert.equal(livePositionMark({...p,side:"SHORT"},null,101000).pnl,-1.25);
  assert.equal(livePositionMark(p,null,101000).rate,-.25);
});
test("stale exchange PnL is timestamped, missing/future exchange values stay unknown",()=>{
  const p={...position,exchangeUnrealisedPnl:0,exchangePnlAt:100000};
  assert.equal(livePositionMark(p,runtime,150000).pnl,0);assert.equal(livePositionMark(p,runtime,150000).fresh,false);
  assert.equal(livePositionMark(position,runtime,101000).pnl,null);
  assert.equal(livePositionMark(p,runtime,90000).pnl,null);
  assert.equal(livePositionMark(p,runtime,101000).rate,null);
});
test("decimal real holdings are never displayed as zero contracts",()=>{
  assert.equal(contractText(.1),"0.1");assert.equal(contractText(.00001),"0.00001");assert.equal(contractText(2),"2");
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
test("dashboard uses granular runtime labels instead of a generic recovery bucket",()=>{
  const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
  const dashboard=readFileSync(new URL("../app/forward-dashboard.tsx",import.meta.url),"utf8");
  assert.match(page,/runtimeStatusLabel\(runtime\)/);
  assert.match(dashboard,/statusLabel/);
  assert.doesNotMatch(dashboard,/healthy\?"正常":"恢复中"/);
});
test("AnchorFlow history cards never fall through to the 15m legacy label",()=>{
  const dashboard=readFileSync(new URL("../app/forward-dashboard.tsx",import.meta.url),"utf8");
  assert.match(dashboard,/const isAnchor=ctx\?\.version==="anchor-flow-entry-v1"/);
  assert.match(dashboard,/isAnchor\?" · AnchorFlow"/);
  assert.match(dashboard,/AnchorFlow新版 · 5m区域负责位置与回测启动，15m负责持仓管理/);
});

test("network failure is not interpreted as confirmed OFF or a successful API save",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("network unavailable");};
  try{await assert.rejects(()=>operatorRequest("/api/live/mode","POST",{enabled:false}),/network unavailable/);assert.equal(calls,1);}
  finally{globalThis.fetch=original;}
});
test("protected PAPER/authentication sources remain unchanged by the LIVE adapter release",()=>{
  const frozen=JSON.parse(readFileSync(new URL("./ui-authority-baseline.json",import.meta.url),"utf8")) as Record<string,string>;
  for(const[path,sha]of Object.entries(frozen))assert.equal(createHash("sha256").update(readFileSync(new URL(`../${path}`,import.meta.url))).digest("hex"),sha,path);
});

test("Safari pattern DOMException is normalized and a mutation is never replayed",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new DOMException("The string did not match the expected pattern.","SyntaxError");};
  try{
    await assert.rejects(()=>operatorRequest("/api/paper/reset","POST",{confirm:"RESET_PAPER"}),
      e=>e instanceof OperatorRequestError&&e.status===0&&/未收到服务器确认/.test(e.message));
    assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});

test("browser TimeoutError is normalized to a Chinese no-replay warning",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{const error=new Error("The operation was aborted due to timeout");error.name="TimeoutError";throw error;};
  try{
    await assert.rejects(()=>operatorRequest("/api/live/history"),e=>e instanceof OperatorRequestError&&e.status===0
      &&/未收到服务器确认/.test(e.message)&&!/The operation was aborted due to timeout/.test(e.message));
  }finally{globalThis.fetch=original;}
});

test("LIVE console suppresses transient read-only timeout banners but keeps real execution errors visible",()=>{
  const live=readFileSync(new URL("../app/live-console.tsx",import.meta.url),"utf8");
  assert.match(live,/!isTransientLiveReadError\(live\.lastError\)/);
  assert.match(live,/OperatorRequestError&&e\.status===0/);
  assert.match(live,/执行提示：\{live\.lastError\}/);
});
