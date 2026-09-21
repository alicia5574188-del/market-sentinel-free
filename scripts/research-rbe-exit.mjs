import { readFileSync } from "node:fs";
import { TURN_CONFIG, TURN_TIMEFRAMES } from "../lib/multi-turn-engine.ts";
import { predictMultiTurnExit, RBE_EXIT_CONFIGS } from "../lib/turn-exit-predictor.ts";

const DATASET=process.env.RESEARCH_DATASET??"/tmp/rbe-gate-history.json";
const raw=JSON.parse(readFileSync(DATASET,"utf8"));
if(raw.interval!=="5m")throw new Error("RBE research requires Gate 5m candles");
const datasets=raw.datasets;
const FRICTION=0.0019;
const signFor=(s)=>s==="LONG"?1:-1;
const clip=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const median=v=>{const a=[...v].sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const sigmoid=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const tfSeconds={ "5m":300,"15m":900,"30m":1800,"1h":3600,"4h":14400,"1d":86400 };
const opposite=s=>s==="LONG"?"SHORT":s==="SHORT"?"LONG":"NEUTRAL";

function aggregate(rows,tf){
  const step=tfSeconds[tf];if(tf==="5m")return rows;
  const groups=new Map();
  for(const c of rows){const bucket=Math.floor(c.time/step)*step;const a=groups.get(bucket)??[];a.push(c);groups.set(bucket,a);}
  const factor=step/300;
  return [...groups].sort((a,b)=>a[0]-b[0]).flatMap(([time,a])=>{
    if(a.length!==factor)return[];
    for(let i=1;i<a.length;i++)if(a[i].time!==a[i-1].time+300)return[];
    return[{time,open:a[0].open,high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low)),
      close:a.at(-1).close,volume:a.reduce((n,x)=>n+x.volume,0)}];
  });
}

function rawMetrics(rows,tf,index){
  const cfg=TURN_CONFIG[tf],start=Math.max(0,index-Math.max(cfg.minBars,24)+1),a=rows.slice(start,index+1);
  if(a.length<cfg.minBars)return null;
  const step=tfSeconds[tf];for(let i=1;i<a.length;i++)if(a[i].time!==a[i-1].time+step)return null;
  const closes=a.map(x=>x.close),rets=closes.slice(1).map((x,i)=>x/closes[i]-1);
  const ranges=a.map(x=>(x.high-x.low)/x.close),atrRate=Math.max(.0005,median(ranges.slice(-14)));
  const slow=a.at(-1).close/a[Math.max(0,a.length-9)].close-1,fast=a.at(-1).close/a[Math.max(0,a.length-4)].close-1;
  const path=Math.abs(slow)/Math.max(1e-9,rets.slice(-8).reduce((n,x)=>n+Math.abs(x),0));
  const rawScore=(.65*slow+.35*fast)/(atrRate*Math.max(1,Math.sqrt(4)));
  const rawDirection=Math.abs(rawScore)<.10?"NEUTRAL":rawScore>0?"LONG":"SHORT";
  const confidence=clip(sigmoid(Math.abs(rawScore)*1.35-.45)*(.55+.45*clip(path)));
  const prior=a.slice(-7,-1),last=a.at(-1),priorHigh=Math.max(...prior.map(x=>x.high)),priorLow=Math.min(...prior.map(x=>x.low));
  const structureLong=clip((priorLow-last.close)/(atrRate*last.close)+.5),structureShort=clip((last.close-priorHigh)/(atrRate*last.close)+.5);
  const recent=rets.slice(-3),older=rets.slice(-9,-3),recentMean=mean(recent),olderMean=mean(older);
  const momentum=recentMean/(atrRate/Math.sqrt(3)),acceleration=(recentMean-olderMean)/(atrRate/Math.sqrt(3));
  let pos=0,neg=0,maxPos=0,maxNeg=0;for(const r of rets.slice(-8)){const z=r/atrRate;pos=Math.max(0,pos+z-.12);neg=Math.max(0,neg-z-.12);maxPos=Math.max(maxPos,pos);maxNeg=Math.max(maxNeg,neg);}
  const cusumLong=clip(maxPos/3.2),cusumShort=clip(maxNeg/3.2),shift=(recentMean-olderMean)/Math.max(atrRate/Math.sqrt(3),1e-9);
  const changeLong=clip(sigmoid(1.15*shift-1.1)),changeShort=clip(sigmoid(-1.15*shift-1.1));
  const newHigh=last.high>=priorHigh,newLow=last.low<=priorLow,location=(last.close-last.low)/Math.max(last.high-last.low,1e-9);
  const failedLong=newLow&&location>.65?clip((location-.65)/.35):0,failedShort=newHigh&&location<.35?clip((.35-location)/.35):0;
  const volatility=clip((ranges.at(-1)/Math.max(median(ranges.slice(-14,-1)),1e-9)-1)/1.5);
  const vols=a.map(x=>x.volume),volume=clip((Math.log(Math.max(last.volume,1e-9)/Math.max(median(vols.slice(-14,-1)),1e-9))+.2)/2);
  return{rawDirection,confidence,atrRate,expectedMoveRate:atrRate*(.8+.55*Math.sqrt(Math.max(1,cfg.minutes/15))),
    structureLong,structureShort,momentum,acceleration,cusumLong,cusumShort,changeLong,changeShort,failedLong,failedShort,volatility,volume,price:last.close};
}

function nextFrame(symbol,tf,m,previous,breadthLong,propagation,completedAt){
  const cfg=TURN_CONFIG[tf];let incumbent=previous?.direction??m.rawDirection;
  if(incumbent==="NEUTRAL"&&m.rawDirection!=="NEUTRAL"&&m.confidence>=.42)incumbent=m.rawDirection;
  const against=incumbent==="LONG"?-1:incumbent==="SHORT"?1:0;
  const structure=incumbent==="LONG"?m.structureLong:incumbent==="SHORT"?m.structureShort:0;
  const momentum=clip(against*m.momentum/1.7),acceleration=clip(against*m.acceleration/1.8);
  const cusum=incumbent==="LONG"?m.cusumShort:incumbent==="SHORT"?m.cusumLong:0;
  const changePoint=incumbent==="LONG"?m.changeShort:incumbent==="SHORT"?m.changeLong:0;
  const failedExtension=incumbent==="LONG"?m.failedShort:incumbent==="SHORT"?m.failedLong:0;
  const breadth=incumbent==="LONG"?clip((.5-breadthLong)/.35):incumbent==="SHORT"?clip((breadthLong-.5)/.35):0;
  const score=-2.45+1.35*structure+1.05*momentum+.75*acceleration+1.10*cusum+.90*changePoint+.55*failedExtension+.60*breadth+.70*propagation+.25*m.volatility+.10*m.volume;
  const p=clip(sigmoid(score)*(1+.12*m.volatility)*(1+.04*m.volume)+.05*structure,.02,.98),opp=opposite(incumbent);
  const newBar=!previous||previous.completedAt!==completedAt;
  let candidateSide=previous?.candidateSide??"NEUTRAL",candidateBars=previous?.candidateBars??0;
  if(incumbent==="NEUTRAL"){candidateSide="NEUTRAL";candidateBars=0;}
  else if(p>=cfg.turning){if(newBar){if(candidateSide===opp)candidateBars++;else{candidateSide=opp;candidateBars=1;}}}
  else if(p<cfg.watch){candidateSide="NEUTRAL";candidateBars=0;}
  else if(newBar)candidateBars=Math.max(0,candidateBars-1);
  const extreme=p>=.90&&structure>=.65,confirmed=incumbent!=="NEUTRAL"&&p>=cfg.confirm&&(candidateBars>=cfg.confirmBars||extreme);
  let direction=incumbent,justTurned=false,lastTurnAt=previous?.lastTurnAt??null,phase;
  let turnProbability=p;
  if(confirmed&&opp!=="NEUTRAL"){direction=opp;justTurned=true;lastTurnAt=completedAt;candidateSide="NEUTRAL";candidateBars=0;phase="CONFIRMED";turnProbability=clip(1-p,.05,.32);}
  else phase=p>=cfg.turning?"TURNING":p>=cfg.watch?"WATCH":"FLOW";
  if(direction==="NEUTRAL"&&m.rawDirection!=="NEUTRAL"&&m.confidence>.52)direction=m.rawDirection;
  const continuationScore=direction==="NEUTRAL"?0:clip(m.confidence*(1-turnProbability));
  const evidence={structure,momentum,acceleration,cusum,changePoint,failedExtension,volatility:m.volatility,volume:m.volume,breadth,propagation};
  return{version:"multi-turn-v1",symbol,timeframe:tf,observedAt:completedAt,completedAt,ready:true,direction,rawDirection:m.rawDirection,
    directionConfidence:m.confidence,turnProbability,triggerProbability:p,continuationScore,phase,candidateSide,candidateBars,justTurned,lastTurnAt,
    signalAgeBars:justTurned?0:newBar?(previous?.signalAgeBars??0)+1:(previous?.signalAgeBars??0),atrRate:m.atrRate,expectedMoveRate:m.expectedMoveRate,
    stopRate:Math.max(.0035,Math.min(cfg.maxStop,m.atrRate*1.5)),price:m.price,breadthLong,propagationPressure:propagation,evidence,reason:"research"};
}

const symbols=datasets.map(x=>x.symbol),series=Object.fromEntries(datasets.map(({symbol,rows})=>[symbol,Object.fromEntries(TURN_TIMEFRAMES.map(tf=>[tf,aggregate(rows,tf)]))]));
const indices=Object.fromEntries(symbols.map(s=>[s,Object.fromEntries(TURN_TIMEFRAMES.map(tf=>[tf,0]))]));
const prevFrames=Object.fromEntries(symbols.map(s=>[s,{}])),frames=Object.fromEntries(symbols.map(s=>[s,{}]));
const rowByTime=Object.fromEntries(symbols.map(s=>[s,new Map(series[s]["5m"].map(r=>[r.time+300,r]))]));
const start=Math.max(...symbols.map(s=>series[s]["5m"][0].time))+30*86400,end=Math.min(...symbols.map(s=>series[s]["5m"].at(-1).time+300));
const paired=[],active=new Map();
const actionDebug={decisions:0,healthy:0,early:0,defensive:0,preExit:0,shouldExit:0,warnings:0,arms:0,
  secondSignals:0,renewalRearms:0,hazardPass:0,survivalPass:0,pairPass:0,countPass:0,
  persistent:0,reductions:0,full:0,stopArms:0,stopHits:0,resets:0};

function closeLeg(leg,price,time,reason){
  if(leg.closedAt)return;
  const remaining=leg.remaining??1,d=signFor(leg.side),ret=d*(price/leg.entry-1)-FRICTION;
  leg.realized=(leg.realized??0)+remaining*ret;leg.remaining=0;
  leg.closedAt=time;leg.exit=price;leg.reason=reason;leg.net=leg.realized;
}
function reduceLeg(leg,price,time,fraction,reason,decision){
  if(leg.closedAt)return;
  const remaining=leg.remaining??1,cut=Math.min(remaining,Math.max(0,fraction));
  if(cut<=0)return;
  const d=signFor(leg.side),ret=d*(price/leg.entry-1)-FRICTION;
  leg.realized=(leg.realized??0)+cut*ret;leg.remaining=remaining-cut;
  leg.rbeStage=(leg.rbeStage??0)+1;leg.rbeActions=(leg.rbeActions??0)+1;leg.rbe=decision;
  leg.lastRbeAt=time;leg.lastRbeMfe=leg.mfe;leg.lastRbeReason=reason;
  if(leg.remaining<=1e-9)closeLeg(leg,price,time,reason);
}
function markLeg(leg,row){
  const d=signFor(leg.side);const favorable=d>0?row.high/leg.entry-1:1-row.low/leg.entry;
  const adverse=d>0?1-row.low/leg.entry:row.high/leg.entry-1;leg.mfe=Math.max(leg.mfe,favorable);leg.mae=Math.max(leg.mae,adverse);
}
function metrics(trades,kind){
  const rows=trades.map(t=>t[kind]).filter(x=>x.closedAt);
  const net=rows.reduce((n,x)=>n+x.net,0),wins=rows.filter(x=>x.net>0).length;
  const reversals=rows.filter(x=>x.mfe>=Math.max(.008,x.entryAtr*.75)&&x.net<0).length;
  const capture=rows.filter(x=>x.mfe>.002).map(x=>Math.max(-1,Math.min(1.5,x.net/Math.max(x.mfe,1e-9))));
  return{n:rows.length,net,mean:rows.length?net/rows.length:0,winRate:rows.length?wins/rows.length:0,reversals,
    capture:mean(capture),topMfe:mean(rows.sort((a,b)=>b.mfe-a.mfe).slice(0,Math.max(1,Math.floor(rows.length*.1))).map(x=>x.net))};
}

for(let now=start;now<=end;now+=300){
  for(const tf of TURN_TIMEFRAMES){
    const completed=[];
    for(const symbol of symbols){
      const rows=series[symbol][tf];let idx=indices[symbol][tf];
      while(idx<rows.length&&rows[idx].time+tfSeconds[tf]<=now){
        const completedAt=rows[idx].time+tfSeconds[tf];
        if(completedAt===now)completed.push([symbol,idx]);
        idx+=1;indices[symbol][tf]=idx;
      }
    }
    if(!completed.length)continue;
    const rawNow=new Map();let longs=0,shorts=0;
    for(const [symbol,idx] of completed){const m=rawMetrics(series[symbol][tf],tf,idx);if(m){rawNow.set(symbol,m);if(m.rawDirection==="LONG")longs++;else if(m.rawDirection==="SHORT")shorts++;}}
    const breadth=(longs+shorts)?longs/(longs+shorts):.5;
    for(const [symbol,m] of rawNow){
      const lower=TURN_TIMEFRAMES.slice(0,TURN_TIMEFRAMES.indexOf(tf)).flatMap(x=>frames[symbol][x]?[frames[symbol][x]]:[]);
      const incumbent=prevFrames[symbol][tf]?.direction??m.rawDirection;
      const propagation=lower.length&&incumbent!=="NEUTRAL"?clip(mean(lower.map(x=>x.direction===opposite(incumbent)?Math.max(.65,x.triggerProbability):x.phase==="TURNING"?x.triggerProbability*.5:0))):0;
      const next=nextFrame(symbol,tf,m,prevFrames[symbol][tf],breadth,propagation,now);prevFrames[symbol][tf]=next;frames[symbol][tf]=next;
    }
  }

  for(const [symbol,pair] of [...active]){
    const row=rowByTime[symbol].get(now);if(!row)continue;
    for(const kind of ["baseline","candidate"])if(!pair[kind].closedAt)markLeg(pair[kind],row);
    const own=frames[symbol][pair.timeframe];
    const d=signFor(pair.side),baselineStopHit=d>0?row.low<=pair.baseline.stop:row.high>=pair.baseline.stop;
    const candidateStop=pair.candidate.rbeStop??pair.candidate.stop;
    const candidateStopHit=!pair.candidate.closedAt&&(d>0?row.low<=candidateStop:row.high>=candidateStop);
    if(candidateStopHit){
      if(candidateStop!==pair.candidate.stop)actionDebug.stopHits++;
      closeLeg(pair.candidate,candidateStop,now,candidateStop!==pair.candidate.stop?"RBE_PROTECTIVE_STOP":"STOP");
    }
    if(baselineStopHit){
      closeLeg(pair.baseline,pair.baseline.stop,now,"STOP");
      if(!pair.candidate.closedAt)closeLeg(pair.candidate,pair.candidate.stop,now,"STOP");
      active.delete(symbol);continue;
    }
    if(own&&own.direction!==pair.side&&own.lastTurnAt&&own.lastTurnAt>=pair.openedAt){
      closeLeg(pair.baseline,row.close,now,"CONFIRMED_TURN");
    }
    if(!pair.candidate.closedAt){
      const dec=predictMultiTurnExit({side:pair.side,timeframe:pair.timeframe,entryPrice:pair.candidate.entry,stopPrice:pair.candidate.stop,
        currentPrice:row.close,favorable:pair.candidate.mfe,frames:frames[symbol]},pair.config);
      const leg=pair.candidate,atr=Math.max(own?.atrRate??.001,1e-9);
      const renewed=(leg.mfe-(leg.rbeArmedMfe??leg.mfe))/atr;
      if(dec){
        actionDebug.decisions++;
        if(dec.phase==="HEALTHY")actionDebug.healthy++;
        else if(dec.phase==="EARLY_WARNING")actionDebug.early++;
        else if(dec.phase==="DEFENSIVE")actionDebug.defensive++;
        else if(dec.phase==="PRE_TURN_EXIT")actionDebug.preExit++;
        if(dec.shouldExit)actionDebug.shouldExit++;
      }
      const warning=dec&&(dec.shouldExit||dec.phase==="DEFENSIVE");
      if(warning){actionDebug.warnings++;
        const severe=dec.diagnostics.ownTurn>=.84&&dec.diagnostics.structureBreak>=.55||dec.shockHazard>=.93;
        if(!leg.rbeArmedAt){
          // First predictive hit only arms the state. We do not wait for price
          // confirmation; we wait for the predictive state itself to persist.
          actionDebug.arms++;leg.rbeArmedAt=now;leg.rbeArmedMfe=leg.mfe;leg.rbeArmedHazard=dec.reversalHazard;
          leg.rbeArmedSurvival=dec.extensionSurvival;leg.rbeSignalCount=1;leg.rbe=dec;
        }else{
          if(renewed>=.45&&!severe){
            actionDebug.renewalRearms++;
            // A real extension after the warning means the old warning became
            // stale. Re-arm from the new MFE instead of permanently blocking
            // persistence or cutting a trend that just proved it can extend.
            actionDebug.resets++;actionDebug.arms++;
            leg.rbeArmedAt=now;leg.rbeArmedMfe=leg.mfe;leg.rbeArmedHazard=dec.reversalHazard;
            leg.rbeArmedSurvival=dec.extensionSurvival;leg.rbeSignalCount=1;leg.rbe=dec;
          }else{
            const separated=now-(leg.lastRbeSignalAt??leg.rbeArmedAt)>=300;
            if(separated){leg.rbeSignalCount=(leg.rbeSignalCount??1)+1;actionDebug.secondSignals++;}
            const hazardPersistent=dec.reversalHazard>=(leg.rbeArmedHazard??0)-.035;
            const survivalPersistent=dec.extensionSurvival<=(leg.rbeArmedSurvival??1)+.05;
            if(hazardPersistent)actionDebug.hazardPass++;
            if(survivalPersistent)actionDebug.survivalPass++;
            if(hazardPersistent&&survivalPersistent)actionDebug.pairPass++;
            if((leg.rbeSignalCount??0)>=2)actionDebug.countPass++;
            const persistent=(leg.rbeSignalCount??0)>=2&&hazardPersistent&&survivalPersistent;
            if(persistent)actionDebug.persistent++;
            if(persistent){
              // Prediction does not liquidate the runner. It converts the
              // forecast into a temporary, causal protection boundary that is
              // only active while the RBE state remains dangerous.
              const hazardScale=clip((dec.reversalHazard-.45)/.45);
              const horizonCushion={ "5m":.95,"15m":1.15,"30m":1.35,"1h":1.60,"4h":1.95,"1d":2.30 }[pair.timeframe];
              const cushionAtr=severe
                ?horizonCushion*.55
                :horizonCushion*(1-.30*hazardScale);
              const grossFloor=Math.max(FRICTION+.00015,
                dec.diagnostics.currentReturn-atr*cushionAtr);
              const floorPrice=pair.side==="LONG"
                ?leg.entry*(1+grossFloor)
                :leg.entry*(1-grossFloor);
              const currentProtect=leg.rbeStop??leg.stop;
              const better=pair.side==="LONG"?floorPrice>currentProtect:floorPrice<currentProtect;
              if(better){leg.rbeStop=floorPrice;actionDebug.stopArms++;}
              leg.rbe=dec;
              if((leg.rbeStage??0)===0&&dec.diagnostics.currentReturnAtr>.75){
                // The prediction already acts by arming a protective boundary.
                // Do not skim a healthy runner merely because the warning fired.
                leg.rbeStage=1;
              }
            }
          }
        }
        leg.lastRbeSignalAt=now;
      }else if(leg.rbeArmedAt){
        // A renewed extension or a material hazard collapse invalidates the
        // prior warning. This lets genuine runners clear stale alarms.
        if(renewed>=.45||!dec||dec.reversalHazard<(leg.rbeArmedHazard??1)-.12){
          actionDebug.resets++;leg.rbeArmedAt=0;leg.rbeArmedMfe=leg.mfe;leg.rbeArmedHazard=0;leg.rbeArmedSurvival=1;
          leg.rbeSignalCount=0;leg.lastRbeSignalAt=0;leg.rbeStop=leg.stop;
        }
      }
    }
    if(pair.baseline.closedAt){if(!pair.candidate.closedAt)closeLeg(pair.candidate,row.close,now,"BASELINE_END");active.delete(symbol);}
  }

  for(const symbol of symbols){
    if(active.has(symbol))continue;
    const row=rowByTime[symbol].get(now);if(!row)continue;
    const candidates=TURN_TIMEFRAMES.flatMap(tf=>{const f=frames[symbol][tf],cfg=TURN_CONFIG[tf];return f&&f.direction!=="NEUTRAL"&&f.continuationScore>=cfg.minContinuation
      ?[{tf,f,score:f.continuationScore*Math.max(.1,f.expectedMoveRate/.0019)}]:[];}).sort((a,b)=>b.score-a.score);
    const c=candidates[0];if(!c)continue;
    const side=c.f.direction,d=signFor(side),entry=row.close*(1+d*.00025),stop=entry*(1-d*c.f.stopRate);
    const config=RBE_EXIT_CONFIGS.balanced,base={side,entry,stop,entryAtr:c.f.atrRate,openedAt:now,closedAt:0,exit:0,net:0,mfe:0,mae:0,
      reason:"",remaining:1,realized:0,rbeStage:0,rbeActions:0,lastRbeAt:0,lastRbeMfe:0,
      rbeArmedAt:0,rbeArmedMfe:0,rbeArmedHazard:0,rbeArmedSurvival:1,rbeSignalCount:0,lastRbeSignalAt:0,rbeStop:stop};
    const pair={symbol,side,timeframe:c.tf,openedAt:now,config,baseline:{...base},candidate:{...base}};active.set(symbol,pair);paired.push(pair);
  }
}
for(const pair of active.values()){const row=series[pair.symbol]["5m"].at(-1);for(const kind of ["baseline","candidate"])if(!pair[kind].closedAt)closeLeg(pair[kind],row.close,end,"END");}

const folds=[0,1,2].map(i=>{const a=start+(end-start)*i/3,b=start+(end-start)*(i+1)/3,t=paired.filter(x=>x.openedAt>=a&&x.openedAt<b);
  return{fold:i+1,baseline:metrics(t,"baseline"),candidate:metrics(t,"candidate")};});
const all={baseline:metrics(paired,"baseline"),candidate:metrics(paired,"candidate")};
const byTimeframe=Object.fromEntries(TURN_TIMEFRAMES.map(tf=>{
  const rows=paired.filter(x=>x.timeframe===tf);return[tf,{n:rows.length,baseline:metrics(rows,"baseline"),candidate:metrics(rows,"candidate")}];
}));
const runnerRows=paired.filter(x=>x.baseline.mfe>=Math.max(.02,x.baseline.entryAtr*1.5)&&x.baseline.net>0);
const givebackRows=paired.filter(x=>x.baseline.mfe>=Math.max(.008,x.baseline.entryAtr*.75)&&x.baseline.net<0);
const cohort={
  runners:{n:runnerRows.length,baseline:metrics(runnerRows,"baseline"),candidate:metrics(runnerRows,"candidate"),
    candidateWorse:runnerRows.filter(x=>x.candidate.net<x.baseline.net).length},
  givebacks:{n:givebackRows.length,baseline:metrics(givebackRows,"baseline"),candidate:metrics(givebackRows,"candidate"),
    candidateBetter:givebackRows.filter(x=>x.candidate.net>x.baseline.net).length},
};
const cohortByTimeframe=Object.fromEntries(TURN_TIMEFRAMES.map(tf=>{
  const runners=runnerRows.filter(x=>x.timeframe===tf),givebacks=givebackRows.filter(x=>x.timeframe===tf);
  return[tf,{
    runners:{n:runners.length,baseline:metrics(runners,"baseline"),candidate:metrics(runners,"candidate")},
    givebacks:{n:givebacks.length,baseline:metrics(givebacks,"baseline"),candidate:metrics(givebacks,"candidate")},
  }];
}));
console.log("RBE_RESEARCH_SUMMARY="+JSON.stringify({source:raw.source,months:raw.months,symbols,paired:paired.length,all,folds,byTimeframe,cohort,cohortByTimeframe,actionDebug},null,2));
const rbeFields=["reversalHazard","slowHazard","shockHazard","extensionSurvival","holdValueRate","expectedExtensionRate","expectedReversalCostRate","evidenceFamilies"];
const rbeDiagFields=["ownTurn","ownDecay","lowerLead","lowerSupport","upperSupport","upperOpposition","sequenceShift","structureBreak","breadthPressure","currentReturn","profitGiveback","runnerMfeAtr","givebackAtr"];
function rbeFeatureMeans(rows){
  const exits=rows.map(x=>x.candidate.rbe).filter(Boolean);
  const out={n:exits.length};
  for(const key of rbeFields)out[key]=mean(exits.map(x=>Number(x[key]??0)));
  for(const key of rbeDiagFields)out[key]=mean(exits.map(x=>Number(x.diagnostics?.[key]??0)));
  return out;
}
const falseRunnerExits=runnerRows.filter(x=>x.candidate.reason==="RBE");
const savedGivebackExits=givebackRows.filter(x=>x.candidate.reason==="RBE"&&x.candidate.net>x.baseline.net);
const harmfulGivebackExits=givebackRows.filter(x=>x.candidate.reason==="RBE"&&x.candidate.net<=x.baseline.net);
const rbeExitDiagnostics={
  falseRunner:rbeFeatureMeans(falseRunnerExits),
  savedGiveback:rbeFeatureMeans(savedGivebackExits),
  harmfulGiveback:rbeFeatureMeans(harmfulGivebackExits),
};
console.log("RBE_EXIT_DIAGNOSTICS="+JSON.stringify(rbeExitDiagnostics,null,2));

const foldWins=folds.filter(x=>x.candidate.net>x.baseline.net).length;
const reversalImproved=all.candidate.reversals<all.baseline.reversals;
const captureImproved=all.candidate.capture>all.baseline.capture;
const topRunnerPreserved=all.candidate.topMfe>=all.baseline.topMfe*.85;
const foldRobust=folds.every(x=>x.candidate.net>=x.baseline.net-.00015*x.baseline.n);
const runnerRetention=cohort.runners.baseline.net>0?cohort.runners.candidate.net/cohort.runners.baseline.net:1;
const givebackRecovery=cohort.givebacks.baseline.net<0
  ?(cohort.givebacks.candidate.net-cohort.givebacks.baseline.net)/Math.abs(cohort.givebacks.baseline.net):0;
const accepted=paired.length>=120&&foldWins>=2&&all.candidate.net>all.baseline.net&&reversalImproved&&captureImproved
  &&topRunnerPreserved&&foldRobust&&runnerRetention>=.85&&givebackRecovery>=.35;
if(!accepted)throw new Error(`RBE_ACCEPTANCE_FAILED paired=${paired.length} foldWins=${foldWins} net=${all.baseline.net.toFixed(4)}->${all.candidate.net.toFixed(4)} reversals=${all.baseline.reversals}->${all.candidate.reversals} capture=${all.baseline.capture.toFixed(3)}->${all.candidate.capture.toFixed(3)} topMfe=${all.baseline.topMfe.toFixed(3)}->${all.candidate.topMfe.toFixed(3)} runnerRetention=${runnerRetention.toFixed(3)} givebackRecovery=${givebackRecovery.toFixed(3)} foldRobust=${foldRobust}`);
console.log(`RBE_ACCEPTANCE_PASS paired=${paired.length} foldWins=${foldWins}/3 net=${all.baseline.net.toFixed(4)}->${all.candidate.net.toFixed(4)} reversals=${all.baseline.reversals}->${all.candidate.reversals} capture=${all.baseline.capture.toFixed(3)}->${all.candidate.capture.toFixed(3)} topMfe=${all.baseline.topMfe.toFixed(3)}->${all.candidate.topMfe.toFixed(3)} foldRobust=${foldRobust}`);
