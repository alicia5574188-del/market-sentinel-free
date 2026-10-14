/** Observation only. Never changes an order, a stop, or the account. */
import type {ForwardState, Quote} from './forward-relations.ts';

export const TRADE_PATH_KEY='market-intelligence:trade-paths:v1';
export const TRADE_PATH_INDEX_KEY='market-intelligence:trade-paths:v2';
export const TRADE_PATH_PAGE_PREFIX='market-intelligence:trade-paths:v2:';
export const TRADE_PATH_VERSION='trade-path-v1' as const;
export const TRADE_PATH_PAGE_VERSION='trade-path-v2' as const;
const AFTER_MINUTES=180;
const PATH_CAP=1200;
const PATH_PAGE_SIZE=4;
const PAGE_BYTE_BUDGET=96_000;
const PRICE_WINDOW_MS=5*60_000;
const COST_RATE=0.002;
const FEE_RATE=0.0007;
const TAKE_PROFITS=[0.4,0.6,0.8,1,1.5,2,3];
const STOP_LOSSES=[0.3,0.4,0.6,0.8,1,1.5];
const HOLD_MINUTES=[5,15,30,45,60,90,120,180];

export type PathPoint=[number,number,number];
export type TradePath={
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;qty:number;notional:number;entryFee:number;openedAt:number;
  exit:number|null;exitAt:number|null;net:number|null;hold:PathPoint[];after:PathPoint[];page?:number;
};
export type TradePathBook={
  version:typeof TRADE_PATH_VERSION;accountStartedAt:number;trades:TradePath[];
  dirty:number[];drop:number[];indexDirty:boolean;
};
export type TradePathPage={version:typeof TRADE_PATH_PAGE_VERSION;accountStartedAt:number;page:number;trades:TradePath[]};
export type TradePathIndex={version:typeof TRADE_PATH_PAGE_VERSION;accountStartedAt:number;pages:number[]};
export type PathWrite={op:'put';page:number;value:TradePathPage}|{op:'delete';page:number}|{op:'index';value:TradePathIndex};

export function emptyTradePathBook(accountStartedAt:number):TradePathBook{
  return {version:TRADE_PATH_VERSION,accountStartedAt,trades:[],dirty:[],drop:[],indexDirty:false};
}
export function restoreTradePathBook(saved:TradePathBook|undefined,accountStartedAt:number){
  if(!saved||saved.version!==TRADE_PATH_VERSION||saved.accountStartedAt!==accountStartedAt||!Array.isArray(saved.trades))return emptyTradePathBook(accountStartedAt);
  return {version:TRADE_PATH_VERSION,accountStartedAt,trades:saved.trades,dirty:[],drop:[],indexDirty:false};
}
export function adoptLegacyPaths(saved:TradePathBook|undefined,accountStartedAt:number){
  const book=restoreTradePathBook(saved,accountStartedAt);
  const count=book.trades.length;
  book.trades.forEach((row,index)=>{row.page=Math.floor((count-1-index)/PATH_PAGE_SIZE);});
  book.dirty=[...new Set(book.trades.map(row=>row.page??0))];
  book.indexDirty=book.trades.length>0;
  return book;
}
export function bookFromStoredPaths(accountStartedAt:number,index:TradePathIndex,pages:Iterable<TradePathPage|undefined>){
  const book=emptyTradePathBook(accountStartedAt);
  const byPage=new Map<number,TradePath[]>();
  for(const page of pages){
    if(!page||page.version!==TRADE_PATH_PAGE_VERSION||page.accountStartedAt!==accountStartedAt||!Array.isArray(page.trades))continue;
    byPage.set(page.page,page.trades);
  }
  for(const page of [...index.pages].sort((a,b)=>b-a)){
    const rows=byPage.get(page);if(rows)book.trades.push(...rows);
  }
  return book;
}
export function peekPathWrite(book:TradePathBook):PathWrite|null{
  const page=book.dirty[0];
  if(page!=null)return {op:'put',page,value:packPathPage(book.accountStartedAt,page,book.trades.filter(row=>(row.page??0)===page))};
  if(book.indexDirty){
    const pages=[...new Set(book.trades.map(row=>row.page??0))].sort((a,b)=>a-b);
    return {op:'index',value:{version:TRADE_PATH_PAGE_VERSION,accountStartedAt:book.accountStartedAt,pages}};
  }
  const drop=book.drop[0];
  return drop==null?null:{op:'delete',page:drop};
}
export function commitPathWrite(book:TradePathBook,job:PathWrite){
  if(job.op==='put')book.dirty.shift();
  else if(job.op==='index')book.indexDirty=false;
  else book.drop.shift();
}

export function observeTradePaths(book:TradePathBook,state:ForwardState,execution:Record<string,Quote>,analysis:Record<string,Quote>,now:number,bars?:Record<string,{time:number;high:number;low:number}[]>){
  let changed=false;
  if(book.accountStartedAt!==state.startedAt){book.accountStartedAt=state.startedAt;book.trades=[];book.dirty=[];book.indexDirty=true;changed=true;}
  const byId=new Map(book.trades.map(row=>[row.id,row]));
  for(const t of [...state.positions,...state.history]){
    if(t.inverseCopy)continue;
    let row=byId.get(t.id);
    if(!row){
      const page=nextPathPage(book);
      row={id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,qty:t.quantity,notional:t.notional,entryFee:t.entryFee,openedAt:t.openedAt,
        exit:null,exitAt:null,net:null,hold:[],after:[],page};
      if(!book.trades.some(item=>(item.page??0)===page))book.indexDirty=true;
      book.trades.unshift(row);byId.set(t.id,row);markDirty(book,page);changed=true;
    }
    if(row.hold.length<=1&&rebuildFromBars(row,bars?.[t.symbol],t.closedAt??now)){markDirty(book,row.page??0);changed=true;}
    if(t.status==='CLOSED'&&row.exit==null&&t.exitPrice!=null&&t.closedAt!=null){
      row.exit=t.exitPrice;row.exitAt=t.closedAt;row.net=t.netPnl;row.qty=t.realization?.initialQuantity??row.qty;
      note(row.hold,Math.max(0,Math.floor((t.closedAt-t.openedAt)/60_000)),t.exitPrice);markDirty(book,row.page??0);changed=true;
    }
    const live=execution[t.symbol],wide=analysis[t.symbol];
    if(t.status==='OPEN'){
      const px=pathPrice(t.side,live,wide,t.lastPrice,t.lastQuoteAt,now);if(px==null)continue;
      if(note(row.hold,Math.floor((now-t.openedAt)/60_000),px)){markDirty(book,row.page??0);changed=true;}
    }else if(row.exitAt!=null&&now-row.exitAt<=AFTER_MINUTES*60_000){
      const px=pathPrice(t.side,live,wide,0,0,now);if(px==null)continue;
      if(note(row.after,Math.floor((now-row.exitAt)/60_000),px)){markDirty(book,row.page??0);changed=true;}
    }
  }
  if(book.trades.length>PATH_CAP){
    const dropped=book.trades.splice(PATH_CAP);
    for(const page of new Set(dropped.map(row=>row.page??0))){
      if(book.trades.some(row=>(row.page??0)===page))markDirty(book,page);
      else retirePage(book,page);
    }
    changed=true;
  }
  return changed;
}

function nextPathPage(book:TradePathBook){
  if(!book.trades.length)return 0;
  let max=0,count=0;
  for(const row of book.trades){
    const page=row.page??0;
    if(page>max){max=page;count=1;}
    else if(page===max)count++;
  }
  return count>=PATH_PAGE_SIZE?max+1:max;
}
function markDirty(book:TradePathBook,page:number){if(!book.dirty.includes(page))book.dirty.push(page);}
function retirePage(book:TradePathBook,page:number){
  book.dirty=book.dirty.filter(item=>item!==page);
  if(!book.drop.includes(page))book.drop.push(page);
  book.indexDirty=true;
}
function packPathPage(accountStartedAt:number,page:number,trades:TradePath[]):TradePathPage{
  const copy=trades.map(row=>({...row,hold:row.hold.map(point=>[...point] as PathPoint),after:row.after.map(point=>[...point] as PathPoint)}));
  for(let guard=0;guard<8&&roughBytes(copy)>PAGE_BYTE_BUDGET;guard++){
    const row=copy.reduce((left,right)=>left.hold.length+left.after.length>=right.hold.length+right.after.length?left:right);
    if(row.hold.length>60)row.hold=thin(row.hold);
    else if(row.after.length>60)row.after=thin(row.after);
    else break;
  }
  return {version:TRADE_PATH_PAGE_VERSION,accountStartedAt,page,trades:copy};
}
function roughBytes(trades:TradePath[]){
  return trades.reduce((sum,row)=>sum+160+(row.hold.length+row.after.length)*24,80);
}
function thin(points:PathPoint[]){return points.filter((_,index)=>index===0||index===points.length-1||index%2===0);}
function pathPrice(side:'LONG'|'SHORT',live:Quote|undefined,wide:Quote|undefined,lastPrice:number,lastQuoteAt:number,now:number){
  const exec=side==='LONG'?live?.bestBid:live?.bestAsk;
  if(live&&exec!=null&&exec>0&&live.bestAsk>=live.bestBid&&now-live.observedAt<=PRICE_WINDOW_MS)return exec;
  if(wide&&wide.bestBid>0&&wide.bestAsk>=wide.bestBid&&now-wide.observedAt<=PRICE_WINDOW_MS)return (wide.bestBid+wide.bestAsk)/2;
  if(lastPrice>0&&lastQuoteAt>0&&now-lastQuoteAt<=PRICE_WINDOW_MS)return lastPrice;
  return null;
}
function barMs(time:number){return time<1e12?time*1000:time;}
function rebuildFromBars(row:TradePath,bars:{time:number;high:number;low:number}[]|undefined,endAt:number){
  if(!bars?.length||row.hold.length>1)return false;
  const points:PathPoint[]=[];
  for(const bar of bars){
    const start=barMs(bar.time);
    if(!(bar.high>0)||!(bar.low>0)||start+300_000<=row.openedAt||start>=endAt)continue;
    const minute=Math.max(0,Math.floor((Math.max(start,row.openedAt)-row.openedAt)/60_000));
    const low=Math.min(bar.low,bar.high),high=Math.max(bar.low,bar.high),last=points.at(-1);
    if(last&&last[0]===minute){last[1]=Math.min(last[1],low);last[2]=Math.max(last[2],high);}
    else points.push([minute,low,high]);
  }
  if(points.length<2)return false;
  row.hold=points;return true;
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
  if(!rows.length)return {trades:0,best:null,profitable:false,verdict:'重置之后还没有走出价格路径。新单从下一拍开始记，进场、持仓、出场后 180 分钟都会留下。'};
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
  const dir=row.side==='LONG'?1:-1,tp=tpPct/100,sl=slPct/100,path=continued(row);
  let exit=path.at(-1)!,reason:'sl'|'tp'|'time'|'open'='open';
  for(const point of path){
    const worst=Math.min(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    const best=Math.max(signed(dir,row.entry,point[1]),signed(dir,row.entry,point[2]));
    if(worst<=-sl){exit=[point[0],stopPrice(row,sl),stopPrice(row,sl)];reason='sl';break;}
    if(best>=tp){exit=[point[0],tpPrice(row,tp),tpPrice(row,tp)];reason='tp';break;}
    if(point[0]>=holdMin){exit=point;reason='time';break;}
  }
  if(reason==='open'&&row.exit!=null&&row.exitAt!=null&&!row.after.length)exit=[Math.floor((row.exitAt-row.openedAt)/60_000),row.exit,row.exit];
  const price=(exit[1]+exit[2])/2,gross=dir*row.qty*(price-row.entry),fee=row.entryFee+row.qty*price*FEE_RATE;
  return {net:gross-fee,minute:exit[0]};
}
function continued(row:TradePath):PathPoint[]{
  if(row.exitAt==null||!row.after.length)return row.hold;
  const base=Math.max(0,Math.floor((row.exitAt-row.openedAt)/60_000));
  return [...row.hold,...row.after.map(([minute,low,high])=>[base+minute,low,high] as PathPoint)];
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
