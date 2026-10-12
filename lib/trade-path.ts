/** Observation only. Never changes an order, a stop, or the account. */
import type {ForwardState, Quote} from './forward-relations.ts';

export const TRADE_PATH_KEY='market-intelligence:trade-paths:v1';
export const TRADE_PATH_VERSION='trade-path-v1' as const;
const AFTER_MINUTES=60;
const COST_RATE=0.002;
const FEE_RATE=0.0007;
const TAKE_PROFITS=[0.4,0.6,0.8,1,1.5,2,3];
const STOP_LOSSES=[0.3,0.4,0.6,0.8,1,1.5];
const HOLD_MINUTES=[5,15,30,45,60,90,120,180];

export type PathPoint=[number,number,number];
export type TradePath={
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;qty:number;notional:number;entryFee:number;openedAt:number;
  exit:number|null;exitAt:number|null;net:number|null;hold:PathPoint[];after:PathPoint[];
};
export type TradePathBook={version:typeof TRADE_PATH_VERSION;accountStartedAt:number;trades:TradePath[]};

export function emptyTradePathBook(accountStartedAt:number):TradePathBook{
  return {version:TRADE_PATH_VERSION,accountStartedAt,trades:[]};
}
export function restoreTradePathBook(saved:TradePathBook|undefined,accountStartedAt:number){
  if(!saved||saved.version!==TRADE_PATH_VERSION||saved.accountStartedAt!==accountStartedAt||!Array.isArray(saved.trades))return emptyTradePathBook(accountStartedAt);
  return saved;
}

export function observeTradePaths(book:TradePathBook,state:ForwardState,execution:Record<string,Quote>,analysis:Record<string,Quote>,now:number){
  let changed=false;
  if(book.accountStartedAt!==state.startedAt){book.accountStartedAt=state.startedAt;book.trades=[];changed=true;}
  const byId=new Map(book.trades.map(row=>[row.id,row]));
  for(const t of [...state.positions,...state.history]){
    if(t.inverseCopy)continue;
    let row=byId.get(t.id);
    if(!row){
      row={id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,qty:t.quantity,notional:t.notional,entryFee:t.entryFee,openedAt:t.openedAt,
        exit:null,exitAt:null,net:null,hold:[],after:[]};
      book.trades.unshift(row);byId.set(t.id,row);changed=true;
    }
    if(t.status==='CLOSED'&&row.exit==null&&t.exitPrice!=null&&t.closedAt!=null){
      row.exit=t.exitPrice;row.exitAt=t.closedAt;row.net=t.netPnl;row.qty=t.realization?.initialQuantity??row.qty;
      note(row.hold,Math.max(0,Math.floor((t.closedAt-t.openedAt)/60_000)),t.exitPrice);changed=true;
    }
    const live=execution[t.symbol],wide=analysis[t.symbol];
    if(t.status==='OPEN'){
      const px=executable(t.side,live,now);if(px==null)continue;
      if(note(row.hold,Math.floor((now-t.openedAt)/60_000),px))changed=true;
    }else if(row.exitAt!=null&&now-row.exitAt<=AFTER_MINUTES*60_000){
      const px=executable(t.side,live,now)??mid(wide,now);if(px==null)continue;
      if(note(row.after,Math.floor((now-row.exitAt)/60_000),px))changed=true;
    }
  }
  if(book.trades.length>80){book.trades.length=80;changed=true;}
  return changed;
}

function executable(side:'LONG'|'SHORT',q:Quote|undefined,now:number){
  if(!q||!(q.bestBid>0)||!(q.bestAsk>=q.bestBid)||now-q.observedAt>10_000)return null;
  return side==='LONG'?q.bestBid:q.bestAsk;
}
function mid(q:Quote|undefined,now:number){
  if(!q||!(q.bestBid>0)||!(q.bestAsk>=q.bestBid)||now-q.observedAt>60_000)return null;
  return (q.bestBid+q.bestAsk)/2;
}
function note(points:PathPoint[],minute:number,price:number){
  if(!Number.isFinite(price)||price<=0||minute<0)return false;
  const last=points.at(-1);
  if(last&&last[0]===minute){
    const low=Math.min(last[1],price),high=Math.max(last[2],price);
    if(low===last[1]&&high===last[2])return false;
    last[1]=low;last[2]=high;return true;
  }
  if(last&&minute<last[0])return false;
  if(points.length>=240&&minute%5!==0)return false;
  points.push([minute,price,price]);
  return true;
}

export type PathExport={
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;exit:number|null;openedAt:number;closedAt:number|null;
  maxFavorablePct:number;maxAdversePct:number;bestHoldMin:number|null;direction:string;
  hold:PathPoint[];after:PathPoint[];
};
export function exportTradePaths(book:TradePathBook):PathExport[]{
  return book.trades.map(row=>{
    const peak=extreme(row);
    return {id:row.id,symbol:row.symbol,side:row.side,entry:row.entry,exit:row.exit,openedAt:row.openedAt,closedAt:row.exitAt,
      maxFavorablePct:round(peak.favorable*100),maxAdversePct:round(peak.adverse*100),bestHoldMin:peak.minute,
      direction:peak.favorable>=COST_RATE?'进场后走出过成本':'进场后没有走出成本',
      hold:row.hold,after:row.after};
  });
}

export function searchHolding(book:TradePathBook){
  const rows=book.trades.filter(row=>row.hold.length>0);
  if(!rows.length)return {trades:0,best:null,profitable:false,verdict:'重置之后还没有走出价格路径。新单从下一拍开始记，进场、持仓、出场后 60 分钟都会留下。'};
  let best:{tpPct:number;slPct:number;holdMin:number;net:number;wins:number;trades:number}|null=null;
  for(const tp of TAKE_PROFITS)for(const sl of STOP_LOSSES)for(const holdMin of HOLD_MINUTES){
    let net=0,wins=0,used=0;
    for(const row of rows){
      const result=simulate(row,tp,sl,holdMin);if(!result)continue;
      net+=result.net;used++;if(result.net>0)wins++;
    }
    if(!used)continue;
    if(!best||net>best.net)best={tpPct:tp,slPct:sl,holdMin,net:round(net),wins,trades:used};
  }
  const right=rows.filter(row=>extreme(row).favorable>=COST_RATE).length;
  const verdict=!best?'还没有足够的价格路径。'
    :best.net>0?`固定止盈 ${best.tpPct}%、止损 ${best.slPct}%、持有 ${best.holdMin} 分钟，这 ${best.trades} 笔净利润 ${best.net}。`
    :`这 ${rows.length} 笔里，没有任何一种固定止盈、止损、持仓时间能让净利润为正。最好的一种也是 ${best.net}。问题在入场。`;
  return {trades:rows.length,directionRight:right,afterMinutes:AFTER_MINUTES,best,profitable:!!best&&best.net>0,verdict};
}

function simulate(row:TradePath,tpPct:number,slPct:number,holdMin:number){
  const dir=row.side==='LONG'?1:-1,tp=tpPct/100,sl=slPct/100;
  let exit=row.hold.at(-1)!,reason:'sl'|'tp'|'time'|'open'='open';
  for(const point of row.hold){
    const worst=Math.min(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    const best=Math.max(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    if(worst<=-sl){exit=[point[0],stopPrice(row,sl),stopPrice(row,sl)];reason='sl';break;}
    if(best>=tp){exit=[point[0],tpPrice(row,tp),tpPrice(row,tp)];reason='tp';break;}
    if(point[0]>=holdMin){exit=point;reason='time';break;}
  }
  if(reason==='open'&&row.exit!=null&&row.exitAt!=null)exit=[Math.floor((row.exitAt-row.openedAt)/60_000),row.exit,row.exit];
  const price=(exit[1]+exit[2])/2,gross=dir*row.qty*(price-row.entry),fee=row.entryFee+row.qty*price*FEE_RATE;
  return {net:gross-fee,minute:exit[0]};
}
function stopPrice(row:TradePath,sl:number){return row.side==='LONG'?row.entry*(1-sl):row.entry*(1+sl);}
function tpPrice(row:TradePath,tp:number){return row.side==='LONG'?row.entry*(1+tp):row.entry*(1-tp);}
function signed(dir:number,entry:number,price:number){return dir*(price/entry-1);}
function extreme(row:TradePath){
  let favorable=0,adverse=0,minute:number|null=null;
  const dir=row.side==='LONG'?1:-1;
  for(const point of row.hold){
    const best=Math.max(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    const worst=Math.min(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    if(best>favorable){favorable=best;minute=point[0];}
    adverse=Math.max(adverse,-worst);
  }
  return {favorable,adverse,minute};
}
function round(n:number){return Number(n.toFixed(4));}
