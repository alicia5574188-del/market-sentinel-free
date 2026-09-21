import test from "node:test";
import assert from "node:assert/strict";
import { rankMultiTurnUniverse, type MultiTurnUniverseTicker } from "../lib/multi-turn-universe.ts";

const row=(symbol:string,change:number,range:number,volume=1_000_000):MultiTurnUniverseTicker=>{
  const last=100,low=100-range*50,high=100+range*50;
  return{symbol,last,low24h:low,high24h:high,change24hRate:change,volume24hUsd:volume,fundingRate:0,openInterest:1};
};

test("universe ranking favors high-volatility market amplifiers over high-volume quiet coins",()=>{
  const rows=[
    row("QUIET_USDT",.01,.015,5_000_000_000),
    row("BASE1_USDT",.04,.05),
    row("BASE2_USDT",.035,.045),
    row("AMP_USDT",.18,.24,50_000),
    row("IND_USDT",-.14,.22,40_000),
  ];
  const ranked=rankMultiTurnUniverse(rows,3);
  assert.ok(ranked.some(x=>x.symbol==="AMP_USDT"));
  assert.ok(ranked.some(x=>x.symbol==="IND_USDT"));
  assert.equal(ranked.some(x=>x.symbol==="QUIET_USDT"),false);
  assert.equal(ranked.find(x=>x.symbol==="AMP_USDT")?.class,"MARKET_AMPLIFIER");
  assert.equal(ranked.find(x=>x.symbol==="IND_USDT")?.class,"INDEPENDENT_VOLATILITY");
});

test("turnover is not a ranking input",()=>{
  const base=[row("A_USDT",.10,.18,1),row("B_USDT",.10,.18,9_000_000_000),row("C_USDT",.03,.04,5_000_000)];
  const ranked=rankMultiTurnUniverse(base,3);
  assert.equal(ranked.find(x=>x.symbol==="A_USDT")?.score,ranked.find(x=>x.symbol==="B_USDT")?.score);
});

test("quiet contracts can be omitted even if liquid",()=>{
  const ranked=rankMultiTurnUniverse([row("QUIET_USDT",.002,.01,10_000_000_000),row("MOVE_USDT",.08,.12,10_000)],30);
  assert.deepEqual(ranked.map(x=>x.symbol),["MOVE_USDT"]);
});
