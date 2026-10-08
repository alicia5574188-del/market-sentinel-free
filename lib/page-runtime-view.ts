/** Page polling payload only. Research-heavy trade fields stay in storage and in
 * the review export (which reads forwardView directly); the dashboard never
 * renders them, so they are not resent on every 10s refresh. */
type Row=Record<string,unknown>;
const PAGE_OMITTED_TRADE_FIELDS=['review'] as const;
const PAGE_OMITTED_INVERSE_FIELDS=['lossResearch','sourceEntryPlan','sourceExitAudit'] as const;
function pageTrade(t:unknown){
  if(!t||typeof t!=='object')return t;
  const row={...(t as Row)};
  for(const key of PAGE_OMITTED_TRADE_FIELDS)delete row[key];
  if(row.inverseCopy&&typeof row.inverseCopy==='object'){
    const copy={...(row.inverseCopy as Row)};
    for(const key of PAGE_OMITTED_INVERSE_FIELDS)delete copy[key];
    row.inverseCopy=copy;
  }
  return row;
}
export function pageForwardView<T>(view:T):T{
  if(!view||typeof view!=='object')return view;
  const v={...(view as Row)};
  if(Array.isArray(v.positions))v.positions=v.positions.map(pageTrade);
  if(Array.isArray(v.history))v.history=v.history.map(pageTrade);
  if('entryOpportunities' in v)delete v.entryOpportunities;
  delete v.shadowInverse;delete v.confirmationReality;delete v.latestReason;delete v.events;
  if(v.boundaries&&typeof v.boundaries==='object'){
    const boundaries={...(v.boundaries as Row)};
    if(typeof boundaries.accounting==='string'&&boundaries.accounting.includes('影子'))boundaries.accounting='决策账户按实际成交记账。新单跟当前正反，金额和提案一样。';
    v.boundaries=boundaries;
  }
  if(v.cost&&typeof v.cost==='object'){
    const cost={...(v.cost as Row)};
    if(typeof cost.assumption==='string'&&cost.assumption.includes('影子'))cost.assumption='决策账户按实际成交记账。';
    v.cost=cost;
  }
  return v as T;
}
