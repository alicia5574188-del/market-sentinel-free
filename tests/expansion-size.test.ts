import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {EXPANSION_SIZE,expansionFor} from "../lib/forward-relations.ts";

test("size multiple per stage: shock 10x, trend 5x, everything else 1x; nothing uses 6x any more",()=>{
  assert.deepEqual(EXPANSION_SIZE,{SHOCK:10,TREND:5});
  assert.equal(expansionFor("SHOCK"),10);
  assert.equal(expansionFor("TREND"),5);
  for(const other of ["TRANSITION","ROTATION",null,undefined,""])assert.equal(expansionFor(other),1,String(other));
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  assert.doesNotMatch(core,/EXPANSION_SIZE=6/);
});

test("the multiple scales the same budgets as before (risk, headrooms, notional and margin caps); leverage is set separately",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const open=core.slice(core.indexOf("function openIntelligenceTrade"),core.indexOf("export function extremeResidualConfirmationProfile"));
  for(const re of [/TOTAL_RISK_RATE\*expansion/,/SIDE_RISK_RATE\*expansion/,/FIVE_MINUTE_NEW_RISK_RATE\*expansion/,/CONTINUATION_SIDE_RISK_RATE\*expansion/,
    /\.headroom\*expansion/,/environmentRiskScale\*expansion/,/equity\*\.70\*expansion/,/TOTAL_MARGIN_RATE\*expansion/])assert.match(open,re);
  assert.match(open,/leverage=safePaperLeverage\(/,"leverage comes from the liquidation-safe rule (tests/paper-leverage.test.ts), not from the size multiple");
});

test("sizing arithmetic at 1000U equity, 1.75% stop, normal risk rate 0.55%",()=>{
  const equity=1000,stop=.0175,cost=2*(.0007+.00025),risk=.0055;
  const size=(k:number)=>{const wanted=equity*risk*k,notional=Math.min(wanted/(stop+cost),equity*.70*k);return {wanted,notional};};
  const trend=size(expansionFor("TREND")),shock=size(expansionFor("SHOCK"));
  assert.ok(Math.abs(trend.wanted-27.5)<1e-9&&Math.abs(shock.wanted-55)<1e-9);
  assert.ok(trend.notional>1400&&trend.notional<1450,String(trend.notional));
  assert.ok(shock.notional>2800&&shock.notional<2900,String(shock.notional));
  // the notional cap (0.70 × equity × multiple) does not bind at a normal stop width
  assert.ok(shock.notional<equity*.70*10&&trend.notional<equity*.70*5);
});
