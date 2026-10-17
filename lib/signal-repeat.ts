/** Frozen at the moment a signal is written down. Never decides an entry or an exit. */
export type SignalTally={n:number;at:number};
export type SignalRepeat={n:number;gapMin:number|null};
const CAP=2_000;

export function quoteSpreadBps(bid:number,ask:number){
  if(!(bid>0)||!(ask>=bid))return null;
  const mid=(bid+ask)/2;
  if(!(mid>0))return null;
  return Math.round((ask-bid)/mid*10_000*100)/100;
}

export function rememberSignalRepeat(tally:Record<string,SignalTally>|null|undefined,symbol:string,side:"LONG"|"SHORT",now:number){
  const book:Record<string,SignalTally>={};
  for(const [key,row] of Object.entries(tally??{})){
    if(row&&Number.isFinite(row.n)&&row.n>=1&&Number.isFinite(row.at)&&row.at>=0)book[key]={n:Math.floor(row.n),at:row.at};
  }
  const key=`${symbol}|${side}`;
  const prev=book[key];
  const n=prev?prev.n+1:1;
  const gapMin=prev&&now>=prev.at?Math.round((now-prev.at)/60_000*10)/10:null;
  book[key]={n,at:now};
  const overflow=Object.keys(book);
  if(overflow.length>CAP){
    overflow.sort((a,b)=>book[a]!.at-book[b]!.at);
    for(const old of overflow.slice(0,overflow.length-CAP))if(old!==key)delete book[old];
  }
  return {tally:book,repeat:{n,gapMin} satisfies SignalRepeat};
}

export function normalizeSignalTally(raw:unknown):Record<string,SignalTally>{
  if(!raw||typeof raw!=="object")return {};
  const book:Record<string,SignalTally>={};
  for(const [key,row] of Object.entries(raw as Record<string,unknown>)){
    const item=row as Partial<SignalTally>|null;
    if(!item||typeof item.n!=="number"||typeof item.at!=="number")continue;
    if(!(item.n>=1)||!Number.isFinite(item.n)||!(item.at>=0)||!Number.isFinite(item.at))continue;
    book[key]={n:Math.floor(item.n),at:item.at};
  }
  const keys=Object.keys(book);
  if(keys.length<=CAP)return book;
  keys.sort((a,b)=>book[a]!.at-book[b]!.at);
  for(const old of keys.slice(0,keys.length-CAP))delete book[old];
  return book;
}
