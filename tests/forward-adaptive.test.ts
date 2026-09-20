import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveCandidatePriority, adaptiveEntryAdjustment, adaptiveTargetRisk, inspectRapidCondition } from "../lib/forward-adaptive.ts";
import { EVIDENCE_POLICY, blankDiagnostics, familyKey, inspectCondition } from "../lib/forward-evidence.ts";
import type { Measurement, Rule } from "../lib/forward-relations.ts";
import type { TurnForecast } from "../lib/forward-market-state.ts";
import type { MarketTurnProtection } from "../lib/forward-turn-protection.ts";

const BAR=300_000,BASE=1_790_300_000_000;
function measurements(groupReturns:number[],symbols=8):Measurement[]{
  return groupReturns.flatMap((response,g)=>Array.from({length:symbols},(_,i)=>{
    const at=BASE+g*15*60_000,symbol=`M${i}_USDT`,up=response>0?Math.abs(response)*1.3:.002,down=response<0?Math.abs(response)*1.3:.002;
    return{symbol,at,seenAt:at+BAR,price:100,x:[1,0,0,0,0,0,0,0],horizon:15,
      endAt:at+15*60_000,availableAt:at+15*60_000+1000,response,up,down};
  }));
}
function baseRule(side:"LONG"|"SHORT"="LONG",horizon=60):Rule{
  const r:Rule={id:"r",signature:"r",parentId:null,version:1,createdAt:BASE,expiresAt:BASE+86_400_000,status:"EXPERIMENTAL",
    conditions:[{feature:0,op:"GE",threshold:0}],side,horizon,stopRate:.02,armRate:.015,givebackRate:.006,exitMode:"REACTION_DECAY",
    samples:30,trainGroups:5,checkGroups:3,estimatedNetRate:.01,priorResponse:.01,recentResponse:.012,standardError:.001,
    reason:"fixture",mutation:"CREATE",grammar:"fixture",liveEligible:false};
  r.evidence={policy:EVIDENCE_POLICY,scope:"CROSS_ASSET",symbols:["M0_USDT"],sourceKey:"fixture",family:familyKey(r),cap:.03,
    rawNet:.01,boundedNet:.009,calibratedNet:.008,costRate:.0022,quality:.8,worstWithoutSymbol:.006,
    calibration:{groups:0,effectiveGroups:0,penalty:0,meanResidual:0,meanNet:0,latestAt:0,sourceKey:"fixture"}};
  return r;
}

test("rapid lane can recognize a recent conditional reversal without relabeling older outcomes",()=>{
  const rows=measurements([.007,.007,.006,.006,.006,-.012,-.011,-.013]);
  const now=rows.at(-1)!.availableAt+1000;
  const c=inspectRapidCondition({rows,conditions:[{feature:0,op:"GE",threshold:0}],now,feedback:[]});
  assert.ok(c);assert.equal(c!.adaptiveLane,"RAPID_15M");assert.equal(c!.side,"SHORT");
  assert.equal(c!.checkGroups,3);assert.ok(c!.estimatedNetRate>0);assert.ok((c!.evidence.boundedNet??0)>0);
  assert.ok(c!.evidence.quality<=.85);assert.match(c!.evidence.warnings?.join("；")??"",/快速适应层/);
});

test("rapid lane fills the transition gap when the slow chronological learner has not yet qualified the new side",()=>{
  const rows=measurements([.008,.008,.008,.008,.008,.008,.008,.008,.008,-.015,-.015,-.015]);
  const now=rows.at(-1)!.availableAt+1000,conditions=[{feature:0,op:"GE" as const,threshold:0}];
  const slow=inspectCondition({rows,conditions,horizon:15,now,feedback:[]},blankDiagnostics());
  const fast=inspectRapidCondition({rows,conditions,now,feedback:[]});
  assert.equal(slow,null,"mixed old/new chronology should not fabricate a slow edge during regime migration");
  assert.ok(fast);assert.equal(fast!.side,"SHORT");assert.equal(fast!.adaptiveLane,"RAPID_15M");
});

test("rapid lane rejects noisy or cost-negative recent groups instead of forcing a reversal",()=>{
  const weak=measurements([.006,.006,.006,.001,-.001,.001]);
  const now=weak.at(-1)!.availableAt+1000;
  assert.equal(inspectRapidCondition({rows:weak,conditions:[{feature:0,op:"GE",threshold:0}],now,feedback:[]}),null);
  const noisy=measurements([.006,.006,.006,.012,-.012,.012]);
  assert.equal(inspectRapidCondition({rows:noisy,conditions:[{feature:0,op:"GE",threshold:0}],now,feedback:[]}),null);
});

test("pullback and reversal warnings migrate learned risk continuously instead of hard-zeroing it",()=>{
  const pullback={phase:"PULLBACK",lastFreshPhase:"PULLBACK",threatenedSide:"LONG",pressure:.6} as unknown as TurnForecast;
  const long=adaptiveEntryAdjustment({side:"LONG",horizon:60,state:null,forecast:pullback,turn:null});
  const short=adaptiveEntryAdjustment({side:"SHORT",horizon:60,state:null,forecast:pullback,turn:null});
  assert.ok(long.riskMultiplier>0&&long.riskMultiplier<1);assert.ok(short.riskMultiplier>0);
  assert.ok(short.priorityMultiplier>long.priorityMultiplier);

  const reversal={...pullback,phase:"REVERSAL_RISK",lastFreshPhase:"REVERSAL_RISK",pressure:1} as unknown as TurnForecast;
  const threatened=adaptiveEntryAdjustment({side:"LONG",horizon:60,state:null,forecast:reversal,turn:null});
  const opposite=adaptiveEntryAdjustment({side:"SHORT",horizon:60,state:null,forecast:reversal,turn:null});
  assert.equal(threatened.riskMultiplier,.3);assert.ok(opposite.priorityMultiplier>1);
  assert.ok(threatened.riskMultiplier>0,"market warning must not become a trading pause");
});

test("unconfirmed long-horizon countertrend is throttled rather than blocked",()=>{
  const forecast={phase:"REVERSAL_RISK",lastFreshPhase:"REVERSAL_RISK",threatenedSide:"LONG",pressure:1} as unknown as TurnForecast;
  const a=adaptiveEntryAdjustment({side:"SHORT",horizon:180,state:null,forecast,turn:null});
  assert.equal(a.riskMultiplier,.55);assert.ok(a.priorityMultiplier>0);
});

test("severe synchronized turn protection retains a small learned probe allocation",()=>{
  const turn={until:BASE+60_000,threatenedSide:"LONG"} as unknown as MarketTurnProtection;
  const a=adaptiveEntryAdjustment({side:"LONG",horizon:15,state:null,forecast:null,turn});
  assert.equal(a.riskMultiplier,.2);assert.ok(a.priorityMultiplier>0);
});

test("drawdown scaling and turn scaling reduce size without introducing a peer-count starvation term",()=>{
  const risk=adaptiveTargetRisk({equity:1000,quality:.8,allocationScale:.7,riskMultiplier:.5,stateHeadroom:20});
  assert.ok(Math.abs(risk-4.2)<1e-12);
  assert.ok(Math.abs(adaptiveTargetRisk({equity:1000,quality:.8,allocationScale:.55,riskMultiplier:.2,stateHeadroom:20})-1.32)<1e-12);
  assert.ok(risk>0);
  const many=adaptiveTargetRisk({equity:1000,quality:1,allocationScale:1,riskMultiplier:1,stateHeadroom:20,
    readyPeers:30,minimumMeaningfulRisk:1.1});
  assert.ok(many>=1.1);assert.ok(many>20/30,"ready names must not pre-divide every order below meaningful size");
});

test("adaptive priority favors fresh opposite migration without overriding learned evidence",()=>{
  const rule=baseRule("SHORT",60);
  const normal=adaptiveEntryAdjustment({side:"SHORT",horizon:60,state:null,forecast:null,turn:null});
  const reversal={phase:"REVERSAL_RISK",lastFreshPhase:"REVERSAL_RISK",threatenedSide:"LONG",pressure:1} as unknown as TurnForecast;
  const migrate=adaptiveEntryAdjustment({side:"SHORT",horizon:60,state:null,forecast:reversal,turn:null});
  assert.ok(adaptiveCandidatePriority(rule,migrate)>adaptiveCandidatePriority(rule,normal));
});
