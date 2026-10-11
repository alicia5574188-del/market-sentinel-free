import assert from 'node:assert/strict';
import test from 'node:test';
import {runLiveResearch,type ResearchBar,type ResearchSnap} from '../lib/live-research.ts';

function bars(n:number,price:number,volume:number,jump=0):ResearchBar[]{
  const out:ResearchBar[]=[];
  let px=price;
  for(let i=0;i<n;i++){
    px*=1+(i===n-1?jump:((i%5)-2)*0.0004);
    out.push({t:1_700_000_000+i*300,o:px,h:px*1.001,l:px*0.999,c:px,v:i===n-1?volume*(1+Math.abs(jump)*10):volume});
  }
  return out;
}
const snap=(symbol:string,jump:number):ResearchSnap=>({symbol,bid:100,ask:100.02,last:100*(1+jump),depthBid:10,depthAsk:10,funding:0.0001,m1:[],m5:bars(80,100,10,jump)});

test('the sharpest coin is ranked first and the note is research, not an order',()=>{
  const view=runLiveResearch([snap('BTC_USDT',0),snap('ETH_USDT',0),snap('SOL_USDT',0.04)],Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(view.candidates[0]?.symbol,'SOL_USDT');
  assert.equal(view.decision?.direction,'SHORT');
  assert.match(view.status,/不下单/);
  assert.equal(view.context?.symbol,'SOL_USDT');
  assert.ok((view.library??0)>=20);
  assert.ok(view.analogy);
});
