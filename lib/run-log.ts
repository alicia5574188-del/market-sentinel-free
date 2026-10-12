/** One export. Strategy decisions and runtime faults stay in different categories. */
import type {ForwardState,Quote,Trade} from './forward-relations.ts';
import {PAPER_COST,freshQuote,forwardEquity} from './forward-relations.ts';
export type LogCat='STRAT'|'EXEC'|'DATA'|'RISK'|'SYS'|'PNL';
export type RunEvent={ts:number;level:'DEBUG'|'INFO'|'WARN'|'ERROR';cat:LogCat;symbol:string|null;event:string;reason:string|null;
  fields:Record<string,number|string|boolean|null>;trace:string};
export type RunFunnel={day:string;scans:number;universe:number;stale:number;spread:number;priceCheck:number;trend:number;
  exhaustion:number;sweep:number;micro:number;signals:number;rested:number;filled:number;cancelled:number;closed:number;wins:number};
export const emptyFunnel=(day:string):RunFunnel=>({day,scans:0,universe:0,stale:0,spread:0,priceCheck:0,trend:0,exhaustion:0,sweep:0,micro:0,signals:0,rested:0,filled:0,cancelled:0,closed:0,wins:0});

const CAP=300;
export function appendRunLog(log:RunEvent[]|undefined,event:RunEvent){return [...(log??[]),event].slice(-CAP);}
export function traceOf(now:number){return `scan-${Math.floor(now/2_000).toString(36)}`;}

export type LsrPlace={spreadBps:number;vsMid:number;fallback:boolean;rejected:boolean};
export function placeFromEvent(fields:RunEvent['fields']):LsrPlace|null{
  if(typeof fields.spread_bps!=='number')return null;
  let vsMid=fields.submitted_vs_mid_bps;
  if(typeof vsMid!=='number'&&typeof fields.bid==='number'&&typeof fields.ask==='number'&&typeof fields.submitted==='number'){
    const mid=(fields.bid+fields.ask)/2;
    vsMid=mid>0?(fields.side==='SHORT'?(mid-fields.submitted)/mid*10_000:(fields.submitted-mid)/mid*10_000):0;
  }
  return {spreadBps:fields.spread_bps,vsMid:typeof vsMid==='number'?vsMid:0,fallback:fields.fallback_used===true,rejected:fields.post_only_rejected===true};
}
export function placesFromEvents(events:RunEvent[]){return events.filter(event=>event.event==='order_placing').map(event=>placeFromEvent(event.fields)).filter((row):row is LsrPlace=>row!=null);}
export type LsrFill={ts:number;symbol:string;side:'LONG'|'SHORT';price:number;qty:number;notional:number;fee:number;tag:'open'|'close';trace:string;waitMs:number|null;limit:number|null};
export type LsrPositionRow={id:string;symbol:string;side:'LONG'|'SHORT';entry:number;exit:number|null;qty:number;notional:number;gross_pnl:number|null;fee:number;net_pnl:number|null;holdSec:number;exit_reason:'stop'|'tp'|'time'|'prior'|'tp1'|'tp2'|'sl'|'invalidate'|'external'|'dropped'|null;gapBps:number|null;opened_at:number;closed_at:number|null;trace:string};
export type LsrCurvePoint={ts:number;equity:number;closed_pnl:number;unrealized_pnl:number;positions:number};
const ROW_CAP=8_000;
export function rememberRow<T>(rows:T[]|undefined,row:T){return [...(rows??[]),row].slice(-ROW_CAP);}

export function buildRunLogExport(input:{events:RunEvent[];funnel:RunFunnel|null;health:{sources?:{source:string;fresh?:boolean;failures?:number;lastError?:string|null;rows?:number}[];healthySources?:number};gate:{connected?:boolean;lastError?:string|null;freshBooks?:number};exportedAt:number;liveEnabled:boolean;
  positions?:LsrPositionRow[];fills?:LsrFill[];curve?:LsrCurvePoint[];equity?:number|null;initial?:number|null;closedNet?:number|null;priorAdjustment?:number|null;
  unreconstructed?:number|null;unreconstructedN?:number|null;
  places?:LsrPlace[]|null}){
  const funnel=input.funnel??emptyFunnel('');
  const strategy={signal_not_triggered:funnel.trend+funnel.exhaustion+funnel.sweep+funnel.micro+funnel.spread,
    signal_triggered_no_fill:funnel.cancelled};
  const runtime={data_stale:funnel.stale,price_disagreement:funnel.priceCheck,
    ws_disconnect:input.gate.connected===false?1:0,order_rejected:input.events.filter(e=>e.event==='order_rejected').length};
  const positions=(input.positions??[]).filter(row=>row.exit_reason!=='prior'),fills=input.fills??[],curve=input.curve??[];
  const closed=positions.filter(row=>row.net_pnl!=null);
  const closedPnl=closed.reduce((n,row)=>n+(row.net_pnl??0),0);
  const unrealized=positions.filter(row=>row.net_pnl==null).reduce((n,row)=>n+(row.gross_pnl??0)-row.fee,0);
  const equity=input.equity??null,initial=input.initial??null,prior=input.priorAdjustment??0,unreconstructed=input.unreconstructed??0;
  const identity=equity!=null&&initial!=null?equity-(initial+prior+closedPnl+unrealized+unreconstructed):null;
  const fillFee=fills.reduce((n,row)=>n+row.fee,0),positionFee=positions.reduce((n,row)=>n+row.fee,0);
  const waits=fills.filter(row=>row.tag==='open'&&row.waitMs!=null).map(row=>row.waitMs??0);
  const slips=fills.filter(row=>row.tag==='open'&&row.limit!=null&&row.limit>0).map(row=>{
    const bps=(row.price-row.limit!)/row.limit!*10_000;return row.side==='LONG'?bps:-bps;});
  const gaps=closed.filter(row=>row.exit_reason==='stop'&&row.gapBps!=null).map(row=>row.gapBps??0).sort((a,b)=>a-b);
  const at=(p:number)=>gaps.length?gaps[Math.min(gaps.length-1,Math.max(0,Math.ceil(p*gaps.length)-1))]!:0;
  let gap=true;for(let i=1;i<curve.length;i++)if(Math.abs(curve[i]!.equity-curve[i-1]!.equity)>=5)gap=false;
  const logs=[...input.events];
  if(gaps.length<10)logs.push({ts:input.exportedAt,level:'WARN',cat:'PNL',symbol:null,event:'stop_sample_short',reason:`止损样本 ${gaps.length} 笔，不到 10 笔，止损统计先别当真。`,fields:{count:gaps.length},trace:traceOf(input.exportedAt)});
  const rows=(input.places&&input.places.length?input.places:placesFromEvents(input.events));
  const fallbackN=rows.filter(row=>row.fallback).length,rejectedN=rows.filter(row=>row.rejected).length;
  const body={version:'lsr-run-log-v2' as const,exportedAt:input.exportedAt,liveEnabled:input.liveEnabled,
    howToRead:'这是当前市场智能模拟账户。权益 = 初始 + 已平净利 + 未平（价格盈亏 − 开仓费 − 预计平仓费）。不是已经停掉的实验漏斗。',
    funnel,sourceHealth:input.health,gate:input.gate,
    breakdown:{strategy_issues:strategy,runtime_issues:runtime,
      verdict:runtime.data_stale+runtime.price_disagreement+runtime.ws_disconnect+runtime.order_rejected>strategy.signal_not_triggered&&runtime.data_stale+runtime.ws_disconnect>0?'先看运行':'先看策略'},
    logs:logs.slice(-200),
    invariants:{equity,initial,prior_adjustment:Number(prior.toFixed(4)),closed_pnl_sum:Number(closedPnl.toFixed(4)),unrealized_pnl:Number(unrealized.toFixed(4)),
      identity_error:identity==null?null:Number(identity.toFixed(4)),
      checks:{fees_match:Math.abs(fillFee-positionFee)<0.05,positions_sum_match:Math.abs(closedPnl-(input.closedNet??closedPnl))<0.05,no_gap_in_equity_curve:gap}},
    execution_quality:{signals:funnel.signals,filled:funnel.filled,cancelled:funnel.cancelled,
      fill_rate:funnel.signals>0?Number((funnel.filled/funnel.signals).toFixed(4)):0,
      cancel_rate:funnel.signals>0?Number((funnel.cancelled/funnel.signals).toFixed(4)):0,
      order_timeout_ms:6000,avg_wait_ms:waits.length?Number((waits.reduce((n,v)=>n+v,0)/waits.length).toFixed(1)):0,
      avg_slippage_bps:slips.length?Number((slips.reduce((n,v)=>n+v,0)/slips.length).toFixed(2)):0,
      placed:rows.length,fallback_used:fallbackN,post_only_rejected:rejectedN,
      fallback_rate:rows.length?Number((fallbackN/rows.length).toFixed(4)):0,
      avg_spread_bps:rows.length?Number((rows.reduce((n,row)=>n+row.spreadBps,0)/rows.length).toFixed(2)):0,
      avg_submitted_vs_mid_bps:rows.length?Number((rows.reduce((n,row)=>n+row.vsMid,0)/rows.length).toFixed(2)):0},
    stop_loss_stats:{count:gaps.length,gapbps_min:gaps[0]??0,gapbps_median:at(.5),gapbps_p90:at(.9),gapbps_max:gaps.at(-1)??0,gapbps_values:gaps},
    book_audit:[
      {step:'初始资金',amount:initial},
      {step:'旧账 prior_adjustment，只记一次，不算进已平',amount:Number(prior.toFixed(4))},
      {step:'已平净利，含实验单',amount:Number(closedPnl.toFixed(4))},
      {step:'还没平的浮盈，已扣掉开仓手续费和开仓滑点',amount:Number(unrealized.toFixed(4))},
      {step:`平仓记录被裁掉的 ${input.unreconstructedN??0} 笔，合计现金，不算进胜率`,amount:Number(unreconstructed.toFixed(4))},
      {step:'上面几项加出来的权益',amount:initial==null?null:Number((initial+prior+closedPnl+unrealized+unreconstructed).toFixed(4))},
      {step:'账户实际权益',amount:equity},
      {step:'对不上的差额。接近 0 才算账平了',amount:identity==null?null:Number(identity.toFixed(4))},
    ],
    positions,fills,equity_curve:curve};
  if(JSON.stringify(body).length>20_000_000)body.equity_curve=curve.filter((_,i)=>i%5===0);
  return body;
}

/** The phone export. Rows are the live paper account, not a retired experiment book. */
export function accountLogBook(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const openRows:LsrPositionRow[]=[];
  const closedRows:LsrPositionRow[]=[];
  const fills:LsrFill[]=[];
  for(const t of state.history){
    const row=closedAccountRow(t);
    closedRows.push(row);
    fills.push({ts:t.openedAt,symbol:t.symbol,side:t.side,price:t.entryPrice,qty:t.quantity,notional:t.notional,fee:row.fee,tag:'open',trace:row.trace,waitMs:null,limit:t.entryPrice});
  }
  let unrealized=0;
  for(const t of state.positions){
    const marked=openMark(state,t,quotes,now);
    const row:LsrPositionRow={id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,exit:null,qty:t.quantity,notional:t.notional,
      gross_pnl:round4(marked.gross+marked.realized),fee:round4(t.entryFee+marked.exitReserve),net_pnl:null,
      holdSec:Math.max(0,Math.round((now-t.openedAt)/1000)),exit_reason:null,gapBps:null,opened_at:t.openedAt,closed_at:null,trace:t.id};
    openRows.push(row);
    unrealized+=row.gross_pnl!-row.fee;
    fills.push({ts:t.openedAt,symbol:t.symbol,side:t.side,price:t.entryPrice,qty:t.quantity,notional:t.notional,fee:row.fee,tag:'open',trace:row.trace,waitMs:null,limit:t.entryPrice});
  }
  const mark=forwardEquity(state,quotes,now);
  const closedNet=closedRows.reduce((n,row)=>n+(row.net_pnl??0),0);
  const funnel=emptyFunnel('');
  const eligible=state.opportunities.filter(o=>o.eligible&&o.expiresAt>now).length;
  funnel.universe=new Set([...state.positions,...state.history].map(t=>t.symbol)).size;
  funnel.scans=state.positions.length+state.history.length+state.opportunities.length;
  funnel.signals=eligible;
  funnel.filled=state.positions.length+state.history.length;
  funnel.closed=state.history.length;
  funnel.wins=state.history.filter(t=>(t.netPnl??0)>0).length;
  return {positions:[...closedRows,...openRows],fills,curve:[{ts:now,equity:round4(mark.equity),closed_pnl:round4(closedNet),unrealized_pnl:round4(unrealized),positions:openRows.length}],
    equity:mark.equity,initial:state.initialEquity,closedNet:round4(closedNet),priorAdjustment:0,places:[] as LsrPlace[],funnel,
    unreconstructed:0,unreconstructedN:0};
}
function closedAccountRow(t:Trade):LsrPositionRow{
  return {id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,exit:t.exitPrice,qty:t.quantity,notional:t.notional,
    gross_pnl:t.grossPnl,fee:round4(t.entryFee+t.exitFee+t.fundingAllowance),net_pnl:t.netPnl,
    holdSec:t.closedAt==null?0:Math.max(0,Math.round((t.closedAt-t.openedAt)/1000)),exit_reason:null,gapBps:null,
    opened_at:t.openedAt,closed_at:t.closedAt,trace:t.id};
}
function openMark(state:ForwardState,t:Trade,quotes:Record<string,Quote>,now:number){
  const q=quotes[t.symbol],fresh=freshQuote(q,now),policy=t.exitControl?.policy;
  const realized=t.realization?t.realization.gross-t.realization.fees-t.realization.funding:0;
  let px=t.lastPrice,reserveExit=false;
  if(t.inverseCopy){
    const source=state.inverseTrial?.source.positions.find(x=>x.id===t.inverseCopy!.sourceId);
    const valid=!!source&&source.lastPrice>0&&source.lastQuoteAt<=now;
    px=valid?source.lastPrice:t.lastPrice;
  }else if(policy==='lsr-v1'||policy==='rx-v1'||policy==='desk-v1'||policy==='needle-v1'||policy==='brain-v1'||policy==='score-v1'||policy==='read-v1'){
    px=fresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
  }else{
    px=fresh?(q!.bestBid+q!.bestAsk)/2:t.lastPrice;
    reserveExit=true;
  }
  const gross=px>0?(t.side==='LONG'?1:-1)*t.quantity*(px-t.entryPrice):0;
  return {gross,realized,exitReserve:reserveExit&&px>0?t.quantity*px*PAPER_COST.feeRate:0};
}
function round4(n:number){return Number(n.toFixed(4));}
