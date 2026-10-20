/**
 * The run-log export (kind=log), format living-run-log-v3. Pure: the worker hands in what it already has
 * (account book from buildRunLogExport, timeline buckets and cases from memory + D1) and gets the file back.
 */
import {RUNLOG_VERSION,mergeBuckets,whyNoTrades,caseStats,GATE_LABEL,LAYER_LABEL,BUCKET_MS,type Bucket,type FinalCase} from "./runlog.ts";

/** Position columns that describe the current system (everything else on a stored row is legacy and not exported). */
const POSITION_KEEP=new Set(["id","symbol","side","entry","exit","qty","notional","gross_pnl","fee","net_pnl","holdSec","opened_at","closed_at",
  "leverage","stop_price","exit_trigger","exit_move_pct","account_epoch","rule_epoch","planned_hold_min","funding_rate","volume24h_usd","entry_spread_bps",
  "path_minutes","mfe_pct","mae_pct","mfe_min","mae_before_mfe_pct","mfe_6h_pct","mae_6h_pct","hold_mfe_pct","exit_giveback_pct",
  "stop_dist_pct","hour_utc","weekday","chg_1h_pct","atr_5m_pct","dist_high_10h_pct","dist_low_10h_pct","range_pos_10h","mkt_with_share"]);
export function slimPosition(row:Record<string,unknown>){
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(row))if(POSITION_KEEP.has(k)||k.startsWith("living_"))out[k]=v;
  return out;
}

export const HOW_TO_READ=[
  "log_since 是运行日志清空的时间（有值时）：那之前的订单、时间线、案例、权益分钟和长期归档都已清掉，这份导出从那一刻开始，window_from 不会早于它。",
  "这是运行日志 v3，只为现在的系统写：开单、持有、出场都由研究层（living-v2）按实时的资金意图和人性读数决定。旧系统的阶段/路由、S1、entry_gate、老动量信号的未开单记录都不再导出。",
  "所有价格数字都是价格涨跌（%，路径里是基点 bp，1bp=0.01%），不是 ROE，不乘杠杆。",
  "想知道为什么很久没开单：先看 why_no_trades（整个导出窗口的汇总：开单通道每种状态多少分钟、候选在每一层被挡了多少次、最常见的挡单原因 top_reasons、大多数币为什么根本没有想法 no_idea_reasons、最长一段没开单的主要原因），再按时间看 timeline：每 10 分钟一行，gate 是开单通道每分钟的状态，funnel 是候选逐层的计数，reasons 是被挡原因，blocker 是这一段最主要的原因，events 是这段里的状态变化。minutes 少于 10 表示那段时间程序停过（例如部署）。",
  "想找赚钱的办法：看 cases。每一行是研究层认真看过的一个想法（某个币、某个方向、某个打法），记下当时的资金/情绪读数、证据数字、市场意图、走到了哪一层、被什么挡住，以及之后 6 小时每分钟的价格路径和结果（out）。同一个币同方向同打法 90 分钟内只算一个案例，seen 是这期间又被看到几次，stages 是每次层级变化。case_stats 按打法 × 走到的层汇总：被挡掉的想法后来到底涨了还是跌了。",
  "positions 是账户里的真实模拟单（开着的和平掉的，全部导出），带研究层字段 living_* 和价格路径；paths 是这些单从开仓起的分钟路径。账户对账看 account。",
];
export const FIELD_NOTES:Record<string,unknown>={
  timeline:{at:"这一段开始（UTC 毫秒）",end:"结束",minutes:"实际采样的分钟数",gate:"开单通道每分钟状态的分钟数，含义见 gate_labels",
    market:"市场意图每分钟的分钟数，如 RISK_OFF/SHORT（真资金做空）、CALM（平静）、WARMING（还读不出来）",last:"段末的市场意图：state 状态、side 方向、conf 把握、allowed 允许的打法/方向",
    mode:"研究层模式：off 关 / compute-only 只计算 / paper-enabled 模拟开单",fast:"快速通道（集体异动）每分钟状态：CALM 平静、ALERT 警报、CONFIRMED 确认",
    funnel:"这段里候选逐层的计数（每分钟每个候选算一次）：reads 读了几次币、ideas 有打法想法、no_idea 没想法；其余见 layer_labels",
    reasons:"层:原因 的计数（数字换成 #）",open:"段末持仓数",watches:"段末在等位置数",opened:"这段开出的单",blocker:"这一段最主要的没开单原因",events:"状态变化（市场意图、降级、模式、重启、集体异动）",boot:"程序这次启动的编号；同一段有两个编号说明这段里重启过"},
  cases:{id:"案例编号",at:"第一次出现（UTC 毫秒）",sym:"币",side:"方向",pb:"打法代码",pb_label:"打法",kind:"normal 五步闭环 / fast 集体异动",
    intent:"这个币当时的资金状态/情绪，如 DEMAND/BLOWOFF（贪婪见顶）、SUPPLY/CONVICTION（真卖盘）、FLUSH_DOWN/CAPITULATION（踩踏出尽）",
    strength:"证据强度 0–1",why:"研究层的一句话",
    ev:"当时的证据（%）：p15/p60 价格 15/60 分钟涨跌，oi15/oi60 持仓量变化，funding 资金费（%），taker15 主动买卖（>0.5 买方多），vol15 成交量倍数，basis 期现溢价",
    market:"当时的市场意图",layer:"第一次被挡（或推进到）的层",reason:"原因",furthest:"走到最远的一层",stages:"每次层级变化：时间、层、原因、价格",
    ref:"参考价：第一次出现时的中间价",seen:"90 分钟内被看到的次数",last:"最后一次被看到",trade:"开出的单：id、开仓时间/价、止损，平仓后有出场价、原因、净盈亏（U）",
    final:"true 表示 6 小时已走完、路径定稿；false 是进行中（路径到导出为止）",
    path:"t0 起每分钟一格，格式 收,高,低（相对 ref 的基点，原始价格方向，不按多空翻转），分号分隔；空格表示那一分钟没有数据（程序停了）；coarse 是只有 5 分钟精度的分钟段（重启前较早的部分）",
    out:"按案例方向算（价格 %）：mfe/mae 最大有利/不利及第几分钟，mae_before_mfe 到最高点前最深回撤，r15…r360 各时点收益，hit_1pct_first 先到 +1% 还是 -1%，from_open 从实际开仓起算"},
  positions:"账户真实模拟单。living_playbook 打法，living_intent 开单时资金状态/情绪，living_market_intent 市场意图，living_story 叙述，living_flow_evidence 证据数字，living_invalidation 失效价，living_protect_* 保护；mfe_pct/mae_pct 等是这笔单从开仓起的价格路径结果（%）。",
};
export const REVIEW_PLAN=[
  "很久没开单：why_no_trades.longest_no_open 那一段的 main 和 gate；再到 timeline 里那几行看是哪一层挡的、原因是什么。",
  "被挡住的想法后来怎么走：case_stats 里 furthest 为 L1_MARKET / L2_WEAK / NO_LOCATION / WATCH_END 的行，avg_r60/avg_r360 和先涨 1% 的比例；明显为正的层说明那一层挡掉了好单。",
  "开出的单：cases 里 furthest=OPENED 的行（out.from_open）和 positions 对照，看持有和出场是否拿住了路径里的利润。",
  "单个币：在 cases 里按 sym 过滤，看每次研究层怎么判断、之后价格怎么走。",
];

export type RunLogExportInput={
  exportedAt:number;liveEnabled:boolean;buildSha:string;hours:number;
  /** Run-log wipe time (lib/runlog-wipe.ts): nothing before it is exported and the window never starts earlier. */
  since?:number|null;
  status:Record<string,unknown>|null;
  buckets:Bucket[];cases:FinalCase[];
  account:{equity:number|null;initial:number|null;invariants:unknown;book_audit:unknown;equity_curve:unknown;equity_minutes:unknown[];drawdown:Record<string,unknown>;
    curve_since:number|null;drawdown_since:number|null;account_resets:unknown;account_epoch:number;account_reset_pending:number|null;liveFills:unknown;
    equity_gaps:unknown;equity_filled_min:number};
  positions:Record<string,unknown>[];fills:unknown[];paths:unknown[];
  archive:Record<string,unknown>;
};
export function buildLivingRunLog(input:RunLogExportInput){
  const from=Math.max(input.exportedAt-input.hours*3_600_000,input.since??0);
  // one row per 10-minute window: rows of the same window from two boots (a restart inside it) are merged
  const byAt=new Map<number,Bucket[]>();
  for(const b of input.buckets){if(!b||typeof b.at!=="number"||b.end<from)continue;const xs=byAt.get(b.at)??[];
    if(!xs.some(x=>x.id===b.id))xs.push(b);else{const i=xs.findIndex(x=>x.id===b.id);if((b.lastSampleAt??0)>=(xs[i]!.lastSampleAt??0))xs[i]=b;}byAt.set(b.at,xs);}
  const timeline=[...byAt.entries()].sort((a,b)=>a[0]-b[0]).map(([,xs])=>xs.length===1?xs[0]!:mergeBuckets(xs));
  // windows with no row at all (program down for a whole bucket) are listed so a gap is never silent
  const gaps:{from:number;to:number}[]=[];
  for(let i=1;i<timeline.length;i++){const a=timeline[i-1]!,b=timeline[i]!;if(b.at-a.at>BUCKET_MS)gaps.push({from:a.end,to:b.at});}
  const seen=new Set<string>(),cases:FinalCase[]=[];
  for(const c of [...input.cases].sort((a,b)=>Number(b.final)-Number(a.final))){if(!c||seen.has(c.id)||c.at<from)continue;seen.add(c.id);cases.push(c);}
  cases.sort((a,b)=>a.at-b.at);
  return {version:RUNLOG_VERSION,exportedAt:input.exportedAt,buildSha:input.buildSha,liveEnabled:input.liveEnabled,window_hours:input.hours,window_from:from,log_since:input.since??null,
    howToRead:HOW_TO_READ,reviewPlan:REVIEW_PLAN,fieldNotes:FIELD_NOTES,gate_labels:GATE_LABEL,layer_labels:LAYER_LABEL,
    now:input.status,
    why_no_trades:whyNoTrades(timeline,input.exportedAt),
    timeline,timeline_gaps:gaps,
    cases,case_stats:caseStats(cases),
    account:{equity:input.account.equity,initial:input.account.initial,invariants:input.account.invariants,book_audit:input.account.book_audit,
      equity_curve:input.account.equity_curve,...input.account.drawdown,curve_since:input.account.curve_since,drawdown_since:input.account.drawdown_since,
      equity_gaps:input.account.equity_gaps,equity_filled_min:input.account.equity_filled_min},
    account_resets:input.account.account_resets,account_epoch:input.account.account_epoch,account_reset_pending:input.account.account_reset_pending,
    equity_minutes:input.account.equity_minutes,liveFills:input.account.liveFills,
    positions:input.positions.map(slimPosition),fills:input.fills,paths:input.paths,
    archive:input.archive};
}
