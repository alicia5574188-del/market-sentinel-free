import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {buildPredictivePathEngine,predictiveExitDecision} from "../lib/predictive-path-engine.ts";
import {PREDICTIVE_PATH_POLICY,PREDICTIVE_PATH_VERSION} from "../lib/predictive-path-types.ts";

const INPUT=process.env.CAUSAL_REPLAY_DATASET??"/tmp/causal-replay-gate.json";
const OUTPUT=process.env.CAUSAL_REPLAY_OUTPUT??"/tmp/causal-replay-report.json";
const DESIGN_MONTH=process.env.CAUSAL_DESIGN_MONTH??"202607";
const HOLDOUT_MONTH=process.env.CAUSAL_HOLDOUT_MONTH??"202608";
const CACHE=process.env.CAUSAL_REPLAY_CACHE??".causal-replay-cache";
mkdirSync(CACHE,{recursive:true});
const raw=JSON.parse(readFileSync(INPUT,"utf8"));
if(raw.interval!=="5m")throw new Error("causal replay requires 5m Gate data");
const datasets=raw.datasets??[],symbols=datasets.map(d=>d.symbol);
if(symbols.length<4)throw new Error("causal replay needs at least four symbols");
const STEP=300,ROUND_TRIP_COST=PREDICTIVE_PATH_POLICY.estimatedRoundTripCost;
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1)/1000;
const nextMonth=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1)/1000;
const design={from:monthStart(DESIGN_MONTH),to:nextMonth(DESIGN_MONTH)};
const holdout={from:monthStart(HOLDOUT_MONTH),to:nextMonth(HOLDOUT_MONTH)};
if(design.to>holdout.from)throw new Error("design month must end before holdout month");

const gateRows=new Map(datasets.map(d=>[d.symbol,(d.rows??[]).sort((a,b)=>a.time-b.time)]));
const gateIndex=new Map([...gateRows].map(([s,rows])=>[s,new Map(rows.map((r,i)=>[r.time,i]))]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,timeout=9000){
  let last;
  for(let attempt=0;attempt<6;attempt++){
    try{
      const response=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeout)});
      if(response.ok)return await response.json();
      const detail=(await response.text().catch(()=>"")).slice(0,180);
      if(response.status!==429)throw new Error(url+" -> "+response.status+" "+detail);
      last=new Error(url+" -> 429 "+detail);
    }catch(error){last=error;if(!/429|Too Many Requests|50011/.test(String(error?.message??error)))throw error;}
    await sleep(Math.min(2500,180*2**attempt));
  }
  throw last??new Error(url+" retry exhausted");
}
const extSymbol=s=>s.endsWith("_USDT")?s.slice(0,-5)+"USDT":s;
const kucoinSymbol=s=>{let b=s.slice(0,-5);if(b==="BTC")b="XBT";return b+"USDTM";};

async function okxHistory(symbol,from,to){
  const out=[];let after=to*1000,guard=0,inst=symbol.slice(0,-5)+"-USDT-SWAP";
  while(after>from*1000&&guard++<600){
    const body=await json("https://www.okx.com/api/v5/market/history-candles?instId="+encodeURIComponent(inst)
      +"&bar=5m&after="+Math.floor(after)+"&limit=100");
    if(body.code!=="0"||!Array.isArray(body.data))throw new Error(symbol+" OKX payload");
    const rows=body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4])}))
      .filter(r=>r.time>=from&&r.time<to&&r.open>0&&r.close>0).sort((a,b)=>a.time-b.time);
    for(const r of rows)out.push(r);
    if(!body.data.length)break;
    const oldest=Math.min(...body.data.map(r=>Number(r[0])/1000).filter(Number.isFinite));
    if(!(oldest>0)||oldest*1000>=after)break;after=oldest*1000-1;await sleep(95);
  }
  return [...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);
}
async function kucoinHistory(symbol,from,to){
  const out=[];let cursor=from,guard=0;
  while(cursor<to&&guard++<240){
    const end=Math.min(to,cursor+199*300);
    const body=await json("https://api-futures.kucoin.com/api/v1/kline/query?symbol="+encodeURIComponent(kucoinSymbol(symbol))
      +"&granularity=5&from="+Math.floor(cursor*1000)+"&to="+Math.floor(end*1000));
    if(body.code!=="200000"||!Array.isArray(body.data))throw new Error(symbol+" KuCoin payload");
    const rows=body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4])}))
      .filter(r=>r.time>=from&&r.time<to&&r.open>0&&r.close>0).sort((a,b)=>a.time-b.time);
    for(const r of rows)out.push(r);
    cursor=end+300;await sleep(20);
  }
  return [...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);
}
async function gatePublic(path){
  let last;for(const base of ["https://api.gateio.ws/api/v4","https://fx-api.gateio.ws/api/v4"]){
    try{return await json(base+path,9000);}catch(e){last=e;}
  }throw last;
}
async function gateStats(symbol,from,to){
  const out=[];let cursor=from,guard=0;
  while(cursor<to&&guard++<300){
    const rows=await gatePublic("/futures/usdt/contract_stats?contract="+encodeURIComponent(symbol)
      +"&from="+Math.floor(cursor)+"&interval=4h&limit=100");
    const clean=(Array.isArray(rows)?rows:[]).map(x=>({time:Number(x.time),openInterestUsd:Number(x.open_interest_usd??0),
      longLiqUsd:Number(x.long_liq_usd??0),shortLiqUsd:Number(x.short_liq_usd??0),lsrTaker:Number(x.lsr_taker??0),
      lsrAccount:Number(x.lsr_account??0),topLsrSize:Number(x.top_lsr_size??0),markPrice:Number(x.mark_price??0)}))
      .filter(x=>x.time>=from&&x.time<to).sort((a,b)=>a.time-b.time);
    out.push(...clean);if(!clean.length)break;const next=clean.at(-1).time+14_400;if(next<=cursor)break;cursor=next;await sleep(30);
  }
  return [...new Map(out.map(x=>[x.time,x])).values()].sort((a,b)=>a.time-b.time);
}
async function gateFunding(symbol,from,to){
  const out=[];let cursor=from;
  while(cursor<to){const end=Math.min(to,cursor+120*86_400);
    const rows=await gatePublic("/futures/usdt/funding_rate?contract="+encodeURIComponent(symbol)+"&from="+Math.floor(cursor)
      +"&to="+Math.floor(end)+"&limit=1000");
    for(const x of Array.isArray(rows)?rows:[])if(Number(x.t)>=from&&Number(x.t)<to)out.push({time:Number(x.t),rate:Number(x.r??0)});
    cursor=end;await sleep(25);
  }
  return [...new Map(out.map(x=>[x.time,x])).values()].sort((a,b)=>a.time-b.time);
}
async function gatePremium(symbol,from,to){
  const out=[];let cursor=from;
  while(cursor<to){const end=Math.min(to,cursor+25*86_400);
    const rows=await gatePublic("/futures/usdt/premium_index?contract="+encodeURIComponent(symbol)+"&from="+Math.floor(cursor)
      +"&to="+Math.floor(end)+"&interval=1h");
    for(const x of Array.isArray(rows)?rows:[])if(Number(x.t)>=from&&Number(x.t)<to)out.push({time:Number(x.t),close:Number(x.c??0)});
    cursor=end;await sleep(25);
  }
  return [...new Map(out.map(x=>[x.time,x])).values()].sort((a,b)=>a.time-b.time);
}
function prior(rows,time){
  let lo=0,hi=rows.length-1,best=-1;while(lo<=hi){const m=(lo+hi)>>1;if(rows[m].time<=time){best=m;lo=m+1;}else hi=m-1;}return best;
}
function median(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function percentile(values,p){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;return a[Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)))];}

const external={},derivatives={};let cursor=0;
async function loadWorker(){
  while(cursor<symbols.length){const symbol=symbols[cursor++],cachePath=CACHE+"/"+symbol+"-"+DESIGN_MONTH+"-"+HOLDOUT_MONTH+".json";
    let okx,kucoin,stats,funding,premium;
    if(existsSync(cachePath)){
      ({okx,kucoin,stats,funding,premium}=JSON.parse(readFileSync(cachePath,"utf8")));
    }else{
      [okx,kucoin,stats,funding,premium]=await Promise.all([
        okxHistory(symbol,design.from,holdout.to),kucoinHistory(symbol,design.from,holdout.to),
        gateStats(symbol,design.from,holdout.to),gateFunding(symbol,design.from,holdout.to),gatePremium(symbol,design.from,holdout.to)
      ]);
      writeFileSync(cachePath,JSON.stringify({okx,kucoin,stats,funding,premium})+"\n");
    }
    external[symbol]={okx:new Map(okx.map(x=>[x.time,x])),kucoin:new Map(kucoin.map(x=>[x.time,x]))};
    derivatives[symbol]={stats,funding,premium};
    console.log(symbol+" external="+okx.length+"/"+kucoin.length+" stats="+stats.length+" funding="+funding.length+" premium="+premium.length);
  }
}
await Promise.all(Array.from({length:1},loadWorker));

function gateReturn(symbol,time,bars){
  const rows=gateRows.get(symbol),idx=gateIndex.get(symbol)?.get(time);return rows&&idx!=null&&idx>=bars?rows[idx].close/rows[idx-bars].close-1:0;
}
function multiQuote(symbol,time,gateClose,decisionAt){
  const ex=external[symbol],o=ex?.okx.get(time),k=ex?.kucoin.get(time),venues=[o,k].filter(Boolean);
  if(venues.length<2)return null;
  const closes=venues.map(x=>x.close),returns=venues.map((x,i)=>{
    const map=i===0?ex.okx:ex.kucoin,prev=map.get(time-STEP);return prev?.close>0?x.close/prev.close-1:0;
  });
  const mid=median(closes),disagreement=(Math.max(...closes)-Math.min(...closes))/Math.max(mid,1e-12),
    up=returns.filter(x=>x>0.00002).length,down=returns.filter(x=>x<-0.00002).length,active=up+down,
    breadth=active?(up-down)/active:0,agreement=active?Math.max(up,down)/active:.5;
  return{bestBid:gateClose*.9999,bestAsk:gateClose*1.0001,observedAt:decisionAt,fresh:true,entryReady:true,
    sourceCount:venues.length,disagreementRate:disagreement,sourceBreadth:breadth,directionalAgreement:agreement,medianShortMove:median(returns)};
}
function ancillary(symbol,time){
  const d=derivatives[symbol]??{stats:[],funding:[],premium:[]},si=prior(d.stats,time),fi=prior(d.funding,time),pi=prior(d.premium,time),
    s=si>=0?d.stats[si]:null,prev=si>0?d.stats[si-1]:null,oi=Number(s?.openInterestUsd??0),prevOi=Number(prev?.openInterestUsd??0),
    longLiq=Number(s?.longLiqUsd??0),shortLiq=Number(s?.shortLiqUsd??0),sum=longLiq+shortLiq,
    breadthVals=symbols.map(x=>gateReturn(x,time,3)).filter(Number.isFinite);
  return{fundingRate:fi>=0?Number(d.funding[fi].rate??0):0,basisRate:pi>=0?Number(d.premium[pi].close??0):0,
    openInterest:oi,openInterestChangeRate:prevOi>0?oi/prevOi-1:0,
    liquidationLongNotionalRate:oi>0?longLiq/oi:0,liquidationShortNotionalRate:oi>0?shortLiq/oi:0,
    liquidationImbalance:sum>0?(shortLiq-longLiq)/sum:0,
    takerLongShortLog:Number(s?.lsrTaker)>0?Math.log(Number(s.lsrTaker)):0,
    accountLongShortLog:Number(s?.lsrAccount)>0?Math.log(Number(s.lsrAccount)):0,
    topLongShortLog:Number(s?.topLsrSize)>0?Math.log(Number(s.topLsrSize)):0,
    btcReturn15m:gateReturn("BTC_USDT",time,3),btcReturn60m:gateReturn("BTC_USDT",time,12),
    ethReturn15m:gateReturn("ETH_USDT",time,3),ethReturn60m:gateReturn("ETH_USDT",time,12),
    marketBreadth:breadthVals.length?breadthVals.reduce((n,v)=>n+Math.sign(v),0)/breadthVals.length:0};
}

function runWindow(window,label){
  const commonTimes=(gateRows.get(symbols[0])??[]).map(x=>x.time).filter(t=>t>=window.from&&t<window.to);
  let state={version:PREDICTIVE_PATH_VERSION,updatedAt:window.from*1000,symbols:{},directionMemory:{}},positions=new Map(),trades=[],
    eligibleSignals=0,waitSignals=0,directionChecks=0,directionCorrect=0,entryDirectionChecks=0,entryDirectionCorrect=0,
    eligibleFutureNetSum=0,eligibleFutureNetCount=0,signalDiagnostics=[];
  for(const time of commonTimes){
    const paths={},quotes={},anc={};
    for(const symbol of symbols){
      const rows=gateRows.get(symbol),idx=gateIndex.get(symbol)?.get(time);if(idx==null||idx<80)continue;
      const path=rows.slice(Math.max(0,idx-89),idx+1);paths[symbol]=path;
      const q=multiQuote(symbol,time,rows[idx].close,(time+STEP)*1000);if(q)quotes[symbol]=q;
      anc[symbol]=ancillary(symbol,time);
    }
    const now=(time+STEP)*1000,built=buildPredictivePathEngine({paths,quotes,ancillary:anc,previous:state,now,allowed:new Set(symbols)});
    state=built.state;eligibleSignals+=built.candidates.filter(x=>x.eligible).length;
    waitSignals+=Object.values(state.symbols).filter(x=>!x.enterNow&&x.rawSide).length;
    for(const [symbol,forecast] of Object.entries(state.symbols)){
      const rows=gateRows.get(symbol),idx=gateIndex.get(symbol)?.get(time);if(idx==null||idx+12>=rows.length)continue;
      const future=rows[idx+12].close/rows[idx].close-1;
      if(forecast.stableSide){directionChecks++;
        if((forecast.stableSide==="LONG"&&future>0)||(forecast.stableSide==="SHORT"&&future<0))directionCorrect++;}
      if(forecast.enterNow&&forecast.stableSide&&forecast.rawSide===forecast.stableSide){
        entryDirectionChecks++;const d=forecast.stableSide==="LONG"?1:-1,net=d*future-ROUND_TRIP_COST,
          sideData=forecast.stableSide==="LONG"?forecast.long:forecast.short,
          signed=v=>d*v;
        eligibleFutureNetSum+=net;eligibleFutureNetCount++;
        if(d*future>0)entryDirectionCorrect++;
        signalDiagnostics.push({symbol,side:forecast.stableSide,net60:net,correct:d*future>0,confidence:forecast.confidence,
          entryQuality:forecast.entryQuality,directionProbability:forecast.directionProbability,
          expectedReturn:d*forecast.expectedReturn.m60,mfe:sideData.mfe60,mae:sideData.mae60,touch:sideData.targetBeforeRisk60,
          netEv:sideData.netEv60,persistence:forecast.evidence.persistence,price:signed(forecast.evidence.price),
          technical:signed(forecast.evidence.technical),derivatives:signed(forecast.evidence.derivatives),
          liquidation:signed(forecast.evidence.liquidation),multiVenue:signed(forecast.evidence.multiVenue),
          context:signed(forecast.evidence.context),agreement:forecast.crossVenue.agreement,
          disagreement:forecast.crossVenue.disagreementRate});
      }
    }
    for(const [symbol,pos] of [...positions]){
      const rows=gateRows.get(symbol),idx=gateIndex.get(symbol)?.get(time),forecast=state.symbols[symbol],memory=state.directionMemory[symbol];
      if(idx==null)continue;const bar=rows[idx],d=pos.side==="LONG"?1:-1,
        fav=pos.side==="LONG"?bar.high/pos.entry-1:1-bar.low/pos.entry,
        adv=pos.side==="LONG"?1-bar.low/pos.entry:bar.high/pos.entry-1;
      pos.mfe=Math.max(pos.mfe,fav);pos.mae=Math.max(pos.mae,adv);
      if(now<=pos.openedAt+15*60_000){pos.mfe15=Math.max(pos.mfe15,fav);pos.mae15=Math.max(pos.mae15,adv);}
      const stopped=pos.side==="LONG"?bar.low<=pos.stop:bar.high>=pos.stop,
        decision=predictiveExitDecision({side:pos.side,forecast,memory,stopped,ageMinutes:(now-pos.openedAt)/60_000});
      if(decision.reason){
        const exit=stopped?pos.stop:bar.close,gross=d*(exit/pos.entry-1),net=gross-ROUND_TRIP_COST;
        trades.push({...pos,closedAt:now,exit,reason:decision.reason,gross,net,holdMinutes:(now-pos.openedAt)/60_000});
        positions.delete(symbol);
      }
    }
    for(const c of built.candidates){
      if(!c.eligible||positions.has(c.symbol))continue;
      const rows=gateRows.get(c.symbol),idx=gateIndex.get(c.symbol)?.get(time);if(idx==null)continue;const entry=rows[idx].close,d=c.side==="LONG"?1:-1;
      positions.set(c.symbol,{symbol:c.symbol,side:c.side,openedAt:now,entry,stop:entry*(1-d*c.catastrophicStopRate),
        predictedHold:c.expectedHoldMinutes,predictedMfe:c.predictedMfeRate,predictedMae:c.predictedMaeRate,mfe:0,mae:0,mfe15:0,mae15:0});
    }
  }
  for(const [symbol,pos] of positions){
    const rows=gateRows.get(symbol),last=rows.filter(x=>x.time<window.to).at(-1);if(!last)continue;const d=pos.side==="LONG"?1:-1,gross=d*(last.close/pos.entry-1);
    trades.push({...pos,closedAt:window.to*1000,exit:last.close,reason:"WINDOW_END",gross,net:gross-ROUND_TRIP_COST,holdMinutes:(window.to*1000-pos.openedAt)/60_000});
  }
  const closed=trades.filter(t=>t.reason!=="WINDOW_END"),wins=closed.filter(t=>t.net>0),losses=closed.filter(t=>t.net<=0),
    grossWin=wins.reduce((n,t)=>n+t.net,0),grossLoss=-losses.reduce((n,t)=>n+t.net,0),holds=closed.map(t=>t.holdMinutes),
    fast=closed.filter(t=>t.holdMinutes<15).length,stop=closed.filter(t=>t.reason==="CATASTROPHIC_STOP").length,
    mfeBeat=closed.filter(t=>t.mfe>t.mae).length,immediateBad=closed.filter(t=>t.mae15>t.mfe15).length,
    winnerMedian=median(wins.map(t=>t.net)),avgWin=wins.length?wins.reduce((n,t)=>n+t.net,0)/wins.length:0,
    avgLoss=losses.length?-losses.reduce((n,t)=>n+t.net,0)/losses.length:0,net=closed.reduce((n,t)=>n+t.net,0);
  const profile=(name,predicate)=>{
    const rows=signalDiagnostics.filter(predicate),nets=rows.map(x=>x.net60),wins=rows.filter(x=>x.correct).length;
    return{name,count:rows.length,accuracy:rows.length?wins/rows.length:0,avgNet60:rows.length?nets.reduce((a,b)=>a+b,0)/rows.length:0,
      medianNet60:median(nets),positiveNetRate:rows.length?rows.filter(x=>x.net60>0).length/rows.length:0};
  };
  const profiles=[
    profile("BASE",()=>true),
    ...[.62,.65,.68,.70,.72].map(v=>profile("DIR_"+v,x=>x.directionProbability>=v)),
    ...[.65,.70,.75,.80].map(v=>profile("CONF_"+v,x=>x.confidence>=v)),
    ...[.65,.70,.75,.80].map(v=>profile("ENTRYQ_"+v,x=>x.entryQuality>=v)),
    ...[.006,.008,.010,.012].map(v=>profile("EXP_"+v,x=>x.expectedReturn>=v)),
    ...[.008,.010,.012,.015].map(v=>profile("MFE_"+v,x=>x.mfe>=v)),
    ...[.001,.002,.004,.006].map(v=>profile("NETEV_"+v,x=>x.netEv>=v)),
    ...[1.5,2.5,4].map(v=>profile("MFE_MAE_"+v,x=>x.mfe/Math.max(x.mae,.0005)>=v)),
    ...[.55,.65,.75].map(v=>profile("PERSIST_"+v,x=>x.persistence>=v)),
    profile("PRICE_TECH_ALIGN",x=>x.price>=.2&&x.technical>=.2),
    profile("INDEPENDENT_ALIGN",x=>x.price>=.2&&x.technical>=.2&&x.multiVenue>=.1&&x.derivatives>=-.15),
    profile("FULL_ALIGN",x=>x.price>=.25&&x.technical>=.25&&x.multiVenue>=.2&&x.derivatives>=0&&x.context>=-.1),
    profile("BIG_PATH_ALIGN",x=>x.expectedReturn>=.008&&x.mfe>=.010&&x.directionProbability>=.65&&x.price>=.2&&x.technical>=.2),
  ].filter(x=>x.count>0).sort((a,b)=>b.avgNet60-a.avgNet60||b.count-a.count);

  return{label,from:window.from,to:window.to,signals:{eligible:eligibleSignals,wait:waitSignals},closedTrades:closed.length,wins:wins.length,
    winRate:closed.length?wins.length/closed.length:0,netRateSum:net,avgNetRate:closed.length?net/closed.length:0,
    profitFactor:grossLoss>0?grossWin/grossLoss:(grossWin>0?99:0),medianHoldMinutes:median(holds),p25HoldMinutes:percentile(holds,.25),
    fastExitRate:closed.length?fast/closed.length:0,catastrophicStopRate:closed.length?stop/closed.length:0,
    mfeBeatMaeRate:closed.length?mfeBeat/closed.length:0,first15AdverseDominanceRate:closed.length?immediateBad/closed.length:0,
    winnerMedianNetRate:winnerMedian,avgWinRate:avgWin,avgLossRate:avgLoss,payoffRatio:avgLoss>0?avgWin/avgLoss:0,
    directionChecks,directionAccuracy:directionChecks?directionCorrect/directionChecks:0,
    entryDirectionChecks,entryDirectionAccuracy:entryDirectionChecks?entryDirectionCorrect/entryDirectionChecks:0,
    eligibleFutureAvgNet60:eligibleFutureNetCount?eligibleFutureNetSum/eligibleFutureNetCount:0,
    diagnosticProfiles:profiles.slice(0,24),
    exitReasons:Object.fromEntries([...new Set(closed.map(t=>t.reason))].map(r=>[r,closed.filter(t=>t.reason===r).length])),
    symbols:Object.fromEntries(symbols.map(s=>[s,{trades:closed.filter(t=>t.symbol===s).length,net:closed.filter(t=>t.symbol===s).reduce((n,t)=>n+t.net,0)}])),
    sample:closed.slice(-20)};
}
const thresholds={
  design:{minClosedTrades:35,minProfitFactor:1.05,minAvgNetRate:0,minMedianHoldMinutes:25,maxFastExitRate:.35,maxCatastrophicStopRate:.38,
    minMfeBeatMaeRate:.55,maxFirst15AdverseDominanceRate:.48,minWinnerMedianNetRate:.006,minEntryDirectionAccuracy:.55,minEligibleFutureAvgNet60:0},
  holdout:{minClosedTrades:25,minProfitFactor:1.00,minAvgNetRate:0,minMedianHoldMinutes:25,maxFastExitRate:.40,maxCatastrophicStopRate:.42,
    minMfeBeatMaeRate:.52,maxFirst15AdverseDominanceRate:.52,minWinnerMedianNetRate:.005,minEntryDirectionAccuracy:.52,minEligibleFutureAvgNet60:0}
};
function failures(m,t){
  const out=[];for(const [key,value] of Object.entries(t)){
    const metric=key.replace(/^min/,"").replace(/^max/,"");const prop=metric[0].toLowerCase()+metric.slice(1),actual=m[prop];
    if(key.startsWith("min")&&!(actual>=value))out.push(prop+" "+actual+" < "+value);
    if(key.startsWith("max")&&!(actual<=value))out.push(prop+" "+actual+" > "+value);
  }return out;
}
const designMetrics=runWindow(design,"DESIGN"),designFailures=failures(designMetrics,thresholds.design);
console.log("DESIGN "+JSON.stringify({metrics:designMetrics,failures:designFailures},null,2));
if(designFailures.length){
  writeFileSync(OUTPUT,JSON.stringify({version:"causal-predictive-replay-v1",policy:PREDICTIVE_PATH_POLICY,thresholds,design:designMetrics,
    designFailures,holdout:null,holdoutFailures:["NOT_RUN_BECAUSE_DESIGN_FAILED"]},null,2)+"\n");
  throw new Error("design replay failed: "+designFailures.join("; "));
}
const holdoutMetrics=runWindow(holdout,"HOLDOUT"),holdoutFailures=failures(holdoutMetrics,thresholds.holdout);
const report={version:"causal-predictive-replay-v1",policy:PREDICTIVE_PATH_POLICY,thresholds,design:designMetrics,designFailures,
  holdout:holdoutMetrics,holdoutFailures,notes:[
    "No model fitting or parameter training occurs in this replay.",
    "July is the design gate; August is not evaluated unless July passes.",
    "External multi-source replay uses causal 5m Bybit and KuCoin closes, not unavailable historical sub-minute BBO microstructure.",
    "PAPER/LIVE execution costs are represented by the fixed production round-trip cost hurdle; this is a behavioral release gate, not a profit promise."
  ]};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("HOLDOUT "+JSON.stringify({metrics:holdoutMetrics,failures:holdoutFailures},null,2));
if(holdoutFailures.length)throw new Error("holdout replay failed: "+holdoutFailures.join("; "));
console.log(JSON.stringify({status:"PASS",output:OUTPUT,design:designMetrics,holdout:holdoutMetrics},null,2));
