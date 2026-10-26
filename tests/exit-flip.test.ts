import {test} from "node:test";
import assert from "node:assert/strict";
import {flipExits,reverseTradeNet} from "../lib/dynamic/exit-flip.ts";

test("the other side keeps the original stop distance and the original target distance",()=>{
  const x=flipExits("LONG",100,90,130);
  assert.deepEqual(x,{side:"SHORT",stop:110,target:70});
});

test("no target stays a stop only — a target is not invented",()=>{
  const x=flipExits("SHORT",100,108,null);
  assert.deepEqual(x,{side:"LONG",stop:92,target:null});
});

test("a stop that is not a real price is not sent",()=>{
  assert.equal(flipExits("LONG",100,0,110),null);
  assert.equal(flipExits("LONG",100,100,110),null);
});

test("a long that was held down to its stop pays that distance on the short",()=>{
  const net=reverseTradeNet({side:"LONG",entry:0.07308,exit:0.05956,stopDistPct:18.1445,notional:496.944,fee:0.7,gross:-92,bars:[[0.07,0.076],[0.055,0.06]]});
  assert.ok(Math.abs(net-89.5)<1,String(net));
});