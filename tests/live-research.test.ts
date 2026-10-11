import assert from 'node:assert/strict';
import test from 'node:test';
import {runLiveResearch,reviewResearchLog,researchLevel,priceWords,type ResearchBar,type ResearchSnap} from '../lib/live-research.ts';

function bars(n:number,price:number,volume:number,jump=0):ResearchBar[]{
  const out:ResearchBar[]=[];
  let px=price;
  for(let i=0;i<n;i++){
    px*=1+(i===n-1?jump:((i%5)-2)*0.0004);
    out.push({t:1_700_000_000+i*300,o:px,h:px*1.001,l:px*0.999,c:px,v:i===n-1?volume*(1+Math.abs(jump)*10):volume});
  }
  return out;
}
function drift(n:number,lastHour:number):ResearchBar[]{
  return Array.from({length:n},(_,i)=>{
    const px=i<n-13?100:100*(1+lastHour*(i-(n-13))/12);
    return {t:1_700_000_000+i*300,o:px,h:px,l:px,c:px,v:10};
  });
}
const snap=(symbol:string,jump:number,depthBid=10,m5?:ResearchBar[]):ResearchSnap=>({
  symbol,bid:100,ask:100.02,last:100*(1+jump),depthBid,depthAsk:10,funding:0.0001,m1:[],m5:m5??bars(80,100,10,jump),
});

test('missing BTC is reported as missing, not zero',()=>{
  const view=runLiveResearch([snap('ETH_USDT',0),snap('SOL_USDT',0.04)],Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(view.context?.btc1h,null);
  assert.equal(view.context?.corr1h,null);
});

test('evidence decides the direction, a rise alone does not',()=>{
  const pumped=snap('SOL_USDT',0.04,1);
  pumped.funding=0.002;pumped.depthAsk=10;
  const view=runLiveResearch([snap('BTC_USDT',0),snap('ETH_USDT',0),pumped],Date.parse('2026-10-11T00:00:00Z'));
  const text=`${view.decision?.observation} ${view.decision?.conclusion} ${view.decision?.evidence.join(" ")}`;
  assert.equal(text.includes("反方向"),false);
  assert.equal(view.decision?.conclusion.includes("做空"),true);
  assert.equal(view.decision?.evidence.length,4);
});

test('one vote each way is a contradiction and stays on watch',()=>{
  const pumped=snap('SOL_USDT',0.04,50);
  pumped.funding=0.002;pumped.depthAsk=10;
  const view=runLiveResearch([snap('BTC_USDT',0),snap('ETH_USDT',0),pumped],Date.parse('2026-10-11T00:00:00Z'));
  assert.ok(view.decision?.conflict?.includes("矛盾"));
  assert.equal(view.decision?.level,"观望");
  assert.equal(view.decision?.direction,null);
});

test('a new high says there is no resistance above',()=>{
  const m5=Array.from({length:80},(_,i)=>{const px=100+i;return {t:1_700_000_000+i*300,o:px,h:px,l:px,c:px,v:10};});
  const climbed=snap('SOL_USDT',0,10,m5);climbed.last=m5.at(-1)!.c;
  const view=runLiveResearch([snap('BTC_USDT',0),climbed],Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(view.context?.resistanceText,"创新高，上面没有现成的压力");
});

test('an hour later, a short that fell is marked right',()=>{
  const bars=[{t:1_000,o:100,h:100,l:100,c:100,v:1},{t:1_000+3600,o:99,h:99,l:99,c:99,v:1}];
  const [row]=reviewResearchLog([{at:0,symbol:"SOL_USDT",level:"弱信号",confidence:0.6,btc1h:-0.002,direction:"SHORT",price:100,laterRet:null,verdict:null}],[{symbol:"SOL_USDT",m5:bars}],3_700_000);
  assert.equal(row?.verdict,"对");
  assert.ok((row?.laterRet??0)<0);
});

test('confidence below 55 percent stays on watch',()=>{
  assert.equal(researchLevel(0.47),'观望');
  assert.equal(researchLevel(0.52),'观望');
  assert.equal(researchLevel(0.55),'弱信号');
  assert.equal(researchLevel(0.64),'弱信号');
  assert.equal(researchLevel(0.65),'明确信号');
});

test('a strong move is described as a multiple of normal, and a watch still shows a plan',()=>{
  assert.equal(priceWords(2.59),'价格比平时猛 2.6 倍（明显偏强）');
  const pumped=snap('SOL_USDT',0.04,50);
  pumped.funding=0.002;pumped.depthAsk=10;
  const view=runLiveResearch([snap('BTC_USDT',0),snap('ETH_USDT',0),pumped],Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(view.decision?.level,'观望');
  assert.ok(view.decision?.entry&&view.decision.entry>0);
  assert.ok(view.decision?.planSide==='LONG'||view.decision?.planSide==='SHORT');
  assert.equal(view.decision?.headline.includes('反方向'),false);
});

test('BTC hour return uses the last hour of its own candles',()=>{
  const view=runLiveResearch([
    snap('BTC_USDT',0,10,drift(80,-0.0032)),
    snap('ETH_USDT',0,10,drift(80,-0.001)),
    snap('SOL_USDT',0.04),
  ],Date.parse('2026-10-11T00:00:00Z'));
  assert.ok(Math.abs((view.context?.btc1h??0)+0.0032)<0.0002, String(view.context?.btc1h));
  assert.equal(view.candidates[0]?.symbol,'SOL_USDT');
});

test('a deep book does not steal the rank from the actual move',()=>{
  const calm=snap('DOGE_USDT',0,500);
  const moved=snap('SOL_USDT',0.04,10);
  const view=runLiveResearch([snap('BTC_USDT',0),calm,moved],Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(view.candidates[0]?.symbol,'SOL_USDT');
  const again=runLiveResearch([snap('BTC_USDT',0),{...calm,depthBid:5},moved],Date.parse('2026-10-11T00:00:00Z'));
  assert.deepEqual(again.analogy?.refs.map(row=>row.symbol),view.analogy?.refs.map(row=>row.symbol));
});
