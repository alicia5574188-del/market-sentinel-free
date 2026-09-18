/** Read-side Gate settlement attribution. Never drives orders or changes old ledgers. */
import { liveExitTag } from "./gate-live.ts";
export const SETTLEMENT_VERSION="gate-close-settlement-v1";
export type GatePositionClose={contract?:string;side?:string;time?:number|string;pnl?:number|string;
  pnl_pnl?:number|string;pnl_fee?:number|string;pnl_fund?:number|string;text?:string;
  max_size?:number|string;accum_size?:number|string;first_open_time?:number|string;long_price?:number|string;short_price?:number|string};
export type SettlementPosition={id:string;symbol:string;side:"LONG"|"SHORT";status:string;entryAt?:number;exitAt?:number;
  entryPrice:number;exchangeSize:number;parity?:{sourceId:string;copiedAt:number;roundedContracts:number}};
export type Settlement={version:typeof SETTLEMENT_VERSION;checkedAt:number;closedAt:number;openedAt:number;
  pnl:number;pricePnl:number|null;fees:number|null;funding:number|null;entryPrice:number;exitPrice:number;
  nativeKey:string;match:"TAG_AND_LIFECYCLE"|"UNIQUE_LIFECYCLE"};
const numeric=(v:unknown)=>v!==null&&v!==undefined&&String(v).trim()!==""&&Number.isFinite(Number(v))?Number(v):null;
const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-10,Math.abs(b)*1e-7);
function candidate(p:SettlementPosition,r:GatePositionClose,now:number) {
  if(p.status!=="CLOSED"||!p.parity||p.parity.sourceId!==p.id||!p.entryAt||!p.exitAt
    ||r.contract!==p.symbol||r.side!==p.side.toLowerCase())return false;
  const opened=numeric(r.first_open_time),ended=numeric(r.time),max=numeric(r.max_size),acc=numeric(r.accum_size);
  const ep=numeric(p.side==="LONG"?r.long_price:r.short_price),xp=numeric(p.side==="LONG"?r.short_price:r.long_price);
  if(opened===null||ended===null||max===null||acc===null||ep===null||xp===null||ep<=0||xp<=0||numeric(r.pnl)===null)return false;
  const start=opened*1000,end=ended*1000;
  // Position entryAt is first observed fill; copiedAt is the durable reservation.
  // Never attach a position cycle that began before this source reservation.
  if(start<p.parity.copiedAt-2000||start>p.entryAt+2000||p.entryAt-start>120000
    ||end<start||end>p.exitAt+2000||end>now)return false;
  // Extra manual adds/partial reductions would contaminate a position-wide PnL.
  if(!(p.exchangeSize>0)||!near(Math.abs(max),p.exchangeSize)||!near(Math.abs(acc),p.exchangeSize)||!near(ep,p.entryPrice))return false;
  if(r.text&&r.text.startsWith("t-ms-")&&r.text!==liveExitTag(p.id)&&!r.text.startsWith("t-ms-s-"))return false;
  return r.text===liveExitTag(p.id)||Math.abs(p.exitAt-end)<=120000;
}
export function matchSettlements(positions:readonly SettlementPosition[],rows:readonly GatePositionClose[],now:number) {
  const result:Record<string,Settlement>={};
  // Duplicate API rows do not become competing or double-counted settlements.
  const unique=[...new Map(rows.map(r=>[JSON.stringify(r),r])).values()];
  const matches=positions.map(p=>({p,rows:unique.filter(r=>candidate(p,r,now))}));
  for(const {p,rows:found} of matches){
    if(found.length!==1)continue;const r=found[0];
    if(matches.filter(m=>m.rows.includes(r)).length!==1)continue;
    const start=Number(r.first_open_time)*1000,end=Number(r.time)*1000;
    // An overlapping second source is evidence of a combined cycle, even when
    // the closing tag identifies just one leg. Do not assign combined profit.
    if(positions.some(o=>o.id!==p.id&&o.symbol===p.symbol&&o.side===p.side&&o.entryAt&&o.exitAt
      &&o.entryAt<=end&&o.exitAt>start&&o.entryAt>=start-2000))continue;
    result[p.id]={version:SETTLEMENT_VERSION,checkedAt:now,openedAt:start,closedAt:end,pnl:Number(r.pnl),
      pricePnl:numeric(r.pnl_pnl),fees:numeric(r.pnl_fee),funding:numeric(r.pnl_fund),
      entryPrice:Number(p.side==="LONG"?r.long_price:r.short_price),exitPrice:Number(p.side==="LONG"?r.short_price:r.long_price),
      nativeKey:JSON.stringify([r.contract,r.side,start,end]),match:r.text===liveExitTag(p.id)?"TAG_AND_LIFECYCLE":"UNIQUE_LIFECYCLE"};
  }
  return result;
}