import {fitRbeModel,predictRbeModel,binaryPredictionMetrics} from "../lib/rbe-learned-value.ts";
import {commonTopCohort} from "./rbe-replay-policy.mjs";

const direction=side=>side==="LONG"?1:-1;
const average=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const bound=x=>Math.max(-20,Math.min(20,x));

export function learnedFeatures(dec,own,prior,ageBars,minutes){
  const d=dec.diagnostics,e=own.evidence;
  return[d.ownTurn,d.ownDecay,d.lowerLead,d.adjacentLowerOpposition,d.lowerSupport,d.upperSupport,
    d.upperOpposition,d.sequenceShift,d.structureBreak,d.breadthPressure,dec.extensionSurvival,
    dec.slowHazard,dec.shockHazard,e.momentum,e.acceleration,e.cusum,e.failedExtension,e.volatility,e.volume,
    bound(d.currentReturnAtr),bound(d.runnerMfeAtr),bound(d.givebackAtr),bound(ageBars),
    Math.log2(minutes/5)/9,bound(own.expectedMoveRate/own.atrRate),
    prior?own.continuationScore-prior.continuation:0,prior?own.triggerProbability-prior.turn:0];
}

function labelEvent(snapshot,pair,rowByTime){
  const d=direction(pair.side),distance=snapshot.price*snapshot.atr;
  const upper=snapshot.price+distance,lower=snapshot.price-distance;
  for(let at=snapshot.at+300;at<=snapshot.at+snapshot.horizon;at+=300){
    const row=rowByTime.get(at);if(!row)return null;
    const up=row.high>=upper,down=row.low<=lower;
    if(up&&down)return null; // OHLC cannot resolve the barrier order.
    if(up||down){
      const favorable=d>0?up:down;
      return{event:favorable?0:at===snapshot.at+300?2:1,resolvedAt:at};
    }
  }
  return{event:3,resolvedAt:snapshot.at+snapshot.horizon};
}

function summarize(pairs,kind){
  const returns=pairs.map(p=>p[kind].net),net=returns.reduce((a,b)=>a+b,0);
  return{n:pairs.length,net,mean:average(returns),winRate:average(returns.map(v=>Number(v>0))),
    // Common baseline opportunity denominator, even when the candidate exits early.
    capture:average(pairs.filter(p=>p.baseline.mfe>.002).map(p=>Math.max(-1,Math.min(1.5,p[kind].net/p.baseline.mfe)))),
    reversals:pairs.filter(p=>p[kind].mfe>=Math.max(.008,p.baseline.entryAtr*.75)&&p[kind].net<0).length};
}

export function runLearnedWalkForward({pairs,rowByTime,months,friction}){
  const samples=[],labelAudit={ambiguousOrMissing:0,valid:0};
  for(const pair of pairs){
    const accepted=[],decisions=[];
    for(const snapshot of pair.samples??[]){
      const next=rowByTime[pair.symbol].get(snapshot.at+300);
      if(!next||next.time!==snapshot.at)continue;
      const label=labelEvent(snapshot,pair,rowByTime[pair.symbol]);
      const value=direction(pair.side)*(pair.baseline.exit-next.open)/pair.baseline.entry/snapshot.atr;
      const s={...snapshot,...label,value,nextOpen:next.open,tradeId:pair.id,labelValid:!!label,
        resolvedAt:Math.max(label?.resolvedAt??Infinity,pair.baseline.closedAt),weight:0};
      decisions.push(s);
      if(!label){labelAudit.ambiguousOrMissing++;continue;}
      accepted.push(s);
    }
    pair.decisionSamples=decisions;
    pair.learnedSamples=accepted;
    for(const s of accepted){s.weight=1/accepted.length;samples.push(s);}
  }
  labelAudit.valid=samples.length;
  const models=[],folds=[],evaluated=[],probabilityRows=[],leadMinutes=[];
  for(let index=3;index<months.length;index++){
    const month=months[index],year=Number(month.slice(0,4)),m=Number(month.slice(4));
    const start=Date.UTC(year,m-1,1)/1000,end=Date.UTC(year,m,1)/1000;
    const cutoff=start-2*86400; // Purge two days in addition to outcome maturity.
    const trainPairs=pairs.filter(p=>p.baseline.closedAt<cutoff);
    let model=fitRbeModel(samples,cutoff);
    if(!model){folds.push({month,skipped:"insufficient matured training"});continue;}
    // Three fixed fitted-policy iterations. Each label uses only fully matured
    // TRAINING episodes. Zero is immediate cash-out value; continuation targets
    // follow the previous fitted policy at later decision states.
    for(let iteration=0;iteration<3;iteration++){
      const targets=[];
      for(const pair of trainPairs){
        let exit=pair.baseline.exit;
        const rows=pair.decisionSamples;
        for(let i=rows.length-1;i>=0;i--){
          const s=rows[i];
          const value=direction(pair.side)*(exit-s.nextOpen)/pair.baseline.entry/s.atr;
          if(s.labelValid&&s.resolvedAt<cutoff)targets.push({...s,value});
          if(predictRbeModel(model,s.x)?.shouldExit)exit=s.nextOpen;
        }
      }
      model=fitRbeModel(targets,cutoff)??model;
    }
    models.push({month,model});
    const testPairs=pairs.filter(p=>p.openedAt>=start&&p.openedAt<end);
    const predictions=[];
    for(const pair of testPairs){
      const candidate={...pair.baseline};
      let exited=false;
      for(const s of pair.decisionSamples){
        const p=predictRbeModel(model,s.x);if(!p)continue;
        const y=Number(s.event===1||s.event===2);
        // Evaluation uses outcomes only AFTER prediction. Folds never select fit or policy.
        if(s.labelValid)predictions.push({p:p.reversal,y,reference:model.prevalence[1]+model.prevalence[2]});
        if(!exited&&p.shouldExit&&s.at<pair.baseline.closedAt){
          candidate.exit=s.nextOpen;candidate.closedAt=s.at;candidate.reason="LEARNED_RBE";
          candidate.net=direction(pair.side)*(s.nextOpen/pair.baseline.entry-1)-friction;
          candidate.mfe=Math.max(s.mfe,direction(pair.side)*(s.nextOpen/pair.baseline.entry-1));
          candidate.prediction=p;exited=true;
          if(pair.baseline.reason==="CONFIRMED_TURN")leadMinutes.push((pair.baseline.closedAt-s.at)/60);
        }
      }
      evaluated.push({...pair,candidate});
    }
    probabilityRows.push(...predictions);
    const foldPairs=evaluated.filter(p=>p.openedAt>=start&&p.openedAt<end);
    folds.push({month,cutoff,trainedStates:model.samples,trainedTrades:model.trades,
      baseline:summarize(foldPairs,"baseline"),candidate:summarize(foldPairs,"candidate"),
      prediction:binaryPredictionMetrics(predictions)});
  }
  const all={baseline:summarize(evaluated,"baseline"),candidate:summarize(evaluated,"candidate")};
  const runners=evaluated.filter(p=>p.baseline.mfe>=Math.max(.02,p.baseline.entryAtr*1.5)&&p.baseline.net>0);
  const givebacks=evaluated.filter(p=>p.baseline.mfe>=Math.max(.008,p.baseline.entryAtr*.75)&&p.baseline.net<0);
  const top=commonTopCohort(evaluated),runnerBase=summarize(runners,"baseline"),runnerNew=summarize(runners,"candidate");
  const givebackBase=summarize(givebacks,"baseline"),givebackNew=summarize(givebacks,"candidate");
  const topBase=summarize(top,"baseline"),topNew=summarize(top,"candidate");
  const prediction=binaryPredictionMetrics(probabilityRows);
  const runnerRetention=runnerBase.net>0?runnerNew.net/runnerBase.net:null;
  const givebackRecovery=givebackBase.net<0?(givebackNew.net-givebackBase.net)/-givebackBase.net:null;
  const foldWins=folds.filter(f=>f.candidate&&f.candidate.net>f.baseline.net).length;
  const gates={enoughPairs:evaluated.length>=120,positiveNet:all.candidate.net>0,
    netImproves:all.candidate.net>all.baseline.net,foldsImprove:foldWins>=2,
    runnerPreserved:runnerRetention!==null&&runnerRetention>=.85,
    givebackRecovered:givebackRecovery!==null&&givebackRecovery>=.35,
    commonTopPreserved:topBase.net>0&&topNew.net>=topBase.net*.85,
    brierImproves:prediction.brier!==null&&prediction.brier<prediction.referenceBrier,
    discrimination:prediction.auc!==null&&prediction.auc>=.55};
  return{version:"rbe-fitted-stopping-research-v1",policyIterations:3,folds,all,labelAudit,prediction,
    cohort:{runners:{baseline:runnerBase,candidate:runnerNew},givebacks:{baseline:givebackBase,candidate:givebackNew},
      commonTop:{baseline:topBase,candidate:topNew}},runnerRetention,givebackRecovery,foldWins,
    meanLeadMinutes:average(leadMinutes),leadSampleCount:leadMinutes.length,
    gates,accepted:Object.values(gates).every(Boolean),releaseAuthorized:false,models,
    limitations:["Approximate regularized fitted policy, not a proof of global optimal stopping.",
      "State samples within trades are correlated; weighting is per trade, metrics are descriptive.",
      "March-August history was already inspected; expanding fits are causal but evaluation is not pristine holdout.",
      "Surrogate entries/frames and fixed friction do not prove production or account-level profitability."]};
}
