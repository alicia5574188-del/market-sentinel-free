import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {ForwardState,Quote,Trade} from '../lib/forward-relations.ts';
import type {InverseFill} from '../lib/shadow-inverse-ledger.ts';
import {pairedPaidView,inversePaidFeeView,tradePaidNetPnl,remainingPaidNetPnl} from '../lib/paid-fee-view.ts';

const now=1_790_830_000_000,fee=.0007;
const near=(a:number|null|undefined,b:number)=>{assert.equal(typeof a,'number');assert.ok(Math.abs(a!-b)<1e-8,`${a} != ${b}`);};
function quote(bid=109.9,ask=110.1,at=now){return{bestBid:bid,bestAsk:ask,observedAt:at,fresh:true} as Quote;}
function pair(sourceSide:'LONG'|'SHORT'='LONG',spread=.2){
  const sourceEntry=sourceSide==='LONG'?100+spread/2:100-spread/2;
  const inverseEntry=sourceSide==='LONG'?100-spread/2:100+spread/2;
  const fill:InverseFill={sequence:0,kind:'OPEN',sourceAt:now-60000,appliedAt:now-60000,sourceQuoteAt:now-60000,quoteAt:now-60000,
    sourcePrice:sourceEntry,price:inverseEntry,quantity:10,contracts:10,sourceGross:0,gross:0,
    sourceFee:10*sourceEntry*fee,fee:10*inverseEntry*fee,sourceFunding:0,funding:0,spreadDrag:0};
  return{id:'iv-source',symbol:'TEST_USDT',side:sourceSide==='LONG'?'SHORT':'LONG',status:'OPEN',quantity:10,contracts:10,
    entryPrice:inverseEntry,notional:10*inverseEntry,entryFee:fill.fee,lastPrice:110,lastQuoteAt:now,openedAt:now-60000,closedAt:null,
    inverseCopy:{sourceId:'source',sourceSide,sourceEntryPrice:sourceEntry,fills:[fill]}} as Trade;
}
function exit(t:Trade,kind:'REDUCE'|'CLOSE',quantity:number,sp:number,ip:number){
  const i=t.inverseCopy!,sg=(i.sourceSide==='LONG'?1:-1)*quantity*(sp-i.sourceEntryPrice),g=(t.side==='LONG'?1:-1)*quantity*(ip-t.entryPrice);
  const f:InverseFill={sequence:i.fills.length,kind,sourceAt:now,appliedAt:now,sourceQuoteAt:now,quoteAt:now,
    sourcePrice:sp,price:ip,quantity,contracts:quantity,sourceGross:sg,gross:g,sourceFee:quantity*sp*fee,fee:quantity*ip*fee,
    sourceFunding:.001,funding:.001,spreadDrag:-(sg+g)};
  i.fills.push(f);
  if(kind==='CLOSE'){t.status='CLOSED';t.closedAt=now;t.netPnl=i.fills.reduce((n,r)=>n+r.gross-r.fee-r.funding,0);t.quantity=10;}
  else t.quantity-=quantity;
  return f;
}
function state(t:Trade){
  const fs=t.inverseCopy!.fills,add=(key:keyof InverseFill)=>fs.reduce((n,f)=>n+Number(f[key]),0);
  return{positions:t.status==='OPEN'?[t]:[],history:t.status==='CLOSED'?[t]:[],inverseTrial:{source:{positions:[]},totals:{
    sourceGross:add('sourceGross'),gross:add('gross'),sourceFees:add('sourceFee'),fees:add('fee'),sourceFunding:add('sourceFunding'),
    funding:add('funding'),spreadDrag:add('spreadDrag'),opened:1,closed:t.status==='CLOSED'?1:0,reductions:0}}} as unknown as ForwardState;
}
for(const side of ['LONG','SHORT'] as const){
  test(`${side}: open net deducts only paid entry fees, not projected exits`,()=>{
    const t=pair(side,0),r=pairedPaidView(t,quote(110,110),now)!;
    near(r.source.fees,.7);near(r.inverse.fees,.7);assert.equal(r.exitFills,0);
    near(r.source.netPnl,(side==='LONG'?100:-100)-.7);near(r.inverse.netPnl,(side==='LONG'?-100:100)-.7);
    near(r.source.estimatedExitFee,.77);near(r.netGap,1.4);near(r.grossGap,0);
    near(r.source.exitFees,0);near(r.inverse.exitFees,0);
  });
  test(`${side}: executable quote gap is separate from paid fees`,()=>{
    const t=pair(side),r=pairedPaidView(t,quote(),now)!;
    near(r.grossGap,4);near(r.paidFees,1.4);near(r.netGap,5.4);
    near(r.netGap,r.grossGap!+r.paidFees+r.bookedFunding);
  });
}
test('partial exit includes only filled quantity fee; losing inverse still displays actual booked amounts',()=>{
  const t=pair();exit(t,'REDUCE',4,108,108.2);const r=pairedPaidView(t,quote(),now)!;
  near(r.source.entryFees,.7007);near(r.inverse.entryFees,.6993);
  near(r.source.exitFees,4*108*fee);near(r.inverse.exitFees,4*108.2*fee);
  near(r.inverse.netPnl,-4*(108.2-99.9)-6*(110.1-99.9)-.6993-4*108.2*fee-.001);
  near(r.source.estimatedExitFee,6*109.9*fee);assert.equal(r.exitFills,1);assert.equal(r.remainingQuantity,6);
});
test('closed parent reconstructs both nets and fees from receipts without live source or quotes',()=>{
  const t=pair();exit(t,'REDUCE',4,108,108.2);exit(t,'CLOSE',6,109.9,110.1);
  const r=pairedPaidView(t)!;near(r.inverse.netPnl,t.netPnl!);near(r.source.floatingGross,0);near(r.inverse.floatingGross,0);
  near(r.source.fees,.7007+4*108*fee+6*109.9*fee);assert.equal(r.source.estimatedExitFee,0);
  assert.equal(r.remainingQuantity,0);assert.equal(r.exitFills,2);assert.equal(r.quoteFresh,true);
  near(r.netGap,r.paidFees+r.bookedFunding+r.grossGap!);
});
test('missing source marks stay unknown; no same-price synthetic source mark',()=>{
  const r=pairedPaidView(pair(),undefined,now)!;assert.equal(r.source.price,null);assert.equal(r.source.netPnl,null);
  assert.equal(r.quoteFresh,false);assert.equal(r.grossGap,null);assert.equal(r.netGap,null);near(r.source.fees,.7007);
});
for(const [name,q] of [['future',quote(110,111,now+1)],['stale',quote(110,111,now-10001)],['crossed',quote(111,110)],['NaN',quote(NaN,111)]] as const){
  test(`${name} quote cannot supply a fresh source estimate`,()=>{
    const r=pairedPaidView(pair(),q,now)!;assert.equal(r.quoteFresh,false);assert.equal(r.source.netPnl,null);
  });
}
test('aggregate includes archived realized outcomes exactly once, ignores unpaired legacy holdings',()=>{
  const t=pair(),s=state(t);s.positions.push({...t,id:'legacy',inverseCopy:undefined});
  s.inverseTrial!.totals.sourceGross=-20;s.inverseTrial!.totals.gross=18;
  s.inverseTrial!.totals.sourceFees+=1;s.inverseTrial!.totals.fees+=1;s.inverseTrial!.totals.spreadDrag=2;
  const before=JSON.stringify(s),r=inversePaidFeeView(s,{TEST_USDT:quote()},now)!;
  assert.equal(r.rows.length,1);near(r.source.netPnl,-20+98-1.7007);near(r.inverse.netPnl,18-102-1.6993);
  near(r.reconciliation.netGap,r.reconciliation.paidFees+r.reconciliation.bookedFunding+r.reconciliation.realizedGrossGap+r.reconciliation.openGrossGap!);
  assert.equal(r.estimatedExitFees.includedInNet,false);assert.equal(JSON.stringify(s),before);
});
test('all-closed summary retains paid totals without current positions',()=>{
  const t=pair();exit(t,'CLOSE',10,109.9,110.1);const r=inversePaidFeeView(state(t),{},now)!;
  assert.equal(r.rows.length,0);near(r.inverse.netPnl,t.netPnl!);near(r.estimatedExitFees.inverse,0);
});
test('ordinary and partial display do not change strategy cost functions or double-count original entry fee',()=>{
  const t={status:'OPEN',side:'LONG',quantity:6,entryPrice:100,lastPrice:110,entryFee:.7,
    realization:{initialQuantity:10,gross:32,fees:.3024,funding:.01}} as Trade;
  near(remainingPaidNetPnl(t),59.58);near(tradePaidNetPnl(t),90.9876);
  near(tradePaidNetPnl({...t,status:'CLOSED',netPnl:90}),90);
});
test('the durable inverse ledger changes only by its read-only summary projection',()=>{
  const text=readFileSync(new URL('../lib/shadow-inverse-ledger.ts',import.meta.url),'utf8')
    .replace("\nimport {inversePaidFeeView} from './paid-fee-view.ts';",'')
    .replace('return{paidCost:inversePaidFeeView(state,quotes,now),version:v.version','return{version:v.version');
  const bytes=Buffer.from(text),hash=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(hash,'a417aa5a8f4383b2e701bc7578f5752c1ba2f94e');
});
