import test from "node:test";
import assert from "node:assert/strict";
import { nextProtectionWriteBudget, readProtectionWriteBudget, protectionWriteBudgetView,
  PROTECTION_WRITE_BUDGET_VERSION, PROTECTION_WRITE_CAP, PROTECTION_WRITE_INTERVAL_MS,
  PRIMARY_PLANNED_DO_ROWS, TWO_MEMBER_PLANNED_DO_ROWS, type ProtectionWriteBudget } from "../lib/forward-write-budget.ts";

const T=Date.parse("2026-09-20T12:00:00.000Z");
function budget(writes=1,lastCommittedAt=T):ProtectionWriteBudget {
  return {version:PROTECTION_WRITE_BUDGET_VERSION,day:new Date(lastCommittedAt).toISOString().slice(0,10),writes,lastCommittedAt};
}

test("protection lane reserves exactly one ten-second write for each interval in a UTC day",()=>{
  assert.equal(PROTECTION_WRITE_INTERVAL_MS,10000);assert.equal(PROTECTION_WRITE_CAP,8640);
  assert.equal(PROTECTION_WRITE_CAP*PROTECTION_WRITE_INTERVAL_MS,86400000);
  let value:ProtectionWriteBudget|null=null;
  const start=Date.parse("2026-09-20T00:00:00.001Z");
  for(let i=0;i<PROTECTION_WRITE_CAP;i++)value=nextProtectionWriteBudget(value,start+i*PROTECTION_WRITE_INTERVAL_MS);
  assert.equal(value?.writes,8640);assert.equal(value?.day,"2026-09-20");
});

test("the 8640th committed write is admitted and the 8641st same-day write is refused without changing the counter",()=>{
  const prior=budget(PROTECTION_WRITE_CAP-1),last=nextProtectionWriteBudget(prior,T+10000),saved=structuredClone(last);
  assert.equal(last.writes,8640);assert.equal(prior.writes,8639);
  assert.throws(()=>nextProtectionWriteBudget(last,T+20000),/专用额度已满/);
  assert.deepEqual(last,saved);
});

test("dedicated capacity cannot bypass the persistent ten-second interval after a restart",()=>{
  const persisted=readProtectionWriteBudget(JSON.parse(JSON.stringify(budget(20))))!;
  for(const elapsed of [0,1,9999])assert.throws(()=>nextProtectionWriteBudget(persisted,T+elapsed),/十秒间隔/);
  const next=nextProtectionWriteBudget(persisted,T+10000);
  assert.equal(next.writes,21);assert.equal(next.lastCommittedAt,T+10000);
});

test("a new UTC day resets only the daily count and retains cross-midnight interval protection",()=>{
  const last=Date.parse("2026-09-20T23:59:55.000Z"),prior=budget(PROTECTION_WRITE_CAP,last);
  assert.throws(()=>nextProtectionWriteBudget(prior,Date.parse("2026-09-21T00:00:00.000Z")),/十秒间隔/);
  const next=nextProtectionWriteBudget(prior,Date.parse("2026-09-21T00:00:05.000Z"));
  assert.equal(next.day,"2026-09-21");assert.equal(next.writes,1);assert.equal(prior.writes,8640);
});

test("later UTC days also begin at one rather than inheriting an obsolete exhausted count",()=>{
  const next=nextProtectionWriteBudget(budget(PROTECTION_WRITE_CAP),Date.parse("2026-09-23T12:00:00.000Z"));
  assert.equal(next.day,"2026-09-23");assert.equal(next.writes,1);
});

test("clock rollback within a day or into an earlier resource day cannot clear the protection ledger",()=>{
  const prior=budget(100),saved=structuredClone(prior);
  for(const now of [T-1,T-10000,Date.parse("2026-09-19T23:59:59.999Z")])
    assert.throws(()=>nextProtectionWriteBudget(prior,now),/十秒间隔|回拨资源日/);
  assert.deepEqual(prior,saved);
});

test("invalid new commit timestamps fail instead of minting a fresh budget",()=>{
  for(const now of [0,-1,Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY])
    assert.throws(()=>nextProtectionWriteBudget(null,now),/提交时间异常/);
});

test("missing legacy lane is accepted without treating malformed existing counters as missing",()=>{
  for(const value of [null,undefined]){
    assert.equal(readProtectionWriteBudget(value),null);
    assert.deepEqual(nextProtectionWriteBudget(value,T),budget());
  }
  for(const value of [{},false,"",0])assert.throws(()=>readProtectionWriteBudget(value),/资源账异常/);
});

test("invalid, fractional, exhausted-beyond-cap or nonfinite persisted counters fail closed",()=>{
  for(const writes of [-1,0,.5,8641,Number.MAX_SAFE_INTEGER+1,Number.NaN,Number.POSITIVE_INFINITY,"1",null]){
    const corrupt={...budget(),writes};
    assert.throws(()=>readProtectionWriteBudget(corrupt),/资源账异常/);
    assert.throws(()=>nextProtectionWriteBudget(corrupt,T+86400000),/资源账异常/,"new date cannot reset corrupt persisted state");
  }
});

test("invalid policy, day, timestamp and day/timestamp mismatch cannot be relabeled as a valid resource record",()=>{
  const corrupt=[
    {...budget(),version:"unknown-version"},
    {...budget(),day:"2026-9-20"},
    {...budget(),day:"2026-02-31"},
    {...budget(),day:"2026-09-19"},
    {...budget(),lastCommittedAt:0},
    {...budget(),lastCommittedAt:-1},
    {...budget(),lastCommittedAt:Number.NaN},
    {...budget(),lastCommittedAt:Number.POSITIVE_INFINITY},
  ];
  for(const value of corrupt)assert.throws(()=>readProtectionWriteBudget(value),/资源账异常/);
});

test("valid records round-trip by value without exposing or mutating caller-owned objects",()=>{
  const source=budget(123),read=readProtectionWriteBudget(source)!;
  assert.deepEqual(read,source);assert.notEqual(read,source);
  read.writes=124;assert.equal(source.writes,123);
});

test("health view shows zero for an older day while retaining the last durable commit timestamp",()=>{
  const prior=budget(8640),now=Date.parse("2026-09-21T00:00:00.000Z");
  const view=protectionWriteBudgetView(prior,now);
  assert.deepEqual(view,{policy:PROTECTION_WRITE_BUDGET_VERSION,day:"2026-09-21",writes:0,cap:8640,
    lastCommittedAt:T,independentOfFinancialWrites:true});
  assert.equal(prior.writes,8640,"projection is not a counter reset");
  assert.equal(protectionWriteBudgetView(prior,T+10000).writes,8640);
});

test("health view of a legacy missing lane is explicit and requires no synthetic prior write",()=>{
  for(const value of [null,undefined]){
    const view=protectionWriteBudgetView(value,T);
    assert.equal(view.writes,0);assert.equal(view.lastCommittedAt,null);
    assert.equal(view.cap,8640);assert.equal(view.independentOfFinancialWrites,true);
  }
});

test("published row model keeps primary plus two members bounded without double-counting shared protection",()=>{
  assert.ok(Number.isSafeInteger(PRIMARY_PLANNED_DO_ROWS)&&PRIMARY_PLANNED_DO_ROWS>PROTECTION_WRITE_CAP);
  assert.ok(Number.isSafeInteger(TWO_MEMBER_PLANNED_DO_ROWS)&&TWO_MEMBER_PLANNED_DO_ROWS<100000);
  assert.equal(TWO_MEMBER_PLANNED_DO_ROWS-PRIMARY_PLANNED_DO_ROWS,2*18080);
});
