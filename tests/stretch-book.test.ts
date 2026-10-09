import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote, type Trade} from '../lib/forward-relations.ts';
import {applyStretchBook, readStretch} from '../lib/stretch-book.ts';
import {freshStretchLedger} from '../lib/shadow-inverse.ts';
import {applyInverseSourceTrade, newInverseTrial} from '../lib/shadow-inverse-ledger.ts';

const bucket=Math.floor(1_791_500_000/900)*900;
const T=bucket*1000+10_000;
const contract={quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1,volume24hUsd:5_000_000};
const quote=(bid:number,ask:number,at=T):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true});
function path(from:number,to:number):Candle[]{
  const end=bucket-900,start=end-7*900,bars:Candle[]=[];
  for(let i=0;i<8;i++){
    const open=from+(to-from)*i/8,close=from+(to-from)*(i+1)/8;
    for(let k=0;k<3;k++){
      const px=open+(close-open)*(k+1)/3;
      bars.push({time:start+i*900+k*300,open:k===0?open:px,high:Math.max(open,close)+.01,low:Math.min(open,close)-.01,close:k===2?close:px,volume:1});
    }
  }
  return bars;
}
function book(){
  const s=initialForward(T-60_000);
  s.inverseTrial=newInverseTrial(s,T-60_000,1000);
  s.inverseTrial.paperPolicy='stretch-v1';
  s.balance=1000;
  return s;
}
test('a two-hour BTC rise opens one large follower and ignores a chase',()=>{
  const paths={BTC_USDT:path(100,101.2),ETH_USDT:path(50,50.9),SOL_USDT:path(20,20.05)};
  const read=readStretch(paths,{BTC_USDT:contract,ETH_USDT:contract,SOL_USDT:contract},T);
  assert.equal(read.dir,'UP');
  assert.ok(read.names.some(row=>row.symbol==='ETH_USDT'));
  assert.equal(read.names.some(row=>row.symbol==='SOL_USDT'),false);
  const s=book();
  const ethClose=50.9;
  applyStretchBook(s,paths,{ETH_USDT:quote(ethClose,ethClose*1.0002),BTC_USDT:quote(101.2,101.22)},{ETH_USDT:contract,BTC_USDT:contract},T);
  const open=s.positions.filter(t=>t.exitControl?.policy==='stretch-v1');
  assert.equal(open.length,2);
  const eth=open.find(t=>t.symbol==='ETH_USDT')!;
  assert.equal(eth.side,'LONG');
  assert.ok(eth.notional>1800&&eth.notional<=2000,`notional ${eth.notional}`);
  assert.equal(eth.leverage,5);
  assert.ok(Math.abs(eth.stopPrice/eth.entryPrice-0.995)<1e-9);
  const chased=book();
  applyStretchBook(chased,paths,{ETH_USDT:quote(ethClose*1.006,ethClose*1.0062)},{ETH_USDT:contract},T);
  assert.equal(chased.positions.length,0);
  assert.match(JSON.stringify(chased.inverseTrial!.work),/不追/);
});
test('a flat BTC tape opens nothing, and a stop, giveback, or two hours exits',()=>{
  const flat={BTC_USDT:path(100,100.2),ETH_USDT:path(50,51)};
  const quiet=book();
  applyStretchBook(quiet,flat,{ETH_USDT:quote(51,51.01)},{ETH_USDT:contract,BTC_USDT:contract},T);
  assert.equal(quiet.positions.length,0);
  const s=book();
  applyStretchBook(s,{BTC_USDT:path(100,101.2),ETH_USDT:path(50,50.9)},{ETH_USDT:quote(50.9,50.91),BTC_USDT:quote(101.2,101.22)},{ETH_USDT:contract,BTC_USDT:contract},T);
  const t=s.positions.find(row=>row.symbol==='ETH_USDT')!;
  assert.ok(t);
  const entry=t.entryPrice;
  applyStretchBook(s,{BTC_USDT:path(100,101.2),ETH_USDT:path(50,50.9)},{ETH_USDT:quote(entry*.994,entry*.995)},{ETH_USDT:contract},T);
  assert.equal(s.history[0]?.exitReason,'STRETCH_WRONG_EXIT');
  const held=book();
  applyStretchBook(held,{BTC_USDT:path(100,101.2),ETH_USDT:path(50,50.9)},{ETH_USDT:quote(50.9,50.91)},{ETH_USDT:contract,BTC_USDT:contract},T);
  const runner=held.positions[0]!;
  const up=runner.entryPrice*1.009;
  applyStretchBook(held,{BTC_USDT:path(100,101.2)},{ETH_USDT:quote(up,up*1.0002)},{ETH_USDT:contract},T);
  assert.equal(runner.status,'OPEN');
  const back=runner.entryPrice*(1+runner.favorable/2);
  applyStretchBook(held,{BTC_USDT:path(100,101.2)},{ETH_USDT:quote(back,back*1.0001,T+60_000)},{ETH_USDT:contract},T+60_000);
  assert.equal(held.history[0]?.exitReason,'STRETCH_GIVEBACK_EXIT');
  const stale=book();
  applyStretchBook(stale,{BTC_USDT:path(100,101.2),ETH_USDT:path(50,50.9)},{ETH_USDT:quote(50.9,50.91)},{ETH_USDT:contract,BTC_USDT:contract},T);
  const old=stale.positions[0]!;
  const at=T+2*60*60_000+1000;
  applyStretchBook(stale,{BTC_USDT:path(100,101.2)},{ETH_USDT:quote(old.entryPrice,old.entryPrice*1.0001,at)},{ETH_USDT:contract},at);
  assert.equal(stale.history[0]?.exitReason,'STRETCH_TIME_EXIT');
});
test('the new book starts at 1000 and does not copy a proposal',()=>{
  const prior=book();
  prior.balance=800;prior.resolved=3;
  const next=freshStretchLedger(prior,T);
  assert.equal(next.balance,1000);
  assert.equal(next.inverseTrial?.paperPolicy,'stretch-v1');
  const source={id:'src',symbol:'ETH_USDT',side:'LONG',openedAt:T,closedAt:null,status:'OPEN',entryPrice:50,exitPrice:null,
    quantity:1,contracts:1,quantoMultiplier:1,notional:50,leverage:5,margin:10,plannedRisk:1,stopPrice:49,armPrice:51,
    favorable:0,adverse:0,lastPrice:50,lastQuoteAt:T,entryFee:.025,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,
    exitReason:null,relationFailureBars:0,lastRelationBar:T,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    rule:{id:'src',signature:'x',parentId:null,version:1,createdAt:T,expiresAt:T+1,status:'EXPERIMENTAL',conditions:[],side:'LONG',horizon:30,
      stopRate:.01,armRate:.01,givebackRate:.01,exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,
      priorResponse:null,recentResponse:0,standardError:0,reason:'x',mutation:'CREATE',grammar:'x',liveEligible:false}} as Trade;
  applyInverseSourceTrade(next,source,quote(50,50.01),T);
  assert.equal(next.positions.length,0);
});
