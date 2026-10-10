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

export function buildRunLogExport(input:{events:RunEvent[];funnel:RunFunnel|null;health:{sources?:{source:string;fresh?:boolean;failures?:number;lastError?:string|null;rows?:number}[];healthySources?:number};gate:{connected?:boolean;lastError?:string|null;freshBooks?:number};exportedAt:number;liveEnabled:boolean}){
  const funnel=input.funnel??emptyFunnel('');
  const strategy={signal_not_triggered:funnel.trend+funnel.exhaustion+funnel.sweep+funnel.micro+funnel.spread,
    signal_triggered_no_fill:funnel.cancelled};
  const runtime={data_stale:funnel.stale,price_disagreement:funnel.priceCheck,
    ws_disconnect:input.gate.connected===false?1:0,order_rejected:input.events.filter(e=>e.event==='order_rejected').length};
  return {version:'lsr-run-log-v1' as const,exportedAt:input.exportedAt,liveEnabled:input.liveEnabled,
    howToRead:'没做单先看 funnel，数字堆在 trend 或 exhaustion 就是策略没触发。signals 有、filled 没有，看 logs 里的 EXEC。stale、priceCheck、ws_disconnect 是运行问题。',
    funnel,sourceHealth:input.health,gate:input.gate,
    breakdown:{strategy_issues:strategy,runtime_issues:runtime,
      verdict:runtime.data_stale+runtime.price_disagreement+runtime.ws_disconnect+runtime.order_rejected>strategy.signal_not_triggered&&runtime.data_stale+runtime.ws_disconnect>0?'先看运行':'先看策略'},
    logs:input.events};
}
