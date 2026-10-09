import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote} from '../lib/forward-relations.ts';
import {applyReadBook, readMarket, READ_POLICY} from '../lib/read-book.ts';
import {freshReadLedger} from '../lib/shadow-inverse.ts';
import {newInverseTrial} from '../lib/shadow-inverse-ledger.ts';

const T=1_800_000_000_000;
const contract={quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1,volume24hUsd:5_000_000};
const quote=(px:number,at=T+5_000):Quote=>({bestBid:px-0.01,bestAsk:px,observedAt:at,fresh:true});
function series(prices:number[],shift=0):Candle[]{
  const rows:Candle[]=[];
  for(let i=0;i<prices.length-1;i++){
    const time=T/1000-(prices.length-1-i)*300+shift,o=prices[i]!,c=prices[i+1]!;
    rows.push({time,open:o,high:Math.max(o,c),low:Math.min(o,c),close:c,volume:1});
  }
  return rows;
}
function flatThen(to:number){
  const px=Array(25).fill(100);
  for(let i=1;i<=24;i++)px.push(100+(to-100)*i/24);
  return series(px);
}
function book(){
  const s=initialForward(T-60_000);
  s.inverseTrial=newInverseTrial(s,T-60_000,1000);
  s.inverseTrial.paperPolicy=READ_POLICY;
  return s;
}
function continueMarket(at=T+5_000){
  const paths:Record<string,Candle[]>={},quotes:Record<string,Quote>={},contracts:Record<string,typeof contract>={};
  const add=(symbol:string,to:number)=>{paths[symbol]=flatThen(to);quotes[symbol]=quote(to,at);contracts[symbol]=contract;};
  for(let i=0;i<4;i++)add(`J${i}_USDT`,100.6);
  for(let i=0;i<5;i++)add(`M${i}_USDT`,101.2);
  for(let i=0;i<3;i++)add(`L${i}_USDT`,103);
  return {paths,quotes,contracts};
}

test('a fresh book reads the recent stretch and joins the move without chasing the leaders',()=>{
  const s=book();
  const {paths,quotes,contracts}=continueMarket();
  const view=readMarket(paths,contracts,T+5_000);
  assert.equal(view.call,'CONTINUE');
  assert.equal(view.side,'LONG');
  assert.ok(view.names.every(n=>n.symbol.startsWith('J')));
  assert.equal(view.names.some(n=>n.symbol.startsWith('L')),false);
  assert.equal(applyReadBook(s,paths,{},quotes,contracts,T+5_000),true);
  assert.equal(s.positions.length,4);
  assert.ok(s.positions.every(t=>t.side==='LONG'&&t.symbol.startsWith('J')&&t.liveEligible===false));
  assert.ok(Math.abs(tStop(s)-0.012)<1e-9);
  applyReadBook(s,paths,{},quotes,contracts,T+5_000);
  assert.equal(s.positions.length,4);
});

test('a small grind is not a wave',()=>{
  const s=book();
  const paths:Record<string,Candle[]>={},quotes:Record<string,Quote>={},contracts:Record<string,typeof contract>={};
  for(let i=0;i<12;i++){
    const symbol=`S${i}_USDT`;
    paths[symbol]=flatThen(100.2);quotes[symbol]=quote(100.2);contracts[symbol]=contract;
  }
  assert.notEqual(readMarket(paths,contracts,T+5_000).call,'CONTINUE');
  applyReadBook(s,paths,{},quotes,contracts,T+5_000);
  assert.equal(s.positions.length,0);
});

test('rotating inside the old range does not trade',()=>{
  const s=book();
  const paths:Record<string,Candle[]>={},quotes:Record<string,Quote>={},contracts:Record<string,typeof contract>={};
  const down=()=>{const px=[];for(let i=0;i<=24;i++)px.push(100+2*i/24);for(let i=1;i<=24;i++)px.push(102-2*i/24);return series(px);};
  const up=()=>{const px=Array(25).fill(100);for(let i=1;i<=24;i++)px.push(100+0.4*i/24);return series(px);};
  for(let i=0;i<3;i++){paths[`L${i}_USDT`]=down();quotes[`L${i}_USDT`]=quote(100);contracts[`L${i}_USDT`]=contract;}
  for(let i=0;i<3;i++){paths[`D${i}_USDT`]=up();quotes[`D${i}_USDT`]=quote(100.4);contracts[`D${i}_USDT`]=contract;}
  for(let i=0;i<6;i++){paths[`F${i}_USDT`]=series(Array(49).fill(100));quotes[`F${i}_USDT`]=quote(100);contracts[`F${i}_USDT`]=contract;}
  const view=readMarket(paths,contracts,T+5_000);
  assert.equal(view.call,'NONE');
  applyReadBook(s,paths,{},quotes,contracts,T+5_000);
  assert.equal(s.positions.length,0);
});

test('a spike that already came back is a single fade, not a market trade',()=>{
  const s=book();
  const paths:Record<string,Candle[]>={},quotes:Record<string,Quote>={},contracts:Record<string,typeof contract>={};
  const spike=()=>{const px=Array(25).fill(100);for(let i=1;i<=24;i++)px.push(i<=12?100+2*i/12:102-(1.7*(i-12)/12));return series(px);};
  paths.SPIKE_USDT=spike();quotes.SPIKE_USDT=quote(100.3);contracts.SPIKE_USDT=contract;
  for(let i=0;i<11;i++){paths[`F${i}_USDT`]=series(Array(49).fill(100));quotes[`F${i}_USDT`]=quote(100);contracts[`F${i}_USDT`]=contract;}
  const view=readMarket(paths,contracts,T+5_000);
  assert.equal(view.call,'BACK');
  assert.deepEqual(view.names.map(n=>n.symbol),['SPIKE_USDT']);
  applyReadBook(s,paths,{},quotes,contracts,T+5_000);
  assert.equal(s.positions.length,1);
  assert.equal(s.positions[0]!.side,'SHORT');
});

test('a wide spread or a chased price is not filled',()=>{
  const s=book();
  const m=continueMarket();
  for(const q of Object.values(m.quotes)){q.bestBid=100;q.bestAsk=100.2;}
  applyReadBook(s,m.paths,{},m.quotes,m.contracts,T+5_000);
  assert.equal(s.positions.length,0);
  const chased=continueMarket();
  for(const q of Object.values(chased.quotes)){q.bestBid=104;q.bestAsk=104.01;}
  applyReadBook(s,chased.paths,{},chased.quotes,chased.contracts,T+5_000);
  assert.equal(s.positions.length,0);
});

test('the wave is held through a small fluctuation and closed when the reading ends',()=>{
  const s=book();
  const m=continueMarket();
  applyReadBook(s,m.paths,{},m.quotes,m.contracts,T+5_000);
  const later=T+5*60_000;
  for(const q of Object.values(m.quotes))q.observedAt=later;
  applyReadBook(s,m.paths,{},m.quotes,m.contracts,later);
  assert.equal(s.positions.length,4);
  assert.equal(s.resolved,0);
  const ended=T+600_000+5_000;
  const paths:Record<string,Candle[]>={};
  for(const [symbol,rows] of Object.entries(m.paths))paths[symbol]=rows.map(r=>({...r,time:r.time+600}));
  const flat=series(Array(49).fill(100),600);
  for(const symbol of Object.keys(paths))paths[symbol]=flat;
  for(const q of Object.values(m.quotes))q.observedAt=ended;
  applyReadBook(s,paths,{},m.quotes,m.contracts,ended);
  assert.equal(s.positions.length,0);
  assert.ok(s.history.every(t=>t.exitReason==='READ_THESIS_EXIT'));
  assert.equal(s.inverseTrial?.readNextAt,ended+60*60_000);
});

test('a 1.2% stop closes, and the same stretch is not immediately reopened',()=>{
  const s=book();
  const m=continueMarket();
  applyReadBook(s,m.paths,{},m.quotes,m.contracts,T+5_000);
  const t=s.positions[0]!;
  const at=T+70_000;
  const minute:Record<string,Candle[]>={};
  minute[t.symbol]=[{time:T/1000,open:t.entryPrice,high:t.entryPrice,low:t.stopPrice-0.01,close:t.stopPrice,volume:1}];
  m.quotes[t.symbol]=quote(t.stopPrice,at);
  applyReadBook(s,m.paths,minute,m.quotes,m.contracts,at);
  assert.equal(s.history.some(row=>row.id===t.id&&row.exitReason==='READ_STOP_EXIT'),true);
  applyReadBook(s,m.paths,{},m.quotes,m.contracts,at+5_000);
  assert.equal(s.positions.some(row=>row.symbol===t.symbol),false);
});

test('a large price loss with a small fee reverses the next wave, and a fee-sized result stops',()=>{
  const s=book();
  s.inverseTrial!.readGross=-40;s.inverseTrial!.readFee=3;s.inverseTrial!.readClosed=4;
  const m=continueMarket();
  applyReadBook(s,m.paths,{},m.quotes,m.contracts,T+5_000);
  assert.ok(s.positions.length>0);
  assert.ok(s.positions.every(t=>t.side==='SHORT'));
  const stopped=book();
  stopped.inverseTrial!.readGross=-1;stopped.inverseTrial!.readFee=2;stopped.inverseTrial!.readClosed=4;
  applyReadBook(stopped,m.paths,{},m.quotes,m.contracts,T+5_000);
  assert.equal(stopped.positions.length,0);
  assert.match(stopped.inverseTrial?.readNote??'',/先停/);
});

test('reset starts a clean 1000U book on this reading',()=>{
  const prior=initialForward(T-86_400_000);
  prior.balance=880;prior.inverseTrial=newInverseTrial(prior,T-86_400_000,1000);
  prior.inverseTrial.paperPolicy='score-v1';
  const next=freshReadLedger(prior,T);
  assert.equal(next.balance,1000);
  assert.equal(next.inverseTrial?.paperPolicy,READ_POLICY);
  assert.equal(next.positions.length,0);
});

function tStop(s:ReturnType<typeof book>){
  const t=s.positions[0]!;
  return Math.abs(t.entryPrice-t.stopPrice)/t.entryPrice;
}
