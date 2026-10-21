/**
 * 2026-10-21 user: only the living layer opens paper trades. The legacy stack never opens a new one, whatever the living
 * layer's state (off / record-only / automatic FALLBACK = no directive; new-source switch off = legacyGate "open";
 * living acting = legacyGate "note"). Its would-open signals stay in the run log as record-only (not-opened) rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runForward} from "./living/forward-sim.ts";
import {bj} from "./living/fixture.ts";
import {LEGACY_ENTRY_DISABLED_REASON} from "../lib/forward-relations.ts";
import type {LivingDirective} from "../lib/living/directive.ts";
import {allItems} from "../lib/living/config.ts";

const W={from:bj("10-19 05:20"),to:bj("10-19 07:28"),stepMs:6000};
const directive=(legacyGate:"note"|"open",newSource:boolean):LivingDirective=>({version:"living-v2",items:{...allItems(true),newSource},actions:[],orders:[],legacyGate});
const opened=(r:ReturnType<typeof runForward>)=>[...r.state.positions,...r.state.history].filter(t=>!t.unopened&&!t.inverseCopy);

test("control: the same replay window does open legacy trades when the replay-only switch is on",()=>{
  assert.ok(opened(runForward(W)).length>0,"window must contain legacy open signals");
});
const states:Array<[string,Record<string,unknown>]>=[
  ["living off / record-only / FALLBACK (no directive)",{}],
  ["new-source switch off (legacyGate open)",{living:directive("open",false)}],
  ["living acting (legacyGate note)",{living:directive("note",true)}],
];
for(const [name,extra] of states)test(`legacy stack cannot open a paper trade: ${name}`,()=>{
  const r=runForward({...W,extra:()=>({...extra,replayLegacyOpens:false})});
  assert.equal(opened(r).length,0,"no legacy trade may open");
  assert.equal(r.state.positions.length,0);
  if(!("living" in extra)||(extra.living as LivingDirective).legacyGate==="open"){
    // would-open signals are still recorded, as not-opened rows
    assert.ok((r.state.unopenedTrades??[]).some(t=>t.unopened),"would-open signals stay in the run log as record-only rows");
  }
});
test("production never sets the replay-only switch and the open path is guarded",()=>{
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.doesNotMatch(worker,/replayLegacyOpens/);
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  assert.match(core,/if\(!replayLegacyOpens\)\{\n\s+const noted=openIntelligenceTrade\([^;]*,true,gateNote\);\n\s+const why=LEGACY_ENTRY_DISABLED_REASON;/);
  assert.match(LEGACY_ENTRY_DISABLED_REASON,/只有研究层开单/);
});
