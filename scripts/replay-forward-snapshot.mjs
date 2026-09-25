import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const sum=(rows,key)=>rows.reduce((n,row)=>n+Number(row[key]??0),0);
const round=(value,digits=8)=>Number(value.toFixed(digits));
const rate=(trade)=>Number(trade.netPnl??0)/Math.max(Number(trade.notional??0),1e-9);
const outsideAtEntry=(trade)=>{
  const boundary=Number(trade.entryContext?.interruptBoundary),entry=Number(trade.entryPrice);
  if(!(boundary>0&&entry>0))return 0;
  return trade.side==="SHORT"?boundary/entry-1:entry/boundary-1;
};
const strongImmediate=(trade)=>trade.entryContext?.mode==="RELATION"&&Number(trade.entryContext?.entryScore)>=82
  &&Number(trade.forecast?.remainingNetRate)>=.0045&&Number(trade.entryContext?.edgeRatio)>=.65
  &&Number(trade.entryContext?.relationHealth)>=.64&&Number(trade.entryContext?.relationLivePathScore)>=.60
  &&Number(trade.entryContext?.marketFit)>=65;

export function analyzeSnapshot(snapshot){
  const forward=snapshot?.forward;if(!forward||!Array.isArray(forward.history))throw new Error("Forward snapshot history missing");
  const history=forward.history,shock=history.filter(t=>t.entryContext?.mode==="SHOCK"),ordinary=history.filter(t=>t.entryContext?.mode!=="SHOCK"),
    byMode=Object.fromEntries([...new Set(ordinary.map(t=>t.entryContext?.mode??"UNKNOWN"))].sort().map(mode=>{const rows=ordinary.filter(t=>(t.entryContext?.mode??"UNKNOWN")===mode);
      return[mode,{trades:rows.length,grossPnl:round(sum(rows,"grossPnl")),fees:round(sum(rows,"entryFee")+sum(rows,"exitFee")),netPnl:round(sum(rows,"netPnl"))}];})),
    byExit=Object.fromEntries([...new Set(history.map(t=>t.exitReason??"UNKNOWN"))].sort().map(exit=>{const rows=history.filter(t=>(t.exitReason??"UNKNOWN")===exit);
      return[exit,{trades:rows.length,wins:rows.filter(t=>Number(t.netPnl)>0).length,netPnl:round(sum(rows,"netPnl"))}];})),
    predicted=ordinary.map(t=>Number(t.forecast?.remainingNetRate??0)),actual=ordinary.map(rate),
    target=ordinary.map(t=>Number(t.exitPlan?.targetRate??t.entryContext?.remainingSpaceRate??0)),
    lateShock=shock.map(t=>{const region=(forward.regions??[]).find(r=>r.symbol===t.symbol),atr=Math.max(.00045,Number(region?.atrRate??.00045)),
      chaseLimit=Math.max(.0045,Math.min(.008,atr*.95)),outside=outsideAtEntry(t);return{id:t.id,symbol:t.symbol,side:t.side,
        oldEventId:t.entryContext?.interruptEventId,outsideRate:round(outside),chaseLimitRate:round(chaseLimit),newInitialDecision:outside>chaseLimit?"WAIT_RETEST":"CONTINUATION_DELAY",
        exitReason:t.exitReason,netPnl:round(Number(t.netPnl)),fees:round(Number(t.entryFee)+Number(t.exitFee))};}),
    shockNet=sum(shock,"netPnl"),shockFees=sum(shock,"entryFee")+sum(shock,"exitFee"),shockGross=sum(shock,"grossPnl"),
    best=ordinary.toSorted((a,b)=>Number(b.netPnl)-Number(a.netPnl))[0],canonicalEvent=`market-shock-${shock[0]?.side??"UNKNOWN"}-${Math.floor(Math.min(...shock.map(t=>t.openedAt))/60_000)}`;
  const extendedIds=new Set(lateShock.filter(x=>x.newInitialDecision==="WAIT_RETEST").map(x=>x.id)),extended=shock.filter(x=>extendedIds.has(x.id)),
    extendedNet=sum(extended,"netPnl"),extendedFees=sum(extended,"entryFee")+sum(extended,"exitFee"),extendedGross=sum(extended,"grossPnl");
  return{source:{exportedAt:snapshot.exportedAt,completed:forward.resolved,wins:forward.wins,losses:forward.resolved-forward.wins,
      balance:forward.balance,equity:forward.equity,grossPnl:round(forward.grossPnl),fees:round(forward.fees),fundingAllowance:round(forward.fundingAllowance),
      netPnl:round(forward.equity-forward.initialEquity),turnover:round(forward.turnover),matureSamples:Array.isArray(snapshot.measurements)?snapshot.measurements.length:null,
      storageError:forward.storage?.error??null},
    ordinary:{trades:ordinary.length,grossPnl:round(sum(ordinary,"grossPnl")),fees:round(sum(ordinary,"entryFee")+sum(ordinary,"exitFee")),
      netPnl:round(sum(ordinary,"netPnl")),predictedPositive:predicted.filter(x=>x>0).length,actualLosses:actual.filter(x=>x<0).length,
      averagePredictedNetRate:round(sum(predicted.map(value=>({value})),"value")/Math.max(1,predicted.length)),
      averageActualNetRate:round(sum(actual.map(value=>({value})),"value")/Math.max(1,actual.length)),
      averageTargetRate:round(sum(target.map(value=>({value})),"value")/Math.max(1,target.length)),byMode},byExit,
    shock:{trades:shock.length,grossPnl:round(shockGross),fees:round(shockFees),netPnl:round(shockNet),canonicalEvent,initialDecisions:lateShock,
      recordedEntryOutcome:"All three recorded timestamps are delayed; SUI/XLM require WAIT_RETEST and LINK requires a distinct 3-quote/4-second continuation path inside the same event pool.",
      extendedMoveLowerBound:{completed:history.length-extended.length,tradeReductionRate:round(extended.length/history.length),
        grossPnl:round(forward.grossPnl-extendedGross),fees:round(forward.fees-extendedFees),netPnl:round((forward.equity-forward.initialEquity)-extendedNet),
        note:"Causal lower bound removes only SUI/XLM's already-extended recorded fills. LINK is delayed, not assumed removed; later retest/restart outcomes remain unknown."}},
    entryValidation:{strongImmediateCount:ordinary.filter(strongImmediate).length,validationCount:ordinary.filter(t=>!strongImmediate(t)).length,
      bestWinner:{id:best?.id,symbol:best?.symbol,netPnl:round(Number(best?.netPnl??0)),strongImmediate:best?strongImmediate(best):false,
        firstProfitDelayMs:best?.firstProfitAt&&best?.openedAt?best.firstProfitAt-best.openedAt:null}},
    limitations:["The snapshot contains entry/exit records but not the complete resident 2-second BBO path, so later retest fills and ordinary validation pass/cancel outcomes are not reconstructed with future prices.",
      "All admission classifications use fields available at each recorded entry; realized PnL is used only for calibration/audit, never to decide the historical entry."]};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv[2];if(!file)throw new Error("usage: node scripts/replay-forward-snapshot.mjs <snapshot.json>");
  console.log(JSON.stringify(analyzeSnapshot(JSON.parse(await readFile(file,"utf8"))),null,2));
}
