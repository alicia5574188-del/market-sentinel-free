import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {advanceShockEpisode,entryRuleForEnvironment,initialShockEpisode,SHOCK_EPISODE_SETTLE_MS} from "../lib/shock-episode.ts";

test("a shock stamp starts one episode and a short return to transition does not end it",()=>{
  const shock=advanceShockEpisode(initialShockEpisode(),"SHOCK",1_000);
  assert.equal(shock.active,true);
  assert.equal(shock.startedAt,1_000);
  const trend=advanceShockEpisode(shock,"TREND",2_000);
  assert.equal(trend.active,true);
  assert.equal(trend.transitionSince,null);
  const blink=advanceShockEpisode(trend,"TRANSITION",3_000);
  assert.equal(blink.active,true);
  assert.equal(blink.transitionSince,3_000);
  const back=advanceShockEpisode(blink,"ROTATION",3_000+30_000);
  assert.equal(back.active,true);
  assert.equal(back.transitionSince,null);
  assert.equal(entryRuleForEnvironment("TREND",back),"shock-room");
  assert.equal(entryRuleForEnvironment("TRANSITION",back),"shock-room");
});

test("fifteen continuous minutes of transition ends the episode",()=>{
  const shock=advanceShockEpisode(initialShockEpisode(),"SHOCK",0);
  const started=advanceShockEpisode(shock,"TRANSITION",10_000);
  const still=advanceShockEpisode(started,"TRANSITION",10_000+SHOCK_EPISODE_SETTLE_MS-1);
  assert.equal(still.active,true);
  assert.equal(entryRuleForEnvironment("TRANSITION",still),"shock-room");
  const done=advanceShockEpisode(still,"TRANSITION",10_000+SHOCK_EPISODE_SETTLE_MS);
  assert.equal(done.active,false);
  assert.equal(entryRuleForEnvironment("TRANSITION",done),"transition");
  assert.equal(entryRuleForEnvironment("TREND",done),"original");
  assert.equal(entryRuleForEnvironment("ROTATION",initialShockEpisode()),"original");
});

test("another shock inside the settle window keeps the same episode",()=>{
  const shock=advanceShockEpisode(initialShockEpisode(),"SHOCK",5_000);
  const waiting=advanceShockEpisode(shock,"TRANSITION",20_000);
  const again=advanceShockEpisode(waiting,"SHOCK",30_000);
  assert.equal(again.active,true);
  assert.equal(again.startedAt,5_000);
  assert.equal(again.transitionSince,null);
});

test("the live entry path uses the episode and does not give those trades the transition exit",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.match(advance,/advanceShockEpisode\(/);
  const entries=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  assert.match(entries,/entryRuleForEnvironment/);
  assert.match(entries,/shockRoom=decided\.entry/);
  const open=core.slice(core.indexOf("function openIntelligenceTrade"),core.indexOf("export function extremeResidualConfirmationProfile"));
  assert.match(open,/shockRoom\.side!==o\.side/);
  assert.doesNotMatch(open,/transitionRule:shockRoom/);
  assert.match(core,/next\.shockEpisode=structuredClone\(prior\.shockEpisode\)/);
});
