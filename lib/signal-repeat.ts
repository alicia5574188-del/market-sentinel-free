/** Frozen at the moment a signal is written down. Never decides an entry or an exit. */
export type SignalTally={
  n:number;at:number;
  n_symbol?:number;
  last_id?:string;last_side?:"LONG"|"SHORT";last_at?:number;
  last_net_pct?:number|null;last_mfe_pct?:number|null;last_mae_pct?:number|null;
};
export type SignalRepeat={
  n:number;gapMin:number|null;
  nSymbol:number|null;prevSide:"LONG"|"SHORT"|null;prevGapMin:number|null;
  prevNetPct:number|null;prevMfePct:number|null;
};
export type SignalTallyMeta={backfilled:boolean;from:number|null};
const CAP=2_000;

export function quoteSpreadBps(bid:number,ask:number){
  if(!(bid>0)||!(ask>=bid))return null;
  const mid=(bid+ask)/2;
  if(!(mid>0))return null;
  return Math.round((ask-bid)/mid*10_000*100)/100;
}

function mins(now:number,at:number){return Math.round((now-at)/60_000*10)/10;}

export function rememberSignalRepeat(tally:Record<string,SignalTally>|null|undefined,symbol:string,side:"LONG"|"SHORT",now:number,id?:string){
  const book=normalizeSignalTally(tally);
  const sideKey=`${symbol}|${side}`;
  const sidePrev=book[sideKey];
  const sym=book[symbol];
  const n=sidePrev?sidePrev.n+1:1;
  const nSymbol=(sym?.n??0)+1;
  const gapMin=sidePrev&&now>=sidePrev.at?mins(now,sidePrev.at):null;
  const prevSide=sym?.last_side==="LONG"||sym?.last_side==="SHORT"?sym.last_side:null;
  const prevGapMin=sym&&typeof sym.last_at==="number"&&now>=sym.last_at?mins(now,sym.last_at):null;
  book[sideKey]={n,at:now,n_symbol:nSymbol};
  book[symbol]={n:nSymbol,at:now,last_id:id,last_side:side,last_at:now,last_net_pct:null,last_mfe_pct:null,last_mae_pct:null};
  const overflow=Object.keys(book);
  if(overflow.length>CAP){
    overflow.sort((a,b)=>book[a]!.at-book[b]!.at);
    for(const old of overflow.slice(0,overflow.length-CAP))if(old!==sideKey&&old!==symbol)delete book[old];
  }
  return {tally:book,repeat:{n,gapMin,nSymbol,prevSide,prevGapMin,
    prevNetPct:typeof sym?.last_net_pct==="number"?sym.last_net_pct:null,
    prevMfePct:typeof sym?.last_mfe_pct==="number"?sym.last_mfe_pct:null} satisfies SignalRepeat};
}

export function noteSignalOutcome(tally:Record<string,SignalTally>|null|undefined,row:{id:string;symbol:string;netPct:number|null;mfePct:number|null;maePct:number|null}){
  const book=normalizeSignalTally(tally);
  const sym=book[row.symbol];
  if(!sym||sym.last_id!==row.id)return book;
  book[row.symbol]={...sym,last_net_pct:row.netPct,last_mfe_pct:row.mfePct,last_mae_pct:row.maePct};
  return book;
}

export function backfillSignalTally(rows:{id:string;symbol:string;side:"LONG"|"SHORT";openedAt:number;status?:string;netPct?:number|null;mfePct?:number|null;maePct?:number|null}[]){
  let tally:Record<string,SignalTally>={};
  const ordered=rows.filter(row=>row.symbol&&(row.side==="LONG"||row.side==="SHORT")&&row.openedAt>0)
    .sort((a,b)=>a.openedAt-b.openedAt||a.id.localeCompare(b.id));
  for(const row of ordered){
    tally=rememberSignalRepeat(tally,row.symbol,row.side,row.openedAt,row.id).tally;
    if(row.status==="CLOSED")tally=noteSignalOutcome(tally,{id:row.id,symbol:row.symbol,netPct:row.netPct??null,mfePct:row.mfePct??null,maePct:row.maePct??null});
  }
  return {tally,from:ordered[0]?.openedAt??null};
}

export function normalizeSignalTally(raw:unknown):Record<string,SignalTally>{
  if(!raw||typeof raw!=="object")return {};
  const book:Record<string,SignalTally>={};
  for(const [key,row] of Object.entries(raw as Record<string,unknown>)){
    const item=row as Partial<SignalTally>|null;
    if(!item||typeof item.n!=="number"||typeof item.at!=="number")continue;
    if(!(item.n>=1)||!Number.isFinite(item.n)||!(item.at>=0)||!Number.isFinite(item.at))continue;
    const next:SignalTally={n:Math.floor(item.n),at:item.at};
    if(typeof item.n_symbol==="number"&&item.n_symbol>=1)next.n_symbol=Math.floor(item.n_symbol);
    if(typeof item.last_id==="string"&&item.last_id)next.last_id=item.last_id;
    if(item.last_side==="LONG"||item.last_side==="SHORT")next.last_side=item.last_side;
    if(typeof item.last_at==="number"&&item.last_at>=0)next.last_at=item.last_at;
    if(typeof item.last_net_pct==="number"&&Number.isFinite(item.last_net_pct))next.last_net_pct=item.last_net_pct;
    if(typeof item.last_mfe_pct==="number"&&Number.isFinite(item.last_mfe_pct))next.last_mfe_pct=item.last_mfe_pct;
    if(typeof item.last_mae_pct==="number"&&Number.isFinite(item.last_mae_pct))next.last_mae_pct=item.last_mae_pct;
    book[key]=next;
  }
  const keys=Object.keys(book);
  if(keys.length<=CAP)return book;
  keys.sort((a,b)=>book[a]!.at-book[b]!.at);
  for(const old of keys.slice(0,keys.length-CAP))delete book[old];
  return book;
}

export function earliestTallyAt(tally:Record<string,SignalTally>){
  let at:number|null=null;
  for(const row of Object.values(tally))if(at==null||row.at<at)at=row.at;
  return at;
}
