"""One-shot, exact-source guarded construction on an isolated review branch."""
from pathlib import Path
import subprocess
import json

EXPECTED = {
 'lib/position-intelligence-engine.ts':'bdf491c9a4d9dd5f0ad225198f36799aaaf8d527',
 'lib/forward-relations.ts':'8d520c99f8421156f74e13a0b3ab114025acceda',
 'tests/market-intelligence-engine.test.ts':'dd58ac4d0c96cefd536c341daee302ac158b6bd6',
 'package.json':'e7e21db20990211b33c7421cca0d81b1fea929e1',
}
for path, sha in EXPECTED.items():
    actual=subprocess.check_output(['git','hash-object',path],text=True).strip()
    if actual!=sha: raise RuntimeError(f'Unreviewed base for {path}: {actual}')

def replace(s,old,new,count=1):
    if s.count(old)!=count: raise RuntimeError(f'Expected {count} exact matches, got {s.count(old)}: {old[:150]}')
    return s.replace(old,new)

p=Path('lib/position-intelligence-engine.ts');s=p.read_text()
s=replace(s,'import type {SymbolLiquidityMap} from "./market-intelligence-liquidity.ts";', '''import type {SymbolLiquidityMap} from "./market-intelligence-liquidity.ts";
import {advancePositionReview,capturePositionBaseline,positionAdvantage,validPositionBaseline,
  type PositionBaseline,type PositionReviewMemory} from "./position-evidence-contract.ts";''')
s=replace(s,'  entryAdvantage:number;', '''  baseline?:PositionBaseline;
  reviewMemory?:PositionReviewMemory;
  reviewCandidate?:boolean;
  entryConflict?:boolean;
  exitBasis?:"ENTRY_PRICE_FALSIFIED"|"PERSISTENT_ENTRY_FAILURE"|"PERSISTENT_VALUE_LOSS"|null;
  entryAdvantage:number;''')
s=replace(s,'type QuoteDetail={','type QuoteDetail={\n  observedAt?:number;')
s=replace(s,'  previous?:PositionIntelligenceState;costRate?:number;marketStateAgeMs?:number;entryResponseValidated?:boolean;', '''  previous?:PositionIntelligenceState;costRate?:number;marketStateAgeMs?:number;entryResponseValidated?:boolean;
  openedAt?:number;entryBaseline?:PositionBaseline;''')
s=replace(s,'    currentAdvantage=clip((same*.55+(50+alignedZ*14)*.20+pathSide*100*.15+(50+alignedPressure*25)*.10),0,100),\n    entryAdvantage=clip(input.entryScore,0,100),advantageChange=currentAdvantage-entryAdvantage,', '''    // Quality/ranking scores are not comparable to the position-advantage scale.
    // Old positions acquire an explicitly RECOVERED baseline, never a fake entry.
    openedAt=input.openedAt??input.now-Math.max(0,input.ageMin)*60_000,
    currentAdvantage=positionAdvantage(input.side,state)??50,
    baseline=validPositionBaseline(input.entryBaseline,input.now)?input.entryBaseline:
      validPositionBaseline(input.previous?.baseline,input.now)?input.previous!.baseline:
      (input.marketStateAgeMs??0)<=8*60_000?capturePositionBaseline(input.side,state,input.now,"RECOVERED"):undefined,
    entryAdvantage=baseline?.score??currentAdvantage,advantageChange=baseline?currentAdvantage-entryAdvantage:0,''')
s=replace(s,'    entryFalsified=entryNeverProved&&entryFailureConcern&&supportFamilies.length===0&&dataConfidence>=70\n      &&input.signedRate<=-entryFalsificationAdverse&&advantageChange<-18,', '''    // Historical minute context can inform value, but cannot alone masquerade
    // as a newly observed post-entry failure. Hard price stops remain separate.
    evidenceAfter=Math.max(openedAt,baseline?.at??input.now),
    freshFlowFailure=concernFamilies.includes("FLOW")&&typeof q?.observedAt==="number"
      &&q.observedAt>evidenceAfter&&q.observedAt<=input.now&&input.now-q.observedAt<=10_000,
    freshPathFailure=concernFamilies.includes("PATH")&&(input.minutePath??[]).some(r=>
      r.time*1000>=evidenceAfter&&r.time*1000+60_000<=input.now&&r.open>0&&r.close>0&&d*(r.close/r.open-1)<0),
    entryFalsified=entryNeverProved&&entryFailureConcern&&supportFamilies.length===0&&dataConfidence>=70
      &&(freshFlowFailure||freshPathFailure)&&input.signedRate<=-entryFalsificationAdverse&&advantageChange<-18,''')
s=replace(s,'''    prior=input.previous,newCompletedBar=completedBar>0&&completedBar>(prior?.lastCompletedBar??0),
    continuedReview=shouldReview&&prior&&(prior.decision==="REVIEW"||prior.decision==="EXIT"),
    reviewBars=shouldReview?(continuedReview?(prior.reviewBars+(newCompletedBar?1:0)):1):0,
    reviewSince=shouldReview?(continuedReview?prior.reviewSince??input.now:input.now):null,''', '''    recovering=concernFamilies.length===0&&supportFamilies.length>=2&&holdValueScore>=55&&continuationRatio>=1.35
      &&supportFamilies.some(f=>f==="RELATIVE"||f==="STRUCTURE"||f==="LIQUIDITY")
      &&supportFamilies.some(f=>f==="PATH"||f==="FLOW"),
    reviewMemory=advancePositionReview({now:input.now,openedAt,barAt:completedBar,concern:shouldReview,
      recovering,dataReady:!!state&&dataConfidence>=60,previous:input.previous?.reviewMemory}),
    reviewBars=reviewMemory.confirmations,reviewSince=reviewMemory.since,''')
s=replace(s,'    decision:PositionDecision=entryFalsified||hardExit||unconfirmedFailure?"EXIT":shouldReview?"REVIEW":"HOLD",', '''    entryConflict=enoughIndependentConcern&&valueWeak&&dataConfidence>=60,
    exitBasis:PositionIntelligenceState["exitBasis"]=entryFalsified?"ENTRY_PRICE_FALSIFIED":
      unconfirmedFailure?"PERSISTENT_ENTRY_FAILURE":hardExit?"PERSISTENT_VALUE_LOSS":null,
    decision:PositionDecision=exitBasis?"EXIT":reviewSince!=null?"REVIEW":"HOLD",''')
s=replace(s,'''        :`继续等待的剩余空间/正常回撤比已降至 ${continuationRatio.toFixed(2)}×，且至少两个独立仓位证据家族持续恶化；退出通过防误杀闸门。`''', '''        :unconfirmedFailure
          ?`入场位置失败：未形成有效正向证明，结构与独立反证在新的完成K线后仍未恢复，逆向幅度超过该交易的证伪条件。`
          :`持续复核后退出：${continuationRatio<.95?`剩余空间/正常回撤仅 ${continuationRatio.toFixed(2)}×`:`持仓价值评分 ${holdValueScore.toFixed(0)}，低于38`}；原始空间/回撤比 ${continuationRatio.toFixed(2)}×，${concernFamilies.join("、")} 仍提供反证。`''')
s=replace(s,'''      ?`发现矛盾但证据尚未收敛：剩余空间/正常回撤约 ${continuationRatio.toFixed(2)}×，进入复核，不因单一细节平仓。`''', '''      ?shouldReview
        ?`发现矛盾但证据尚未收敛：剩余空间/正常回撤约 ${continuationRatio.toFixed(2)}×，继续复核，不因单一细节平仓。`
        :"短时反证减弱，但尚未形成持续恢复证据；保留复核记录，本次不增加确认也不触发价值退出。"''')
s=replace(s,'    entryAdvantage,currentAdvantage,advantageChange,remainingSpaceRate,', '    baseline,reviewMemory,reviewCandidate:shouldReview,entryConflict,exitBasis,\n    entryAdvantage,currentAdvantage,advantageChange,remainingSpaceRate,')
p.write_text(s)

p=Path('lib/forward-relations.ts');s=p.read_text()
s=replace(s,'  type PositionIntelligenceState } from "./position-intelligence-engine.ts";', '''  type PositionIntelligenceState } from "./position-intelligence-engine.ts";
import {capturePositionBaseline} from "./position-evidence-contract.ts";''')
s=replace(s,'      now,side:t.side,signedRate:signed,peakFavorableRate:t.favorable,ageMin,firstProfit:!!t.firstProfitAt,', '      now,openedAt:t.openedAt,side:t.side,signedRate:signed,peakFavorableRate:t.favorable,ageMin,firstProfit:!!t.firstProfitAt,')
s=replace(s,'originalStopRate,decision:position.decision,\n      reviewBars:position.reviewBars,', 'originalStopRate,decision:position.reviewCandidate===false?"HOLD":position.decision,\n      reviewBars:position.reviewBars,')
s=replace(s,'{authority:"POSITION_INTELLIGENCE",decision:position.decision,quoteAt:q!.observedAt,reviewBars:position.reviewBars,barAt:position.lastCompletedBar}', '''{authority:"POSITION_INTELLIGENCE",decision:position.decision,quoteAt:q!.observedAt,
        reviewBars:position.reviewBars,barAt:position.lastCompletedBar,reviewSince:position.reviewSince,
        exitBasis:position.exitBasis??null,baselineSource:position.baseline?.source??null,
        entryAdvantage:position.entryAdvantage,currentAdvantage:position.currentAdvantage}''')
s=replace(s,'  response?:{validation:EntryValidation;decision:EntryResponseDecision}){','  response?:{validation:EntryValidation;decision:EntryResponseDecision},minutePath?:Candle[]){')
s=replace(s,'  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;', '''  // Use the very same position assessment before financial admission. A single
  // concern or slow response is not a veto; only converged independent failure
  // with weak holding value contradicts an otherwise approved entry.
  const positionState=s.extremumRegime.symbols[o.symbol],mark=side==="LONG"?q.bestBid:q.bestAsk,
    entryAssessment=evaluatePositionIntelligence({now,openedAt:now,side,signedRate:d*(mark/price-1),
      peakFavorableRate:0,ageMin:0,firstProfit:false,expectedHoldMinutes:horizon,
      stopRate:Math.max(.004,softInvalidationRate),entryScore:o.environmentScore??o.score,
      entryResidual:o.residual??0,entryRelativeStrength:o.relativeStrength??.5,entryRemainingSpaceRate:remainingNet,
      state:positionState,narrative:s.extremumRegime.narrative,quote:q,minutePath,currentPrice:mark,
      liquidity:s.extremumRegime.liquidity?.symbols[o.symbol],entryTradePlan:o.tradePlan,
      entryOrigin:o.liquidityOriginLower!=null&&o.liquidityOriginUpper!=null
        ?{lower:o.liquidityOriginLower,upper:o.liquidityOriginUpper}:null,
      entryTarget:o.liquidityTargetLower!=null&&o.liquidityTargetUpper!=null
        ?{lower:o.liquidityTargetLower,upper:o.liquidityTargetUpper}:null,
      entryBaseline:capturePositionBaseline(side,positionState,now),entryResponseValidated:!!response,
      marketStateAgeMs:Math.max(0,now-s.extremumRegime.updatedAt),costRate:ROUND_TRIP_COST});
  if(entryAssessment.entryConflict)return "入场与持仓证据冲突，等待回调/新响应";
  t.positionIntelligence=entryAssessment;
  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;''')
s=replace(s,'const error=openIntelligenceTrade(s,o,q!,meta,now,equity,{validation,decision});', 'const error=openIntelligenceTrade(s,o,q!,meta,now,equity,{validation,decision},minutePaths?.[o.symbol]);')
s=replace(s,'if(error.startsWith("实时成交性价比")||error.startsWith("实时入场已消耗剩余空间")){', '''if(error.startsWith("实时成交性价比")||error.startsWith("实时入场已消耗剩余空间")||error.startsWith("入场与持仓证据冲突")){
        if(error.startsWith("入场与持仓证据冲突")){validation.supportSamples=0;validation.oppositionSamples=0;}''')
p.write_text(s)

# Existing tests must provide a truly later candle, not a late fetch of a candle
# already completed before review. Assertions remain; the fixture clocks change.
p=Path('tests/market-intelligence-engine.test.ts');s=p.read_text()
s=replace(s,'state:{...broken,signalLastBar:T},quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true,previous:first}',
              'state:{...broken,signalLastBar:T+300_000},quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true,previous:first}')
s=replace(s,'state:{...neutralStructure,signalLastBar:T},quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true,previous:first}',
              'state:{...neutralStructure,signalLastBar:T+300_000},quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true,previous:first}')
s=replace(s,'const secondState={...broken,signalLastBar:T};', 'const secondState={...broken,signalLastBar:T+300_000};')
s=replace(s,'const structureBroken={...neutralStructure,shortScore:82,signalSide:"SHORT" as const,signalLastBar:T+300_000};',
              'const structureBroken={...neutralStructure,shortScore:82,signalSide:"SHORT" as const,signalLastBar:T+600_000};')
s=replace(s,'const failed=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:-.006,', '''const failed=evaluatePositionIntelligence({now:T,openedAt:T-24_000,
    entryBaseline:{version:"position-evidence-v2",source:"ENTRY",at:T-24_000,score:93},side:"LONG",signedRate:-.006,''')
# Only the immediate-failure fixture needs its fresh quote provenance made explicit.
s=replace(s,'state:broken,quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true});\n  assert.equal(failed.reviewBars',
              'state:broken,quote:{...quote,observedAt:T},minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true});\n  assert.equal(failed.reviewBars')
p.write_text(s)
p=Path('package.json');s=p.read_text();data=json.loads(s)
data['scripts']['test:direct']+=' tests/position-evidence-contract.test.ts tests/position-evidence-integration.test.ts'
p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
print('Applied exact-source position evidence repair; no platform, money, stop, LIVE or account-reset code changed.')
