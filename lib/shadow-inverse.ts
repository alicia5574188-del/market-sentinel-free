/** One source strategy evaluation, one passive inverse application, one atomic
 * durable state. No private exchange calls and no inverse-to-source feedback. */
import {advanceForward as advanceBaseline} from './shadow-baseline/forward-relations.ts';
import {normalizeForward,drainLegacyForwardPositions,forwardEquity,type ForwardState} from './forward-relations.ts';
import {captureTradeReviews} from './review-trace.ts';
import {SHADOW_BASELINE_BUILD,SHARED_MARKET_KEYS,shadowCapsule,sourceDecisionState,newInverseTrial,
  applyInverseSourceTrade,markInversePositions,recordInverseCurve,assertInverseTrial} from './shadow-inverse-ledger.ts';
import {beijingDayKey} from './beijing-time.ts';
import {FIXED_ALLOCATION_EQUITY} from './fixed-allocation.ts';

export function advanceShadowInverse(input:Parameters<typeof advanceBaseline>[0]){
  const s=normalizeForward(structuredClone(input.state),input.now),activated=!s.inverseTrial;
  if(!s.inverseTrial){
    s.inverseTrial=newInverseTrial(s,input.now,forwardEquity(s,input.quotes,input.now).equity);
    // In-flight decisions of the just-retired integration are not relabeled as
    // old-version signals. The same market tick rebuilds baseline candidates.
    s.entryValidations={};
    s.revision++;s.events.unshift({id:`a${s.startedAt}-${s.revision}`,at:input.now,kind:'START',subject:'shadow-inverse-v1',
      reason:'影子决策固定2b4fd60f；新单反向复制，旧账户与旧持仓保留'});
  }
  const sourceBefore=sourceDecisionState(s),source=advanceBaseline({...input,state:sourceBefore,allocationEquity:FIXED_ALLOCATION_EQUITY}),trial=s.inverseTrial!;
  // Observers cannot influence source decisions; baseline entries carry the
  // frozen code identity even though a newer build hosts the adapter.
  try{captureTradeReviews(sourceBefore,source.state,input.now,SHADOW_BASELINE_BUILD,
    '8dbebcae5e0ca7b48c939e66dc98fce02b35dbed99e41d2dcf950e9008ee4f24',input.quotes);}catch{/* optional diagnostic */}
  for(const key of SHARED_MARKET_KEYS)Object.assign(s,{[key]:structuredClone(source.state[key])});
  // Existing visible holdings are neither reversed retroactively nor force
  // closed. They drain under the pre-cutover controller, isolated from sizing.
  const beforeFinancial=JSON.stringify([s.balance,s.resolved,s.positions.map(t=>[t.id,t.stopPrice,t.contracts])]);
  drainLegacyForwardPositions(s,input);
  const subjects=new Set(source.state.events.filter(e=>Number(e.id.split('-').at(-1))>sourceBefore.revision).map(e=>e.subject));
  const rows=new Map([...source.state.history,...source.state.positions].map(t=>[t.id,t]));
  for(const id of subjects){const t=rows.get(id);if(t)applyInverseSourceTrade(s,t,input.quotes[t.symbol],input.now);}
  // Reference-level updates do not create another exit trigger or transaction.
  for(const t of source.state.positions){const m=s.positions.find(x=>x.inverseCopy?.sourceId===t.id);
    if(m){m.stopPrice=t.stopPrice;m.armPrice=t.armPrice;m.inverseCopy!.sourceStopPrice=t.stopPrice;
      m.inverseCopy!.sourceTargetPrice=t.winnerManagement?.targetLevel??t.entryContext?.winnerPlan?.target??null;}}
  trial.source=shadowCapsule(source.state);trial.lastSourceRevision=source.state.revision;
  markInversePositions(s,input.quotes,input.now);recordInverseCurve(s,input.quotes,input.now);
  const mark=forwardEquity(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));
  const day=beijingDayKey(input.now),daily=s.daily.at(-1);
  if(daily?.day===day){daily.lastAt=input.now;daily.endEquity=mark.equity;}
  else s.daily.push({day,firstAt:input.now,lastAt:input.now,startEquity:mark.equity,endEquity:mark.equity,exactBoundary:false});
  s.daily=s.daily.slice(-45);
  s.latestReason=`影子按2b4fd60f独立决策；模拟只反向跟随。已配对${trial.totals.opened}笔，旧持仓${s.positions.filter(t=>!t.inverseCopy).length}笔单独收尾。`;
  assertInverseTrial(s);
  return{state:s,changed:activated||source.changed||beforeFinancial!==JSON.stringify([s.balance,s.resolved,s.positions.map(t=>[t.id,t.stopPrice,t.contracts])]),
    protectionChanged:source.protectionChanged};
}
