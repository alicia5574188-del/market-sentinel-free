import test from 'node:test';
import assert from 'node:assert/strict';
import type {ForwardState,Trade} from '../lib/forward-relations.ts';
import type {InverseFill} from '../lib/shadow-inverse-ledger.ts';
import {pairedPaidView,inversePaidFeeView,tradePaidNetPnl,remainingPaidNetPnl,PAID_FEE_VIEW_VERSION} from '../lib/paid-fee-view.ts';
import {INVERSE_FEE_POLICY} from '../lib/inverse-fee.ts';

const now=1_790_830_000_000,fee=.0007;
const near=(a:number|null|undefined,b:number)=>{assert.equal(typeof a,'number');assert.ok(Math.abs(a!-b)<1e-8,`${a} != ${b}`);};
function pair(sourceSide:'LONG'|'SHORT'='LONG'){
  const fill:InverseFill={sequence:0,kind:'OPEN',sourceAt:now-60000,appliedAt:now-60000,sourceQuoteAt:now-60000,quoteAt:now-60000,
    sourcePrice:100,price:100,quantity:10,contracts:10,sourceGross:0,gross:0,sourceFee:.7,fee:.7,sourceFunding:0,funding:0,spreadDrag:0};
  const inverse={id:'iv-source',symbol:'TEST_USDT',side:sourceSide==='LONG'?'SHORT':'LONG',status:'OPEN',quantity:10,contracts:10,
    entryPrice:100,notional:1000,entryFee:.7,lastPrice:110,lastQuoteAt:now,openedAt:now-60000,closedAt:null,
    inverseCopy:{sourceId:'source',sourceSide,sourceEntryPrice:100,fills:[fill]}} as Trade;
  const source={id:'source',symbol:'TEST_USDT',side:sourceSide,status:'OPEN',quantity:10,contracts:10,entryPrice:100,lastPrice:110,lastQuoteAt:now} as Trade;
  return{inverse,source};
}
function exit(t:Trade,kind:'REDUCE'|'CLOSE',quantity:number,price:number){
  const i=t.inverseCopy!,sg=(i.sourceSide==='LONG'?1:-1)*quantity*(price-i.sourceEntryPrice);
  const f:InverseFill={sequence:i.fills.length,kind,sourceAt:now,appliedAt:now,sourceQuoteAt:now,quoteAt:now,
    sourcePrice:price,price,quantity,contracts:quantity,sourceGross:sg,gross:-sg,sourceFee:quantity*price*fee,fee:quantity*price*fee,
    sourceFunding:.001,funding:0,spreadDrag:0};
  i.fills.push(f);if(kind==='CLOSE'){t.status='CLOSED';t.closedAt=now;t.netPnl=i.fills.reduce((n,r)=>n+r.gross-r.fee,0);t.quantity=10;}
  else t.quantity-=quantity;return f;
}
function state(t:Trade){
  const fs=t.inverseCopy!.fills,add=(key:keyof InverseFill)=>fs.reduce((n,f)=>n+Number(f[key]),0);
  return{positions:t.status==='OPEN'?[t]:[],history:t.status==='CLOSED'?[t]:[],inverseTrial:{source:{positions:t.status==='OPEN'?[{...pair(t.inverseCopy!.sourceSide).source,lastPrice:110,lastQuoteAt:now}]:[]},
    totals:{sourceGross:add('sourceGross'),gross:add('gross'),sourceFees:add('sourceFee'),fees:add('fee'),sourceFunding:add('sourceFunding'),
      funding:0,spreadDrag:0,opened:1,closed:t.status==='CLOSED'?1:0,reductions:0}}} as unknown as ForwardState;
}

for(const side of ['LONG','SHORT'] as const)test(side+' open pair is exact gross mirror and only entry fees break net symmetry',()=>{
  const {inverse,source}=pair(side),r=pairedPaidView(inverse,undefined,now,source)!;
  assert.equal(r.version,PAID_FEE_VIEW_VERSION);near(r.source.entryPrice,100);near(r.inverse.entryPrice,100);
  near(r.source.grossPnl,side==='LONG'?100:-100);near(r.inverse.grossPnl,side==='LONG'?-100:100);
  near(r.grossMirrorResidual,0);near(r.source.fees,.7);near(r.inverse.fees,.7);
  near(r.source.netPnl,(side==='LONG'?100:-100)-.7);near(r.inverse.netPnl,(side==='LONG'?-100:100)-.7);
  near(r.netSum,-1.4);near(r.paidFees,1.4);assert.equal(r.exitFills,0);
});

test('partial exit uses the exact same source price and recognizes only filled fees',()=>{
  const {inverse,source}=pair();exit(inverse,'REDUCE',4,108);source.quantity=6;source.lastPrice=110;
  const r=pairedPaidView(inverse,undefined,now,source)!;
  near(r.source.realizedGross,32);near(r.inverse.realizedGross,-32);near(r.source.floatingGross,60);near(r.inverse.floatingGross,-60);
  near(r.source.exitFees,4*108*fee);near(r.inverse.exitFees,4*108*fee);near(r.grossMirrorResidual,0);
  near(r.netSum,-2*(.7+4*108*fee));assert.equal(r.exitFills,1);assert.equal(r.remainingQuantity,6);
});

test('closed pair remains exact mirror even though source receipt may retain its own funding audit field',()=>{
  const {inverse}=pair();exit(inverse,'CLOSE',10,109.9);const r=pairedPaidView(inverse)!;
  near(r.source.grossPnl,99);near(r.inverse.grossPnl,-99);near(r.grossMirrorResidual,0);
  near(r.source.fees,.7+10*109.9*fee);near(r.inverse.fees,r.source.fees);near(r.netSum,-r.paidFees);
  near(r.source.netPnl!+r.inverse.netPnl!,-r.paidFees);assert.equal(r.remainingQuantity,0);
});

test('open pair needs the shadow mark; it never invents a second market price',()=>{
  const {inverse}=pair(),r=pairedPaidView(inverse,undefined,now,undefined)!;
  assert.equal(r.source.price,null);assert.equal(r.inverse.price,null);assert.equal(r.source.netPnl,null);assert.equal(r.inverse.netPnl,null);
  assert.equal(r.quoteFresh,false);assert.equal(r.grossMirrorResidual,null);
});

test('aggregate exact mirror has zero gross residual and net sum equals negative paid fees',()=>{
  const {inverse,source}=pair(),s=state(inverse);s.inverseTrial!.source.positions=[source] as Trade[];
  const r=inversePaidFeeView(s,{},now)!;near(r.source.grossPnl,100);near(r.inverse.grossPnl,-100);
  near(r.reconciliation.grossMirrorResidual,0);near(r.reconciliation.netSum,-r.reconciliation.paidFees);
  assert.equal(r.estimatedExitFees.includedInNet,false);
});

test('new 5bp inverse fee is independent of the frozen 7bp source in pair and aggregate net',()=>{
  const {inverse,source}=pair(),first=inverse.inverseCopy!.fills[0]!;
  first.fee=.5;first.feeRate=.0005;first.feePolicy=INVERSE_FEE_POLICY;inverse.entryFee=.5;
  const row=pairedPaidView(inverse,undefined,now,source)!;near(row.source.fees,.7);near(row.inverse.fees,.5);
  near(row.paidFees,1.2);near(row.netSum,-1.2);near(row.inverse.netPnl,tradePaidNetPnl(inverse));
  near(row.inverse.estimatedExitFee,.55);near(row.source.estimatedExitFee,.77);
  const aggregate=inversePaidFeeView(state(inverse),{},now)!;near(aggregate.inverse.fees,.5);
  near(aggregate.source.fees,.7);near(aggregate.reconciliation.paidFees,1.2);near(aggregate.reconciliation.netSum,-1.2);
});
test('old 7bp entry remains booked while the current future exit estimate is 5bp',()=>{
  const {inverse,source}=pair(),row=pairedPaidView(inverse,undefined,now,source)!;
  near(row.inverse.entryFees,.7);near(row.inverse.estimatedExitFee,.55);near(row.inverse.netPnl,-100.7);
  const f=exit(inverse,'CLOSE',10,109.9);f.fee=10*109.9*.0005;f.feeRate=.0005;f.feePolicy=INVERSE_FEE_POLICY;
  inverse.netPnl=inverse.inverseCopy!.fills.reduce((n,f)=>n+f.gross-f.fee,0);
  const closed=pairedPaidView(inverse)!,summary=inversePaidFeeView(state(inverse),{},now)!;
  near(closed.inverse.fees,.7+10*109.9*.0005);near(closed.source.fees,.7+10*109.9*.0007);
  near(closed.inverse.netPnl,inverse.netPnl);near(summary.inverse.netPnl,inverse.netPnl);
  near(closed.netSum,-closed.paidFees);near(summary.reconciliation.netSum,-summary.reconciliation.paidFees);
});
test('generic non-paired display still respects already-booked partial funding while excluding future exit fee',()=>{
  const t={status:'OPEN',side:'LONG',quantity:6,entryPrice:100,lastPrice:110,entryFee:.7,
    realization:{initialQuantity:10,gross:32,fees:.3024,funding:.01}} as Trade;
  near(remainingPaidNetPnl(t),59.58);near(tradePaidNetPnl(t),90.9876);near(tradePaidNetPnl({...t,status:'CLOSED',netPnl:90}),90);
});
