/**
 * Regression (2026-10-21 01:40 user screenshots: ONDO/ZRO/ARB each closed twice — LIVING_FAST_EXHAUST and then the old
 * "推不动了"/"碰到保护位" exit on the same trade). A living EXIT must close a trade exactly once: it leaves the positions
 * list in the same tick, no later exit can book it again, and the ledger (balance/resolved) counts it once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {runForward} from "./living/forward-sim.ts";
import {bj} from "./living/fixture.ts";
import type {LivingDirective,LivingTradeAction} from "../lib/living/directive.ts";
import {allItems} from "../lib/living/config.ts";
import type {ForwardState} from "../lib/forward-relations.ts";

function ledgerGap(s:ForwardState){
  const seen=new Set<string>();let net=0;
  for(const t of s.history){if(t.unopened||seen.has(t.id))continue;seen.add(t.id);net+=t.netPnl;}
  const openFees=s.positions.reduce((a,t)=>a+t.entryFee,0);
  return s.balance-(s.initialEquity+net-openFees);
}

test("living EXIT closes once: position removed same tick, one history row, balance/resolved counted once",()=>{
  const exited=new Set<string>();let exits=0;
  const r=runForward({from:bj("10-19 05:20"),to:bj("10-19 07:28"),stepMs:6000,
    extra:(state,inp)=>{
      const actions:LivingTradeAction[]=[];
      for(const t of state.positions)if(!t.inverseCopy&&t.status==="OPEN"&&!exited.has(t.id)&&inp.now-t.openedAt>=120_000){
        exited.add(t.id);actions.push({tradeId:t.id,action:"EXIT",code:"LIVING_FAST_EXHAUST",reason:"test exit"});
      }
      const living:LivingDirective={version:"living-v1",items:allItems(true),actions,orders:[],legacyGate:"open"};
      return {living};
    },
    onTick:(state)=>{
      for(const t of state.positions)assert.equal(t.status,"OPEN",`closed trade ${t.id} still in positions`);
      const ids=state.history.map(t=>t.id);
      assert.equal(new Set(ids).size,ids.length,"same trade closed twice in history");
      exits=state.history.filter(t=>t.exitReason==="LIVING_FAST_EXHAUST").length;
    }});
  assert.ok(exits>0,"fixture must produce at least one living exit");
  assert.equal(r.state.resolved,r.state.history.filter(t=>!t.unopened).length);
  assert.ok(Math.abs(ledgerGap(r.state))<1e-6,`balance off by ${ledgerGap(r.state)}`);
});

test("page view shows a double-closed trade once (its first close) and no closed rows as open",async()=>{
  const {pageForwardView}=await import("../lib/page-runtime-view.ts");
  const first={id:"t1",symbol:"ONDO_USDT",status:"CLOSED",closedAt:1000,exitReason:"LIVING_FAST_EXHAUST",netPnl:-1.33};
  const second={...first,closedAt:3000,exitReason:"WINNER_THESIS_EXIT",netPnl:-1.24};
  const other={id:"t2",symbol:"ZRO_USDT",status:"CLOSED",closedAt:2000,netPnl:1};
  const v=pageForwardView({positions:[{...first},{id:"t3",status:"OPEN"}],history:[second,other,first]}) as {positions:{id:string}[];history:{id:string;exitReason?:string}[]};
  assert.deepEqual(v.positions.map(t=>t.id),["t3"]);
  assert.deepEqual(v.history.map(t=>`${t.id}:${t.exitReason??""}`),["t2:","t1:LIVING_FAST_EXHAUST"]);
});

test("repairDoubleCloses undoes exactly the second close and is idempotent",async()=>{
  const {repairDoubleCloses}=await import("../lib/double-close-repair.ts");
  const r=runForward({from:bj("10-19 05:20"),to:bj("10-19 06:40"),stepMs:6000,
    extra:(state,inp)=>({living:{version:"living-v1",items:allItems(true),orders:[],legacyGate:"open",
      actions:state.positions.filter(t=>inp.now-t.openedAt>=120_000).map(t=>({tradeId:t.id,action:"EXIT" as const,code:"LIVING_FAST_EXHAUST",reason:"x"}))} satisfies LivingDirective})});
  const s=structuredClone(r.state);
  const t=s.history.find(x=>!x.unopened)!;assert.ok(t,"need a closed trade");
  const clean={balance:s.balance,resolved:s.resolved,wins:s.wins,fees:s.fees,grossPnl:s.grossPnl,turnover:s.turnover,hist:s.history.length};
  // Book a second close of the same trade the way the bug did: later, worse price, full quantity credited again.
  const dup=structuredClone(t),gross=-0.9,exitFee=0.1,funding=0.01;
  Object.assign(dup,{closedAt:(t.closedAt??0)+38*60_000,exitReason:"WINNER_THESIS_EXIT",grossPnl:gross,exitFee,fundingAllowance:funding,
    netPnl:gross-t.entryFee-exitFee-funding});
  s.history.unshift(dup);s.balance+=gross-exitFee-funding;s.grossPnl+=gross;s.fees+=exitFee;s.fundingAllowance+=funding;s.resolved++;s.turnover+=t.notional;
  assert.ok(Math.abs(ledgerGap(s))>1e-6,"duplicate must break the ledger identity");
  const out=repairDoubleCloses(s,Date.now());
  assert.equal(out.rows.length,1);assert.equal(out.rows[0]!.kept.reason,t.exitReason);assert.equal(out.rows[0]!.dropped.reason,"WINNER_THESIS_EXIT");
  assert.ok(Math.abs(s.balance-clean.balance)<1e-9);assert.equal(s.resolved,clean.resolved);assert.equal(s.wins,clean.wins);
  assert.ok(Math.abs(s.fees-clean.fees)<1e-9);assert.ok(Math.abs(s.grossPnl-clean.grossPnl)<1e-9);assert.ok(Math.abs(s.turnover-clean.turnover)<1e-6);
  assert.equal(s.history.length,clean.hist);assert.ok(s.history.includes(s.history.find(x=>x.id===t.id)!));
  assert.ok(Math.abs(ledgerGap(s))<1e-6);
  const again=repairDoubleCloses(s,Date.now());assert.equal(again.rows.length,0);assert.equal(again.balanceAfter,again.balanceBefore);
});

test("repair ignores rows from before the account start and reset closes; a reloaded (JSON) repaired state is a no-op",async()=>{
  const {findDoubleCloses,repairDoubleCloses}=await import("../lib/double-close-repair.ts");
  const row=(id:string,openedAt:number,closedAt:number,exitReason:string)=>({id,symbol:"X_USDT",openedAt,closedAt,exitReason,status:"CLOSED",
    grossPnl:-1,exitFee:.1,fundingAllowance:0,netPnl:-1.2,entryFee:.1,notional:100,plannedRisk:1}) as unknown as import("../lib/forward-relations.ts").Trade;
  assert.equal(findDoubleCloses([row("old",50,70,"A"),row("old",50,60,"B")],100).length,0,"previous account epoch untouched");
  assert.equal(findDoubleCloses([row("r",150,170,"ACCOUNT_RESET"),row("r",150,160,"B")],100).length,0,"reset close untouched");
  assert.equal(findDoubleCloses([row("d",150,170,"WINNER_THESIS_EXIT"),row("d",150,160,"LIVING_FAST_EXHAUST")],100).length,1);
  const s={startedAt:100,balance:1000,grossPnl:0,fees:0,fundingAllowance:0,resolved:2,wins:0,turnover:200,revision:0,events:[],positions:[],
    environmentPerformance:{cells:{}},history:[row("d",150,170,"WINNER_THESIS_EXIT"),row("d",150,160,"LIVING_FAST_EXHAUST")]} as unknown as ForwardState;
  const out=repairDoubleCloses(s,1000);
  assert.equal(out.rows.length,1);assert.ok(Math.abs(s.balance-1001.1)<1e-9);assert.equal(s.resolved,1);
  assert.equal(s.history.length,1);assert.equal(s.history[0]!.exitReason,"LIVING_FAST_EXHAUST");
  assert.equal(s.events[0]!.subject,"ledger-repair-double-close-v1");
  const reloaded=JSON.parse(JSON.stringify(s)) as ForwardState;
  assert.equal(repairDoubleCloses(reloaded,2000).rows.length,0);assert.equal(reloaded.balance,s.balance);assert.equal(reloaded.events.length,1);
});

test("worker runs the repair right after loading the forward state and reports it in health",async()=>{
  const {readFileSync}=await import("node:fs");
  const src=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.match(src,/this\.forwardState = await readForwardStore\(ctx\.storage, Date\.now\(\)\);\s*await this\.repairLedgerOnce\(ctx\.storage\);/);
  assert.match(src,/repairDoubleCloses\(s, now\)/);assert.match(src,/ledgerRepair:this\.ledgerRepair\?/);
});
