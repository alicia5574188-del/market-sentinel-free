/** A capped note of a real exchange fill. Recording it never places or cancels an order. */
export type LiveFillNote={
  sourceId:string;symbol:string;side:"LONG"|"SHORT";leg?:"ENTRY"|"EXIT";
  paperPrice:number|null;exchangePrice:number;
  bid:number|null;ask:number|null;spreadBps:number|null;
  slip_bps?:number|null;fee?:number|null;fee_rate?:number|null;role?:"maker"|"taker"|null;
  submit_at?:number|null;at:number;latency_ms?:number|null;paper_at?:number|null;
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
  const leg=row.leg??"ENTRY";
  return [...kept.filter(item=>!(item.sourceId===row.sourceId&&(item.leg??"ENTRY")===leg)),{...row,leg}].slice(-CAP);
}

export function normalizeLiveFills(raw:unknown):LiveFillNote[]{
  if(!Array.isArray(raw))return [];
  const out:LiveFillNote[]=[];
  for(const item of raw){
    if(!item||typeof item!=="object")continue;
    const row=item as Partial<LiveFillNote>;
    if(typeof row.sourceId!=="string"||(row.side!=="LONG"&&row.side!=="SHORT")||typeof row.symbol!=="string")continue;
    if(typeof row.exchangePrice!=="number"||!(row.exchangePrice>0)||typeof row.at!=="number"||!(row.at>0))continue;
    const note:LiveFillNote={sourceId:row.sourceId,symbol:row.symbol,side:row.side,leg:row.leg==="EXIT"?"EXIT":"ENTRY",
      paperPrice:typeof row.paperPrice==="number"&&row.paperPrice>0?row.paperPrice:null,
      exchangePrice:row.exchangePrice,
      bid:typeof row.bid==="number"&&row.bid>0?row.bid:null,
      ask:typeof row.ask==="number"&&row.ask>0?row.ask:null,
      spreadBps:typeof row.spreadBps==="number"&&Number.isFinite(row.spreadBps)?row.spreadBps:null,
      slip_bps:typeof row.slip_bps==="number"&&Number.isFinite(row.slip_bps)?row.slip_bps:null,
      fee:typeof row.fee==="number"&&Number.isFinite(row.fee)?row.fee:null,
      fee_rate:typeof row.fee_rate==="number"&&Number.isFinite(row.fee_rate)?row.fee_rate:null,
      role:row.role==="maker"||row.role==="taker"?row.role:null,
      submit_at:typeof row.submit_at==="number"?row.submit_at:null,
      at:row.at,latency_ms:typeof row.latency_ms==="number"?row.latency_ms:null,
      paper_at:typeof row.paper_at==="number"?row.paper_at:null};
    if(usable(note))out.push(note);
  }
  return out.slice(-CAP);
}

type ConfirmedCost={contract?:string;price?:number|string;fee?:number|string;role?:string;
  create_time?:number|string;close_size?:number|string;trade_value?:number|string};

/** 用已经拉回来的 Gate 成交补手续费和 maker/taker。对不上就保持空，不另发请求。 */
export function applyConfirmedFillCosts(notes:LiveFillNote[]|null|undefined, rows:ConfirmedCost[]|null|undefined):LiveFillNote[]{
  const kept=normalizeLiveFills(notes);
  if(!rows?.length)return kept;
  return kept.map(note=>{
    if(typeof note.fee==="number")return note;
    const hits=rows.filter(row=>{
      if(row.contract!==note.symbol)return false;
      const px=Number(row.price);
      if(!(px>0)||Math.abs(px/note.exchangePrice-1)>0.002)return false;
      const raw=Number(row.create_time),ms=raw>1e12?raw:raw*1000;
      if(!(ms>0)||Math.abs(ms-note.at)>180_000)return false;
      if(row.close_size!=null&&String(row.close_size)!==""&&Number.isFinite(Number(row.close_size))){
        const closing=Number(row.close_size)!==0;
        if(((note.leg??"ENTRY")==="EXIT")!==closing)return false;
      }
      return Number.isFinite(Number(row.fee));
    });
    if(!hits.length)return note;
    let fee=0,notional=0,role:"maker"|"taker"|null=null,mixed=false;
    for(const row of hits){
      fee+=Number(row.fee);
      const tv=Number(row.trade_value);
      if(tv>0)notional+=tv;
      const next=row.role==="maker"||row.role==="taker"?row.role:null;
      if(next&&role&&next!==role)mixed=true;
      else if(next)role=next;
    }
    return {...note,fee:Number(fee.toFixed(8)),
      fee_rate:notional>0?Number((fee/notional).toFixed(8)):note.fee_rate??null,
      role:mixed?null:role};
  });
}
