/** v3 environment read: coin env classification, market env, env → playbook mapping, env-native setups, hold target, logging. */
import test from "node:test";
import assert from "node:assert/strict";
import {coinEnv,marketEnv,envDecide,envSetup,sweepReclaim,impulse,envPlan,basketAutocorr,envTag,envHead,ENV_PLAYBOOKS,type CoinEnv,type MarketEnv} from "../lib/living/regime.ts";
import {holdCheck,planIntent,type CoinIntent} from "../lib/living/intent.ts";
import {PLAYBOOK_LABEL} from "../lib/living/thesis.ts";
import {LAYER_LABEL,holdReadRow,HOLD_READ_FIELDS} from "../lib/living/runlog.ts";
import {livingDetail,livingWhy} from "../lib/living-trade-view.ts";
import {readFileSync} from "node:fs";

type B={time:number;open:number;high:number;low:number;close:number};
/** bars from a close path; each bar's range = w × close around open/close */
function bars(closes:number[],w=.002,t0=0):B[]{
  return closes.map((c,i)=>{const o=i?closes[i-1]!:c;const hi=Math.max(o,c)*(1+w/2),lo=Math.min(o,c)*(1-w/2);return{time:t0+i*300,open:o,high:hi,low:lo,close:c};});
}
const flat=(n:number,p=100,amp=.004)=>Array.from({length:n},(_,i)=>p*(1+amp*Math.sin(i*1.3)));

test("coin env: trend up / trend down", ()=>{
  const up=coinEnv(bars([...flat(240),...Array.from({length:48},(_,i)=>100*(1+.0015*i+.001*Math.sin(i)))]));
  assert.equal(up.state,"TREND_UP");assert.equal(up.side,"LONG");assert.ok(up.clarity>0&&up.clarity<=1);assert.match(up.sentence,/上升趋势/);
  const dn=coinEnv(bars([...flat(240),...Array.from({length:48},(_,i)=>100*(1-.0015*i+.001*Math.sin(i)))]));
  assert.equal(dn.state,"TREND_DOWN");assert.equal(dn.side,"SHORT");
});
test("coin env: chop (back and forth, low efficiency)", ()=>{
  const zz=Array.from({length:288},(_,i)=>100*(1+.01*Math.sin(i*Math.PI/6)));// 1h swings
  const e=coinEnv(bars(zz,.002));
  assert.equal(e.state,"CHOP",e.sentence);assert.ok(e.ev.er!<=.25);assert.ok(e.ev.flips!>=.45);assert.match(e.sentence,/假突破/);
});
test("coin env: quiet (range far below its own level), spike / flush, warming", ()=>{
  const loud=bars(flat(240,100,.01),.012),quiet=bars(flat(48,100,.0008),.002,240*300);
  assert.equal(coinEnv([...loud,...quiet]).state,"QUIET");
  const sp=coinEnv(bars([...flat(276),...Array.from({length:12},(_,i)=>100*(1+.004*(i+1)))]));assert.equal(sp.state,"SPIKE");assert.ok(sp.ev.p60!>=.04);
  const fl=coinEnv(bars([...flat(276),...Array.from({length:12},(_,i)=>100*(1-.004*(i+1)))]));assert.equal(fl.state,"FLUSH");
  assert.equal(coinEnv(bars(flat(10))).state,"WARMING");
});
const E=(state:CoinEnv["state"],clarity=.8,p60=.001):CoinEnv=>({state,side:state==="TREND_UP"||state==="SPIKE"?"LONG":state==="TREND_DOWN"||state==="FLUSH"?"SHORT":null,clarity,sentence:"币环境：x",
  ev:{er:null,hh:null,ll:null,flips:null,wick:null,range4h:null,atr:.003,vol:1,p60,pos:.5,net:null}});
test("market env: majority, warming, chop via autocorrelation", ()=>{
  assert.equal(marketEnv(Array.from({length:20},()=>E("TREND_UP")),E("TREND_UP"),.1,.02,0).state,"TREND_UP");
  assert.equal(marketEnv(Array.from({length:20},()=>E("TREND_DOWN",.8,-.01)),E("TREND_DOWN"),null,-.02,0).side,"SHORT");
  assert.equal(marketEnv(Array.from({length:20},()=>E("CHOP")),null,-.3,0,0).state,"CHOP");
  assert.equal(marketEnv(Array.from({length:5},()=>E("CHOP")),null,null,null,0).state,"WARMING");
  const mixed=marketEnv([...Array.from({length:5},()=>E("TREND_UP")),...Array.from({length:5},()=>E("TREND_DOWN")),...Array.from({length:10},()=>E("UNCLEAR"))],null,null,null,0);
  assert.equal(mixed.state,"MIXED");
  // alternating basket 15m returns → negative autocorrelation
  const alt=Array.from({length:300},(_,i)=>100*(1+.005*(Math.floor(i/3)%2)));
  const ac=basketAutocorr([bars(alt),bars(alt),bars(alt)]);assert.ok(ac!=null&&ac<-.5,String(ac));
});
const M=(state:MarketEnv["state"],side:"LONG"|"SHORT"|null,clarity=.8):MarketEnv=>({at:0,state,side,clarity,sentence:"市场环境：x",ev:{n:20,shares:{},breadth:null,btc:null,ac15:null,dir24:null}});
test("env → playbook: coin env picks the family, market env decides the side and the size", ()=>{
  assert.equal(envDecide(E("CHOP"),M("CHOP",null),"follow","LONG").layer,"ENV_MISMATCH","no breakout-follow in chop");
  assert.equal(envDecide(E("CHOP"),M("CHOP",null),"crowd-break","LONG").ok,false);
  const sr=envDecide(E("CHOP"),M("CHOP",null),"sweep-reclaim","SHORT");assert.ok(sr.ok);assert.equal(sr.layer,"ENV_PICK");
  assert.equal(envDecide(E("TREND_DOWN"),M("CHOP",null),"follow","SHORT").ok,false,"trend shorts only with a down market");
  assert.ok(envDecide(E("TREND_DOWN"),M("TREND_DOWN","SHORT"),"follow","SHORT").ok);
  assert.equal(envDecide(E("TREND_UP"),M("TREND_DOWN","SHORT",.8),"follow","LONG").layer,"L1_MARKET","market clearly against");
  assert.ok(envDecide(E("TREND_UP"),M("TREND_DOWN","SHORT",.3),"follow","LONG").ok,"weak market not a block");
  assert.ok(envDecide(E("FLUSH"),M("FLUSH","SHORT",.9),"flush-rebound","LONG").ok,"buying the exhausted flush is the point");
  assert.equal(envDecide(E("TREND_UP"),M("TREND_UP","LONG"),"squeeze-fade","SHORT").ok,false);
  assert.equal(envDecide(E("UNCLEAR"),M("CHOP",null),"absorb-revert","LONG").ok,false);
  assert.equal(envDecide(null,null,"follow","LONG").ok,false);
  for(const [c,m] of [[E("CHOP",0),M("MIXED",null,.2)],[E("TREND_UP",1),M("TREND_UP","LONG",1)],[E("QUIET",.5),M("WARMING",null,0)]] as const){
    const d=envDecide(c,m,ENV_PLAYBOOKS[c.state][0]!.pb,ENV_PLAYBOOKS[c.state][0]!.side??"LONG");assert.ok(d.ok);assert.ok(d.mult>=.5&&d.mult<=1,String(d.mult));}
  assert.equal(envDecide(E("TREND_UP",1),M("TREND_UP","LONG",1),"follow","LONG").mult,1);
  assert.equal(envDecide(E("CHOP",0),M("MIXED",null,.2),"sweep-reclaim","LONG").mult,.5);
});
test("env setups: chop sweep-and-reclaim targets the range middle; quiet first impulse + retest", ()=>{
  const base=Array.from({length:42},(_,i)=>100*(1+.004*Math.sin(i*Math.PI/3)));
  const sw=bars([...base,100.1,99.4,98.9,99.3,99.6,99.8],.003);
  const r=sweepReclaim(sw,.3)!;assert.equal(r.side,"LONG");assert.ok(r.ext<r.lo&&sw.at(-1)!.close>r.lo);
  const p=envPlan("sweep-reclaim","LONG",sw,.3)!;assert.ok(Math.abs(p.target!-r.mid)<1e-9);assert.ok(p.inv<r.ext);assert.ok(p.lo>=r.lo-1e-9&&p.hi<=r.mid+1e-9);
  const chop:CoinEnv={...E("CHOP",.6),ev:{...E("CHOP").ev,atr:.003}};
  const st=envSetup(chop,sw,null)!;assert.equal(st.pb,"sweep-reclaim");assert.equal(st.side,"LONG");assert.ok(st.strength>=.45);
  const q=[...Array.from({length:44},()=>100),100,100.8,100.7,100.65];const qb=bars(q,.001);qb[45]={time:45*300,open:100,high:100.85,low:99.98,close:100.8};
  const im=impulse(qb,.1,null,true)!;assert.equal(im.side,"LONG");assert.ok(Math.abs(im.start-99.98)<1e-9);
  const ip=envPlan("impulse-retest","LONG",qb,.1)!;assert.ok(ip.inv<im.start&&ip.lo>im.start&&ip.hi<im.ext);
  const ci={symbol:"T",f:{atr5:.1,last:100.65,rangePos:.9,rangeHi:100.85,rangeLo:99.9}} as unknown as CoinIntent;
  assert.deepEqual(planIntent("impulse-retest","LONG",ci,qb,[]),ip,"planIntent delegates");
  assert.equal(envSetup({...E("QUIET",.6),ev:{...E("QUIET").ev,atr:.001}},qb,null)!.pb,"impulse-retest");
  assert.equal(envSetup({...E("TREND_UP",.6),ev:{...E("TREND_UP").ev,atr:.01}},bars(flat(48)),"SUPPLY"),null,"no pullback buy against real selling");
});
test("hold: sweep-reclaim takes profit at the planned range middle", ()=>{
  const coin={capital:"DRIFT",emotion:"CALM",crowd:null,actor:null,strength:.3,why:"",f:{rangePos:.3,taker5:0,p5:0}} as unknown as CoinIntent;
  const base={pb:"sweep-reclaim" as const,side:"LONG" as const,entry:99,stop:98.5,coin,market:null,ageMin:20,holdMin:0,cost:.001,target:100};
  assert.equal(holdCheck({...base,price:99.5}).act,"HOLD");
  const v=holdCheck({...base,price:100.02});assert.equal(v.act,"EXIT");assert.equal(v.code,"LIVING_INTENT_DONE");assert.match(v.why,/区间中部/);
  assert.equal(holdCheck({...base,pb:"impulse-retest",price:99.5}).act,"HOLD");
});
test("logging and labels: env layers, hold-read env field, labels in sync, trade card shows env", ()=>{
  assert.ok(LAYER_LABEL.ENV_MISMATCH&&LAYER_LABEL.ENV_PICK);
  assert.equal(HOLD_READ_FIELDS.at(-1),"env");
  assert.ok(holdReadRow(3,{coin:null,h:null,market:"CALM",code:"",env:"CHOP|M:TREND_UP"}).endsWith(",CHOP|M:TREND_UP"));
  const card=readFileSync(new URL("../app/order-card.tsx",import.meta.url),"utf8");
  for(const k of ["sweep-reclaim","impulse-retest"] as const)assert.ok(card.includes(`"${k}":"${PLAYBOOK_LABEL[k]}"`),k);
  assert.equal(envTag(E("CHOP"),M("TREND_UP","LONG")),"CHOP|M:TREND_UP");
  assert.equal(envHead("币环境：上升趋势，高点抬高（2/3） → 做多（效率 0.5，4 小时区间 1%）"),"币环境：上升趋势，高点抬高（2/3） → 做多");
  const t={side:"LONG" as const,entryPrice:99,stopPrice:98.5,plannedRisk:5,leverage:5,notional:300,expectedHoldMinutes:120,
    entryContext:{living:{v:"living-v2",k:"N",pb:"sweep-reclaim",ev:"normal",mult:3,sc:.6,rk:1,inv:98.5,hold:120,why:"x",in:"DRIFT/CALM",mk:"CALM",lm:.7,tg:100,
      env:"环境：币「来回震荡」（清晰度 0.60）+ 市场「来回震荡」→ 做「sweep-reclaim 多」，仓位 0.7×｜币环境：来回震荡 → 只做假突破｜市场环境：来回震荡为主"}}};
  const lines=livingDetail(t,"震荡假突破收回（做回区间中部）").join("\n");
  assert.match(lines,/币环境：来回震荡/);assert.match(lines,/市场环境：来回震荡为主/);assert.match(lines,/为什么选这个打法/);assert.match(lines,/目标：100/);assert.match(lines,/环境清晰度 0.7/);
  assert.match(livingWhy(t,"x"),/环境：币「来回震荡」/);
});
