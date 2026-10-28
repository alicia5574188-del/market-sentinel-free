// Safety net for the "strategy system removed, core trading kept" change.
// Nothing here opens a position; everything checks that existing orders are still managed to the end and old data still loads.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {prepareForwardWrite,readForwardStore} from '../lib/forward-store.ts';
import {applyStripCoreReset,stripCoreResetDone,STRIP_CORE_RESET_KIND,pageStartedAt,advanceForward,initialForward,normalizeForward,forwardSummary,HOLD_BACKSTOP_MULTIPLE,PAPER_COST,type ForwardState,type Quote,type Trade} from '../lib/forward-relations.ts';

const T=1_791_800_000_000;
const quote=(bid:number,ask:number,at:number):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,sourceCount:2,disagreementRate:0});
function trade(id:string,over:Partial<Trade>={}):Trade{
  const entry=100,fee=entry*PAPER_COST.feeRate;
  return {id,symbol:'ETH_USDT',side:'LONG',openedAt:T,closedAt:null,status:'OPEN',entryPrice:entry,exitPrice:null,quantity:1,contracts:1,
    quantoMultiplier:1,notional:entry,leverage:5,margin:20,plannedRisk:1,stopPrice:98,armPrice:103,favorable:0,adverse:0,lastPrice:entry,
    lastQuoteAt:T,entryFee:fee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,
    lastRelationBar:T,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,...over} as Trade;
}
const withTrade=(t:Trade):ForwardState=>{const s=initialForward(T);s.positions=[t];s.balance-=t.entryFee;return normalizeForward(s,T);};
const tick=(state:ForwardState,now:number,bid:number,ask=bid+.01,symbol='ETH_USDT')=>
  advanceForward({state,now,quotes:{[symbol]:quote(bid,ask,now)},contracts:{}});

test('no strategy: a flat account with fresh quotes everywhere never opens anything',()=>{
  let s=initialForward(T);
  const quotes=Object.fromEntries(['BTC_USDT','ETH_USDT','SOL_USDT','SUI_USDT'].map(x=>[x,quote(100,100.01,T)]));
  for(let i=1;i<=50;i++){const r=advanceForward({state:s,now:T+i*2000,quotes:Object.fromEntries(Object.entries(quotes).map(([k,v])=>[k,{...v,observedAt:T+i*2000}])),contracts:{}});s=r.state;}
  assert.equal(s.positions.length,0);assert.equal(s.history.length,0);assert.equal(s.balance,s.initialEquity);
  assert.equal((s.opportunities??[]).length,0);
});

test('existing position: stop closes it, it leaves positions and lands in the history with its fees',()=>{
  const s=withTrade(trade('old-1')),r=tick(s,T+5000,97.5);
  assert.equal(r.state.positions.length,0);assert.equal(r.state.history.length,1);
  const h=r.state.history[0]!;assert.equal(h.id,'old-1');assert.equal(h.status,'CLOSED');assert.equal(h.exitReason,'STRUCTURE_STOP');
  assert.ok(h.netPnl!<0);assert.ok(h.exitFee>0);assert.equal(r.changed,true);
  assert.equal(r.state.resolved,1);
});

test('existing position: a price between stop and target is left alone (no new strategy decision can close or add)',()=>{
  const s=withTrade(trade('old-2')),r=tick(s,T+5000,100.5);
  assert.equal(r.state.positions.length,1);assert.equal(r.state.positions[0]!.status,'OPEN');assert.equal(r.state.history.length,0);
});

test('existing position: recorded take-profit closes it (living context target)',()=>{
  const s=withTrade(trade('old-tp',{entryContext:{living:{tg:103,hold:30,hx:0}} as never}));
  const r=tick(s,T+5000,103.5);
  assert.equal(r.state.positions.length,0);assert.equal(r.state.history[0]!.exitReason,'TAKE_PROFIT');assert.ok(r.state.history[0]!.netPnl!>0);
});

test('existing position: saved protective floor (livingGuard) still closes it',()=>{
  const s=withTrade(trade('old-guard',{stopPrice:90,livingGuard:{stop:101,code:'FIXTURE',at:T} as never}));
  const r=tick(s,T+5000,100.5);
  assert.equal(r.state.positions.length,0);assert.equal(r.state.history[0]!.exitReason,'LIVING_GUARD_STOP');
});

test('existing position: isolated liquidation closes it before anything else',()=>{
  const s=withTrade(trade('old-liq',{stopPrice:0,leverage:10,margin:10}));
  const r=tick(s,T+5000,80);
  assert.equal(r.state.positions.length,0);assert.equal(r.state.history.length,1);
});

test('existing position with a planned hold: backstop closes it after 1.5x the hold',()=>{
  const s=withTrade(trade('old-hold',{entryContext:{living:{tg:500,hold:30,hx:0}} as never}));
  const early=tick(s,T+HOLD_BACKSTOP_MULTIPLE*30*60_000-60_000,100.2);
  assert.equal(early.state.positions.length,1,'not yet');
  const late=tick(early.state,T+HOLD_BACKSTOP_MULTIPLE*30*60_000+1000,100.2);
  assert.equal(late.state.positions.length,0);assert.equal(late.state.history[0]!.exitReason,'LIVING_FALLBACK_TIMEOUT');
});

test('KNOWN RISK (documented): a position without a planned hold only has stop/liquidation, never a time exit',()=>{
  const s=withTrade(trade('old-hx',{entryContext:{living:{hx:1}} as never}));
  const r=tick(s,T+30*24*3_600_000,100.2);
  assert.equal(r.state.positions.length,1,'stays open until its stop or liquidation is touched');
});

test('stale quote never closes or marks a position',()=>{
  const s=withTrade(trade('old-stale')),stale={ETH_USDT:{...quote(50,50.01,T),fresh:false}};
  const r=advanceForward({state:s,now:T+60_000,quotes:stale,contracts:{}});
  assert.equal(r.state.positions.length,1);assert.equal(r.state.history.length,0);
});

test('pending funds reset waits for the last position to close, then runs once',()=>{
  const s=withTrade(trade('old-reset'));s.pendingFundsReset={requestedAt:T};
  const open=tick(s,T+5000,100.5);
  assert.equal(open.state.positions.length,1);assert.ok(open.state.pendingFundsReset);
  const closed=tick(open.state,T+10_000,97);
  assert.equal(closed.state.positions.length,0);assert.ok(!closed.state.pendingFundsReset);assert.equal(closed.state.balance,1000);
});

test('old saved state (with every retired strategy blob) restores unchanged and keeps its orders',()=>{
  const s=initialForward(T);
  const old=structuredClone(s) as unknown as Record<string,unknown>;
  Object.assign(old,{strategyArena:{x:1},regimePortfolio:{y:2},unopenedTrades:[trade('u-1',{unopened:true} as never)],entryValidations:[],
    inverseTrial:undefined,rules:[{id:'r'}],shadowLedger:{rows:[1,2,3]},unknownFutureField:{keep:true}});
  const closed=trade('h-1',{status:'CLOSED',closedAt:T+1000,exitPrice:101,grossPnl:1,netPnl:.8,exitReason:'PEAK_GIVEBACK'});
  (old.history as Trade[]).push(closed);
  const n=normalizeForward(old as unknown as ForwardState,T+2000) as unknown as Record<string,unknown>;
  assert.equal((n.history as Trade[]).length,1);assert.equal((n.history as Trade[])[0]!.exitReason,'PEAK_GIVEBACK');
  assert.deepEqual(n.unknownFutureField,{keep:true});assert.deepEqual(n.shadowLedger,{rows:[1,2,3]});
  assert.equal((n.unopenedTrades as unknown[]).length,1);
  const page=forwardSummary(n as unknown as ForwardState,{},T+3000);
  assert.equal(page.history.length,1);
});

test('wrangler: Durable Object migrations and bindings are exactly the pre-change ones (a changed migration could wipe the DO)',()=>{
  const cfg=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  const tags=[...cfg.matchAll(/"tag":\s*"([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(tags,['v1','v2','v3','v4','v5-historical-archive','v6-liquidity-three-state','v7-delete-legacy-do','v8-isolated-member-accounts']);
  for(const name of ['MARKET_STREAM','MEMBERS','MEMBER_EXECUTION'])assert.match(cfg,new RegExp(`"name":\\s*"${name}"`));
  assert.match(cfg,/"\* \* \* \* \*"/,'the 1-minute watchdog cron stays: it keeps the alarm that manages open positions alive');
});

test('worker: core routes and the alarm clock are intact; no strategy module is imported any more',()=>{
  const w=readFileSync(new URL('../worker/index-clean.ts',import.meta.url),'utf8');
  for(const route of ['/__health','/api/forward/export','/api/forward/equity','/api/forward/archive','/api/account-logs','/api/history','/api/live/mode','/api/auth/login','/api/paper/reset'])
    assert.ok(w.includes(`"${route}"`),route);
  assert.match(w,/advanceForward\(/);assert.match(w,/async alarm\(/);assert.match(w,/buildRunLogExport/);
  const imports=[...w.matchAll(/from\s*["']\.\.\/lib\/([\w\-/]+)\.ts["']/g)].map(m=>m[1]!);
  for(const gone of ['living/engine','living/entry','dynamic/research','dynamic/predictor','brain-view','forward-protection','multi-turn-universe','research-brain'])
    assert.ok(!imports.includes(gone),`must not import ${gone}`);
  for(const f of imports)assert.ok(existsSync(new URL(`../lib/${f}.ts`,import.meta.url)),`${f} exists`);
});

test('worker: nothing schedules a strategy, shadow trade, research or reverse-mode task',()=>{
  const w=readFileSync(new URL('../worker/index-clean.ts',import.meta.url),'utf8');
  for(const banned of [/advanceShadow/,/launchLiving/,/dynamicResearch/i,/predictorGate/i,/playbookPool/i,/brainJudg/i,/applyResearchExperiment/,/adoptNewDesk/,/reverseMode/i,/wBottom|mTop/i])
    assert.doesNotMatch(w,banned,String(banned));
});

// ---- one-time, owner-authorised paper reset (strategy system removed) ----
const T2=T+60_000;
function oldAccount(){
  const s=initialForward(T);
  const a=trade('old-a',{symbol:'ETH_USDT',lastPrice:101}),b=trade('old-b',{symbol:'BTC_USDT',side:'SHORT',entryPrice:100,lastPrice:99});
  s.positions=[a,b];s.balance=1042.5;s.fees=3.2;s.grossPnl=45;s.resolved=7;s.wins=4;s.turnover=900;
  s.daily=[{day:'2026-10-27',open:1000,high:1050,low:990,close:1042.5} as never];
  const done=trade('hist-1',{status:'CLOSED',closedAt:T+1000,exitPrice:101,netPnl:0.7,exitReason:'TAKE_PROFIT'});
  s.history=[done];
  return normalizeForward(s,T);
}
const resetQuotes=(now:number)=>({ETH_USDT:quote(102,102.01,now),BTC_USDT:quote(98,98.01,now)});

test('one-time reset: old positions are cleared, balance is back to 1000U, nothing is deleted from the history',()=>{
  const s=oldAccount(),r=applyStripCoreReset(s,resetQuotes(T2),T2);
  assert.equal(r.done,true);
  const n=r.state;
  assert.equal(n.positions.length,0);assert.equal(n.balance,1000);assert.equal(n.initialEquity,1000);assert.equal(n.pendingFundsReset??null,null);
  assert.equal(n.resolved,0);assert.equal(n.fees,0);assert.equal(n.turnover,0);
  const ids=n.history.map(t=>t.id);
  assert.ok(ids.includes('hist-1'),'old order history stays');assert.ok(ids.includes('old-a')&&ids.includes('old-b'),'cleared positions are kept as history rows');
  for(const id of ['old-a','old-b']){const t=n.history.find(x=>x.id===id)!;assert.equal(t.status,'CLOSED');assert.equal(t.exitReason,'ACCOUNT_RESET');}
  assert.equal(n.startedAt,s.startedAt,'log epoch (run log key) unchanged');
  assert.equal(pageStartedAt(n),T2);
  assert.equal(n.liveEligible,false);
});

test('one-time reset: an explicit reset log event and an exportable snapshot of the pre-reset positions and balance',()=>{
  const r=applyStripCoreReset(oldAccount(),resetQuotes(T2),T2),n=r.state;
  assert.ok(n.events.some(e=>e.kind==='START'&&/一次性重置.*2.*笔旧纸面持仓.*1042\.50U/.test(e.reason)),'reset log event');
  const m=n.accountResets!.at(-1)!;
  assert.equal(m.kind,STRIP_CORE_RESET_KIND);assert.equal(m.balanceAfter,1000);assert.equal(m.at,T2);
  const snap=m.snapshot!;
  assert.equal(snap.balanceBeforeClose,1042.5);assert.equal(snap.positions.length,2);
  assert.deepEqual(snap.positions.map(p=>p.id).sort(),['old-a','old-b']);
  assert.ok(snap.positions.every(p=>p.netPnlOnClose!=null&&p.exitPrice!=null));
  assert.equal(snap.daily.length,1);assert.equal(snap.historyCount,n.history.length);
  assert.equal(snap.realizedFromClose,Number((snap.balanceAfterClose-snap.balanceBeforeClose).toFixed(4)));
  // it is part of the exported summary, so a review can continue across the reset
  const sum=forwardSummary(n,{},T2);assert.equal(sum.accountResets.at(-1)!.snapshot!.positions.length,2);
  const cut=JSON.parse(JSON.stringify(n));assert.equal(cut.accountResets.at(-1).snapshot.positions[0].id.length>0,true);
});

test('one-time reset is idempotent: a second run (or a replay of the same state) does nothing',()=>{
  const once=applyStripCoreReset(oldAccount(),resetQuotes(T2),T2).state;
  assert.equal(stripCoreResetDone(once),true);
  const again=applyStripCoreReset(once,resetQuotes(T2+5000),T2+5000);
  assert.equal(again.done,false);assert.equal(again.state,once);
  // a new position opened after the reset (e.g. manually) is never touched by a later boot
  const withNew=normalizeForward({...structuredClone(once),positions:[trade('after-reset',{openedAt:T2+10_000})],balance:995},T2+20_000);
  const third=applyStripCoreReset(withNew,resetQuotes(T2+30_000),T2+30_000);
  assert.equal(third.done,false);assert.equal(third.state.positions.length,1);assert.equal(third.state.balance,995);
  assert.equal(once.accountResets!.filter(r=>r.kind===STRIP_CORE_RESET_KIND).length,1);
});

test('DO restart does not repeat the reset: marker + reset survive a real save/restore, and the restored state is skipped',async()=>{
  const reset=applyStripCoreReset(oldAccount(),resetQuotes(T2),T2).state;
  reset.storage={persistedAt:T2,error:null};
  const write=await prepareForwardWrite(null,reset,T2,{compact:true});
  const data=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({get:async<V>(key:string)=>structuredClone(data.get(key)) as V|undefined},T2+1);
  assert.equal(stripCoreResetDone(restored),true);assert.equal(restored.balance,1000);assert.equal(restored.positions.length,0);
  assert.ok(restored.history.some(t=>t.id==='old-a'),'history survives');
  assert.equal(restored.accountResets!.at(-1)!.snapshot!.positions.length,2,'snapshot survives the restart');
  assert.equal(applyStripCoreReset(restored,resetQuotes(T2+9000),T2+9000).done,false);
  // a restart BEFORE the reset was persisted still sees the old account and resets it once
  const old=oldAccount();old.storage={persistedAt:T,error:null};
  const w0=await prepareForwardWrite(null,old,T,{compact:true}),d0=new Map(Object.entries(w0.entries));
  const back=await readForwardStore({get:async<V>(key:string)=>structuredClone(d0.get(key)) as V|undefined},T+1);
  assert.equal(stripCoreResetDone(back),false);assert.equal(back.positions.length,2);
  assert.equal(applyStripCoreReset(back,resetQuotes(T2),T2).done,true);
});

test('after the reset the core keeps running: flat account, no new positions, equity at 1000U',()=>{
  let s=applyStripCoreReset(oldAccount(),resetQuotes(T2),T2).state;
  for(let i=1;i<=20;i++){const now=T2+i*2000;s=advanceForward({state:s,now,quotes:resetQuotes(now),contracts:{}}).state;}
  assert.equal(s.positions.length,0);assert.equal(s.balance,1000);assert.equal(s.accountResets!.length,1);
});

test('reset works with no fresh quote (uses the last saved price) and with an already flat account',()=>{
  const r=applyStripCoreReset(oldAccount(),{},T2);assert.equal(r.done,true);assert.equal(r.state.positions.length,0);
  const flat=initialForward(T);flat.balance=1010;
  const f=applyStripCoreReset(normalizeForward(flat,T),{},T2);assert.equal(f.done,true);assert.equal(f.state.balance,1000);assert.equal(f.state.accountResets![0]!.snapshot!.positions.length,0);
});

test('live switch stays off and the live channel is untouched: the reset is paper-only and waits if anything live is on or open',()=>{
  const w=readFileSync(new URL('../worker/index-clean.ts',import.meta.url),'utf8');
  const fr=readFileSync(new URL('../lib/forward-relations.ts',import.meta.url),'utf8');
  // the pure reset never mentions the live channel or Gate
  const body=fr.slice(fr.indexOf('export function applyStripCoreReset'),fr.indexOf('/** Where the page'));
  assert.doesNotMatch(body,/live|gate|fetch\(/i);
  // the worker runs it only behind the live blocker; the blocker reads memory only and the call site makes no network call
  const blocker=w.slice(w.indexOf('private liveMirrorBlocker'),w.indexOf('private async resetPaperAccount'));
  assert.match(blocker,/requestedEnabled\|\|live\.operational/);assert.match(blocker,/activeLivePositions\(\)\.length/);assert.match(blocker,/activeLiveEntries\(\)\.length/);
  assert.doesNotMatch(blocker,/await|fetch|client|requestedEnabled\s*=/);
  const site=w.slice(w.indexOf('let engineIn=previous'),w.indexOf('const next = advanceForward'));
  assert.match(site,/liveMirrorBlocker\(\)/);assert.doesNotMatch(site,/await|fetch|gateLive|setLive|requestedEnabled\s*=|operational\s*=/);
  // never turns the switch on
  assert.doesNotMatch(body+site,/requestedEnabled\s*=\s*true/);
});
