/**
 * Isolation: with the living layer off (no directive) — and in compute-only, which also passes no directive — the forward
 * core must reproduce the a38882f4 decisions byte-for-byte on two recorded windows (golden pinned before any living code).
 * Also: an empty paper-enabled directive (no actions, no orders, legacy gate open) changes nothing either.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runForward} from "./living/forward-sim.ts";
import {bj} from "./living/fixture.ts";
import type {LivingDirective} from "../lib/living/directive.ts";
import {allItems} from "../lib/living/config.ts";

const golden=JSON.parse(readFileSync(new URL("./fixtures/living/golden-a38882f4.json",import.meta.url),"utf8")) as
  {commit:string;windows:{name:string;from:string;to:string;stepMs:number;final:string;digests:string[];positions:number;history:number;unopened:number}[]};

for(const w of golden.windows){
  test(`living off reproduces a38882f4: ${w.name}`,()=>{
    const r=runForward({from:bj(w.from),to:bj(w.to),stepMs:w.stepMs,digestEvery:10});
    assert.equal(r.digests.length,w.digests.length);
    r.digests.forEach((d,i)=>assert.equal(d,w.digests[i],`digest ${i} differs`));
    assert.equal(r.final,w.final);
    assert.equal(r.state.positions.length,w.positions);assert.equal(r.state.history.length,w.history);
    assert.equal((r.state.unopenedTrades??[]).length,w.unopened);
  });
}
test("empty paper-enabled directive (open legacy gate, no actions/orders) is also identical",()=>{
  const w=golden.windows[1]!;
  const living:LivingDirective={version:"living-v1",items:allItems(true),actions:[],orders:[],legacyGate:"open"};
  const from=bj(w.from),r=runForward({from,to:from+400*w.stepMs,stepMs:w.stepMs,digestEvery:10,extra:()=>({living})});
  assert.equal(r.digests.length,40);
  r.digests.forEach((d,i)=>assert.equal(d,w.digests[i],`digest ${i} differs`));
});
