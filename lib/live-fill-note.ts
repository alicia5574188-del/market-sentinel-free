/** A capped note of a real exchange fill. Recording it never places or cancels an order. */
export type LiveFillNote={
  sourceId:string;symbol:string;side:"LONG"|"SHORT";
  paperPrice:number|null;exchangePrice:number;
  bid:number|null;ask:number|null;spreadBps:number|null;at:number;
};
const CAP=400;

function usable(row:LiveFillNote){
  return !!row&&typeof row.sourceId==="string"&&row.sourceId.length>0&&row.sourceId.length<200
    &&(row.side==="LONG"||row.side==="SHORT")&&typeof row.symbol==="string"
    &&typeof row.exchangePrice==="number"&&row.exchangePrice>0&&Number.isFinite(row.exchangePrice)
    &&typeof row.at==="number"&&row.at>0;
}

export function rememberLiveFill(rows:LiveFillNote[]|null|undefined,row:LiveFillNote){
  const kept=(Array.isArray(rows)?rows:[]).filter(usable);
  if(!usable(row))return kept.slice(-CAP);
  return [...kept.filter(item=>item.sourceId!==row.sourceId),row].slice(-CAP);
}

export function normalizeLiveFills(raw:unknown):LiveFillNote[]{
  if(!Array.isArray(raw))return [];
  const out:LiveFillNote[]=[];
  for(const item of raw){
    if(!item||typeof item!=="object")continue;
    const row=item as Partial<LiveFillNote>;
    if(typeof row.sourceId!=="string"||(row.side!=="LONG"&&row.side!=="SHORT")||typeof row.symbol!=="string")continue;
    if(typeof row.exchangePrice!=="number"||!(row.exchangePrice>0)||typeof row.at!=="number"||!(row.at>0))continue;
    const note:LiveFillNote={sourceId:row.sourceId,symbol:row.symbol,side:row.side,
      paperPrice:typeof row.paperPrice==="number"&&row.paperPrice>0?row.paperPrice:null,
      exchangePrice:row.exchangePrice,
      bid:typeof row.bid==="number"&&row.bid>0?row.bid:null,
      ask:typeof row.ask==="number"&&row.ask>0?row.ask:null,
      spreadBps:typeof row.spreadBps==="number"&&Number.isFinite(row.spreadBps)?row.spreadBps:null,
      at:row.at};
    if(usable(note))out.push(note);
  }
  return out.slice(-CAP);
}
