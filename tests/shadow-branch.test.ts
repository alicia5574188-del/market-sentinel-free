import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync, readFileSync} from 'node:fs';
import {advanceForward, initialForward, normalizeForward, PAPER_COST, type ForwardState, type Quote, type Trade} from '../lib/forward-relations.ts';
import {accountLogBook, buildRunLogExport, shadowSignalOf, withResearchColumns} from '../lib/run-log.ts';
import {emptyTradePathBook, observeTradePaths, pathColumns, type PathCapture, type TradePath} from '../lib/trade-path.ts';
import {RESEARCH_NOTES} from '../lib/log-complete.ts';
import {SHADOW_BTC_RELIABLE_SINCE, SHADOW_COST, shadowFields, shadowOutcome, shadowPlan} from '../lib/shadow-branch.ts';

const T=SHADOW_BTC_RELIABLE_SINCE+86_400_000;
const quote=(bid:number,ask:number,at:number):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,sourceCount:2,disagreementRate:0});
function trade(id:string,openedAt:number,over:Partial<Trade>={}):Trade{
  const entry=100,fee=entry*PAPER_COST.feeRate;
  return {id,symbol:'ETH_USDT',side:'LONG',openedAt,closedAt:null,status:'OPEN',entryPrice:entry,exitPrice:null,quantity:1,contracts:1,
    quantoMultiplier:1,notional:entry,leverage:5,margin:20,plannedRisk:1,stopPrice:98,armPrice:103,favorable:0,adverse:0,lastPrice:entry,
    lastQuoteAt:openedAt,entryFee:fee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,
    lastRelationBar:openedAt,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,...over} as Trade;
}

test('shadow plan: follow / reverse / null, aligned to the signal side, 0.57 boundary',()=>{
  const f=shadowPlan({signalSide:'LONG',btc1hPct:0.8,stopDistPct:2.5,openedAt:T});
  assert.deepEqual(f,{btc1h_aligned_pct:0.8,shadow_branch:'follow',shadow_side:'LONG',shadow_plan:'TP6/SL1',shadow_stop_pct:1,shadow_tp_pct:6});
  const r=shadowPlan({signalSide:'SHORT',btc1hPct:0.8,stopDistPct:2.5,openedAt:T});
  assert.deepEqual(r,{btc1h_aligned_pct:-0.8,shadow_branch:'reverse',shadow_side:'LONG',shadow_plan:'own_stop/6h',shadow_stop_pct:2.5,shadow_tp_pct:null});
  assert.equal(shadowPlan({signalSide:'SHORT',btc1hPct:-0.57,stopDistPct:2,openedAt:T}).shadow_branch,'follow','>= 0.57 follows');
  const below=shadowPlan({signalSide:'LONG',btc1hPct:0.5699,stopDistPct:2,openedAt:T});
  assert.equal(below.shadow_branch,'reverse');assert.equal(below.shadow_side,'SHORT');
  for(const btc of [null,undefined,Number.NaN,'0.8'])assert.deepEqual(shadowPlan({signalSide:'LONG',btc1hPct:btc,stopDistPct:2,openedAt:T}),
    {btc1h_aligned_pct:null,shadow_branch:null,shadow_side:null,shadow_plan:null,shadow_stop_pct:null,shadow_tp_pct:null},`missing BTC 1h ${String(btc)}`);
  assert.equal(shadowPlan({signalSide:'LONG',btc1hPct:0.8,stopDistPct:2,openedAt:SHADOW_BTC_RELIABLE_SINCE-1}).shadow_branch,null,'frozen-BTC era rows stay empty');
  assert.equal(shadowPlan({signalSide:'SHORT',btc1hPct:0.1,stopDistPct:null,openedAt:T}).shadow_stop_pct,null,'no own stop: no stop, no outcome');
});

test('shadow outcome: conservative replay (entry minute adverse only, SL first in one bar, 6h midpoint), pending until decided',()=>{
  const follow=shadowPlan({signalSide:'LONG',btc1hPct:1,stopDistPct:2,openedAt:T});
  // entry minute reaches +7% but only the adverse side counts there; minute 5 hits +6%
  const tp=shadowOutcome(follow,100,[[0,99.5,107],[1,99.6,101],[5,100.5,106.2]]);
  assert.deepEqual(tp,{shadow_exit_reason:'TP',shadow_exit_min:5,shadow_move_pct:6,shadow_net_pct:+(6-SHADOW_COST.roundTrip*100-SHADOW_COST.fundingPerDay*100*5/1440).toFixed(4)});
  assert.equal(shadowOutcome(follow,100,[[0,100,100],[3,98.9,106.5]]).shadow_exit_reason,'SL','both inside one bar: SL first');
  assert.equal(shadowOutcome(follow,100,[[0,100,100],[3,99.5,103]]).shadow_exit_reason,null,'undecided while the path is short');
  const rev=shadowPlan({signalSide:'LONG',btc1hPct:0.2,stopDistPct:2,openedAt:T});
  const hold=Array.from({length:361},(_,m)=>[m,98.9,99.1] as [number,number,number]);
  const out=shadowOutcome(rev,100,hold);
  assert.equal(out.shadow_exit_reason,'TIME');assert.equal(out.shadow_exit_min,360);assert.equal(out.shadow_move_pct,1);
  assert.equal(out.shadow_net_pct,+(1-0.19-0.02*360/1440).toFixed(4));
  assert.equal(shadowOutcome(rev,100,[[0,100,100],[10,101,102.1]]).shadow_exit_reason,'SL','reverse uses the own stop (2%)');
  assert.equal(shadowOutcome(rev,100,hold.slice(0,200)).shadow_exit_reason,null);
  assert.equal(shadowFields({signalSide:'LONG',btc1hPct:null,stopDistPct:2,openedAt:T,entry:100,points:hold}).shadow_exit_reason,null);
});

test('export rows carry the shadow columns: gate signal side and gate BTC value win, notes explain record-only',()=>{
  const row={id:'p',symbol:'ETH_USDT',side:'LONG',entry:100,qty:1,notional:100,entryFee:0.07,openedAt:T,exit:null,exitAt:null,net:null,
    hold:[[0,100,100],[1,98.9,99]],after:[],x:{btc_1h_pct:0.9,stop_dist_pct:2}} as unknown as TradePath;
  const plain=pathColumns(row)!;
  assert.equal(plain.shadow_branch,'follow');assert.equal(plain.shadow_side,'LONG');assert.equal(plain.shadow_exit_reason,'SL');assert.equal(plain.shadow_move_pct,-1);
  // a gate flip: the trade went LONG on a SHORT signal; the gate saw BTC +0.9 → against the SHORT signal → reverse → LONG
  const rows=withResearchColumns([{id:'p',side:'LONG' as const,entry:100,exit:null,notional:100,net_pnl:null,gate_signal_side:'SHORT',gate_btc_1h_pct:0.9}],
    (id,r)=>pathColumns(id==='p'?row:undefined,shadowSignalOf(r)));
  assert.equal(rows[0]!.btc1h_aligned_pct,-0.9);assert.equal(rows[0]!.shadow_branch,'reverse');assert.equal(rows[0]!.shadow_side,'LONG');
  assert.equal(rows[0]!.shadow_stop_pct,2);assert.equal(rows[0]!.shadow_tp_pct,null);
  const gate=withResearchColumns([{id:'p',side:'LONG' as const,entry:100,exit:null,notional:100,net_pnl:null,gate_btc_1h_pct:0.1}],(id,r)=>pathColumns(row,shadowSignalOf(r)));
  assert.equal(gate[0]!.btc1h_aligned_pct,0.1,'the exact gate value is preferred over the entry-feature copy');
  const noPath=withResearchColumns([{id:'q',side:'LONG' as const,entry:100,exit:null,notional:100,net_pnl:null}],()=>null);
  assert.equal('shadow_branch' in noPath[0]!,false,'no path: no research columns (nothing required)');
  assert.match(RESEARCH_NOTES['影子分支']!,/仅记录/);assert.ok(RESEARCH_NOTES.shadow_exit_reason);
});

/** One open LONG plus a not-opened candidate; paths captured with entry features like the worker does. */
function seeded():ForwardState{
  const s=initialForward(T);
  s.positions=[trade('mi-1',T+60_000)];s.balance-=s.positions[0]!.entryFee;
  s.unopenedTrades=[trade('no-1',T+60_000,{side:'SHORT',stopPrice:102,unopened:true} as Partial<Trade>)];
  return normalizeForward(s,T+60_000);
}
const capture:PathCapture={features:t=>({leverage:5,stop_dist_pct:2,hour_utc:0,weekday:1,chg_1h_pct:0,atr_5m_pct:0.3,dist_high_10h_pct:1,
  dist_low_10h_pct:1,range_pos_10h:0.5,mkt_with_share:0.5,btc_1h_pct:t.side==='LONG'?0.7:0.7})};
function run(withExport:boolean){
  let s=seeded();const book=emptyTradePathBook(s.startedAt);const prices=[100,100.5,101,99,97.5,97,98,99];const exports:unknown[]=[];
  prices.forEach((px,i)=>{
    const now=T+120_000+i*60_000,q={ETH_USDT:quote(px,px+0.01,now)};
    s=advanceForward({state:s,now,paths:{},quotes:q,contracts:{}}).state;
    observeTradePaths(book,s,q,{},now,undefined,capture);
    if(withExport){
      const byId=new Map(book.trades.map(p=>[p.id,p]));
      const packed=accountLogBook(s,q,now);
      const file=buildRunLogExport({events:[],funnel:packed.funnel,health:{},gate:{},exportedAt:now,liveEnabled:false,positions:packed.positions,fills:packed.fills,
        curve:packed.curve,equity:packed.equity,initial:packed.initial,closedNet:packed.closedNet,priorAdjustment:packed.priorAdjustment,places:[],
        notOpened:packed.notOpened,accountResets:packed.accountResets,pendingResetAt:packed.pendingResetAt,equityMinutes:[]} as never);
      const cols=(id:string,r:{side:'LONG'|'SHORT';gate_signal_side?:unknown;gate_btc_1h_pct?:unknown})=>pathColumns(byId.get(id),shadowSignalOf(r));
      exports.push({fieldNotes:file.fieldNotes,positions:withResearchColumns(file.positions as never[],cols),not_opened:withResearchColumns(file.not_opened as never[],cols)});
    }
  });
  return {state:JSON.stringify(s),book:JSON.stringify(book),exports};
}

test('trading is identical with and without the shadow columns being built (same opened set, same state, same paths)',()=>{
  const a=run(false),b=run(true);
  assert.equal(b.state,a.state);assert.equal(b.book,a.book);
  const last=b.exports.at(-1) as {fieldNotes:Record<string,string>;positions:Record<string,unknown>[];not_opened:Record<string,unknown>[]};
  assert.match(last.fieldNotes.shadow_branch!,/仅记录/);
  const pos=last.positions.find(r=>r.id==='mi-1')!;
  assert.equal(pos.shadow_branch,'follow');assert.equal(pos.shadow_plan,'TP6/SL1');assert.equal(pos.btc1h_aligned_pct,0.7);
  assert.equal(pos.shadow_exit_reason,'SL','fell 1% after entry');
  const no=last.not_opened.find(r=>r.id==='no-1');
  assert.ok(no,'not-opened row exported');if(no){assert.equal(no.shadow_branch,'reverse');assert.equal(no.shadow_side,'LONG');assert.equal(no.btc1h_aligned_pct,-0.7);}
  // static: only the research/export path can reach the shadow module
  const importers:string[]=[];
  for(const dir of ['lib','worker','app'])for(const f of readdirSync(dir,{recursive:true}) as string[])
    if(/\.(ts|tsx)$/.test(f)&&/from ['"][^'"]*shadow-branch(\.ts)?['"]/.test(readFileSync(`${dir}/${f}`,'utf8')))importers.push(`${dir}/${f}`);
  assert.deepEqual(importers.sort(),['lib/trade-path.ts']);
  assert.doesNotMatch(readFileSync('lib/trade-path.ts','utf8').split('export function pathColumns')[0]!,/shadowFields\(|shadowColumns\(/,'no shadow call in path capture');
});
