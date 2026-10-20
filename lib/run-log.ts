/** One export. Strategy decisions and runtime faults stay in different categories. */
import type {AccountReset,ForwardState,Quote,Trade} from './forward-relations.ts';
import type {EntryStructure} from './entry-structure.ts';
import {orderRecord, pathFields, qualityFields, signalFields, snapFields, gapFields, gateFields, s1Fields, livingFields, entryRuleOf, type OrderJournal, type OrderRecord} from './order-journal.ts';
import type {S1Fields} from './s1-rule.ts';
import type {LivingFields} from './living/run-log-fields.ts';
import {PAPER_COST,freshQuote,forwardEquity} from './forward-relations.ts';
import {readStageTimeline} from './stage-chronicle.ts';
import {type LiveFillNote} from './live-fill-note.ts';
import {summarizeEquity, type EquityMinute} from './equity-minutes.ts';
import {accountEpochAt,resetAdjustment} from './account-reset.ts';
import {isCompleteLogRow,exportLogRow,logRowGaps,LOG_COMPLETE_DEFINITION,LOG_NULL_BY_DESIGN} from './log-complete.ts';
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
export type LsrPositionRow={id:string;symbol:string;side:'LONG'|'SHORT';entry:number;exit:number|null;qty:number;notional:number;gross_pnl:number|null;fee:number;net_pnl:number|null;holdSec:number;exit_reason:'stop'|'tp'|'time'|'prior'|'tp1'|'tp2'|'sl'|'invalidate'|'external'|'dropped'|null;gapBps:number|null;opened_at:number;closed_at:number|null;trace:string;entry_structure?:EntryStructure|null;market_stage?:string|null;market_expectancy?:number|null;entry_phase?:string|null;exit_stage?:string|null;exit_phase?:string|null;exit_trigger?:string|null;entry_rule?:string|null;entry_signal?:'LONG'|'SHORT'|null;entry_fade?:boolean|null;entry_room_pct?:number|null;entry_room_touches?:number|null;live_stage?:string|null;prior_stage?:string|null;stage_age_min?:number|null;minutes_since_shock?:number|null;shock_push?:number|null;sync_drop?:number|null;trend_side?:'LONG'|'SHORT'|null;with_trend?:boolean|null;book?:number|null;residual?:number|null;relative_strength?:number|null;move30?:number|null;sync?:number|null;breadth?:number|null;coin_background?:string|null;coin_recent?:string|null;coin_label?:string|null;coin_versus?:string|null;coin_background_pct?:number|null;coin_recent_pct?:number|null;coin_window_min?:number|null;signal_n?:number|null;signal_gap_min?:number|null;entry_spread_bps?:number|null;signal_n_symbol?:number|null;prev_side?:'LONG'|'SHORT'|null;prev_gap_min?:number|null;prev_net_pct?:number|null;prev_mfe_pct?:number|null;prev_mae_pct?:number|null;leverage?:number|null;shock_seen?:boolean|null;mode?:string|null;trade_plan?:string|null;intent?:string|null;long_score?:number|null;short_score?:number|null;residual_z?:number|null;score?:number|null;stop_price?:number|null;planned_hold_min?:number|null;volume24h_usd?:number|null;funding_rate?:number|null;trend_score?:number|null;factor_30m_pct?:number|null;gap_applicable?:boolean|null;gap_bps?:number|null;tally_since?:number|null;entry_gate?:string|null;gate_signal_side?:'LONG'|'SHORT'|null;gate_btc_1h_pct?:number|null;gate_coin_bg_pct?:number|null}&Partial<S1Fields>&Partial<LivingFields>;
export type LsrCurvePoint={ts:number;equity:number;closed_pnl:number;unrealized_pnl:number;positions:number};
const ROW_CAP=8_000;
export function rememberRow<T>(rows:T[]|undefined,row:T){return [...(rows??[]),row].slice(-ROW_CAP);}

/** Export note for the record-only shadow BTC branch columns (lib/shadow-branch.ts). */
const SHADOW_FIELD_NOTE={living_v2:'研究层 living-v2：开单、持有、出场都由实时的资金意图和人性读数决定（不再需要攒样本）。living_intent 开单时这个币的资金状态/情绪，如 DEMAND/CONVICTION（真买盘、没挤）、FLUSH_DOWN/CAPITULATION（踩踏后出尽）、SQUEEZE_UP/EXHAUSTION（逼空衰竭）、DEMAND/BLOWOFF（贪婪见顶）、ABSORB_BID（下沿被接）、BURST/NEW_POSITIONS（集体异动且新开仓推动）；living_market_intent 当时的市场意图（RISK_ON 真资金做多 / RISK_OFF / SQUEEZE 逼空 / PANIC 恐慌 / CAPITULATION 出尽 / FOMO 贪婪 / COMPLACENT 安逸 / CALM 平静 / MIXED 不清）；living_story 一句话叙述；living_flow_evidence 当时的证据数字（价格、持仓量、资金费、主动买卖、成交量倍数；价格和持仓量都是 %，不是 ROE）。living_reward_pct 在 v2 里是证据强度（0–1），living_persistence 是滚动统计给的仓位系数（0.7–1.2，只调仓位不挡开单）。出场原因 LIVING_INTENT_* 表示持有理由没了（资金反向、拥挤解开、市场意图转向等），LIVING_INTENT_*_LOCK 是锁利润。',living_v1:'研究层 living-v1（lib/living）开的单才有 living_* 字段：living_kind normal=五步闭环 / fast=集体异动快速跟进；living_playbook 打法；living_reward_pct/t/n 开单时这种做法的奖励分（扣成本后的净收益，价格幅度 %，不是 ROE）、t 值、独立样本数；living_persistence 持续性 ok/unverified/negative；living_rank 选币名次；living_invalidation 失效价；living_evidence probe/normal/strong/fast 与 living_multiple 仓位倍数；living_episode 快速通道那一段的编号；living_why 一句话理由。living_protect_* 是研究层收紧过的保护（快速保护/保本），出场原因 LIVING_GUARD_STOP / LIVING_FAST_* / LIVING_THESIS_* 是研究层的出场。研究层开的单只听研究层（2026-10-21 起）：打到止损价记 LIVING_STOP，越过强平价记 LIQUIDATION，大脑暂停（出错/数据不新鲜/关闭）超过 2 分钟且拿满计划时长 1.5 倍记 LIVING_FALLBACK_TIMEOUT；旧出场（WINNER_*、PEAK_GIVEBACK、RHYTHM_BREAK 等）不再用在研究层的单上。rule_epoch=living-v1 表示这行开在研究层接管之后（导出时按研究层开始作用的时刻标注）。没有这些字段的行与之前完全一样。',entry_rule_S1:'S1 只在 10-19 17:15 到当晚用过，已退回旧规则（entry_gate），新单不再有 S1。那段时间趋势/爆发开出来的单 entry_rule 为 S1：btc1h_aligned_pct 是开单时 BTC 1 小时涨跌按原信号方向取正负（正 = 顺着信号），>= 0.57 为 s1_branch=follow（顺势，s1_side 同 original_side，s1_plan TP6_SL1：止盈 6%、止损 1%，最长 24 小时），否则 reverse（反向，s1_side 与 original_side 相反，s1_plan own_stop_6h：用这单自己原来的止损宽度放到另一侧，6 小时到点出）；s1_stop_pct / s1_tp_pct 是价格幅度 %（不是 ROE）；s1_exit_reason 为 TP / SL / TIME_6H / TIME_24H / LIQUIDATION 等，未平为空。趋势/爆发里 BTC 1 小时拿不到时不开，只留档（entry_rule NOT_OPENED，s1_branch 为空）。S1 替换了原来的 entry_gate 三条规则，S1 单的 entry_gate 为空。退回旧规则时还没平的 S1 单改按旧出场规则平（利润回撤、节奏破坏、结构保护等，止损只收紧不放宽），出场原因就是旧规则的代码，s1_exit_reason 同样记这个代码。没有 S1 字段的行不是 S1 单。',
  shadow_branch:'影子分支，仅记录，不参与任何交易决定：btc1h_aligned_pct >= 0.57 → follow（同向 TP6/SL1），否则 reverse（反向 自身止损/6h）；字段 btc1h_aligned_pct、shadow_side/plan/stop_pct/tp_pct 和回放结果 shadow_exit_reason/exit_min/move_pct/net_pct 只在有价格路径的行里出现（研究列），说明见 researchNotes.影子分支'};
export function buildRunLogExport(input:{events:RunEvent[];funnel:RunFunnel|null;health:{sources?:{source:string;fresh?:boolean;failures?:number;lastError?:string|null;rows?:number}[];healthySources?:number};gate:{connected?:boolean;lastError?:string|null;freshBooks?:number};exportedAt:number;liveEnabled:boolean;
  positions?:LsrPositionRow[];fills?:LsrFill[];curve?:LsrCurvePoint[];equity?:number|null;initial?:number|null;closedNet?:number|null;priorAdjustment?:number|null;
  unreconstructed?:number|null;unreconstructedN?:number|null;
  places?:LsrPlace[]|null;notOpened?:LsrPositionRow[]|null;stageTimeline?:ReturnType<typeof readStageTimeline>|null;liveFills?:LiveFillNote[]|null;equityMinutes?:EquityMinute[]|null;tallySince?:number|null;
  /** Funds-only resets in this log epoch (oldest first). */
  accountResets?:AccountReset[]|null;
  /** A funds reset waiting for the account to be flat. */
  pendingResetAt?:number|null;
  /** Run-log export: only complete records leave (see lib/log-complete.ts). Account sums still use every row. */
  completeOnly?:boolean;
  /** With completeOnly: the record's price path is part of a complete record (false = path missing or unfinished). */
  pathReady?:(id:string,closed:boolean)=>boolean}){
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
  const minutes=input.equityMinutes??[];
  const timeline=input.stageTimeline??[];
  const tallySince=input.tallySince??null;
  const resets=input.accountResets??[],lastReset=resets.at(-1)?.at??null;
  const withTally=<T extends object>(rows:T[])=>rows.map(row=>({...row,tally_since:tallySince,
    account_epoch:accountEpochAt(resets,(row as {opened_at?:number|null}).opened_at)}));
  const ddMinutes=lastReset==null?minutes:minutes.filter(row=>row.ts>=lastReset);
  const completeOnly=input.completeOnly===true;
  const pathOk=(row:LsrPositionRow)=>!input.pathReady||input.pathReady(row.id,row.closed_at!=null||row.exit!=null);
  const complete=(row:LsrPositionRow)=>isCompleteLogRow(row as unknown as Record<string,unknown>)&&pathOk(row);
  const missing=(row:LsrPositionRow)=>[...logRowGaps(row as unknown as Record<string,unknown>),...(pathOk(row)?[]:['price_path'])];
  const shownPositions=completeOnly?positions.filter(complete):positions;
  const allNotOpened=input.notOpened??[];
  const shownNotOpened=completeOnly?allNotOpened.filter(complete):allNotOpened;
  const shownIds=new Set(shownPositions.map(row=>row.trace));
  const hiddenPositions=positions.filter(row=>!shownIds.has(row.trace));
  const clean=<T extends object>(rows:T[]):T[]=>completeOnly?rows.map(row=>exportLogRow(row as unknown as Record<string,unknown>) as unknown as T):rows;
  const completeness=completeOnly?{definition:LOG_COMPLETE_DEFINITION,
    positions_shown:shownPositions.length,positions_left_out:hiddenPositions.length,
    positions_left_out_net:Number(hiddenPositions.reduce((n,row)=>n+(row.net_pnl??0),0).toFixed(4)),
    positions_left_out_note:'信息不完整的旧单不在 positions 里，但账户本身没删：权益、已平净利、对账都还算着它们。',
    positions_left_out_missing:hiddenPositions.slice(0,20).map(row=>({id:row.id,missing:missing(row)})),
    not_opened_shown:shownNotOpened.length,not_opened_left_out:allNotOpened.length-shownNotOpened.length}:null;
  const body={version:'lsr-run-log-v2' as const,exportedAt:input.exportedAt,liveEnabled:input.liveEnabled,
    howToRead:'这是当前市场智能模拟账户。权益 = 初始 + 已平净利 + 未平（价格盈亏 − 开仓费 − 预计平仓费）。不是已经停掉的实验漏斗。已平订单单独留档，不随热历史裁掉。每一笔记进场和出场当时的行情判定与演化阶段。分钟路径最多留 1200 笔，按页分开存，一次只写改过的那一页。not_opened 是没开进账户的单，只供复盘，不进权益。同步爆发和趋势的新单仓位都是原来的 5 倍（每行 sizeMultiple 以开仓时为准：最早两种都是 6 倍，10-19 中午到晚上同步爆发是 10 倍）。新单杠杆固定 10 倍（逐仓；合约最高杠杆不到 10 倍时用合约最高），不再按止损调高到 20 倍；10-19 中午到晚上开的单杠杆是 10–20 倍，以每行 leverage 为准。杠杆只改保证金，不改名义和风险；维持保证金率高、止损又宽的币，强平价可能比止损还近，这种单照开，打到强平价按爆仓记。exit_trigger 为 LIQUIDATION 是逐仓爆仓：价格越过强平价、止损没来得及成交，按强平价记出场，亏掉这笔全部保证金。进场另外记下全市场方向、这笔是否顺向、盘口、残差、相对强度、开仓前 30 分钟这个币已经顺着这笔走过的幅度、同步度和广度。研究层另外给每个准备交易的币记下两句：前面这段后半段比前半段高或低多少、有没有慢慢抬或慢慢压，以及进场前同一方向连着走了几根、一共走了多少。这些只用于复盘，不参与开仓。stageTimeline 是行情阶段每次切换的时间线：at 这段开始，until 这段结束，最后一条的 until 是导出时间且 open 为 true 表示还没结束。stage 是这段的名字，prior 是上一段，trendSide 是切过来那一刻写下的全市场方向，min 是这段多少分钟。以前没记下的切换补不回来。这条线不参与开仓或出场。paths 里 hold 加 after 覆盖信号之后 6 小时，一分钟一个点，到点就停，不再往下记。signal_n 是同币同方向第几次信号，signal_gap_min 是距上一笔多少分钟，entry_spread_bps 是写下这一笔时的买卖价差。这三项从本次部署之后的新信号才有。liveFills 是实盘真实成交：exchangePrice 是交易所成交价，bid、ask、spreadBps 是提交时的盘口，leg 区分开仓和平仓。没开实盘就是空的。equity_minutes 是每分钟一条的权益，和上面那条只有一个点的 equity_curve 分开，避免把记账校验弄乱。curve_since、timeline_since、tally_since 分别是这三样从哪一刻开始有。entry_signal、entry_fade、entry_room_pct、entry_room_touches 已经不用，空着是正常的。minutes_since_shock 在还没出现过同步爆发时也是空的，用 shock_seen 区分。trend_score 是短期方向分，有正负，全市场方向为空时也有。factor_30m_pct 是进场时全市场等权 30 分钟收益，单位是百分比。equity_minutes 最多带最近 8 个北京时间日。liveFills 的 fee、fee_rate、role 只有对上已经拉回来的 Gate 成交才有值。这些都不参与开仓或出场。10-19 17:15 到当晚，趋势/爆发的新单用过 S1 开平仓方案（entry_rule 为 S1，字段说明见 fieldNotes.entry_rule_S1），之后已退回下面的 entry_gate 旧规则；S1 单上的 entry_gate 为空。entry_gate 是趋势/爆发两条开仓规则的判定（只在全市场阶段为趋势或同步爆发时有值）：btc_follow 是 BTC 1小时顺着这笔走了至少 0.5% 才开；washout_flip 是趋势里 BTC 1小时不到 ±0.4%、全市场 30 分钟已跌 1.4% 以上，把做空信号反手成做多开，gate_signal_side 是原信号方向；washout_long 是同样条件下原本就是做多；pumped_short 是 BTC 1小时没有跌够 0.5%，但这个币自己背景（coin_background_pct，约 8 小时）已涨 5% 以上，做空照开，gate_coin_bg_pct 是判定时用的背景涨幅，和 coin_background_pct 同一个值；btc_follow_block 和 btc_missing_block 是被挡下只留档（后者是 BTC 1小时拿不到）。gate_btc_1h_pct 是判定时用的 BTC 1小时涨跌，和 btc_1h_pct 同一个算法。account_resets 是资金重置记录：ts 重置时刻，requested_at 点重置的时刻（有持仓时重置先预约，等到没有持仓那一刻才执行，期间照常开平仓，不强平），balance_before 重置前余额，balance_after 重置后余额；重置只动资金、页面曲线和页面开单记录，运行日志不删，重置前的单照样在 positions 里。每一行的 account_epoch 是开仓时处在第几段账户（0 是第一次重置之前）。account_reset_pending 是还在等空仓的预约重置时刻，没有就是空。max_drawdown 只从最后一次重置算起（drawdown_since），重置那一下的跳变不算回撤。',
    reviewPlan:[
      '先看爆发和趋势里开出的单：方向对不对，最后落袋多少。',
      '再看没开、但路径上浮盈到过 5% 的单。对照进场时的全市场方向、是否顺向、盘口、开仓前 30 分钟已走过的幅度。样本够了再决定要不要开。',
      '走过成本后最终亏损的，看回撤到多少出局。',
      '每一个浮盈阶段，看从高点回撤多少出局。',
    ],
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
      {step:'旧账 prior_adjustment 加上每次资金重置拿走/补上的现金（见 account_resets），不算进已平',amount:Number(prior.toFixed(4))},
      {step:'已平净利，含实验单',amount:Number(closedPnl.toFixed(4))},
      {step:'还没平的浮盈，已扣掉开仓手续费和开仓滑点',amount:Number(unrealized.toFixed(4))},
      {step:`平仓记录被裁掉的 ${input.unreconstructedN??0} 笔，合计现金，不算进胜率`,amount:Number(unreconstructed.toFixed(4))},
      {step:'上面几项加出来的权益',amount:initial==null?null:Number((initial+prior+closedPnl+unrealized+unreconstructed).toFixed(4))},
      {step:'账户实际权益',amount:equity},
      {step:'对不上的差额。接近 0 才算账平了',amount:identity==null?null:Number(identity.toFixed(4))},
    ],
    ...(completeness?{log_completeness:completeness}:{}),
    positions:withTally(clean(shownPositions)),fills:completeOnly?fills.filter(row=>shownIds.has(row.trace)):fills,equity_curve:curve,equity_minutes:minutes,...summarizeEquity(ddMinutes),curve_since:minutes[0]?.ts??null,drawdown_since:ddMinutes[0]?.ts??null,
    account_resets:resets.map(r=>({ts:r.at,epoch:r.epoch,requested_at:r.requestedAt,balance_before:r.balanceBefore,balance_after:r.balanceAfter})),
    account_epoch:resets.length,account_reset_pending:input.pendingResetAt??null,
    not_opened:withTally(clean(shownNotOpened)),stageTimeline:timeline,timeline_since:timeline[0]?.at??null,
    tally_since:input.tallySince??null,liveFills:input.liveFills??[],
    fieldNotes:completeOnly?{...LOG_NULL_BY_DESIGN,...SHADOW_FIELD_NOTE,equity_curve:'只有导出这一刻的一个点，用来对账。分钟序列在 equity_minutes。'}
      :{...SHADOW_FIELD_NOTE,entry_signal:'deprecated',entry_fade:'deprecated',entry_room_pct:'deprecated',entry_room_touches:'deprecated',
      minutes_since_shock:'空值并且 shock_seen 为 false，表示到这笔为止还没出现过同步爆发',
      equity_curve:'只有导出这一刻的一个点，用来对账。分钟序列在 equity_minutes。'}};
  if(JSON.stringify(body).length>20_000_000)body.equity_curve=curve.filter((_,i)=>i%5===0);
  return body;
}

/** The phone export. Rows are the live paper account, not a retired experiment book. */
export function accountLogBook(state:ForwardState,quotes:Record<string,Quote>,now:number,journal?:OrderJournal){
  const openRows:LsrPositionRow[]=[];
  const closedRows:LsrPositionRow[]=[];
  const seen=new Set<string>();
  const fills:LsrFill[]=[];
  const pushClosed=(row:LsrPositionRow)=>{
    if(seen.has(row.id))return;
    seen.add(row.id);closedRows.push(row);
    fills.push({ts:row.opened_at,symbol:row.symbol,side:row.side,price:row.entry,qty:row.qty,notional:row.notional,fee:row.fee,tag:'open',trace:row.trace,waitMs:null,limit:row.entry});
  };
  for(const saved of journal?.rows??[])pushClosed(fromRecord(saved));
  for(const t of state.history){
    if(t.inverseCopy||t.exitReason==='ACCOUNT_RESET')continue;
    pushClosed(closedAccountRow(t));
  }
  let unrealized=0;
  for(const t of state.positions){
    const marked=openMark(state,t,quotes,now);
    const row:LsrPositionRow={id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,exit:null,qty:t.quantity,notional:t.notional,
      gross_pnl:round4(marked.gross+marked.realized),fee:round4(t.entryFee+marked.exitReserve),net_pnl:null,
      holdSec:Math.max(0,Math.round((now-t.openedAt)/1000)),exit_reason:null,gapBps:null,opened_at:t.openedAt,closed_at:null,trace:t.id,leverage:t.leverage>0?t.leverage:null,
      entry_structure:t.entryContext?.entryStructure??null,market_stage:t.entryContext?.environment??null,market_expectancy:t.entryContext?.marketExpectancy??null,
      entry_phase:t.entryContext?.marketEvolutionPhase??null,exit_stage:null,exit_phase:null,exit_trigger:null,
      entry_rule:entryRuleOf(t),
      entry_signal:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.signalSide??null,
      entry_fade:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.fade??null,
      entry_room_pct:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.roomPct??null,
      entry_room_touches:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.touches??null,
      live_stage:t.entryContext?.stageNote?.liveStage??null,prior_stage:t.entryContext?.stageNote?.priorStage??null,
      stage_age_min:t.entryContext?.stageNote?.stageAgeMin??null,minutes_since_shock:t.entryContext?.stageNote?.minutesSinceShock??null,
      shock_push:t.entryContext?.stageNote?.shockPush??null,sync_drop:t.entryContext?.stageNote?.syncDrop??null,
      shock_seen:t.entryContext?.stageNote?t.entryContext.stageNote.liveStage==="SHOCK"||t.entryContext.stageNote.minutesSinceShock!=null:null,
      ...qualityFields(t),...pathFields(t),...signalFields(t),...snapFields(t),...gapFields(t),...gateFields(t),...s1Fields(t),...livingFields(t)};
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
  funnel.filled=openRows.length+closedRows.length;
  funnel.closed=closedRows.length;
  funnel.wins=closedRows.filter(row=>(row.net_pnl??0)>0).length;
  const notOpened=(state.unopenedTrades??[]).map(t=>{
    if(t.status==="CLOSED")return closedAccountRow(t);
    const marked=openMark(state,t,quotes,now);
    const row:LsrPositionRow={id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,exit:null,qty:t.quantity,notional:t.notional,
      gross_pnl:round4(marked.gross+marked.realized),fee:round4(t.entryFee+marked.exitReserve),net_pnl:null,
      holdSec:Math.max(0,Math.round((now-t.openedAt)/1000)),exit_reason:null,gapBps:null,opened_at:t.openedAt,closed_at:null,trace:t.id,leverage:t.leverage>0?t.leverage:null,
      entry_structure:t.entryContext?.entryStructure??null,market_stage:t.entryContext?.environment??null,market_expectancy:t.entryContext?.marketExpectancy??null,
      entry_phase:t.entryContext?.marketEvolutionPhase??null,exit_stage:null,exit_phase:null,exit_trigger:null,
      entry_rule:"NOT_OPENED",
      entry_signal:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.signalSide??null,
      entry_fade:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.fade??null,
      entry_room_pct:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.roomPct??null,
      entry_room_touches:(t.entryContext?.transitionRule??t.entryContext?.shockRoom)?.touches??null,
      live_stage:t.entryContext?.stageNote?.liveStage??null,prior_stage:t.entryContext?.stageNote?.priorStage??null,
      stage_age_min:t.entryContext?.stageNote?.stageAgeMin??null,minutes_since_shock:t.entryContext?.stageNote?.minutesSinceShock??null,
      shock_push:t.entryContext?.stageNote?.shockPush??null,sync_drop:t.entryContext?.stageNote?.syncDrop??null,
      shock_seen:t.entryContext?.stageNote?t.entryContext.stageNote.liveStage==="SHOCK"||t.entryContext.stageNote.minutesSinceShock!=null:null,
      ...qualityFields(t),...pathFields(t),...signalFields(t),...snapFields(t),...gapFields(t),...gateFields(t),...s1Fields(t),...livingFields(t)};
    return row;
  });
  return {positions:[...closedRows,...openRows],fills,curve:[{ts:now,equity:round4(mark.equity),closed_pnl:round4(closedNet),unrealized_pnl:round4(unrealized),positions:openRows.length}],
    equity:mark.equity,initial:state.initialEquity,closedNet:round4(closedNet),priorAdjustment:resetAdjustment(state.accountResets),accountResets:state.accountResets??[],pendingResetAt:state.pendingFundsReset?.requestedAt??null,places:[] as LsrPlace[],funnel,
    unreconstructed:0,unreconstructedN:0,notOpened,stageTimeline:readStageTimeline(state.stageChronicle,now),
    tallySince:state.signalTallyMeta?.from??null};
}
/** A not-opened or account trade as its run-log row, without a quote (closed rows, or open rows for completeness only). */
export function closedLogRow(t:Trade){return closedAccountRow(t);}
/** A closed-order journal record as its run-log row (same mapping accountLogBook uses). */
export function journalLogRow(row:OrderRecord){return fromRecord(row);}
/** The single completeness predicate applied to a stored trade (not-opened rows are judged by their own status). */
export function isCompleteTradeRecord(t:Trade){return isCompleteLogRow(closedAccountRow(t) as unknown as Record<string,unknown>,t.status==="CLOSED");}
function closedAccountRow(t:Trade):LsrPositionRow{
  const recorded=orderRecord(t);
  return {id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,exit:t.exitPrice,qty:t.quantity,notional:t.notional,
    gross_pnl:t.grossPnl,fee:round4(t.entryFee+t.exitFee+t.fundingAllowance),net_pnl:t.netPnl,
    holdSec:t.closedAt==null?0:Math.max(0,Math.round((t.closedAt-t.openedAt)/1000)),exit_reason:null,
    opened_at:t.openedAt,closed_at:t.closedAt,trace:t.id,entry_structure:recorded.entry_structure,market_stage:recorded.entry_stage,
    market_expectancy:recorded.market_expectancy,entry_phase:recorded.entry_phase,exit_stage:recorded.exit_stage,
    exit_phase:recorded.exit_phase,exit_trigger:recorded.exit_trigger,entry_rule:recorded.entry_rule??null,
    entry_signal:recorded.entry_signal??null,entry_fade:recorded.entry_fade??null,
    entry_room_pct:recorded.entry_room_pct??null,entry_room_touches:recorded.entry_room_touches??null,
    live_stage:recorded.live_stage??null,prior_stage:recorded.prior_stage??null,stage_age_min:recorded.stage_age_min??null,
    minutes_since_shock:recorded.minutes_since_shock??null,shock_push:recorded.shock_push??null,sync_drop:recorded.sync_drop??null,
    trend_side:recorded.trend_side??null,with_trend:recorded.with_trend??null,book:recorded.book??null,residual:recorded.residual??null,
    relative_strength:recorded.relative_strength??null,move30:recorded.move30??null,sync:recorded.sync??null,breadth:recorded.breadth??null,
    coin_background:recorded.coin_background??null,coin_recent:recorded.coin_recent??null,coin_label:recorded.coin_label??null,
    coin_versus:recorded.coin_versus??null,coin_background_pct:recorded.coin_background_pct??null,
    coin_recent_pct:recorded.coin_recent_pct??null,coin_window_min:recorded.coin_window_min??null,
    signal_n:recorded.signal_n??null,signal_gap_min:recorded.signal_gap_min??null,entry_spread_bps:recorded.entry_spread_bps??null,
    signal_n_symbol:recorded.signal_n_symbol??null,prev_side:recorded.prev_side??null,prev_gap_min:recorded.prev_gap_min??null,
    prev_net_pct:recorded.prev_net_pct??null,prev_mfe_pct:recorded.prev_mfe_pct??null,prev_mae_pct:recorded.prev_mae_pct??null,leverage:recorded.leverage??null,shock_seen:recorded.shock_seen??null,
    mode:recorded.mode??null,trade_plan:recorded.trade_plan??null,intent:recorded.intent??null,
    long_score:recorded.long_score??null,short_score:recorded.short_score??null,residual_z:recorded.residual_z??null,
    score:recorded.score??null,stop_price:recorded.stop_price??null,planned_hold_min:recorded.planned_hold_min??null,
    volume24h_usd:recorded.volume24h_usd??null,funding_rate:recorded.funding_rate??null,trend_score:recorded.trend_score??null,
    factor_30m_pct:recorded.factor_30m_pct??null,
    entry_gate:recorded.entry_gate??null,gate_signal_side:recorded.gate_signal_side??null,gate_btc_1h_pct:recorded.gate_btc_1h_pct??null,gate_coin_bg_pct:recorded.gate_coin_bg_pct??null,
    gapBps:recorded.gap_bps??null,gap_bps:recorded.gap_bps??null,gap_applicable:recorded.gap_applicable??false,...s1Fields(t),...livingFields(t)};
}
function fromRecord(row:OrderRecord):LsrPositionRow{
  return {...row,exit_reason:null,gapBps:row.gap_bps??null,gap_bps:row.gap_bps??null,gap_applicable:row.gap_applicable??false,trace:row.id,market_stage:row.entry_stage};
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

/**
 * Research columns joined onto exported rows: net price % and net ROE % (price move x leverage, after fees),
 * then the record's entry features and its 24h path label. Rows keep every existing field; nothing here feeds trading.
 */
/** Signal for the record-only shadow branch: a TREND/SHOCK gate flip keeps the original signal in gate_signal_side, and
 * gate_btc_1h_pct is the exact BTC 1h value the gate used (otherwise the entry-feature btc_1h_pct, same function/inputs). */
export function shadowSignalOf(row:{side:'LONG'|'SHORT';gate_signal_side?:unknown;gate_btc_1h_pct?:unknown;original_side?:unknown;btc1h_aligned_pct?:unknown}):{side:'LONG'|'SHORT';gateBtc1hPct:number|null}{
  // An S1 row: the shadow replays the same plan from the original signal and the BTC value S1 used (a cross-check of the real exit).
  const o=row.original_side,a=row.btc1h_aligned_pct;
  if((o==='LONG'||o==='SHORT')&&typeof a==='number'&&Number.isFinite(a))return {side:o,gateBtc1hPct:o==='LONG'?a:-a};
  if(o==='LONG'||o==='SHORT')return {side:o,gateBtc1hPct:null};
  const side=row.gate_signal_side==='LONG'||row.gate_signal_side==='SHORT'?row.gate_signal_side:row.side;
  const g=row.gate_btc_1h_pct;return {side,gateBtc1hPct:typeof g==='number'&&Number.isFinite(g)?g:null};
}
export function withResearchColumns<T extends {id:string;side:'LONG'|'SHORT';entry:number;exit:number|null;notional:number;net_pnl:number|null;leverage?:number|null}>(
  rows:T[],columnsOf:(id:string,row:T)=>Record<string,number|string|boolean|null>|null):(T&Record<string,unknown>)[]{
  return rows.map(row=>{
    const lev=row.leverage!=null&&row.leverage>0?row.leverage:null;
    const margin=lev&&row.notional>0?row.notional/lev:null;
    const net_roe_pct=row.net_pnl!=null&&margin?Math.round(row.net_pnl/margin*1e6)/1e4:null;
    const exit_pct=row.exit!=null&&row.entry>0?Math.round((row.side==='LONG'?row.exit/row.entry-1:1-row.exit/row.entry)*1e6)/1e4:null;
    const cols=columnsOf(row.id,row)??{};
    const {leverage:_l,...rest}=cols;void _l;
    // The real S1 value on the row wins over the shadow replay's copy (same number, but never let a research null blank it).
    if(typeof (row as {btc1h_aligned_pct?:unknown}).btc1h_aligned_pct==='number')delete (rest as Record<string,unknown>).btc1h_aligned_pct;
    return {...row,leverage:lev??(typeof cols.leverage==='number'?cols.leverage:null),exit_move_pct:exit_pct,net_roe_pct,...rest};
  });
}
