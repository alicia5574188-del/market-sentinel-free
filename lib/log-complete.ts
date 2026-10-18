/**
 * What a COMPLETE run-log order record is. One definition for every record type the run log exports:
 * a not-opened row (entry_rule NOT_OPENED) and an opened paper trade use the same fields.
 * Review only: nothing here is read by an entry, an exit, sizing, a stop or live copying.
 */
type Row = Record<string, unknown>;

/** Must be present on every record. */
export const LOG_REQUIRED = [
  "id", "symbol", "side", "entry", "qty", "notional", "fee", "holdSec", "opened_at", "trace",
  // market at entry
  "entry_structure", "market_stage", "market_expectancy", "entry_phase",
  "live_stage", "stage_age_min", "shock_push", "shock_seen",
  "book", "residual", "relative_strength", "move30", "sync", "breadth",
  // the coin's own path before entry
  "coin_background", "coin_recent", "coin_label", "coin_versus", "coin_background_pct", "coin_window_min",
  // signal repeat + spread
  "signal_n", "signal_n_symbol", "entry_spread_bps",
  // decision snapshot
  "mode", "trade_plan", "intent", "long_score", "short_score", "residual_z", "score", "stop_price", "planned_hold_min",
  "volume24h_usd", "funding_rate", "trend_score", "factor_30m_pct",
  "gap_applicable",
] as const;

/** Must be present once the record is closed (still-observing rows have no exit yet). */
export const LOG_REQUIRED_WHEN_CLOSED = ["exit", "closed_at", "gross_pnl", "net_pnl", "exit_stage", "exit_phase", "exit_trigger"] as const;

/** Null on purpose. A null here never makes a record incomplete. */
export const LOG_NULL_BY_DESIGN: Record<string, string> = {
  prior_stage: "空值表示这一段行情之前没有记录到上一个阶段",
  minutes_since_shock: "空值并且 shock_seen 为 false，表示到这笔为止还没出现过同步爆发",
  sync_drop: "只有同步爆发之后才有，没爆发过就是空值",
  trend_side: "空值表示进场时全市场没有明确方向；这时 with_trend 也是空值",
  with_trend: "跟着 trend_side：没有全市场方向就没有顺不顺向",
  signal_gap_min: "空值表示这是这个币这个方向第一次出信号，没有上一次可以算间隔",
  prev_side: "空值表示这个币之前没有出过信号",
  prev_gap_min: "同上，没有上一笔",
  prev_net_pct: "同上，没有上一笔",
  prev_mfe_pct: "同上，没有上一笔",
  coin_recent_pct: "进场前最后一根没有明确方向（coin_recent 为 NONE）时是空值",
  gap_bps: "只有止损出局才算滑点（gap_applicable 为 true），其他出局方式是空值",
  exit: "还在观察中（closed_at 为空）的单没有出场价", closed_at: "还在观察中", gross_pnl: "还在观察中时为浮动值或空值",
  net_pnl: "还在观察中", exit_stage: "还在观察中", exit_phase: "还在观察中", exit_trigger: "还在观察中",
};

/** Always null for this account (retired fields). They are removed from the export so they never look like gaps. */
export const LOG_DROPPED_FIELDS = ["entry_signal", "entry_fade", "entry_room_pct", "entry_room_touches", "exit_reason", "gapBps"] as const;

const present = (v: unknown) => v !== null && v !== undefined && !(typeof v === "number" && !Number.isFinite(v)) && v !== "";

/**
 * Names of the fields that make `row` incomplete. Empty array = complete.
 * `closed` defaults to what the row itself says (it has a close time or an exit price).
 */
export function logRowGaps(row: Row, closed?: boolean): string[] {
  const gaps: string[] = [];
  const gapBps = row.gap_bps !== undefined ? row.gap_bps : row.gapBps;
  for (const key of LOG_REQUIRED) if (!present(row[key])) gaps.push(key);
  const isClosed = closed ?? (present(row.closed_at) || present(row.exit));
  if (isClosed) for (const key of LOG_REQUIRED_WHEN_CLOSED) if (!present(row[key])) gaps.push(key);
  // conditional pairs: allowed null only in the case that explains it
  if (present(row.trend_side) !== present(row.with_trend)) gaps.push("with_trend");
  if (!present(row.coin_recent_pct) && present(row.coin_recent) && row.coin_recent !== "NONE") gaps.push("coin_recent_pct");
  if (row.gap_applicable === true && !present(gapBps)) gaps.push("gap_bps");
  if (row.shock_seen === true && row.live_stage !== "SHOCK" && !present(row.minutes_since_shock)) gaps.push("minutes_since_shock");
  if (present(row.signal_n) && Number(row.signal_n) > 1 && !present(row.signal_gap_min)) gaps.push("signal_gap_min");
  return gaps;
}
export const isCompleteLogRow = (row: Row, closed?: boolean) => logRowGaps(row, closed).length === 0;

/** The row as the export shows it: retired always-null fields removed. */
export function exportLogRow<T extends Row>(row: T): Omit<T, (typeof LOG_DROPPED_FIELDS)[number]> {
  const out: Row = { ...row };
  // gap_bps is the one stop-gap field; older row shapes carried the same value only as gapBps.
  if (out.gap_bps === undefined) out.gap_bps = out.gapBps ?? null;
  for (const key of LOG_DROPPED_FIELDS) delete out[key];
  return out as Omit<T, (typeof LOG_DROPPED_FIELDS)[number]>;
}

export const LOG_COMPLETE_DEFINITION =
  "完整记录 = 下面每个字段都有值：品种/方向/价格/数量/金额/手续费/持有时长/开单时间；进场时的行情阶段、结构、预期、" +
  "盘口、残差、相对强度、前30分钟走幅、同步度、广度；这个币进场前的走势（背景、最近几根、文字描述、顺逆、幅度、窗口）；" +
  "信号次数（全市场、这个币）和开单时的价差；决策快照（模式、计划、意图、多空分、残差z、评分、止损价、计划持有、24h成交额、资金费率、趋势分、30分钟因子）。" +
  "已经结束的单还要有出场价、平仓时间、盈亏、出场阶段和出场原因。" +
  "按设计可以为空、不算缺：之前没有阶段/没有上一笔信号/还没出现过同步爆发/全市场没有方向/不是止损出局/还在观察中。";
