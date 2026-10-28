import test from "node:test";
import assert from "node:assert/strict";
import {paperAccountView,accountFloating} from "../lib/paper-account-view.ts";
import {tradePaidNetPnl} from "../lib/paid-fee-view.ts";

const trade=(id:string,symbol:string,side:"LONG"|"SHORT",entry:number,last:number,qty:number,fee:number,extra:Record<string,unknown>={})=>
  ({id,symbol,side,status:"OPEN",entryPrice:entry,lastPrice:last,quantity:qty,entryFee:fee,margin:100,...extra}) as never;

test("paper tile floating equals the sum of the position cards", () => {
  const positions=[trade("a","ONDO_USDT","LONG",1,0.9995,2000,0.33),trade("b","ZRO_USDT","SHORT",2,2.004,600,1.86),trade("c","X_USDT","LONG",5,5,10,0.02)];
  const view=paperAccountView(positions);
  assert.equal(view.openCount,3);
  const cards=positions.reduce((n,t)=>n+tradePaidNetPnl(t),0);
  assert.ok(Math.abs((view.floating??NaN)-cards)<1e-9,`tile ${view.floating} equals sum of cards ${cards}`);
  assert.ok((view.floating??0)<-3);
});

test("flat account floats 0; unpriced positions give null; mirrored inverse copies are not counted", () => {
  assert.equal(accountFloating([]),0);
  assert.equal(accountFloating([trade("n","N_USDT","LONG",1,Number.NaN,1,0)]),null);
  const src=trade("s","BTC_USDT","LONG",100,101,1,0.05,{inverseCopy:{sourceId:"s"}});
  assert.equal(paperAccountView([src]).openCount,0);
});
