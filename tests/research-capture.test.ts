import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Quote, type Trade} from '../lib/forward-relations.ts';
import {btcChange, entryFeatures, type RadarRow} from '../lib/entry-features.ts';
import {emptyTradePathBook, exportTradePaths, FEATURE_FRESH_MS, observeTradePaths, pathColumns, pathComplete, pathLabel, type TradePath} from '../lib/trade-path.ts';
import {withResearchColumns} from '../lib/run-log.ts';
import {equalWeightReturnSince, fillStageForward} from '../lib/stage-chronicle.ts';

const now=1_791_770_400_000;
const quote=(bid:number,ask:number,at=now):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,sourceCount:2,disagreementRate:0});
function open(id:string,side:'LONG'|'SHORT',entry:number,extra:Partial<Trade>={}):Trade{
  return {id,symbol:'ETH_USDT',side,openedAt:now,closedAt:null,status:'OPEN',entryPrice:entry,exitPrice:null,
    quantity:10,contracts:10,quantoMultiplier:1,notional:entry*10,leverage:8,margin:entry*10/8,plannedRisk:1,
    stopPrice:side==='LONG'?entry*0.98:entry*1.02,armPrice:entry,favorable:0,adverse:0,lastPrice:entry,lastQuoteAt:now,entryFee:0.7,
    exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,
    execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,...extra} as Trade;
}
const bars=(n:number,from=100,step=0.05)=>Array.from({length:n},(_,i)=>{const c=from+i*step;return {time:Math.floor(now/1000)-(n-i)*300,open:c,high:c*1.002,low:c*0.998,close:c,volume:i>=n-3?300:100};});
const at=(min:number)=>now+min*60_000;

test('entry features come from the trade, 5m candles, radar, BTC hourly and regime moves',()=>{
  const radar=new Map<string,RadarRow>([
    ['ETH_USDT',{symbol:'ETH_USDT',last:105,high24h:110,low24h:95,change24hRate:0.03,fundingRate:0.0001,openInterest:1100,volume24hUsd:1e9}],
    ['BTC_USDT',{symbol:'BTC_USDT',last:60000,high24h:61000,low24h:59000,change24hRate:-0.01,fundingRate:0,openInterest:5,volume24hUsd:1e10}],
    ['X_USDT',{symbol:'X_USDT',last:1,high24h:1,low24h:1,change24hRate:-0.05,fundingRate:0,openInterest:5,volume24hUsd:1e6}],
  ]);
  const moves=['A','B','C','D','E','F','G','H','ETH'].map((s,i)=>({symbol:`${s}_USDT`,move:i<6?0.004:-0.002}));
  const t=open('f','LONG',105.95);
  const x=entryFeatures({t,now,bars5m:bars(120),radar,radarAt:now-10_000,oiAnchor:{at:now-90*60_000,oi:new Map([['ETH_USDT',1000]])},
    btcHourly:bars(30,60000,10),moves});
  assert.equal(x.leverage,8);
  assert.equal(x.stop_dist_pct,2);
  assert.equal(x.hour_utc,new Date(now).getUTCHours());
  assert.ok(typeof x.chg_1h_pct==='number'&&x.chg_1h_pct>0);
  assert.ok(typeof x.atr_5m_pct==='number'&&Math.abs(x.atr_5m_pct-0.4)<0.01);
  assert.equal(x.vol_surge,3);
  assert.ok(typeof x.range_pos_10h==='number'&&x.range_pos_10h>0.9);
  assert.equal(x.chg_24h_pct,3);
  assert.equal(x.chg_24h_rank,0.6667);
  assert.equal(x.oi_chg_pct,10);
  assert.equal(x.oi_anchor_min,90);
  assert.equal(x.btc_24h_pct,-1,'radar first for BTC 24h');
  assert.ok(typeof x.btc_1h_pct==='number');
  assert.equal(x.mkt_with_share,0.6667);
  // stale radar: radar fields are empty, candles still fill
  const stale=entryFeatures({t,now,bars5m:bars(120),radar,radarAt:now-10*60_000,moves:[]});
  assert.equal(stale.chg_24h_pct,null);assert.equal(stale.mkt_with_share,null);assert.ok(stale.chg_1h_pct!=null);
});

test('btc_1h/4h follow BTC at each entry time; a stale stored hourly path is never reported',()=>{
  const t=open('b','LONG',100);
  // stored hourly path that stopped refreshing 7 h ago (the frozen 0.4661 / 0.674 bug)
  const staleHourly=Array.from({length:30},(_,i)=>({time:Math.floor(now/1000)-7*3600-(30-i)*3600,open:1,high:1,low:1,close:80000+i*10,volume:1}));
  const frozen=entryFeatures({t,now,btcHourly:staleHourly});
  assert.equal(frozen.btc_1h_pct,null);assert.equal(frozen.btc_4h_pct,null);
  // in-memory BTC mids, one per minute for 5 h: 82000 falling 1 per minute
  const mids=Array.from({length:301},(_,i)=>({at:now-(300-i)*60_000,px:82000-i}));
  const a=entryFeatures({t,now,btcHourly:staleHourly,btcMids:mids});
  assert.equal(a.btc_1h_pct,Math.round((81700/81760-1)*1e6)/1e4);
  assert.equal(a.btc_4h_pct,Math.round((81700/81940-1)*1e6)/1e4);
  // an hour later, with more samples, the value changes (was constant before the fix)
  const later=now+60*60_000,more=[...mids,...Array.from({length:60},(_,i)=>({at:now+(i+1)*60_000,px:81700+(i+1)*5}))];
  const b=entryFeatures({t:{...t,openedAt:later},now:later,btcMids:more});
  assert.equal(b.btc_1h_pct,Math.round((82000/81700-1)*1e6)/1e4);
  assert.notEqual(b.btc_4h_pct,a.btc_4h_pct);
  // ring without a sample near "4 h ago" (e.g. right after a restart): null, not a guess
  assert.equal(btcChange({now,btcMids:mids.slice(-90)},4),null);
  assert.ok(btcChange({now,btcMids:mids.slice(-90)},1)!=null);
  // fresh BTC 5m candles win when present
  assert.equal(btcChange({now,btcBars5m:bars(60,100,1),btcMids:mids},1),Math.round((159/147-1)*1e6)/1e4);
  // garbage input never throws
  assert.equal(btcChange({now,btcMids:[{at:NaN,px:-1}] as never},1),null);
});

test('path label: leveraged ROE (price % x leverage), reached_roe_5, 24h tail and the after-exit shift',()=>{
  const row:TradePath={id:'r',symbol:'ETH_USDT',side:'LONG',entry:100,qty:1,notional:100,entryFee:0,openedAt:now,exit:100.2,exitAt:at(10),net:0.1,
    hold:[[0,99.9,100.1],[5,100.3,100.4],[10,100.2,100.2]],after:[[0,100.2,100.3],[50,100.5,100.7]],tail:[[600,99,101]],x:{leverage:8}};
  const label=pathLabel(row);
  assert.equal(label.mfe_pct,1);assert.equal(label.mfe_min,600);
  assert.equal(label.mfe_roe_pct,8);assert.equal(label.reached_roe_5,true);
  assert.equal(label.reached_roe_5_min,60,'0.7% x 8 = 5.6% first reached at exit minute 10 + 50 after');
  assert.equal(label.mfe_6h_pct,0.7);assert.equal(label.mae_pct,1);assert.equal(label.mae_roe_pct,8);
  assert.equal(label.hold_mfe_pct,0.4);assert.equal(label.path_minutes,600);
  assert.equal(label.first_roe_5,'UP');
  assert.equal(pathLabel({...row,hold:[[0,99.3,100]],after:[],tail:[]}).first_roe_5,'DOWN');
  assert.equal(pathLabel({...row,x:null}).reached_roe_5,null,'no leverage: no ROE label');
});

test('capture: features only at the signal, peak and end exit-state, 30-minute track, tail after 6h with radar fallback',()=>{
  const state=initialForward(now);
  const book=emptyTradePathBook(state.startedAt);
  const t=open('a','LONG',100);state.positions.push(t);
  const late=open('late','LONG',100,{symbol:'BTC_USDT',openedAt:now-FEATURE_FRESH_MS-1});state.positions.push(late);
  const capture={features:(tr:Trade)=>({leverage:tr.leverage,stop_dist_pct:2,hour_utc:1,weekday:2,chg_1h_pct:0.1,atr_5m_pct:0.2,dist_high_10h_pct:1,dist_low_10h_pct:1,range_pos_10h:0.5,mkt_with_share:0.6})};
  observeTradePaths(book,state,{ETH_USDT:quote(100,100.1,now)},{},now,undefined,capture);
  const row=book.trades.find(r=>r.id==='a')!;
  assert.equal(row.x?.leverage,8);
  assert.equal(book.trades.find(r=>r.id==='late')!.x,undefined,'first seen long after its signal: no features, record stays incomplete');
  assert.equal(pathComplete(row,false),true);
  (t as unknown as {winnerManagement:unknown}).winnerManagement={phase:'PROTECT',protectedStop:100.5,requestedAction:'HOLD'};
  observeTradePaths(book,state,{ETH_USDT:quote(101,101.1,at(31))},{},at(31),undefined,capture);
  assert.equal(row.peak?.pct,1);assert.equal(row.peak?.wm_phase,'PROTECT');
  assert.deepEqual(row.track?.map(s=>s.m),[0,31]);
  observeTradePaths(book,state,{ETH_USDT:quote(100.5,100.6,at(40))},{},at(40),undefined,capture);
  assert.equal(row.track?.length,2,'no snapshot before 30 more minutes');
  // close
  state.positions.splice(state.positions.indexOf(t),1);
  Object.assign(t,{status:'CLOSED',exitPrice:100.4,closedAt:at(45),netPnl:2,exitReason:'PROFIT_FLOOR',exitAudit:{trigger:'FLOOR',detail:'gave back',evidence:{floor:0.5,nested:{a:1}}}});
  state.history.unshift(t);
  assert.equal(pathComplete(row,true),false,'closed but not yet observed');
  observeTradePaths(book,state,{ETH_USDT:quote(100.4,100.5,at(45))},{},at(45),undefined,capture);
  assert.equal(row.end?.trigger,'FLOOR');assert.deepEqual(row.end?.evidence,{floor:0.5});
  assert.equal(row.end?.peak_pct,1);assert.equal(row.end?.exit_pct,0.4);assert.equal(row.end?.giveback_pct,0.6);
  assert.equal(pathComplete(row,true),true);
  // 6h+ : no quote, radar fallback fresh -> tail bucket
  observeTradePaths(book,state,{},{},at(400),undefined,{...capture,fallback:{ETH_USDT:{px:103,at:at(400)-5_000}}});
  observeTradePaths(book,state,{},{},at(410),undefined,{...capture,fallback:{ETH_USDT:{px:102,at:at(410)}}});
  observeTradePaths(book,state,{},{},at(420),undefined,{...capture,fallback:{ETH_USDT:{px:99,at:at(420)-300_000}}});
  assert.deepEqual(row.tail,[[390,103,103],[405,102,102]],'stale radar price ignored');
  const exp=exportTradePaths(book,id=>id==='a')[0]!;
  assert.deepEqual(exp.tail,[[390,103,103],[405,102,102]]);assert.equal(exp.end?.trigger,'FLOOR');assert.equal(exp.track?.length,2);
  const cols=pathColumns(row)!;
  assert.equal(cols.mfe_pct,3);assert.equal(cols.mfe_roe_pct,24);assert.equal(cols.stop_dist_pct,2);
});

test('unopened records get peak/end/tail but no track',()=>{
  const state=initialForward(now);
  const book=emptyTradePathBook(state.startedAt);
  const t=open('u','SHORT',100,{unopened:true} as Partial<Trade>);
  (state.unopenedTrades??=[]).push(t);
  observeTradePaths(book,state,{ETH_USDT:quote(99,99.1,at(31))},{},at(31));
  observeTradePaths(book,state,{ETH_USDT:quote(98,98.1,at(62))},{},at(62));
  const row=book.trades[0]!;
  assert.equal(row.track,undefined);assert.ok(row.peak&&row.peak.pct>1.8);
});

test('run-log research columns: leverage, net ROE, exit move and joined labels',()=>{
  const rows=[{id:'a',side:'LONG' as const,entry:100,exit:101,notional:1000,net_pnl:8,leverage:8},{id:'b',side:'SHORT' as const,entry:100,exit:null,notional:100,net_pnl:null,leverage:null}];
  const out=withResearchColumns(rows,id=>id==='a'?{leverage:8,mfe_roe_pct:12}:{leverage:6,reached_roe_5:false});
  assert.equal(out[0]!.net_roe_pct,6.4);assert.equal(out[0]!.exit_move_pct,1);assert.equal(out[0]!.mfe_roe_pct,12);
  assert.equal(out[1]!.leverage,6,'row without leverage takes the captured one');assert.equal(out[1]!.net_roe_pct,null);
});

test('stage forward factor: equal-weight return over the same coins; legacy snaps get null',()=>{
  const sw=now-60*60_000;
  const paths:Record<string,{time:number;close:number}[]>={};
  for(let i=0;i<8;i++)paths[`C${i}`]=[{time:(sw-600_000)/1000,close:100},{time:(sw-300_000)/1000,close:100},{time:(now-300_000)/1000,close:i<4?102:101}];
  assert.equal(equalWeightReturnSince(paths,sw),1.5);
  assert.equal(equalWeightReturnSince({C0:paths.C0!},sw),null,'fewer than 8 coins');
  const chronicle={version:'stage-chronicle-v1',changes:[
    {at:sw,stage:'TREND',prior:'TRANSITION',snap:{btc:100,eth:50,factor:null,factor_30m_pct:0.2}},
    {at:sw+1,stage:'SHOCK',prior:'TREND',snap:{btc:100,eth:50,factor:1.2}}]} as unknown as Parameters<typeof fillStageForward>[0];
  const out=fillStageForward(chronicle,101,null,(a:number)=>equalWeightReturnSince(paths,a),now);
  const fwd=out.changes.map(c=>(c as {fwd?:Record<string,{btc_pct:number|null;factor_pct:number|null}>}).fwd);
  assert.equal(fwd[0]?.m30?.factor_pct,1.5);assert.equal(fwd[0]?.m30?.btc_pct,1);
  assert.equal(fwd[1]?.m30?.factor_pct,null);
});
