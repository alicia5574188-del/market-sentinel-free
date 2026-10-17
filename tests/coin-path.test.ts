import assert from "node:assert/strict";
import test from "node:test";
import {coinPathVersus, readCoinPath} from "../lib/coin-path.ts";

const START=1_700_000_000;
function path(closes:number[]){
  return closes.map((close,i)=>{
    const open=i?closes[i-1]!:close;
    return {time:START+i*300,open,high:Math.max(open,close)*1.001,low:Math.min(open,close)*0.999,close};
  });
}
function nowOf(closes:number[]){return (START+(closes.length-1)*300)*1000+300_000;}

test("a downtrend followed by two big up bars is tagged as a spike against that trend",()=>{
  const closes=[];
  let px=100;
  for(let i=0;i<40;i++){px*=0.997;closes.push(px);}
  closes.push(px*1.025,px*1.025*1.025);
  const read=readCoinPath({bars:path(closes),now:nowOf(closes)});
  assert.equal(read.background,"DOWN");
  assert.equal(read.recent,"SPIKE_UP");
  assert.match(read.label,/下跌趋势/);
  assert.match(read.label,/暴涨/);
  assert.equal(coinPathVersus(read,"LONG"),"逆着这段趋势，只顺着刚发生的异动");
  assert.equal(coinPathVersus(read,"SHORT"),"顺着这段趋势，逆着刚发生的异动");
});

test("a steady climb without a fresh impulse stays an uptrend",()=>{
  const closes=[];
  let px=100;
  for(let i=0;i<48;i++){px*=1.0015;closes.push(px);}
  const read=readCoinPath({bars:path(closes),now:nowOf(closes)});
  assert.equal(read.background,"UP");
  assert.equal(read.recent,"NONE");
  assert.equal(coinPathVersus(read,"LONG"),"顺着这段趋势");
  assert.equal(coinPathVersus(read,"SHORT"),"逆着这段趋势");
});

test("a choppy path is a range, and an unfinished bar cannot create the spike",()=>{
  const closes=[];
  for(let i=0;i<40;i++)closes.push(100+(i%2?0.2:-0.2));
  const read=readCoinPath({bars:path(closes),now:nowOf(closes)});
  assert.equal(read.background,"RANGE");
  assert.equal(read.recent,"NONE");
  const spike=[...path(closes),{time:START+closes.length*300,open:100,high:110,low:99,close:109}];
  const hidden=readCoinPath({bars:spike,now:nowOf(closes)});
  assert.equal(hidden.recent,"NONE");
});

test("too little history stays unknown and does not invent a trend",()=>{
  const read=readCoinPath({bars:path([100,101,102,103]),now:nowOf([100,101,102,103])});
  assert.equal(read.background,"UNKNOWN");
  assert.equal(coinPathVersus(read,"LONG"),"背景看不清");
});
