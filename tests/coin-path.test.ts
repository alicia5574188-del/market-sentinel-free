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

test("a downtrend followed by two big up bars records the drop and the run separately",()=>{
  const closes=[];
  let px=100;
  for(let i=0;i<40;i++){px*=0.997;closes.push(px);}
  closes.push(px*1.025,px*1.025*1.025);
  const read=readCoinPath({bars:path(closes),now:nowOf(closes)});
  assert.equal(read.background,"DOWN");
  assert.equal(read.recent,"UP");
  assert.equal(read.runBars,2);
  assert.match(read.label,/已经压成下跌/);
  assert.match(read.label,/进场前 2 根一共涨了/);
  assert.equal(coinPathVersus(read,"LONG"),"逆着背景，顺着进场前这几根");
  assert.equal(coinPathVersus(read,"SHORT"),"顺着背景，逆着进场前这几根");
});

test("a slow climb that never clears the gate is described as lifting, not a flat range",()=>{
  const closes=[];
  let px=100;
  for(let i=0;i<30;i++)closes.push(px+=i%2?0.15:-0.05);
  for(let i=0;i<6;i++)closes.push(px+=0.02);
  const read=readCoinPath({bars:path(closes),now:nowOf(closes)});
  assert.equal(read.background,"RANGE");
  assert.match(read.label,/在慢慢抬，还没抬成趋势/);
  assert.match(read.label,/后半段比前半段高/);
  assert.doesNotMatch(read.label,/震荡/);
});

test("bars in one direction before entry are counted until they stop",()=>{
  const closes=[];
  for(let i=0;i<30;i++)closes.push(100+(i%2?0.05:-0.05));
  let px=100;
  for(let i=0;i<4;i++)closes.push(px*=0.985);
  const read=readCoinPath({bars:path(closes),now:nowOf(closes)});
  assert.equal(read.recent,"DOWN");
  assert.equal(read.runBars,4);
  assert.match(read.label,/进场前 4 根一共跌了/);
  assert.match(read.label,/最大一根跌了/);
});

test("a choppy path says it barely moved, and an unfinished bar cannot extend the run",()=>{
  const closes=[];
  for(let i=0;i<40;i++)closes.push(100+(i%2?0.05:-0.05));
  const read=readCoinPath({bars:path(closes),now:nowOf(closes)});
  assert.equal(read.background,"RANGE");
  assert.match(read.label,/几乎没挪/);
  const spike=[...path(closes),{time:START+closes.length*300,open:100,high:110,low:99,close:90}];
  const hidden=readCoinPath({bars:spike,now:nowOf(closes)});
  assert.equal(hidden.runBars,read.runBars);
  assert.equal(hidden.recent,read.recent);
});

test("too little history stays unknown and does not invent a drift",()=>{
  const read=readCoinPath({bars:path([100,101,102,103]),now:nowOf([100,101,102,103])});
  assert.equal(read.background,"UNKNOWN");
  assert.equal(coinPathVersus(read,"LONG"),"背景看不清");
});
