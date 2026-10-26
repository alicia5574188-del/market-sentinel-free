/**
 * dynamic-v1.4 pool log: one consistent record shape for everything the unified, predictor-gated scheme decides, so a review can
 * rebuild it from the run-log export alone. Records ride in the 10-minute timeline buckets (memory + D1 living_run_log, never DO
 * storage) and the export lists them flat as `pool_log`.
 *
 *  GATE     a gate decision: the allocator's verdict changed for a playbook (src "allocator"), or a fresh entry signal was allowed /
 *           denied (src "signal": pool signal, burst pick, daily-breakout pick) — P(good 6 h), threshold, phase, size, reason
 *  OPEN     a pool trade opened on the paper account — playbook, coin, side, entry, stop, risk %
 *  CLOSE    a pool trade closed — entry, exit, price move % (never ROE), net U, risk %, exit reason, minutes held
 *  PRED     predictor snapshot (hourly): playbooks forecast, how many allowed, top 5 with P(good 6 h), live score, hit rate
 *  SCORE    forecasts that came due and were scored in one analysis: count, hit rate, Brier, live score of the 6 h ones
 *  BACKFILL history download progress (every 30 min): series done / total, requests today, errors, rate-limited venues, trades
 * Pure: no I/O.
 */
const r6=(x:number)=>Math.round(x*1e6)/1e6;
export const POOL_LOG_VERSION="pool-log-v1" as const;
export type PoolRecType="GATE"|"OPEN"|"CLOSE"|"PRED"|"SCORE"|"BACKFILL";
export type PoolRec={t:PoolRecType;at:number;pb?:string|null;sym?:string|null;side?:"LONG"|"SHORT"|null;[k:string]:unknown};
/** per bucket: trades (OPEN / CLOSE) are never dropped below this many; everything else shares the rest */
export const POOL_PER_BUCKET=80,POOL_TRADES_PER_BUCKET=60;
export const POOL_TYPE_LABEL:Record<PoolRecType,string>={GATE:"开单判断",OPEN:"开仓",CLOSE:"平仓",PRED:"预测快照",SCORE:"预测评分",BACKFILL:"历史下载进度"};
/** price move % of a trade in its own direction (0.012 = +1.2%), never ROE */
export const movePct=(side:"LONG"|"SHORT",entry:number|null|undefined,exit:number|null|undefined)=>
  entry&&exit&&entry>0&&exit>0?Math.round((side==="LONG"?1:-1)*(exit/entry-1)*1e6)/1e6:null;
/** a living note that belongs to the unified pool (daily breakout / pool playbook: hx; burst-leader: bh) */
export const isPoolNote=(n:{hx?:1;bh?:1}|null|undefined)=>!!n&&(!!n.hx||!!n.bh);
/** keep numbers short and strings bounded so a record stays ~200–400 bytes */
export function compactRec(r:PoolRec):PoolRec{
  const out:PoolRec={t:r.t,at:r.at};
  for(const [k,v] of Object.entries(r)){if(k==="t"||k==="at"||v===undefined)continue;
    out[k]=typeof v==="number"?(Number.isFinite(v)?r6(v):null):typeof v==="string"?v.slice(0,k==="why"?220:120):v;}
  return out;
}
/** summary of the flat log for the export (per playbook: allowed / denied decisions, opens, closes, Σ price move %) */
export function poolSummary(recs:readonly PoolRec[]){
  const by:Record<string,{allow:number;deny:number;open:number;close:number;win:number;move:number;net:number}>={};
  const counts:Record<string,number>={};
  for(const r of recs){counts[r.t]=(counts[r.t]??0)+1;if(!r.pb)continue;const x=by[r.pb]??={allow:0,deny:0,open:0,close:0,win:0,move:0,net:0};
    if(r.t==="GATE"&&r.src==="signal"){if(r.ok)x.allow++;else x.deny++;}
    if(r.t==="OPEN")x.open++;
    if(r.t==="CLOSE"){x.close++;const m=typeof r.move==="number"?r.move:0;x.move+=m;if(m>0)x.win++;if(typeof r.net==="number")x.net+=r.net;}}
  for(const x of Object.values(by)){x.move=r6(x.move);x.net=Math.round(x.net*100)/100;}
  return {counts,by_playbook:by};
}
export const POOL_FIELD_NOTES={
  common:"每条记录：t 类型，at 时间（UTC 毫秒），pb 打法代码（看 playbook_labels），sym 币，side 方向。价格幅度都是价格涨跌（0.012 = +1.2%），不是 ROE。",
  GATE:"开单判断。src=allocator：分配器对这套打法的结论变了（ok 允许/不允许）；src=signal：一个新的开单信号被放行或拦下（kind=pool 打法池信号 / burst 爆发选币 / htf 日线突破）。p6 未来 6 小时在赚钱期的概率，pMin 门槛，phase 现在是赚钱期 GOOD / 亏钱期 BAD / 不明，elapsedH 这一段已多久（小时），label 数据少/数据一般/数据较足，risk 允许时的风险（占权益比例），why 原因（中文）。decision：ALLOW 分配器允许（src=allocator），CUT 预测被影子交易打脸、暂停 12 小时，ORDER 发出开单，DENY 分配器不允许，SWITCH_OFF 开关 10 关着，BUSY 打法池/本打法/这个币已满，WAIT 研究层只计算/降级，STOP_CROSSED 现价已越过止损，NOT_LIVE 这个币不在实时报价币池（没有 Gate 实时盘口），只记录、不发单（影子交易照记，预测器照学），NO_QUOTE 发出后这个币没有 Gate 实时盘口、没开，REJECTED 发出后模拟账户拒单（src=account，why 是拒单原因，例如维持保证金率 >3%、止损超过爆仓距离 40%、风险预算不足）。",
  OPEN:"开仓：trade 订单号，entry 开仓价，stop 止损，risk 风险（占权益比例，按预测器原公式），why 开单理由。固定名义单另有：notional 实际名义（U），notional_fixed 固定名义设定，sizing_notional_virtual 原公式会开的名义（U），sizing_risk_virtual 原公式的风险额（U，闸门按它算时才有），planned_risk 实际名义的风险额（U）。止损止盈按价格百分比，与名义无关。",
  CLOSE:"平仓：entry/exit 开平价，move 价格涨跌（按方向，%），net 净盈亏（U，已扣费），risk 开仓时的风险比例（老单没有记录时为空），held_min 持有分钟，exit_code 出场代码，exit_why 出场原因。出场代码 LIVING_DYN_POOL_LOCK（池内动态锁利）时另带：lock_peak 最高浮盈，lock_cur 触发时浮盈，lock_line 保护线，lock_stall_min 多少分钟没创新高，lock_r 这单计划风险（开仓价到初始止损的距离），lock_peak_r 最高浮盈是几个 R，lock_window_min 停滞窗口（都是价格涨跌，不是 ROE）。",
  PRED:"预测快照（每小时）：n 有预测的打法数，allowed 允许开单的打法数，top 前 5（pb, p6 概率, phase, label），real6 实盘检验（6 小时内跟着来的影子交易：看好时/不看好时的笔数和平均 %），hit/brier 已到期预测的命中率和 Brier。",
  SCORE:"一次分析里到期并评分的预测：n 个，hit 命中率，brier，good/other 是 6 小时预测看好时/不看好时后续影子交易的 [笔数, 合计 %]。",
  BACKFILL:"历史下载进度（每 30 分钟）：done/total 序列，req 今天请求数，err 累计失败，blocked 限流中的交易所，trades 影子交易笔数，units 已回放的历史块。只用 Bybit/OKX/KuCoin，从不请求 Gate。",
} as const;
