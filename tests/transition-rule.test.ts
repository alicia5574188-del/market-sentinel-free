import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {settledTransitionEntry,transitionEntryDecision,transitionExitReason} from "../lib/transition-rule.ts";
import type {EntryStructure,ZoneNote} from "../lib/entry-structure.ts";

const zone=(place:ZoneNote["place"],distancePct:number):ZoneNote=>({place,center:1,lower:1,upper:1,distancePct,touches:1});
function structure(partial:Partial<EntryStructure>):EntryStructure{
  return {entry:1,support:null,resistance:null,pivotInside:null,volumeBelow:null,volumeAbove:null,volumeInside:null,topBookImbalance:null,...partial};
}

test("transition fades when the level in front is closer than 1.5 percent",()=>{
  const long=transitionEntryDecision(structure({resistance:zone("上方",0.9)}),"LONG");
  assert.equal(long.action,"ENTER");
  if(long.action!=="ENTER")return;
  assert.equal(long.entry.side,"SHORT");
  assert.equal(long.entry.fade,true);
  assert.equal(long.entry.stopRate,0.015);
  assert.equal(long.entry.holdMin,45);
  const short=transitionEntryDecision(structure({support:zone("下方",1.4)}),"SHORT");
  assert.equal(short.action,"ENTER");
  if(short.action!=="ENTER")return;
  assert.equal(short.entry.side,"LONG");
});

test("transition follows the move when the level in front is at least 1.5 percent",()=>{
  const decided=transitionEntryDecision(structure({resistance:zone("上方",1.5)}),"LONG");
  assert.equal(decided.action,"ENTER");
  if(decided.action!=="ENTER")return;
  assert.equal(decided.entry.side,"LONG");
  assert.equal(decided.entry.fade,false);
  assert.equal(decided.entry.stopRate,0.008);
  assert.equal(decided.entry.holdMin,60);
});

test("transition skips when the level in front cannot be measured",()=>{
  assert.equal(transitionEntryDecision(structure({}),"LONG").action,"SKIP");
  assert.equal(transitionEntryDecision(structure({support:zone("下方",0.2)}),"LONG").action,"SKIP");
});

test("settled transition fades short only on the narrow long setup",()=>{
  const zone=(distancePct:number,touches=1)=>({place:"上方" as const,center:1,lower:1,upper:1,distancePct,touches});
  const yes=settledTransitionEntry(structure({resistance:zone(0.5,1)}),"LONG",0.005);
  assert.equal(yes.side,"SHORT");
  assert.equal(yes.fade,true);
  assert.equal(yes.stopRate,0.015);
  assert.equal(yes.holdMin,45);
  assert.equal(yes.touches,1);
  assert.equal(yes.expectancy,0.005);
  const edges=[
    settledTransitionEntry(structure({resistance:zone(0.29,1)}),"LONG",0.005),
    settledTransitionEntry(structure({resistance:zone(0.8,1)}),"LONG",0.005),
    settledTransitionEntry(structure({resistance:zone(0.5,2)}),"LONG",0.005),
    settledTransitionEntry(structure({resistance:zone(0.5,1)}),"LONG",0.0039),
    settledTransitionEntry(structure({resistance:zone(0.5,1)}),"LONG",0.008),
    settledTransitionEntry(structure({support:{place:"下方",center:1,lower:1,upper:1,distancePct:0.4,touches:1}}),"SHORT",0.005),
    settledTransitionEntry(structure({}),"LONG",0.005),
  ];
  for(const row of edges){
    assert.equal(row.fade,false);
    assert.equal(row.stopRate,0.008);
    assert.equal(row.holdMin,60);
  }
  assert.equal(edges[5]!.side,"SHORT");
  assert.equal(edges[6]!.side,"LONG");
});

test("transition exit is only the stop or the time, never an expectancy target",()=>{
  assert.equal(transitionExitReason({signedRate:-0.015,ageMin:1,stopRate:0.015,holdMin:45}),"TRANSITION_STOP");
  assert.equal(transitionExitReason({signedRate:0.02,ageMin:45,stopRate:0.008,holdMin:45}),"TRANSITION_TIME");
  assert.equal(transitionExitReason({signedRate:0.03,ageMin:10,stopRate:0.015,holdMin:45}),null);
  const winner=readFileSync(new URL("../lib/winner-policy.ts",import.meta.url),"utf8");
  assert.equal(winner.includes("EXPECTANCY_EXIT"),false);
});

test("live entries no longer use the transition or shock-room rules",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const advance=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  assert.match(advance,/只有同步爆发或趋势才开新单，这笔只留档/);
  assert.match(advance,/openIntelligenceTrade\([\s\S]*?true\)/);
  assert.doesNotMatch(advance,/settledTransitionEntry/);
  assert.doesNotMatch(advance,/transitionEntryDecision/);
  assert.doesNotMatch(advance,/ruleMode==="transition"/);
  assert.doesNotMatch(advance,/ruleMode==="shock-room"/);
  const manage=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function markAndManage"));
  const transitionAt=manage.indexOf("transitionRule");
  const winnerAt=manage.indexOf("manageWinnerTrade");
  assert.ok(transitionAt>=0&&winnerAt>transitionAt);
  assert.equal(manage.includes("EXPECTANCY_EXIT"),false);
  assert.equal(manage.includes("shockRoom"),false);
});
