// Safety net for the "strategy system removed, core trading kept" change.
// Nothing here opens a position; everything checks that existing orders are still managed to the end and old data still loads.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {advanceForward,initialForward,normalizeForward,forwardSummary,HOLD_BACKSTOP_MULTIPLE,PAPER_COST,type ForwardState,type Quote,type Trade} from '../lib/forward-relations.ts';

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
