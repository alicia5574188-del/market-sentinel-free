/**
 * Byte measurement for the forward hot JSON. Read-only, never writes storage.
 *   node --experimental-strip-types scripts/measure-hot-state.ts <run-log-export.json> [raw-forward-state.json]
 * With a raw decoded ForwardState (second arg) it prints the real per-field bytes of the hot projection.
 * Without it, it prints EXACT sizes of the logging fields (built with the real functions from the export's
 * real ids/symbols/timestamps) and ESTIMATED sizes for unopened trades (synthetic but full-shape rows).
 */
import {readFileSync} from "node:fs";
import {backfillSignalTally} from "../lib/signal-repeat.ts";
import {initialStageChronicle,type StageChange} from "../lib/stage-chronicle.ts";
import {hotProjectionForMeasure} from "../lib/forward-store.ts";

const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)??"").length;
const exportFile=process.argv[2],stateFile=process.argv[3];
const out:Record<string,unknown>={};

if(stateFile){
  const state=JSON.parse(readFileSync(stateFile,"utf8"));
  const hot=hotProjectionForMeasure(state,Date.now());
  const rows=Object.entries(hot.account as Record<string,unknown>).map(([k,v])=>[k,bytes(v)] as const).sort((a,b)=>b[1]-a[1]);
  out.realHotBytes=hot.raw.length;out.realTopFields=rows.slice(0,25);
  const it=(state.inverseTrial??{}) as Record<string,unknown>;
  out.realInverseTrialFields=Object.entries(it).map(([k,v])=>[k,bytes(v)] as const).sort((a,b)=>b[1]-a[1]).slice(0,20);
  console.log(JSON.stringify(out,null,1));process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose export rows, measurement only
type Row=Record<string,any>;
const ex=JSON.parse(readFileSync(exportFile,"utf8")) as {not_opened:Row[];positions:Row[];stageTimeline:unknown[]};
const rows=[...ex.not_opened,...ex.positions];
// 1) signalTally: real backfill over the export's real rows (exact for these rows)
const tallyRows=rows.map(r=>({id:String(r.id),symbol:String(r.symbol),side:r.side,openedAt:Number(r.opened_at),status:r.closed_at?"CLOSED":"OPEN",
  netPct:r.net_pnl!=null&&r.notional>0?r.net_pnl/r.notional*100:null,mfePct:typeof r.mfe==="number"?r.mfe*100:0.8123456789,maePct:0.4123456789}));
const tally=backfillSignalTally(tallyRows).tally;
out.signalTally={rows:tallyRows.length,keys:Object.keys(tally).length,bytes:bytes(tally),perKey:Math.round(bytes(tally)/Object.keys(tally).length),
  cap2000Bytes:Math.round(bytes(tally)/Object.keys(tally).length*2000)};
// 2) stageChronicle changes with snap+fwd (exact shape)
const ch:StageChange={at:1792251605995,stage:"TRANSITION",prior:"TREND",trendSide:"SHORT",
  snap:{sync:0.6123,breadth:0.5512,expansion:0.4421,aligned_flow:-0.1234,pressure:0.3312,persistence:0.5521,btc:67123.45,eth:2612.355,factor:1.2345678901234567},
  fwd:{m30:{btc_pct:-0.12,eth_pct:-0.2,factor_pct:-0.31,at:1792253405995},m60:{btc_pct:-0.22,eth_pct:-0.3,factor_pct:-0.41,at:1792255205995},m120:{btc_pct:0.12,eth_pct:0.1,factor_pct:0.05,at:1792258805995}}};
const chron={...initialStageChronicle(1792251605995),changes:Array.from({length:7},()=>ch)};
out.stageChronicle={nowChanges:ex.stageTimeline.length,perChange:bytes(ch),bytesAt7:bytes(chron),cap2000Bytes:bytes(ch)*2000,
  perDayAtObservedRate:"~7 changes/12h => ~14/day"};
// 3) per-trade logging additions (exact shape)
const entrySnap={mode:"RELATIVE",trade_plan:"CONTINUATION",intent:"RELATIVE_CORE",long_score:61.2345,short_score:44.1234,residual_z:-1.2345678,
  score:78.123456,stop_price:0.123456789,planned_hold_min:240,volume24h_usd:12345678.12,funding_rate:0.0001,trend_score:0.1234,factor_30m_pct:-0.12};
const repeatExtra={nSymbol:3,prevSide:"LONG",prevGapMin:123.4,prevNetPct:-0.512345678,prevMfePct:0.812345678};
out.perTrade={entrySnap:bytes({entrySnap}),signalRepeatExtra:bytes(repeatExtra)};
// 4) ESTIMATE: one full-shape unopened intelligence trade (synthetic text lengths, real numeric shape)
const zh=(n:number)=>"市场关系分化与跨所资金流向确认".repeat(Math.ceil(n/16)).slice(0,n);
const r0=ex.not_opened[0]!;
const t={id:r0.id,symbol:r0.symbol,side:r0.side,openedAt:r0.opened_at,closedAt:r0.closed_at,status:"CLOSED",entryPrice:r0.entry,exitPrice:r0.exit,
  quantity:r0.qty,contracts:123,quantoMultiplier:1,notional:r0.notional,leverage:6,margin:16.67,plannedRisk:1.2,stopPrice:0.98*r0.entry,armPrice:1.01*r0.entry,
  favorable:0.0123,adverse:0.0081,lastPrice:r0.exit,lastQuoteAt:r0.closed_at,entryFee:0.07,exitFee:0.07,fundingAllowance:0,grossPnl:r0.gross_pnl,netPnl:r0.net_pnl,
  exitReason:r0.exit_trigger,relationFailureBars:0,lastRelationBar:r0.opened_at,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,unopened:true,
  rule:{id:"market-intelligence-v1:RELATIVE",signature:"market-intelligence-v1",parentId:null,version:1,createdAt:r0.opened_at,expiresAt:r0.opened_at+864e5,status:"EXPERIMENTAL",
    conditions:[],side:r0.side,horizon:60,stopRate:0.02,armRate:0.01,givebackRate:0.005,exitMode:"REACTION_DECAY",samples:0,trainGroups:0,checkGroups:0,
    estimatedNetRate:0.004,priorResponse:null,recentResponse:null,standardError:0,reason:zh(120),mutation:"CREATE",grammar:"market-intelligence-v1",liveEligible:false},
  entryContext:{winnerPlan:{version:"winner-preservation-v1",intent:"RELATIVE_CORE",eventAt:r0.opened_at,initialStop:0.98*r0.entry,target:1.03*r0.entry,
      targetArea:{lower:1.02*r0.entry,upper:1.04*r0.entry,center:1.03*r0.entry,strength:0.7},origin:{lower:0.99*r0.entry,upper:r0.entry,center:0.995*r0.entry,strength:0.6},riskGroup:"corr:"+r0.symbol,source:"RELATIVE_CORE"},
    version:"adaptive-ten-entry-v1",capturedAt:r0.opened_at,timeframe:"5m",side:r0.side,mode:"RELATIVE",reserve:false,reason:zh(260),
    entryScore:81.2345,directionStrength:77.123,spaceScore:70.12,positionScore:68.9,executionScore:90.1,remainingSpaceRate:0.0234,pullbackRiskRate:0.0091,edgeRatio:2.5712,
    expectedHoldMinutes:240,marketFit:72.3,regionId:null,strategyVersion:"market-intelligence-v1",regime:"DIVERGENT",confirmationStage:"READY",sourceCount:3,disagreementRate:0.0002,
    postEntryState:"PENDING",entryResponse:{version:"entry-response-v2",startedAt:r0.opened_at-60000,confirmedAt:r0.opened_at,elapsedMs:60000,samples:30,advanceRate:0.0012,bestAdvanceRate:0.0021,maxAdverseRate:0.0008,supportFamilies:["RELATIVE","FLOW"],fastLane:false},
    clusterId:"corr:"+r0.symbol,thesisId:`market-intelligence-v1:${r0.symbol}:${r0.side}:${r0.opened_at}`,marketNarrativeId:"mi-1792250000000",thesisSummary:zh(220),invalidationSummary:zh(160),
    entryResidual:0.0123,entryRelativeStrength:0.7123,thesisSince:r0.opened_at-9e5,thesisBars:3,marketEvolutionPhase:"TRANSITION",opportunityLifecyclePhase:"EMERGING",extendedConfirmation:false,
    environment:"TRANSITION",playbook:"OBSERVE",routeAlignment:"NEUTRAL",environmentRiskScale:0.5,environmentProbe:true,environmentReason:zh(140),environmentOutlookVersion:"environment-outlook-v1",
    environmentModeFit:0.61,environmentHorizonMinutes:60,environmentPersistenceScore:0.55,environmentTransitionPressure:0.33,environmentProfitExpansion:"NORMAL",marketExpectancy:0.0123,
    tradePlan:"CONTINUATION",liquidityPlanConfidence:0.62,liquidityReason:zh(120),liquidityTargetRate:0.02,liquidityOriginLower:0.99*r0.entry,liquidityOriginUpper:r0.entry,
    liquidityTargetLower:1.02*r0.entry,liquidityTargetUpper:1.04*r0.entry,liquidityInvalidationPrice:0.98*r0.entry,rapidLiquidityAuthorization:false,
    futureResearchAction:"KEEP",futureResearchReason:zh(100),futureHypothesisIds:["h-1","h-2","h-3"],
    entryStructure:{version:"entry-structure-v1",label:"PULLBACK",distance:0.0123,bars:4,score:0.6},
    stageNote:{liveStage:"TRANSITION",priorStage:"TREND",stageAgeMin:123.4,minutesSinceShock:null,shockPush:0,syncDrop:null},
    entryRead:{trendSide:null,withTrend:null,book:0.1234,residual:0.0123,relativeStrength:0.7123,move30:0.0123,sync:0.6123,breadth:0.5512},
    coinPath:{background:"UP",recent:"PULLBACK",label:"UP_PULLBACK",backgroundPct:0.0234,recentPct:-0.0081,windowMin:240},entrySnap},
  forecast:{remainingNetRate:0.0123,quality:0.78,sizingEquity:1000},expectedHoldMinutes:240,
  positionIntelligence:{version:"position-intelligence-v1",updatedAt:r0.closed_at,decision:"HOLD",phase:"BUILDING",reviewSince:null,reviewBars:0,lastCompletedBar:r0.closed_at,
    entryAdvantage:81,currentAdvantage:74,advantageChange:-7,remainingSpaceRate:0.0123,expectedPullbackRate:0.009,continuationRatio:1.4,holdValueScore:66,exitValueScore:34,dataConfidence:90,
    counterfactualNewEntry:false,supportFamilies:["RELATIVE","FLOW"],concernFamilies:["PATH"],
    assessments:["RELATIVE","PATH","FLOW","STRUCTURE","MARKET"].map((family,j)=>({family,stance:j<2?"SUPPORT":"CONCERN",severity:0.6,summary:zh(90),contextOnly:j===4})),
    reasons:[zh(80),zh(80)],concerns:[zh(80)],summary:zh(120)},
  signalRepeat:{n:2,gapMin:120.5,...repeatExtra},entrySpreadBps:5.12};
const per=bytes(t),perNoPI=bytes({...t,positionIntelligence:undefined});
out.unopenedTradeEstimate={label:"ESTIMATE (synthetic full-shape row, text lengths guessed)",perRow:per,perRowWithoutPI:perNoPI,
  rowsInExport:ex.not_opened.length,bytesAt307:per*307,bytesAt800:per*800,growthPerHourAt12_6:Math.round(per*12.6)};
console.log(JSON.stringify(out,null,1));
