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
  return v as T;
}
