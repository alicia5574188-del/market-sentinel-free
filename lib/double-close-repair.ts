/**
 * One-time ledger repair for trades that were closed twice (living EXIT closed the trade but left it in `positions`;
 * the old exit stack then closed it again: second history row, second balance credit, resolved/wins/turnover/fees twice).
 * The first close (earliest closedAt) is the real one; every later close of the same trade id is undone exactly:
 * the balance gets back what the second close credited (gross − exitFee − funding of that close only — the entry fee
 * was paid once at open and is not touched), and the counters it bumped are taken back. Nothing else is reset; open
 * positions, the run log and every other history row stay as they are. Idempotent: with no duplicate ids it is a no-op.
 * NOT wired anywhere yet — applying it to the live state needs the owner's go-ahead.
 */
import type {ForwardState,Trade} from "./forward-relations.ts";

export type DoubleCloseRow={id:string;symbol:string;kept:{closedAt:number|null;reason:string|null;netPnl:number|null};
  dropped:{closedAt:number|null;reason:string|null;netPnl:number|null;credit:number}};

function closeCredit(t:Trade){
  // What closeTrade added to balance on THIS close: stored totals include earlier partial fills, take those out.
  const r=t.realization;
  return ((t.grossPnl??0)-(r?.gross??0))-(t.exitFee-(r?.fees??0))-(t.fundingAllowance-(r?.funding??0));
}
export function findDoubleCloses(history:Trade[],accountStartedAt?:number):{row:DoubleCloseRow;dropped:Trade}[]{
  const byId=new Map<string,Trade[]>();
  for(const t of history){if(t.unopened||t.inverseCopy||t.exitReason==="ACCOUNT_RESET"||(accountStartedAt!=null&&t.openedAt<accountStartedAt))continue;const g=byId.get(t.id);if(g)g.push(t);else byId.set(t.id,[t]);}
  const out:{row:DoubleCloseRow;dropped:Trade}[]=[];
  for(const rows of byId.values()){
    if(rows.length<2)continue;
    const sorted=[...rows].sort((a,b)=>(a.closedAt??0)-(b.closedAt??0)),kept=sorted[0]!;
    for(const d of sorted.slice(1))out.push({dropped:d,row:{id:d.id,symbol:d.symbol,
      kept:{closedAt:kept.closedAt,reason:kept.exitReason??null,netPnl:kept.netPnl},
      dropped:{closedAt:d.closedAt,reason:d.exitReason??null,netPnl:d.netPnl,credit:closeCredit(d)}}});
  }
  return out;
}
export function repairDoubleCloses(s:ForwardState,now:number):{rows:DoubleCloseRow[];balanceBefore:number;balanceAfter:number}{
  const found=findDoubleCloses(s.history,s.startedAt),balanceBefore=s.balance;
  // A trade already in history must not stay in positions either way.
  if(s.positions.some(t=>t.status!=="OPEN"))s.positions=s.positions.filter(t=>t.status==="OPEN");
  if(!found.length)return {rows:[],balanceBefore,balanceAfter:s.balance};
  const drop=new Set(found.map(f=>f.dropped));
  for(const {dropped:d,row} of found){
    const net=d.netPnl??0,r=d.realization,gross=(d.grossPnl??0)-(r?.gross??0),fee=d.exitFee-(r?.fees??0),funding=d.fundingAllowance-(r?.funding??0);
    s.balance-=row.dropped.credit;s.grossPnl-=gross;s.fees-=fee;s.fundingAllowance-=funding;
    s.resolved=Math.max(0,s.resolved-1);if(net>0)s.wins=Math.max(0,s.wins-1);s.turnover-=d.notional;
    const ctx=d.entryContext,cells=s.environmentPerformance?.cells;
    const cell=ctx?.environment&&ctx?.playbook?cells?.[`${ctx.environment}:${ctx.playbook}`]:undefined;
    if(cell){cell.trades=Math.max(0,cell.trades-1);if(net>0)cell.wins=Math.max(0,cell.wins-1);
      cell.netRiskUnits-=net/Math.max(.01,d.plannedRisk);if(net<=0)cell.lossStreak=Math.max(0,cell.lossStreak-1);}
    const key=ctx?.winnerPlan?.riskGroup,risk=key?s.winnerRisk?.[key]:undefined;
    if(risk)risk.loss=Math.max(0,risk.loss-Math.max(0,-net));
  }
  s.history=s.history.filter(t=>!drop.has(t));
  const rows=found.map(f=>f.row),delta=s.balance-balanceBefore;
  s.revision++;
  s.events.unshift({id:`a${s.startedAt}-${s.revision}`,at:now,kind:"DATA",subject:"ledger-repair-double-close-v1",
    reason:`修正重复平仓 ${rows.length} 笔（${[...new Set(rows.map(r=>r.symbol.replace("_USDT","")))].join("/")}），余额 ${delta>=0?"+":""}${delta.toFixed(2)}U`,
    detail:{rows:rows.length,balanceBefore,balanceAfter:s.balance}});
  return {rows,balanceBefore,balanceAfter:s.balance};
}
