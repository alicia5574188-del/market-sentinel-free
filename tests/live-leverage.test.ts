/* eslint-disable @typescript-eslint/no-explicit-any -- isolated synthetic exchange and durable migration faults */
import test from 'node:test';
import assert from 'node:assert/strict';
import {adjustInverseLeverage} from '../lib/live-leverage.ts';
import {buildProportionalMirror} from '../lib/live-parity.ts';
const T=1790809800000;
function fixture(){
  const p:any={symbol:'AAA_USDT',side:'LONG',status:'OPEN',notional:100,exchangeSize:10,leverage:10,margin:10,exitRequestedAt:null,
    parity:{sourceRole:'INVERSE_PAPER',sourceLeverage:10,sourceId:'original',roundedContracts:10}};
  const actual={contract:'AAA_USDT',size:'10',leverage:'10',value:'100',margin:'10'};
  return {position:p,actual,available:20,now:T,enabled:true,sourceOpen:true,
    persist:async()=>{},setLeverage:async(symbol:string,target:number)=>{assert.equal(symbol,'AAA_USDT');assert.equal(target,5);
      actual.leverage='5';actual.margin='20';return structuredClone(actual);}};
}
test('existing isolated exposure halves leverage and doubles margin with identical contracts and notional',async()=>{
  const f=fixture(),before=structuredClone(f.position);let commits=0,posts=0;
  f.persist=async()=>{commits++;};const set=f.setLeverage;f.setLeverage=async(s,t)=>{posts++;assert.equal(commits,1);return set(s,t);};
  const result=await adjustInverseLeverage(f);assert.equal(result.confirmed,true);assert.equal(result.reservedMargin,10);
  assert.equal(f.position.leverage,5);assert.equal(f.position.margin,20);assert.equal(commits,2);assert.equal(posts,1);
  for(const key of ['symbol','side','notional','exchangeSize','status','exitRequestedAt'])assert.equal(f.position[key],before[key]);
  await adjustInverseLeverage({...f,now:T+100000});assert.equal(posts,1);assert.equal(f.position.parity.executionLeverage,5);
});
test('insufficient margin, cross mode, wrong side/size, OFF, pending source exit and legacy exposure never send',async()=>{
  for(const patch of [ {available:9}, {actual:{contract:'AAA_USDT',size:'10',leverage:'0'}},
    {actual:{contract:'AAA_USDT',size:'-10',leverage:'10'}}, {actual:{contract:'AAA_USDT',size:'11',leverage:'10'}},
    {enabled:false}, {sourceOpen:false} ]){
    const f:any={...fixture(),...patch};f.persist=async()=>{throw new Error('no commit');};f.setLeverage=async()=>{throw new Error('no POST');};
    const r=await adjustInverseLeverage(f);assert.equal(r.attempted,false);assert.equal(f.position.leverage,10);
  }
  const f=fixture();f.position.exitRequestedAt=T;assert.equal((await adjustInverseLeverage(f)).attempted,false);
  f.position.exitRequestedAt=null;delete f.position.parity.sourceRole;assert.equal((await adjustInverseLeverage(f)).attempted,false);
});
test('unknown response survives restart; next native snapshot confirms once without repeated halving',async()=>{
  const f:any=fixture();let posts=0;f.setLeverage=async()=>{posts++;throw new Error('unknown transport result');};
  const r=await adjustInverseLeverage(f);assert.equal(r.attempted,true);assert.equal(r.reservedMargin,10);
  assert.equal(f.position.leverage,10);assert.match(f.position.parity.leverageAdjustError,/unknown/);
  await adjustInverseLeverage({...f,position:structuredClone(f.position),now:T+1000});assert.equal(posts,1);
  const restored=structuredClone(f.position);const verified={...f.actual,leverage:'5',margin:'20'};
  await adjustInverseLeverage({...f,position:restored,actual:verified,now:T+100000});assert.equal(posts,1);
  assert.equal(restored.parity.executionLeverage,5);assert.equal(restored.parity.leverageAdjustError,null);
});
test('durable reserve failure and OFF/source-close during reserve prevent the exchange mutation',async()=>{
  const f:any=fixture();let posts=0;f.setLeverage=async()=>{posts++;};f.persist=async()=>{throw new Error('storage failed');};
  await assert.rejects(()=>adjustInverseLeverage(f),/storage failed/);assert.equal(posts,0);
  const g:any=fixture();g.persist=async()=>{};g.stillAllowed=()=>false;g.setLeverage=f.setLeverage;
  assert.equal((await adjustInverseLeverage(g)).attempted,false);assert.equal(posts,0);
});
test('unconfirmed/mismatched response never fabricates an adjusted native leverage or doubles again',async()=>{
  const f:any=fixture();let posts=0;f.setLeverage=async()=>{posts++;return {...f.actual,size:'0',leverage:'5'};};
  const r=await adjustInverseLeverage(f);assert.equal(r.confirmed,false);assert.equal(f.position.leverage,10);
  await adjustInverseLeverage({...f,now:T+10000});assert.equal(posts,1);
});
test('half leverage uses the same quantized notional and reserves the doubled minimum-lot margin',()=>{
  const source:any={id:'i',symbol:'AAA_USDT',side:'SHORT',status:'OPEN',openedAt:T,entryPrice:100,notional:1000,contracts:100,
    quantity:10,quantoMultiplier:.1,leverage:10,margin:100,plannedRisk:22,stopPrice:98,armPrice:105,lastQuoteAt:T,
    rule:{id:'r',horizon:180,side:'SHORT',stopRate:.02,exitMode:'REACTION_DECAY',givebackRate:.01},
    inverseCopy:{sourceId:'s',sourceSide:'LONG',sourceEntryPrice:100},execution:'REAL_QUOTE_PAPER_MODEL'};
  const input={source,sourceEquity:1000,equity:100,available:25,entryPrice:100,quantoMultiplier:.1,leverageMax:5,maintenanceRate:.005,
    openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,now:T+100,policy:'inverse',sourceRiskAuthority:true,
    sizeRules:{enableDecimal:false,orderSizeMin:'1'}};
  const before=structuredClone(source),r=buildProportionalMirror(input);assert.deepEqual(source,before);
  assert.equal(r.intent.contracts,10);assert.equal(r.intent.notional,100);assert.equal(r.intent.margin,20);assert.equal(r.intent.leverage,5);
  assert.equal(r.binding.receipt.targetMargin,20);assert.equal(r.binding.receipt.sourceMargin,100);
  assert.throws(()=>buildProportionalMirror({...input,available:15}),/可用保证金不足/);
  const min={...input,equity:1,available:1,source:{...source,notional:1000}};
  assert.throws(()=>buildProportionalMirror(min),/最低一张/);
});
