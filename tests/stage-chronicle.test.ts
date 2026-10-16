import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {advanceStageChronicle,initialStageChronicle,stageStamp} from "../lib/stage-chronicle.ts";
import {SHOCK_EPISODE_SETTLE_MS,advanceShockEpisode,initialShockEpisode} from "../lib/shock-episode.ts";

test("a stage change records the previous stage and resets the age",()=>{
  const start=advanceStageChronicle(initialStageChronicle(0),"TRANSITION",0.4,false,0);
  const later=advanceStageChronicle(start,"TRANSITION",0.4,false,10*60_000);
  assert.equal(later.previousStage,null);
  assert.equal(stageStamp(later,0.4,10*60_000).stageAgeMin,10);
  const shock=advanceStageChronicle(later,"SHOCK",0.8,true,12*60_000);
  const stamp=stageStamp(shock,0.8,13*60_000);
  assert.equal(stamp.liveStage,"SHOCK");
  assert.equal(stamp.priorStage,"TRANSITION");
  assert.equal(stamp.stageAgeMin,1);
  assert.equal(stamp.minutesSinceShock,null);
  assert.equal(stamp.shockPush,1);
  assert.equal(stamp.syncDrop,0);
});

test("leaving shock starts the clock, and a second shock in the same round counts as the next push",()=>{
  let episode=advanceShockEpisode(initialShockEpisode(),"SHOCK",0);
  let row=advanceStageChronicle(initialStageChronicle(0),"SHOCK",0.9,episode.active,0);
  episode=advanceShockEpisode(episode,"TREND",5*60_000);
  row=advanceStageChronicle(row,"TREND",0.7,episode.active,5*60_000);
  const left=stageStamp(row,0.7,8*60_000);
  assert.equal(left.priorStage,"SHOCK");
  assert.equal(left.minutesSinceShock,3);
  assert.equal(left.shockPush,1);
  assert.equal(left.syncDrop,0.2);
  episode=advanceShockEpisode(episode,"SHOCK",9*60_000);
  row=advanceStageChronicle(row,"SHOCK",0.85,episode.active,9*60_000);
  assert.equal(stageStamp(row,0.85,9*60_000).shockPush,2);
  assert.equal(stageStamp(row,0.5,9*60_000).syncDrop,0.4);
});

test("a settled round clears the push and the synchrony drop",()=>{
  let episode=advanceShockEpisode(initialShockEpisode(),"SHOCK",0);
  let row=advanceStageChronicle(initialStageChronicle(0),"SHOCK",0.8,episode.active,0);
  episode=advanceShockEpisode(episode,"TRANSITION",10_000);
  row=advanceStageChronicle(row,"TRANSITION",0.4,episode.active,10_000);
  const doneAt=10_000+SHOCK_EPISODE_SETTLE_MS;
  episode=advanceShockEpisode(episode,"TRANSITION",doneAt);
  row=advanceStageChronicle(row,"TRANSITION",0.3,episode.active,doneAt);
  const stamp=stageStamp(row,0.3,doneAt);
  assert.equal(episode.active,false);
  assert.equal(stamp.shockPush,0);
  assert.equal(stamp.syncDrop,null);
  assert.equal(stamp.priorStage,"SHOCK");
  assert.ok((stamp.minutesSinceShock??0)>0);
});

test("the chronicle is recorded on the fill and is not an entry or exit input",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.match(advance,/advanceStageChronicle\(/);
  const open=core.slice(core.indexOf("function openIntelligenceTrade"),core.indexOf("export function extremeResidualConfirmationProfile"));
  assert.match(open,/stageNote:stageStamp\(/);
  const entries=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  assert.equal(entries.includes("stageNote"),false);
  assert.equal(entries.includes("stageChronicle"),false);
  const manage=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function markAndManage"));
  assert.equal(manage.includes("stageNote"),false);
  assert.match(core,/next\.stageChronicle=structuredClone\(prior\.stageChronicle\)/);
});
