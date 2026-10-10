import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote} from '../lib/forward-relations.ts';
import {applyLsrBook} from '../lib/lsr-book.ts';
import {freshLsrLedger} from '../lib/shadow-inverse.ts';
import {newInverseTrial} from '../lib/shadow-inverse-ledger.ts';

const end=Math.floor(1_791_500_000/900)*900-900;
const T=(end+900)*1000+1_000;
const contract={quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1,volume24hUsd:5_000_000};
function quote(bid:number,ask:number,at:number,imbalance=0):Quote{
  return {bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,sourceCount:2,disagreementRate:0,bookImbalance:imbalance};
}
function dump():Candle[]{
  const start=end-21*900,bars:Candle[]=[];
  for(let i=0;i<22;i++){
    const flat=100*(1+(i%2?.0002:-.0001));
    for(let k=0;k<3;k++){
      const time=start+i*900+k*300,last=i===21&&k===2,mid=i===21&&k===1;
      const open=i===21?(k===0?100:k===1?99.8:99.6):flat;
      const close=last?97:mid?99.6:i===21?99.8:flat;
      bars.push({time,open,high:Math.max(open,close)+.01,low:Math.min(open,close)-.01,close,volume:last?80:1});
    }
  }
  return bars;
}
function book(){
  const s=initialForward(T-60_000);
  s.inverseTrial=newInverseTrial(s,T-60_000,1000);
  s.inverseTrial.paperPolicy='lsr-v1';
  s.balance=1000;
  return s;
}
const bids=[100,99.6,99.3,99.95];
test('a strong sweep rests a maker and fills only when the next scan trades through it',()=>{
  const s=book(),paths={ETH_USDT:dump()};
  let placed=0;
  for(let i=0;i<bids.length;i++){
    const at=T+i*2_000;
    applyLsrBook(s,paths,{ETH_USDT:quote(bids[i]!,bids[i]!+.02,at,i===3?.5:0)},{ETH_USDT:contract},at);
    placed=s.inverseTrial?.lsrWork?.length??0;
  }
  assert.equal(s.positions.length,0);
  assert.equal(placed,1);
  const limit=s.inverseTrial!.lsrWork![0]!.price;
  assert.equal(limit,99.95);
  const at=T+8_000;
  applyLsrBook(s,paths,{ETH_USDT:quote(99.9,99.92,at,.5)},{ETH_USDT:contract},at);
  const t=s.positions[0];
  assert.equal(t?.side,'LONG');
  assert.ok(s.inverseTrial?.lsrLog?.some(event=>event.cat==='EXEC'&&event.event==='order_filled'));
  assert.ok(s.inverseTrial?.lsrLog?.some(event=>event.cat==='STRAT'&&event.event==='scan_done'));
  assert.ok((s.inverseTrial?.lsrFunnel?.signals??0)>0);
  assert.equal(t?.entryPrice,limit);
  assert.ok(t&&t.notional>350&&t.notional<=500,`notional ${t?.notional}`);
  assert.ok(Math.abs(t!.stopPrice/t!.entryPrice-.998)<1e-9);
  assert.equal(s.inverseTrial?.lsrWork?.length??0,0);
  applyLsrBook(s,paths,{ETH_USDT:quote(limit*1.004,limit*1.0042,at+2_000)},{ETH_USDT:contract},at+2_000);
  assert.equal(s.history[0]?.exitReason,'LSR_TP_EXIT');
});
test('an untouched maker is cancelled on the next scan, and a new book starts at 1000',()=>{
  const s=book(),paths={ETH_USDT:dump()};
  for(let i=0;i<bids.length;i++){
    const at=T+i*2_000;
    applyLsrBook(s,paths,{ETH_USDT:quote(bids[i]!,bids[i]!+.02,at,i===3?.5:0)},{ETH_USDT:contract},at);
  }
  applyLsrBook(s,paths,{ETH_USDT:quote(100.2,100.22,T+8_000,.5)},{ETH_USDT:contract},T+8_000);
  assert.equal(s.positions.length,0);
  assert.notEqual(s.inverseTrial?.lsrWork?.[0]?.price,99.95);
  const next=freshLsrLedger(s,T);
  assert.equal(next.balance,1000);
  assert.equal(next.inverseTrial?.paperPolicy,'lsr-v1');
});
