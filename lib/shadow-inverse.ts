/** One source strategy evaluation, one passive inverse application, one atomic
 * durable state. No private exchange calls and no inverse-to-source feedback. */
import {advanceForward as advanceBaseline} from './shadow-baseline/forward-relations.ts';
import {normalizeForward,drainLegacyForwardPositions,forwardEquity,resetForwardAccountPreservingLearning,type ForwardState} from './forward-relations.ts';
import {captureTradeReviews} from './review-trace.ts';
import {SHADOW_BASELINE_BUILD,SHARED_MARKET_KEYS,shadowCapsule,sourceDecisionState,newInverseTrial,
  applyInverseSourceTrade,applyInverseSoftLossExits,applyDeskOrderExits,markInversePositions,recordInverseCurve,assertInverseTrial} from './shadow-inverse-ledger.ts';
import {ensureResearchDesk,observeResearch} from './research-decision.ts';
import {applyNeedleBook,NEEDLE_POLICY,NEEDLE_EPOCH,NEEDLE_BEFORE} from './needle-book.ts';
import {applyBrainBook,BRAIN_POLICY,BRAIN_EPOCH,BRAIN_BEFORE} from './research-brain.ts';
import {applyScoreBook,SCORE_POLICY,SCORE_EPOCH,SCORE_BEFORE} from './score-book.ts';
import {applyReadBook,READ_POLICY,READ_EPOCH,READ_BEFORE} from './read-book.ts';
import {applyStretchBook,STRETCH_POLICY} from './stretch-book.ts';
import {noteForwardStudy} from './forward-study.ts';
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
      reason:'研究提案固定；新单按决策开仓，已经开着的单按原来的出场'});
  }
  const sourceBefore=sourceDecisionState(s),source=advanceBaseline({...input,state:sourceBefore,allocationEquity:FIXED_ALLOCATION_EQUITY}),trial=s.inverseTrial!;
  // Observers cannot influence source decisions; baseline entries carry the
  // frozen code identity even though a newer build hosts the adapter.
  try{captureTradeReviews(sourceBefore,source.state,input.now,SHADOW_BASELINE_BUILD,
    '8dbebcae5e0ca7b48c939e66dc98fce02b35dbed99e41d2dcf950e9008ee4f24',input.quotes);}catch{/* optional diagnostic */}
  for(const key of SHARED_MARKET_KEYS)Object.assign(s,{[key]:structuredClone(source.state[key])});
  trial.researchDesk=ensureResearchDesk(trial.researchDesk);
  let researchChanged=false;
  if(trial.paperPolicy!=='reverse-v1'){
    try{researchChanged=observeResearch(trial.researchDesk,input.quotes,input.now);}catch{researchChanged=false;}
  }
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
  if(trial.entryHaltSkipped?.length){
    const open=new Set(trial.source.positions.map(p=>p.id));
    trial.entryHaltSkipped=trial.entryHaltSkipped.filter(id=>open.has(id));
    if(!trial.entryHaltSkipped.length)delete trial.entryHaltSkipped;
  }
  if(trial.detachedSourceIds?.length){
    const open=new Set(trial.source.positions.map(p=>p.id));
    trial.detachedSourceIds=trial.detachedSourceIds.filter(id=>open.has(id));
    if(!trial.detachedSourceIds.length)delete trial.detachedSourceIds;
  }
  noteForwardStudy(trial,input.now);
  markInversePositions(s,input.quotes,input.now);
  const softLoss=applyInverseSoftLossExits(s,input.now);
  const deskExit=applyDeskOrderExits(s,input.quotes,input.now);
  const needle=applyNeedleBook(s,input.minutePaths,input.quotes,input.contracts,input.now);
  const brain=applyBrainBook(s,input.paths,input.minutePaths,input.quotes,input.contracts,input.now);
  const score=applyScoreBook(s,input.paths,input.minutePaths,input.quotes,input.contracts,input.now);
  const read=applyReadBook(s,input.paths,input.minutePaths,input.quotes,input.contracts,input.now);
  const stretch=applyStretchBook(s,input.paths,input.quotes,input.contracts,input.now);
  recordInverseCurve(s,input.quotes,input.now);
  if(trial.paperPolicy===NEEDLE_POLICY||trial.paperPolicy===BRAIN_POLICY||trial.paperPolicy===SCORE_POLICY||trial.paperPolicy===READ_POLICY||trial.paperPolicy===STRETCH_POLICY){
    const eq=forwardEquity(s,input.quotes,input.now).equity,last=trial.curve.at(-1);
    if(last&&input.now-last.at<60_000)last.inverse=eq;
  }
  const mark=forwardEquity(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));
  const day=beijingDayKey(input.now),daily=s.daily.at(-1);
  if(daily?.day===day){daily.lastAt=input.now;daily.endEquity=mark.equity;}
  else s.daily.push({day,firstAt:input.now,lastAt:input.now,startEquity:mark.equity,endEquity:mark.equity,exactBoundary:false});
  s.daily=s.daily.slice(-45);
  const stance=trial.researchDesk?.stance??'FORWARD';
  const note=trial.researchDesk?.note||'';
  const needleOpen=s.positions.filter(t=>t.exitControl?.policy===NEEDLE_POLICY).length;
  const brainOpen=s.positions.filter(t=>t.exitControl?.policy===BRAIN_POLICY).length;
  const scoreOpen=s.positions.filter(t=>t.exitControl?.policy===SCORE_POLICY).length;
  const readOpen=s.positions.filter(t=>t.exitControl?.policy===READ_POLICY).length;
  const stretchOpen=s.positions.filter(t=>t.exitControl?.policy===STRETCH_POLICY).length;
  s.latestReason=trial.paperPolicy===STRETCH_POLICY
    ?`${trial.stretchNote||'大盘这两小时还没有走出一段。'}现在 ${stretchOpen} 笔。`
    :trial.paperPolicy==='reverse-v1'
    ?`只跟提案反着做。现在 ${s.positions.filter(t=>t.inverseCopy?.alignment==='AGAINST_SOURCE').length} 笔。`
    :trial.paperPolicy===READ_POLICY
    ?`${trial.readNote||'最近这段还没有看完。'}现在 ${readOpen} 笔。`
    :trial.paperPolicy===SCORE_POLICY
    ?`${trial.scoreNote||'研究还没有记下足够的半小时。'}现在 ${scoreOpen} 笔。`
    :trial.paperPolicy===BRAIN_POLICY
    ?`${trial.brainNote||'研究还没有整盘结论。'}决策现在 ${brainOpen} 笔。`
    :trial.paperPolicy===NEEDLE_POLICY
    ?`只做收回来的针。向上做空，向下做多。现在 ${needleOpen} 笔。`
    :stance==='FLAT'
    ?`${note}新单先停。已经开着的按各自出场。已记下${trial.totals.opened}笔。`
    :stance==='REVERSE'
    ?`${note}新单反着做。已记下${trial.totals.opened}笔。`
    :`${note}新单跟提案同一边。已记下${trial.totals.opened}笔。`;
  assertInverseTrial(s);
  return{state:s,changed:activated||source.changed||softLoss||deskExit||needle||brain||score||read||stretch||researchChanged||beforeFinancial!==JSON.stringify([s.balance,s.resolved,s.positions.map(t=>[t.id,t.stopPrice,t.contracts])]),
    protectionChanged:source.protectionChanged};
}

export const DESK_CLEAN_EPOCH='desk-clean-2026-10-08' as const;
/** Books opened before this still belong to the pre-desk ledger. */
export const DESK_CLEAN_BEFORE=Date.parse('2026-10-08T06:30:00Z');

/** Delete the old order book and both wallets. Market memory and the research
 * desk stay, so the next order still follows the current decision. */
export function freshDeskLedger(previous:ForwardState,now:number):ForwardState{
  const desk=previous.inverseTrial?.researchDesk;
  const next=resetForwardAccountPreservingLearning(previous,now);
  next.inverseTrial=newInverseTrial(next,now,next.initialEquity);
  if(desk)next.inverseTrial.researchDesk=ensureResearchDesk(structuredClone(desk));
  next.latestReason='旧订单和旧账本已删除。模拟账户从1000U重新开始，决策样本保留，新单按当前决策开。';
  assertInverseTrial(next);
  return next;
}

/** One clean paper book for the needle rules. Drops proposal copies. */
export function freshNeedleLedger(previous:ForwardState,now:number):ForwardState{
  const next=resetForwardAccountPreservingLearning(previous,now);
  next.lastExitAt={};
  next.inverseTrial=newInverseTrial(next,now,next.initialEquity);
  next.inverseTrial.paperPolicy=NEEDLE_POLICY;
  next.latestReason='模拟账户从1000U按针的规则重新开始。不再跟着提案开仓。';
  assertInverseTrial(next);
  return next;
}

/** One clean paper book. BTC's two-hour stretch, then at most two larger orders. */
export function freshStretchLedger(previous:ForwardState,now:number):ForwardState{
  const next=resetForwardAccountPreservingLearning(previous,now);
  next.lastExitAt={};
  next.inverseTrial=newInverseTrial(next,now,next.initialEquity);
  next.inverseTrial.paperPolicy=STRETCH_POLICY;
  next.latestReason='模拟账户从1000U重新开始。大盘走出一段才做，每笔按权益的2倍。';
  assertInverseTrial(next);
  return next;
}

/** One clean paper book that copies each proposal on the opposite side. */
export const REVERSE_EPOCH='reverse-standalone-2026-10-10' as const;
export function freshReverseLedger(previous:ForwardState,now:number):ForwardState{
  const next=resetForwardAccountPreservingLearning(previous,now);
  next.lastExitAt={};
  next.inverseTrial=newInverseTrial(next,now,next.initialEquity);
  next.inverseTrial.paperPolicy='reverse-v1';
  next.inverseTrial.researchDesk={version:'research-desk-v1',stance:'REVERSE',claims:[],
    note:'这套不看样本。每一笔提案都反着做。'};
  next.latestReason='模拟账户从1000U重新开始。只跟提案反着做。';
  assertInverseTrial(next);
  return next;
}

/** One clean paper book. Research proposes. Decision trades. Proposal copies are dropped. */
export function freshBrainLedger(previous:ForwardState,now:number):ForwardState{
  const next=resetForwardAccountPreservingLearning(previous,now);
  next.lastExitAt={};
  next.inverseTrial=newInverseTrial(next,now,next.initialEquity);
  next.inverseTrial.paperPolicy=BRAIN_POLICY;
  next.latestReason='模拟账户从1000U重新开始。研究先看整盘和单币，决策再决定做不做。';
  assertInverseTrial(next);
  return next;
}

/** One clean paper book. Half-hour scores decide the side. Proposal copies are dropped. */
export function freshScoreLedger(previous:ForwardState,now:number):ForwardState{
  const next=resetForwardAccountPreservingLearning(previous,now);
  next.lastExitAt={};
  next.inverseTrial=newInverseTrial(next,now,next.initialEquity);
  next.inverseTrial.paperPolicy=SCORE_POLICY;
  next.latestReason='模拟账户从1000U重新开始。先按半小时记分，核对通过才下单。';
  assertInverseTrial(next);
  return next;
}

/** One clean paper book. Read the recent stretch, then trade one wave. */
export function freshReadLedger(previous:ForwardState,now:number):ForwardState{
  const next=resetForwardAccountPreservingLearning(previous,now);
  next.lastExitAt={};
  next.inverseTrial=newInverseTrial(next,now,next.initialEquity);
  next.inverseTrial.paperPolicy=READ_POLICY;
  next.latestReason='模拟账户从1000U重新开始。先看最近这段走到哪，再决定做不做。';
  assertInverseTrial(next);
  return next;
}

export {NEEDLE_EPOCH,NEEDLE_BEFORE,BRAIN_EPOCH,BRAIN_BEFORE,SCORE_EPOCH,SCORE_BEFORE,READ_EPOCH,READ_BEFORE};
