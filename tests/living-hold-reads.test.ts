/**
 * 2026-10-21: (1) per-minute holding reads in the run log, (2) the "hand profit to the late crowd" living exit,
 * (3) B1 — MIXED market strong-follow probe (0.3×, re-checked at the planned position).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {climaxTake,holdCheck,healthOf,type CoinIntent,type MarketIntent} from "../lib/living/intent.ts";
import {RunLog,HOLD_READ_MAX,HOLD_READ_FIELDS,CASE_PAGE_KEYS,type CaseInput} from "../lib/living/runlog.ts";
import {buildLivingRunLog} from "../lib/living/runlog-export.ts";
import {livingWhy,livingDetail} from "../lib/living-trade-view.ts";

const F={p5:.002,p15:.01,p60:.02,p240:.03,z15:2,z60:2,ext:1,oi5:.002,oi15:.01,oi60:.02,funding:.0001,dFunding60:0,basis:null,taker5:.1,taker15:.1,
  vol5:1,vol15:1.2,vol60:1,imbalance:0,rangePos:.8,rangeHi:110,rangeLo:90,stallMin:0,last:100,atr5:.8};
const coin=(x:Partial<CoinIntent>&{f?:Partial<CoinIntent["f"]>}={}):CoinIntent=>({symbol:"T_USDT",at:0,capital:"DEMAND",emotion:"CONVICTION",crowd:null,actor:"LONG",
  strength:.6,action:null,why:"test",...x,f:{...F,...(x.f??{})}} as CoinIntent);
const mixed={at:0,state:"MIXED",side:null,confidence:.5,sentence:"方向不清",allowed:[]} as unknown as MarketIntent;
const calm={...mixed,state:"CALM"} as MarketIntent;

test("climax take: profit ≥ 1.5× stop distance and the late crowd chases into it", ()=>{
  const greed=coin({emotion:"FOMO",crowd:"LONG"});
  assert.match(climaxTake("LONG",greed,.016,.01)!,/利润交给后来追进的人群/);
  assert.equal(climaxTake("LONG",greed,.014,.01),null,"below 1.5× stop distance: keep holding");
  assert.equal(climaxTake("LONG",coin(),.03,.01),null,"no greed / climax: keep holding");
  assert.ok(climaxTake("LONG",coin({f:{vol5:3.2,taker5:.35,p5:.004}}),.02,.01),"volume ≥3× + taker ≥.3 our way");
  assert.equal(climaxTake("LONG",coin({f:{vol5:3.2,taker5:-.35,p5:.004}}),.02,.01),null,"flow the other way is not our crowd");
  assert.ok(climaxTake("SHORT",coin({capital:"FLUSH_DOWN",emotion:"PANIC",actor:"LONG"}),.02,.01),"longs panicking into a short's profit");
  assert.equal(climaxTake("SHORT",greed,.02,.01),null,"long greed is not our side's crowd for a short");
  assert.equal(climaxTake("LONG",greed,.03,null),null,"unknown stop distance: never fires");
});
test("holdCheck exits with LIVING_INTENT_CLIMAX_TAKE only when the stop distance is known", ()=>{
  const base={pb:"follow" as const,side:"LONG" as const,entry:100,price:102,stop:99,coin:coin({emotion:"FOMO",crowd:"LONG"}),market:calm,ageMin:20,holdMin:90,cost:.0014};
  assert.equal(holdCheck({...base,stopDist:.01}).code,"LIVING_INTENT_CLIMAX_TAKE");
  assert.notEqual(holdCheck(base).code,"LIVING_INTENT_CLIMAX_TAKE");
  assert.equal(holdCheck({...base,price:101,stopDist:.01}).code==="LIVING_INTENT_CLIMAX_TAKE",false,"+1% < 1.5× 1% stop");
});
test("old B1 probe trades (mx:1) still render as a MIXED probe", ()=>{
  const t={side:"LONG" as const,entryPrice:100,stopPrice:99,liquidationPrice:91,plannedRisk:1.6,leverage:10,notional:300,expectedHoldMinutes:60,
    entryContext:{living:{v:"living-v2",k:"N",pb:"follow",ev:"probe",mult:1.5,sc:.66,rk:1,inv:99,hold:60,why:"分歧市场试探（0.3 倍）·顺着真资金：x",in:"DEMAND/CONVICTION",mk:"MIXED",mx:1}}};
  assert.match(livingWhy(t,"顺着真资金（回调跟进）"),/市场分歧，强证据顺势试探（0\.3 倍仓位）/);
  const d=livingDetail(t,"顺着真资金（回调跟进）").join("\n");
  assert.match(d,/分歧市场要求 ≥0\.6/);assert.match(d,/证据档「试探」0\.3/);assert.match(d,/利润交给他们/);
});
const input=(sym:string,at:number):CaseInput=>({at,sym,side:"LONG",pb:"follow",pbLabel:"顺着真资金",kind:"normal",intent:"DEMAND/CONVICTION",strength:.6,
  why:"真买盘",ev:null,market:null,px:100});
test("holding reads: one ≈60-byte row per minute on the linked case, capped, paged under the key limit, exported with a legend", ()=>{
  const T=1_800_000_000_000,rl=new RunLog(T);
  rl.noteCase(input("H_USDT",T),"WATCH","等位置");rl.linkTrade("H_USDT","LONG","follow",{id:"lv-1",openedAt:T,entry:100,stop:99});
  const c=coin();const h=healthOf("LONG",c,mixed);assert.ok(h!=null&&h>0,"real buying with us is healthy");
  assert.equal(rl.holdRead("lv-1",T+30_000,T,{coin:c,h,market:"MIXED",code:""}),true);
  assert.equal(rl.holdRead("lv-1",T+50_000,T,{coin:c,h,market:"MIXED",code:""}),false,"same minute: one row");
  assert.equal(rl.holdRead("nope",T,T,{coin:c,h,market:"MIXED",code:""}),false,"unknown trade: nothing");
  for(let m=1;m<=HOLD_READ_MAX+20;m++)rl.holdRead("lv-1",T+m*60_000,T,{coin:m%2?c:null,h:m%2?h:null,market:"MIXED",code:m===5?"LIVING_INTENT_GONE":""});
  const tr=[...rl.cases.values()][0]!.trade!;const rows=tr.hr!.split(";");
  assert.equal(rows.length,HOLD_READ_MAX);assert.equal(tr.hr_drop,21);
  assert.equal(rows[0]!.split(",").length,HOLD_READ_FIELDS.length);
  const avg=tr.hr!.length/rows.length;assert.ok(avg<=70,`row ≈60 bytes, got ${avg.toFixed(0)}`);
  const pages=rl.values();for(const k of Object.keys(pages)){assert.ok(CASE_PAGE_KEYS.includes(k));assert.ok(JSON.stringify(pages[k]).length<96*1024);}
  const out=buildLivingRunLog({exportedAt:T+3_600_000,liveEnabled:false,buildSha:"x",hours:72,status:null,buckets:[],cases:[...rl.cases.values()].map(x=>({...x,final:false,path:null,out:null})),
    account:{equity:null,initial:null,invariants:null,book_audit:null,equity_curve:null,equity_minutes:[],drawdown:{},curve_since:null,drawdown_since:null,account_resets:null,
      account_epoch:0,account_reset_pending:null,liveFills:null,equity_gaps:null,equity_filled_min:0},positions:[],fills:[],paths:[],archive:{}}) as Record<string,unknown>;
  assert.ok((out.hold_read_legend as {fields:string[]}).fields.includes("h"));
  const exported=(out.cases as {trade:{hr?:string}|null}[])[0]!.trade!;assert.equal(exported.hr,tr.hr);
});
