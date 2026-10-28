/** Which paper book the owner page shows, and the one floating P&L used by the 大脑 tile and the 模拟 tab.
 * The old decision desks (inverse/reverse/lsr/…) only know their own trades. Since the living layer opens the
 * account's trades, a desk that does not hold every open account position must not replace the account view:
 * otherwise the tile shows the dead ledger's floating (+0.00 U) next to real position cards. Display only. */
import {remainingPaidNetPnl} from "./paid-fee-view.ts";
import type {Trade} from "./forward-relations.ts";

export type PaperAccountView={floating:number|null;openCount:number};

/** Floating net of the open account positions, entry fee already deducted (same basis as data.equity). */
export function accountFloating(positions:readonly Trade[]):number|null{
  let sum=0,n=0;
  for(const t of positions){
    if(t.status!=="OPEN"||t.inverseCopy)continue;
    let v:number;try{v=remainingPaidNetPnl(t,t.lastPrice);}catch{continue;}
    if(Number.isFinite(v)){sum+=v;n++;}
  }
  const open=positions.filter(t=>t.status==="OPEN"&&!t.inverseCopy).length;
  return open===0?0:n===0?null:sum;
}

export function paperAccountView(positions:readonly Trade[]):PaperAccountView{
  const open=positions.filter(t=>t.status==="OPEN"&&!t.inverseCopy);
  return {floating:accountFloating(positions),openCount:open.length};
}
