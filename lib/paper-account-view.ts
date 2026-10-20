/** Which paper book the owner page shows, and the one floating P&L used by the 大脑 tile and the 模拟 tab.
 * The old decision desks (inverse/reverse/lsr/…) only know their own trades. Since the living layer opens the
 * account's trades, a desk that does not hold every open account position must not replace the account view:
 * otherwise the tile shows the dead ledger's floating (+0.00 U) next to real position cards. Display only. */
import {remainingPaidNetPnl} from "./paid-fee-view.ts";
import type {Trade} from "./forward-relations.ts";
import type {ForwardDesk} from "./forward-study.ts";

/** Books whose trades are the account's own positions (not mirrored inverse copies). */
export const OWN_DESK_BOOKS=new Set(["needle-v1","brain-v1","score-v1","read-v1","stretch-v1","lsr-v1"]);

export type PaperAccountView={usingDesk:boolean;floating:number|null;openCount:number};

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

export function paperAccountView(desk:ForwardDesk|null|undefined,positions:readonly Trade[],liveEnabled:boolean):PaperAccountView{
  const open=positions.filter(t=>t.status==="OPEN"&&!t.inverseCopy);
  const deskIds=new Set((desk?.open??[]).map(o=>o.id));
  const unmirrored=open.some(t=>!deskIds.has(t.id));
  const own=!!desk?.book&&OWN_DESK_BOOKS.has(desk.book);
  // A non-own desk (reverse / inverse study) is only the account while it holds paired trades.
  const usingDesk=!!desk&&!liveEnabled&&!unmirrored&&(own||desk.open.length>0);
  if(usingDesk)return {usingDesk,floating:desk!.floating,openCount:desk!.openCount};
  return {usingDesk:false,floating:accountFloating(positions),openCount:open.length};
}
