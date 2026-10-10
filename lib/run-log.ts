/** One export. Strategy decisions and runtime faults stay in different categories. */
export type LogCat='STRAT'|'EXEC'|'DATA'|'RISK'|'SYS'|'PNL';
export type RunEvent={ts:number;level:'DEBUG'|'INFO'|'WARN'|'ERROR';cat:LogCat;symbol:string|null;event:string;reason:string|null;
  fields:Record<string,number|string|boolean|null>;trace:string};
export type RunFunnel={day:string;scans:number;universe:number;stale:number;spread:number;priceCheck:number;trend:number;
  exhaustion:number;sweep:number;micro:number;signals:number;rested:number;filled:number;cancelled:number;closed:number;wins:number};
export const emptyFunnel=(day:string):RunFunnel=>({day,scans:0,universe:0,stale:0,spread:0,priceCheck:0,trend:0,exhaustion:0,sweep:0,micro:0,signals:0,rested:0,filled:0,cancelled:0,closed:0,wins:0});

const CAP=300;
export function appendRunLog(log:RunEvent[]|undefined,event:RunEvent){return [...(log??[]),event].slice(-CAP);}
export function traceOf(now:number){return `scan-${Math.floor(now/2_000).toString(36)}`;}

export type LsrFill={ts:number;symbol:string;side:'LONG'|'SHORT';price:number;qty:number;notional:number;fee:number;tag:'open'|'close';trace:string;waitMs:number|null;limit:number|null};
export type LsrPositionRow={id:string;symbol:string;side:'LONG'|'SHORT';entry:number;exit:number|null;qty:number;notional:number;gross_pnl:number|null;fee:number;net_pnl:number|null;holdSec:number;exit_reason:'stop'|'tp'|'time'|'prior'|null;gapBps:number|null;opened_at:number;closed_at:number|null;trace:string};
export type LsrCurvePoint={ts:number;equity:number;closed_pnl:number;unrealized_pnl:number;positions:number};
const ROW_CAP=8_000;
export function rememberRow<T>(rows:T[]|undefined,row:T){return [...(rows??[]),row].slice(-ROW_CAP);}

export function buildRunLogExport(input:{events:RunEvent[];funnel:RunFunnel|null;health:{sources?:{source:string;fresh?:boolean;failures?:number;lastError?:string|null;rows?:number}[];healthySources?:number};gate:{connected?:boolean;lastError?:string|null;freshBooks?:number};exportedAt:number;liveEnabled:boolean;
  positions?:LsrPositionRow[];fills?:LsrFill[];curve?:LsrCurvePoint[];equity?:number|null;initial?:number|null;closedNet?:number|null;priorAdjustment?:number|null;
  exec?:{signals:number;placed:number;fallback:number;spreadSum:number;midSum:number}|null}){
  const funnel=input.funnel??emptyFunnel('');
  const strategy={signal_not_triggered:funnel.trend+funnel.exhaustion+funnel.sweep+funnel.micro+funnel.spread,
    signal_triggered_no_fill:funnel.cancelled};
  const runtime={data_stale:funnel.stale,price_disagreement:funnel.priceCheck,
    ws_disconnect:input.gate.connected===false?1:0,order_rejected:input.events.filter(e=>e.event==='order_rejected').length};
  const positions=(input.positions??[]).filter(row=>row.exit_reason!=='prior'),fills=input.fills??[],curve=input.curve??[];
  const closed=positions.filter(row=>row.net_pnl!=null);
  const closedPnl=closed.reduce((n,row)=>n+(row.net_pnl??0),0);
  const unrealized=positions.filter(row=>row.net_pnl==null).reduce((n,row)=>n+(row.gross_pnl??0)-row.fee,0);
  const equity=input.equity??null,initial=input.initial??null,prior=input.priorAdjustment??0;
  const identity=equity!=null&&initial!=null?equity-(initial+prior+closedPnl+unrealized):null;
  const fillFee=fills.reduce((n,row)=>n+row.fee,0),positionFee=positions.reduce((n,row)=>n+row.fee,0);
  const waits=fills.filter(row=>row.tag==='open'&&row.waitMs!=null).map(row=>row.waitMs??0);
  const slips=fills.filter(row=>row.tag==='open'&&row.limit!=null&&row.limit>0).map(row=>{
    const bps=(row.price-row.limit!)/row.limit!*10_000;return row.side==='LONG'?bps:-bps;});
  const gaps=closed.filter(row=>row.exit_reason==='stop'&&row.gapBps!=null).map(row=>row.gapBps??0).sort((a,b)=>a-b);
  const at=(p:number)=>gaps.length?gaps[Math.min(gaps.length-1,Math.max(0,Math.ceil(p*gaps.length)-1))]!:0;
  let gap=true;for(let i=1;i<curve.length;i++)if(Math.abs(curve[i]!.equity-curve[i-1]!.equity)>=5)gap=false;
  const logs=[...input.events];
  if(gaps.length<10)logs.push({ts:input.exportedAt,level:'WARN',cat:'PNL',symbol:null,event:'stop_sample_short',reason:`止损样本 ${gaps.length} 笔，不到 10 笔，止损统计先别当真。`,fields:{count:gaps.length},trace:traceOf(input.exportedAt)});
  const rejectedN=input.events.filter(event=>event.event==='order_placing'&&event.fields.post_only_rejected===true).length;
  const exec=input.exec??{signals:0,placed:0,fallback:0,spreadSum:0,midSum:0};
  const body={version:'lsr-run-log-v2' as const,exportedAt:input.exportedAt,liveEnabled:input.liveEnabled,
    howToRead:'恒等式是 权益 = 初始 + prior_adjustment + closed_pnl_sum + unrealized_pnl。prior_adjustment 是旧账，只加一次，不算进已平净利，也不算胜率。fallback_rate = 退回买一或卖一的次数 / 这段时间的信号数。avg_spread_bps 是下单时的价差。avg_submitted_vs_mid_bps 是提交价离中间价多远，负数表示还在自己这边。这三个数从本版上线后才开始记。',
    funnel,sourceHealth:input.health,gate:input.gate,
    breakdown:{strategy_issues:strategy,runtime_issues:runtime,
      verdict:runtime.data_stale+runtime.price_disagreement+runtime.ws_disconnect+runtime.order_rejected>strategy.signal_not_triggered&&runtime.data_stale+runtime.ws_disconnect>0?'先看运行':'先看策略'},
    logs:logs.slice(-200),
    invariants:{equity,initial,prior_adjustment:Number(prior.toFixed(4)),closed_pnl_sum:Number(closedPnl.toFixed(4)),unrealized_pnl:Number(unrealized.toFixed(4)),
      identity_error:identity==null?null:Number(identity.toFixed(4)),
      checks:{fees_match:Math.abs(fillFee-positionFee)<0.01,positions_sum_match:Math.abs(closedPnl-(input.closedNet??closedPnl))<0.01,no_gap_in_equity_curve:gap}},
    execution_quality:{signals:funnel.signals,filled:funnel.filled,cancelled:funnel.cancelled,
      fill_rate:funnel.signals>0?Number((funnel.filled/funnel.signals).toFixed(4)):0,
      cancel_rate:funnel.signals>0?Number((funnel.cancelled/funnel.signals).toFixed(4)):0,
      order_timeout_ms:6000,avg_wait_ms:waits.length?Number((waits.reduce((n,v)=>n+v,0)/waits.length).toFixed(1)):0,
      avg_slippage_bps:slips.length?Number((slips.reduce((n,v)=>n+v,0)/slips.length).toFixed(2)):0,
      placed:exec.placed,fallback_used:exec.fallback,post_only_rejected:rejectedN,
      fallback_rate:exec.signals>0?Number((exec.fallback/exec.signals).toFixed(4)):0,
      avg_spread_bps:exec.placed>0?Number((exec.spreadSum/exec.placed).toFixed(2)):0,
      avg_submitted_vs_mid_bps:exec.placed>0?Number((exec.midSum/exec.placed).toFixed(2)):0},
    stop_loss_stats:{count:gaps.length,gapbps_min:gaps[0]??0,gapbps_median:at(.5),gapbps_p90:at(.9),gapbps_max:gaps.at(-1)??0,gapbps_values:gaps},
    positions,fills,equity_curve:curve};
  if(JSON.stringify(body).length>20_000_000)body.equity_curve=curve.filter((_,i)=>i%5===0);
  return body;
}
