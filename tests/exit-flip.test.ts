import {test} from "node:test";
import assert from "node:assert/strict";
import {flipExits} from "../lib/dynamic/exit-flip.ts";

test("a long stop becomes the short target, and the old target distance becomes the short stop",()=>{
  const x=flipExits("LONG",100,90,110);
  assert.deepEqual(x,{side:"SHORT",stop:110,target:90});
});

test("no target uses the stop distance both ways",()=>{
  const x=flipExits("SHORT",100,108,null);
  assert.deepEqual(x,{side:"LONG",stop:92,target:108});
});

test("a stop that is not a real price is not sent",()=>{
  assert.equal(flipExits("LONG",100,0,110),null);
  assert.equal(flipExits("LONG",100,100,110),null);
});
