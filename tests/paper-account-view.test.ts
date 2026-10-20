import test from "node:test";
import assert from "node:assert/strict";
import {paperAccountView,accountFloating} from "../lib/paper-account-view.ts";
import {tradePaidNetPnl} from "../lib/paid-fee-view.ts";

const trade=(id:string,symbol:string,side:"LONG"|"SHORT",entry:number,last:number,qty:number,fee:number,extra:Record<string,unknown>={})=>
  ({id,symbol,side,status:"OPEN",entryPrice:entry,lastPrice:last,quantity:qty,entryFee:fee,margin:100,...extra}) as never;
// Reverse-experiment desk with no paired trades (the production state since the living layer took over entries).
const deadReverseDesk={book:"reverse-v1",floating:0,openCount:0,open:[],equity:1000,initialEquity:1000,netPnl:0} as never;

test("大脑 tile: living trades not held by the old reverse desk use the account's own floating, not +0.00", () => {
  const positions=[trade("a","ONDO_USDT","LONG",1,0.9995,2000,0.33),trade("b","ZRO_USDT","SHORT",2,2.004,600,1.86),trade("c","X_USDT","LONG",5,5,10,0.02)];
  const view=paperAccountView(deadReverseDesk,positions,false);
  assert.equal(view.usingDesk,false);
  assert.equal(view.openCount,3);
  const cards=positions.reduce((n,t)=>n+tradePaidNetPnl(t),0);
  assert.ok(Math.abs((view.floating??NaN)-cards)<1e-9,`tile ${view.floating} equals sum of cards ${cards}`);
  assert.ok((view.floating??0)<-3);
});

test("own decision book that holds every open position still drives the page", () => {
  const positions=[trade("a","ONDO_USDT","LONG",1,1.01,100,0.05)];
  const desk={book:"read-v1",floating:0.95,openCount:1,open:[{id:"a"}]} as never;
  assert.deepEqual(paperAccountView(desk,positions,false),{usingDesk:true,floating:0.95,openCount:1});
  // …but not when the living layer holds a position the desk does not know about
  const more=[...positions,trade("b","ZRO_USDT","SHORT",2,2,10,0.01)];
  const v=paperAccountView(desk,more,false);
  assert.equal(v.usingDesk,false);assert.equal(v.openCount,2);
  // live mode never uses the desk
  assert.equal(paperAccountView(desk,positions,true).usingDesk,false);
});

test("reverse desk with paired open trades is still shown; flat account floats 0; unpriced positions give null", () => {
  const src=trade("s","BTC_USDT","LONG",100,101,1,0.05,{inverseCopy:{sourceId:"s"}});
  const desk={book:"reverse-v1",floating:-1,openCount:1,open:[{id:"s"}]} as never;
  assert.equal(paperAccountView(desk,[src],false).usingDesk,true);
  assert.equal(accountFloating([]),0);
  assert.equal(accountFloating([trade("n","N_USDT","LONG",1,Number.NaN,1,0)]),null);
});
