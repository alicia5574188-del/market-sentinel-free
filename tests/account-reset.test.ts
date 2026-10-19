import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {advanceForward, forwardSummary, initialForward, normalizeForward, PAPER_COST, type ForwardState, type Quote, type Trade} from '../lib/forward-relations.ts';
import {accountEpochAt, cancelFundsReset, requestFundsReset, resetAdjustment} from '../lib/account-reset.ts';
import {accountLogBook, buildRunLogExport} from '../lib/run-log.ts';
import {emptyOrderJournal, observeOrderJournal} from '../lib/order-journal.ts';
import {emptyTradePathBook, observeTradePaths, restoreTradePathBook} from '../lib/trade-path.ts';
import {archivedEquity} from '../lib/equity-curve.ts';

const T=1_791_800_000_000;
const quote=(bid:number,ask:number,at:number):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,sourceCount:2,disagreementRate:0});
function trade(id:string,openedAt:number,over:Partial<Trade>={}):Trade{
  const entry=100,fee=entry*PAPER_COST.feeRate;
  return {id,symbol:'ETH_USDT',side:'LONG',openedAt,closedAt:null,status:'OPEN',entryPrice:entry,exitPrice:null,quantity:1,contracts:1,
    quantoMultiplier:1,notional:entry,leverage:5,margin:20,plannedRisk:1,stopPrice:98,armPrice:103,favorable:0,adverse:0,lastPrice:entry,
    lastQuoteAt:openedAt,entryFee:fee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,
    lastRelationBar:openedAt,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,...over} as Trade;
}
/** A persisted account: one closed winner (+99.9U), one not-opened record still collecting its path. */
function account(open:boolean):ForwardState{
  const s=initialForward(T);
  const won=trade('mi-old',T+60_000,{status:'CLOSED',closedAt:T+600_000,exitPrice:200,grossPnl:100,exitFee:200*PAPER_COST.feeRate,exitReason:'PEAK_GIVEBACK'});
  won.netPnl=100-won.entryFee-won.exitFee;
  s.history=[won];s.balance=s.initialEquity+won.netPnl;s.resolved=1;s.wins=1;s.grossPnl=100;s.fees=won.entryFee+won.exitFee;
  s.unopenedTrades=[trade('no-1',T+700_000,{unopened:true} as Partial<Trade>)];
  if(open){const t=trade('mi-open',T+800_000);s.positions=[t];s.balance-=t.entryFee;}
  s.storage={persistedAt:T+900_000,error:null};
  return normalizeForward(s,T+900_000);
}
const tick=(state:ForwardState,now:number,px:number)=>advanceForward({state,now,paths:{},quotes:{ETH_USDT:quote(px,px+0.01,now)},contracts:{}}).state;

test('flat account: reset runs now, funds back to 1000, page records/curve restart, the log keeps everything',()=>{
  const before=account(false),at=T+1_000_000;
  const r=requestFundsReset(before,at);
  assert.equal(r.status,'DONE');
  const s=r.state;
  assert.equal(s.balance,1000);assert.equal(s.resolved,0);assert.equal(s.grossPnl,0);
  assert.equal(s.startedAt,before.startedAt,'log epoch stays');
  assert.deepEqual(s.history.map(t=>t.id),['mi-old'],'closed trades stay in the account (run log)');
  assert.deepEqual(s.unopenedTrades?.map(t=>t.id),['no-1']);
  assert.equal(s.unopenedTrades?.[0]?.status,'OPEN','incomplete not-opened record keeps collecting');
  assert.deepEqual(s.stageChronicle,before.stageChronicle);
  assert.equal(s.accountResets?.length,1);
  assert.deepEqual({...s.accountResets![0]!},{at,requestedAt:at,epoch:1,equityBefore:Number(before.balance.toFixed(4)),
    balanceBefore:Number(before.balance.toFixed(4)),balanceAfter:1000});
  const page=forwardSummary(s,{},at+1);
  assert.equal(page.history.length,0,'page order records restart');
  assert.equal(page.pageStartedAt,at,'page curve starts at the reset');
  assert.equal(page.equity,1000);
});

test('run-log export keeps pre-reset rows, books the reset, tags epochs and the identity still balances',()=>{
  const s=requestFundsReset(account(false),T+1_000_000).state;
  const later=trade('mi-new',T+1_100_000);s.positions=[later];s.balance-=later.entryFee;
  const now=T+1_200_000,packed=accountLogBook(s,{ETH_USDT:quote(101,101.02,now)},now);
  assert.equal(packed.priorAdjustment,resetAdjustment(s.accountResets));
  const file=buildRunLogExport({events:[],funnel:packed.funnel,health:{healthySources:3},gate:{connected:true,freshBooks:1},exportedAt:now,liveEnabled:false,
    positions:packed.positions,fills:packed.fills,curve:packed.curve,equity:packed.equity,initial:packed.initial,closedNet:packed.closedNet,
    priorAdjustment:packed.priorAdjustment,places:[],notOpened:packed.notOpened,accountResets:packed.accountResets,pendingResetAt:packed.pendingResetAt,
    equityMinutes:[{ts:T+900_000,equity:1099.8},{ts:T+1_000_000,equity:1000},{ts:T+1_100_000,equity:999.9}] as never});
  const ids=file.positions.map(row=>row.id).sort();
  assert.deepEqual(ids,['mi-new','mi-old']);
  assert.ok(Math.abs(file.invariants.identity_error??99)<0.05,`identity ${file.invariants.identity_error}`);
  assert.equal(file.account_resets.length,1);
  assert.equal(file.account_resets[0]!.ts,T+1_000_000);
  assert.equal(file.account_resets[0]!.balance_after,1000);
  assert.ok(file.account_resets[0]!.balance_before>1099);
  assert.equal(file.account_epoch,1);
  assert.equal(file.account_reset_pending,null);
  const epoch=Object.fromEntries(file.positions.map(row=>[row.id,(row as {account_epoch?:number}).account_epoch]));
  assert.deepEqual(epoch,{'mi-old':0,'mi-new':1});
  assert.equal(file.not_opened[0]?.id,'no-1');
  assert.equal(file.max_drawdown_u,0.1,'the reset step itself is not a drawdown');
  assert.equal(file.curve_since,T+900_000,'equity minutes keep their history');
  assert.equal(accountEpochAt(s.accountResets,T),0);
});

test('open positions: reset is pending, nothing is closed, it runs the moment the last one closes',()=>{
  const before=account(true),asked=T+1_000_000;
  const r=requestFundsReset(before,asked);
  assert.equal(r.status,'PENDING');assert.equal(r.open,1);
  assert.equal(r.state.positions.length,1,'no forced close');
  assert.equal(r.state.balance,before.balance);
  assert.equal(requestFundsReset(r.state,asked+1).status,'ALREADY_PENDING');
  // Still open: normal management, reset still waits.
  const s1=tick(r.state,asked+60_000,101);
  assert.equal(s1.positions.length,1);assert.ok(s1.pendingFundsReset);assert.equal(s1.accountResets?.length??0,0);
  // The stop closes it naturally; the reset runs in that same tick.
  const closeAt=asked+120_000,s2=tick(s1,closeAt,97);
  assert.equal(s2.positions.length,0);
  const closed=s2.history.find(t=>t.id==='mi-open')!;
  assert.equal(closed.status,'CLOSED');assert.notEqual(closed.exitReason,'ACCOUNT_RESET');
  assert.equal(s2.pendingFundsReset,null);
  assert.equal(s2.balance,1000);
  assert.equal(s2.accountResets?.[0]?.at,closeAt);assert.equal(s2.accountResets?.[0]?.requestedAt,asked);
  assert.ok(Math.abs(s2.accountResets![0]!.balanceBefore-(before.balance+before.positions[0]!.entryFee+closed.netPnl!))<1e-3,
    'balance_before includes the last natural close');
  assert.deepEqual(s2.history.map(t=>t.id).sort(),['mi-old','mi-open'],'both trades stay in the run log');
});

test('cancel clears a pending reset; a later flat tick does not reset',()=>{
  const r=requestFundsReset(account(true),T+1_000_000);
  const c=cancelFundsReset(r.state,T+1_010_000);
  assert.equal(c.cancelled,true);assert.equal(c.state.pendingFundsReset,null);
  const s=tick(c.state,T+1_100_000,97);
  assert.equal(s.positions.length,0);
  assert.notEqual(s.balance,1000);assert.equal(s.accountResets?.length??0,0);
  assert.equal(cancelFundsReset(s,T+1_200_000).cancelled,false);
});

test('journal and minute paths keep going across a reset (same log epoch)',()=>{
  const before=account(false),journal=emptyOrderJournal(before.startedAt);
  observeOrderJournal(journal,before.history,before.startedAt);
  const paths=emptyTradePathBook(before.startedAt);
  observeTradePaths(paths,before,{ETH_USDT:quote(100,100.01,T+900_000)},{},T+900_000);
  const n0=paths.trades.find(p=>p.id==='no-1')?.hold.length??0;
  const s=requestFundsReset(before,T+1_000_000).state;
  observeOrderJournal(journal,s.history,s.startedAt);
  assert.deepEqual(journal.rows.map(r=>r.id),['mi-old'],'journal rows kept');
  const restored=restoreTradePathBook(structuredClone(paths),s.startedAt);
  assert.equal(restored.trades.length,paths.trades.length,'saved paths load after the reset');
  observeTradePaths(restored,s,{ETH_USDT:quote(101,101.01,T+1_000_000+60_000)},{},T+1_000_000+60_000);
  assert.ok((restored.trades.find(p=>p.id==='no-1')?.hold.length??0)>n0,'incomplete record keeps collecting its path');
});

test('the page curve reads saved packets of the log epoch from the reset onward',()=>{
  const ctx={startedAt:T+1_000_000,initialEquity:1000,policy:'p',exitPolicy:'e',comparableSince:T+1_000_000,persistedAt:0,accountStartedAt:T};
  const packet=(at:number)=>({at,startedAt:T,policyVersion:'p',daily:{lastAt:at,endEquity:1001},account:{positions:[]}});
  assert.equal(archivedEquity(packet(T+900_000),ctx,T+2_000_000),null,'before the reset: not on the page');
  assert.equal(archivedEquity(packet(T+1_100_000),ctx,T+2_000_000)?.equity,1001);
});

test('reset never touches run-log stores, export progress or the archive',()=>{
  const worker=readFileSync(new URL('../worker/index-clean.ts',import.meta.url),'utf8');
  const methods=worker.slice(worker.indexOf('private async resetPaperAccount'),worker.indexOf('private async clearPaperHistory'));
  assert.match(methods,/requestFundsReset\(previous,now\)/);
  assert.match(methods,/cancelFundsReset\(previous,now\)/);
  assert.doesNotMatch(methods,/RUN_LOG_EXPORT_KEY|log:export|TRADE_PATH|ORDER_JOURNAL_KEY|tradePaths|orderJournal|archiver|run_log_archive|THESIS_STORAGE_KEY|transaction\.delete|initialForward|emptyStrategyAccount|closeForwardForReset/);
  const core=readFileSync(new URL('../lib/forward-relations.ts',import.meta.url),'utf8');
  const advance=core.slice(core.indexOf('export function advanceForward'),core.indexOf('export const ACCOUNT_RESET_LIMIT'));
  assert.ok(advance.indexOf('applyFundsReset')>advance.indexOf('markAndManage(s,'),'runs after exits');
  assert.ok(advance.indexOf('applyFundsReset')<advance.indexOf('advanceEntryResponses('),'and before entries');
});
