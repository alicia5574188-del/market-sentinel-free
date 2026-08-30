"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Tab = "总览" | "雷达" | "订单" | "实盘" | "设置";
type TraderId = "dennis_trend" | "raschke_pullback" | "turtle_soup" | "exhaustion_reversal" | "higher_timeframe_swing";
type TradeSide = "LONG" | "SHORT" | "WAIT";
type GuardState = "ACTIVE" | "COOLDOWN" | "PAUSED";

type SchedulerStatus = {
  state: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  phase?: string | null;
  phaseAttempt?: number;
  circuitOpen?: boolean;
  retryAfter?: number | null;
  symbols?: string[];
};

type MarketState = {
  observedAt: number;
  label: string;
  permission: "GREEN" | "YELLOW";
  confidence: number;
  stability: number;
  transitionRisk: number;
  bias: "LONG" | "SHORT" | "NEUTRAL";
  advancingRatio: number;
  decliningRatio: number;
  medianChangePct: number;
  dispersionPct: number;
  benchmarkMomentum: number;
};

type Evaluation = {
  id: string;
  symbol: string;
  observedAt: number;
  traderId: TraderId;
  setupId: string;
  state: "ready" | "watching" | "blocked";
  side: TradeSide;
  confidence: number;
  setupScore: number;
  evidenceScore: number;
  assetRegime: string;
  thesis: string;
  reasons: string[];
  blockers: string[];
  entryPlan: {
    ready?: boolean;
    riskReward?: number;
    stopLossPrice?: number;
    takeProfit1Price?: number;
    takeProfit2Price?: number;
  } | null;
};

type CleanTrade = {
  id: string;
  activeKey: string | null;
  symbol: string;
  status: "holding" | "closed";
  traderId: TraderId;
  setupId: string;
  side: "LONG" | "SHORT";
  assetRegime: string;
  confidence: number;
  entryAt: number;
  entryPrice: number;
  initialStopPrice: number;
  currentStopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  target1HitAt: number | null;
  maxHoldingMinutes: number;
  riskReward: number;
  riskBudgetUsdt: number;
  notionalUsdt: number;
  marginUsdt: number;
  quantity: number;
  leverage: number;
  entryTrigger: string;
  entryThesis: string;
  lastPrice: number;
  lastEvaluatedAt: number;
  maxPriceSeen: number;
  minPriceSeen: number;
  unrealizedNetPct: number;
  unrealizedNetUsdt: number;
  progressR: number;
  exitAt: number | null;
  exitPrice: number | null;
  exitCode: string | null;
  exitReason: string | null;
  grossMovePct: number | null;
  netMovePct: number | null;
  grossPnlUsdt: number | null;
  costUsdt: number | null;
  netPnlUsdt: number | null;
  mfePct: number | null;
  maePct: number | null;
  holdMinutes: number | null;
  postExitStatus: "pending" | "observing" | "complete";
  postExitMfePct: number | null;
  postExitMaePct: number | null;
  exitCapturePct: number | null;
  exitEfficiency: number | null;
  stopRecovery: boolean | null;
  postExitLabel: string | null;
};

type Learning = {
  id: string;
  traderId: TraderId;
  assetRegime: string;
  side: "LONG" | "SHORT";
  sampleCount: number;
  wins: number;
  losses: number;
  expectancyR: number;
  grossProfitR: number;
  grossLossR: number;
  averageMfeR: number;
  averageMaeR: number;
  averageExitEfficiency: number;
  performanceGate?: { state: "ACTIVE" | "PAUSED"; reason: string; profitFactor: number | null };
};

type Guard = { state: GuardState; lossStreak: number; retryAfter: number | null; reason: string };
type Governance = {
  state: "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
  riskMultiplier: number;
  lossStreak: number;
  reason: string;
  traderGuards: Record<TraderId, Guard>;
};

type CleanDashboard = {
  account: {
    startingCapitalUsdt: number;
    realizedPnlUsdt: number;
    unrealizedPnlUsdt: number;
    realizedBalanceUsdt: number;
    equityUsdt: number;
    usedMarginUsdt: number;
    availableMarginUsdt: number;
  };
  trades: CleanTrade[];
  openTrades: CleanTrade[];
  closedTrades: CleanTrade[];
  evaluations: Evaluation[];
  learning: Learning[];
  governance: Governance;
  activity: { symbols: number; evaluations: number; ready: number; watching: number; blocked: number };
  stats: { sampleCount: number; wins: number; scratches: number; losses: number; profitFactor: number | null; totalNetPnlUsdt: number };
  settings: {
    scanEnabled: boolean;
    pushEnabled: boolean;
    coreSymbols: string[];
    universeLimit: number;
    trialCapitalUsdt: number;
    roundTripCostBps: number;
  };
};

type CleanSnapshot = {
  version: "hte-3.1-clean";
  requestedAt: number;
  observedAt: number;
  account: { id: string; displayName: string; role: string; status: string };
  scanner: { status: SchedulerStatus | null; ageMs: number | null; readModel: { target?: string; openReason?: string } | null };
  position: { status: SchedulerStatus | null };
  market: MarketState | null;
  dashboard: CleanDashboard | null;
  degraded: boolean;
  errors: Record<string, string>;
};

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Observation = {
  tradeId: string;
  horizonMinutes: number;
  dueAt: number;
  observedAt: number | null;
  status: "pending" | "complete";
  price: number | null;
  favorablePct: number | null;
  adversePct: number | null;
  favorableR: number | null;
  adverseR: number | null;
};

type TradeChart = {
  version: string;
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  traderId: TraderId;
  setupId: string;
  observedAt: number;
  candles: Candle[];
  currentPrice: number;
  levels: { entry: number; initialStop: number; currentStop: number; takeProfit1: number; takeProfit2: number };
  markers: { kind: "ENTRY" | "EXIT"; time: number; price: number; label: string }[];
  postExitStartAt: number | null;
  observationUntilAt: number | null;
  observations: Observation[];
  counterfactual: { generatedAt: number; horizons: { minutes: number; observedAt: number; originalR: number; oppositeR: number }[]; reversals: { key: string; label: string; triggeredAt: number; triggerPrice: number; side: "LONG" | "SHORT"; observedMinutes: number; terminalR: number; maxFavorableR: number; maxAdverseR: number }[]; summary: string } | null;
  diagnosis: {
    mfePct: number | null;
    maePct: number | null;
    postExitMfePct: number | null;
    postExitMaePct: number | null;
    exitCapturePct: number | null;
    exitEfficiency: number | null;
    stopRecovery: boolean | null;
    label: string | null;
    status: string;
  };
  upstreamError: string | null;
};

type LiveOrder = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  state: string;
  referencePrice: number;
  fillPrice: number | null;
  stopLossPrice: number;
  takeProfitPrice: number;
  leverage: number;
  marginMode: string;
  realizedPnlUsdt: number | null;
  strategyLabel?: string | null;
  strategyThesis?: string | null;
};

type LiveSnapshot = {
  observedAt: number;
  control: {
    entryEnabled: boolean;
    state: string;
    lastError?: string | null;
    emergencyReason?: string | null;
    accountEquityLastUsdt?: number | null;
    dailyRealizedPnlUsdt?: number | null;
    lastReconciledAt?: number | null;
    lastSuccessfulReconcileAt?: number | null;
  };
  credential: { configured: boolean; environment?: string; keyHint?: string; status?: string; lastVerifiedAt?: number | null; lastError?: string | null };
  performanceGate?: { passed?: boolean; reason?: string | null };
  orders: LiveOrder[];
  audit?: { id: string; severity: string; message: string; createdAt: number }[];
  error?: string;
};

const TABS: Tab[] = ["总览", "雷达", "订单", "实盘", "设置"];
const TRADER_INFO: Record<TraderId, { code: string; name: string; setup: string; copy: string }> = {
  dennis_trend: { code: "HT1", name: "Dennis", setup: "趋势突破", copy: "真正离开旧区间才参与，让趋势自己证明方向。" },
  raschke_pullback: { code: "HT2", name: "Raschke", setup: "趋势回踩", copy: "趋势先成立，再等受控回踩与恢复，不追第一根。" },
  turtle_soup: { code: "HT3", name: "Turtle Soup", setup: "假突破", copy: "只做成熟极值被扫后重新收回区间的失败突破。" },
  exhaustion_reversal: { code: "HT4", name: "Exhaustion", setup: "反拥挤衰竭", copy: "不机械反做；等共识拥挤、趋势延伸过度且继续推进失败后再站到反面。" },
  higher_timeframe_swing: { code: "HT5", name: "Swing", setup: "大周期结构", copy: "1h/4h 决定数小时方向，15m/5m 只负责等待逆向回撤结束与精确入场。" },
};

function fmtTime(value: number | null | undefined) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return `$${value.toFixed(digits)}`;
}

function fmtMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 2)}`;
}

function fmtPct(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(digits)}%`;
}

function fmtR(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}R`;
}

function plannedTp2NetUsdt(trade: CleanTrade, roundTripCostBps: number) {
  if (!(trade.entryPrice > 0 && trade.notionalUsdt > 0)) return null;
  const direction = trade.side === "LONG" ? 1 : -1;
  const grossMoveRate = direction * (trade.takeProfit2Price / trade.entryPrice - 1);
  const costRate = Math.max(0, roundTripCostBps) / 10_000;
  return trade.notionalUsdt * (grossMoveRate - costRate);
}

function sideLabel(side: TradeSide) {
  return side === "LONG" ? "做多" : side === "SHORT" ? "做空" : "等待";
}

function horizonLabel(minutes: number) {
  return minutes === 0 ? "出场" : minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error(`${url} 返回了非 JSON 响应`);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `${url} 请求失败 (${response.status})`);
  return payload;
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return <div className="clean-empty"><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}

function CandleChart({ chart }: { chart: TradeChart }) {
  const candles = chart.candles.slice(-180);
  if (candles.length < 2) return <Empty title="K 线正在准备" detail={chart.upstreamError ?? "等待 K 线数据补齐。"} />;
  const width = 900;
  const height = 340;
  const pad = { left: 14, right: 74, top: 20, bottom: 30 };
  const usableW = width - pad.left - pad.right;
  const usableH = height - pad.top - pad.bottom;
  const prices = candles.flatMap((c) => [c.high, c.low]);
  const levels = [chart.levels.entry, chart.levels.initialStop, chart.levels.takeProfit1, chart.levels.takeProfit2].filter(Number.isFinite);
  const min = Math.min(...prices, ...levels);
  const max = Math.max(...prices, ...levels);
  const span = Math.max(max - min, Math.abs(max) * 0.002, 1e-9);
  const y = (price: number) => pad.top + (max - price) / span * usableH;
  const x = (index: number) => pad.left + index / Math.max(1, candles.length - 1) * usableW;
  const barW = Math.max(2, Math.min(8, usableW / candles.length * 0.62));
  const candleMs = (c: Candle) => c.time > 10_000_000_000 ? c.time : c.time * 1000;
  const exitIndex = chart.postExitStartAt == null ? -1 : candles.findIndex((c) => candleMs(c) >= chart.postExitStartAt!);
  const line = (price: number, label: string, cls: string) => <g key={label} className={cls}><line x1={pad.left} x2={width - pad.right} y1={y(price)} y2={y(price)} strokeDasharray="7 6" /><text x={width - pad.right + 6} y={y(price) + 4}>{label}</text></g>;
  return <div className="chart-wrap">
    <div className="chart-toolbar"><div><b>{chart.symbol.replace("_USDT", "")} · 5m</b><small>进场 → 持仓 → 出场后观察</small></div><span className={`pill ${chart.side === "LONG" ? "long" : "short"}`}>{sideLabel(chart.side)}</span></div>
    <svg className="candle-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="订单进出场及出场后K线复盘图">
      {exitIndex >= 0 && <rect className="post-exit-zone" x={x(exitIndex)} y={pad.top} width={Math.max(0, width - pad.right - x(exitIndex))} height={usableH} />}
      {[0,.25,.5,.75,1].map((t) => <line className="chart-grid" key={t} x1={pad.left} x2={width-pad.right} y1={pad.top+usableH*t} y2={pad.top+usableH*t} />)}
      {candles.map((c, i) => {
        const cx = x(i), openY = y(c.open), closeY = y(c.close), highY = y(c.high), lowY = y(c.low);
        const up = c.close >= c.open;
        return <g key={`${c.time}-${i}`} className={up ? "candle-up" : "candle-down"}>
          <line x1={cx} x2={cx} y1={highY} y2={lowY} />
          <rect x={cx-barW/2} y={Math.min(openY,closeY)} width={barW} height={Math.max(1.4,Math.abs(closeY-openY))} rx="1" />
        </g>;
      })}
      {line(chart.levels.entry,"ENTRY","level-entry")}
      {line(chart.levels.initialStop,"STOP","level-stop")}
      {line(chart.levels.takeProfit1,"TP1","level-tp")}
      {line(chart.levels.takeProfit2,"TP2","level-tp")}
      {chart.markers.map((m) => {
        const idx = candles.findIndex((c) => candleMs(c) >= m.time);
        if (idx < 0) return null;
        const cx = x(idx), cy = y(m.price);
        return <g className={m.kind === "ENTRY" ? "marker-entry" : "marker-exit"} key={`${m.kind}-${m.time}`}><circle cx={cx} cy={cy} r="7"/><text x={cx+10} y={cy-10}>{m.kind}</text></g>;
      })}
      <text className="chart-axis" x={width-pad.right+6} y={pad.top+4}>{fmtPrice(max)}</text>
      <text className="chart-axis" x={width-pad.right+6} y={pad.top+usableH}>{fmtPrice(min)}</text>
    </svg>
    <div className="chart-legend"><span><i className="legend-dot entry"/>Entry</span><span><i className="legend-dot stop"/>Stop</span><span><i className="legend-dot tp"/>TP1 / TP2</span><span><i className="legend-dot post"/>Post-Exit 区域</span></div>
  </div>;
}

function TradeReview({ trade }: { trade: CleanTrade }) {
  const [chart, setChart] = useState<TradeChart | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    readJson<TradeChart>(`/api/hte31/chart?trade=${encodeURIComponent(trade.id)}`)
      .then((value) => { if (live) { setChart(value); setError(""); } })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "K线复盘暂不可用"); });
    return () => { live = false; };
  }, [trade.id]);
  if (error) return <div className="trade-review"><Empty title="K 线复盘暂不可用" detail={error} /></div>;
  if (!chart) return <div className="trade-review"><Empty title="正在读取交易复盘" detail="正在组合进场、持仓与出场后 K 线。" /></div>;
  return <div className="trade-review">
    <CandleChart chart={chart} />
    <div className="review-grid">
      <div><span>仓内 MFE</span><b>{fmtPct(chart.diagnosis.mfePct)}</b></div>
      <div><span>仓内 MAE</span><b>{fmtPct(chart.diagnosis.maePct)}</b></div>
      <div><span>出场后 MFE</span><b>{fmtPct(chart.diagnosis.postExitMfePct)}</b></div>
      <div><span>出场后 MAE</span><b>{fmtPct(chart.diagnosis.postExitMaePct)}</b></div>
      <div><span>Exit Capture</span><b>{fmtPct(chart.diagnosis.exitCapturePct)}</b></div>
      <div><span>Exit Efficiency</span><b>{fmtPct(chart.diagnosis.exitEfficiency)}</b></div>
    </div>
    {trade.status === "closed" && <>
      <div className="observer-timeline">{chart.observations.map((item) => <div className="observer-chip" key={item.horizonMinutes}><b>{horizonLabel(item.horizonMinutes)}</b>{item.status === "complete" ? <><span>有利 {fmtR(item.favorableR)}</span><br/><span>不利 {fmtR(item.adverseR)}</span></> : <span>等待观察</span>}</div>)}</div>
      {chart.counterfactual && <><div className="review-grid">{chart.counterfactual.horizons.filter((item)=>item.minutes===120||item.minutes===240||item.minutes===480).map((item)=><div key={item.minutes}><span>{horizonLabel(item.minutes)} 原 / 反</span><b>{fmtR(item.originalR)} / {fmtR(item.oppositeR)}</b></div>)}</div><div className="observer-timeline">{chart.counterfactual.reversals.map((item)=><div className="observer-chip" key={item.key}><b>{item.label}</b><span>终值 {fmtR(item.terminalR)}</span><br/><span>MFE {fmtR(item.maxFavorableR)}</span></div>)}</div><p className="order-thesis"><b>Counterfactual Observer</b> · {chart.counterfactual.summary}</p></>}
      <p className="order-thesis"><b>{chart.diagnosis.label ?? "出场后观察中"}</b> · {chart.diagnosis.status === "complete" ? "12h 观察完成，已进入退出质量学习。" : "平仓结果不会被改写；观察结果只用于未来退出模型学习。"}{chart.diagnosis.stopRecovery ? " · 已标记疑似假止损。" : ""}</p>
    </>}
    {chart.upstreamError && <p className="order-thesis">实时 Gate 图层暂不可用：{chart.upstreamError}；页面仍使用已保存的交易快照。</p>}
  </div>;
}

function OrderCard({ trade, roundTripCostBps }: { trade: CleanTrade; roundTripCostBps: number }) {
  const [expanded, setExpanded] = useState(false);
  const info = TRADER_INFO[trade.traderId];
  const pnl = trade.status === "holding" ? trade.unrealizedNetUsdt : trade.netPnlUsdt;
  const plannedTp2Net = plannedTp2NetUsdt(trade, roundTripCostBps);
  const realizedR = trade.status === "closed" && trade.netPnlUsdt != null && trade.riskBudgetUsdt > 0
    ? trade.netPnlUsdt / trade.riskBudgetUsdt
    : null;
  return <article className="order-card">
    <button className="review-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <div className="card-head"><div className="symbol"><strong>{trade.symbol.replace("_USDT", "")}</strong><small>{info.code} {info.name} · {info.setup} · {trade.assetRegime}</small></div><div><span className={`pill ${trade.side === "LONG" ? "long" : "short"}`}>{sideLabel(trade.side)}</span><div className={pnl != null && pnl < 0 ? "negative" : "positive"} style={{textAlign:"right",marginTop:8,fontWeight:850}}>{fmtMoney(pnl)}</div></div></div>
      <div className="order-numbers"><div><span>入场</span><b>{fmtPrice(trade.entryPrice)}</b></div><div><span>{trade.status === "holding" ? "现价" : "出场"}</span><b>{fmtPrice(trade.status === "holding" ? trade.lastPrice : trade.exitPrice)}</b></div><div><span>原始 Stop</span><b>{fmtPrice(trade.initialStopPrice)}</b></div><div><span>TP2</span><b>{fmtPrice(trade.takeProfit2Price)}</b></div></div>
      <div className="order-economics"><div><span>杠杆</span><b>{trade.leverage}x</b></div><div><span>隔离保证金</span><b>{fmtMoney(trade.marginUsdt)}</b></div><div><span>名义仓位</span><b>{fmtMoney(trade.notionalUsdt)}</b></div><div><span>计划亏损</span><b>{fmtMoney(-trade.riskBudgetUsdt)}</b></div><div><span>TP2预计净利</span><b className="positive">{fmtMoney(plannedTp2Net)}</b></div><div><span>{trade.status === "closed" ? "实际结果" : "当前保护价"}</span><b>{trade.status === "closed" ? fmtR(realizedR) : fmtPrice(trade.currentStopPrice)}</b></div></div>
      <p className="order-thesis">{trade.entryThesis}</p>
      <p className="order-thesis">{trade.status === "holding" ? `${fmtTime(trade.entryAt)} · ${trade.leverage}x · 风险 ${fmtMoney(trade.riskBudgetUsdt)} · ${fmtR(trade.progressR)}` : `${fmtTime(trade.entryAt)} → ${fmtTime(trade.exitAt)} · ${trade.leverage}x · ${fmtR(realizedR)} · ${trade.exitReason ?? trade.exitCode ?? "已平仓"} · ${trade.postExitLabel ?? "出场后观察中"}`} · 点击{expanded ? "收起" : "展开"} K 线复盘</p>
    </button>
    {expanded && <TradeReview trade={trade} />}
  </article>;
}

function TraderCard({ id, dashboard }: { id: TraderId; dashboard: CleanDashboard }) {
  const info = TRADER_INFO[id];
  const guard = dashboard.governance.traderGuards[id];
  const learning = dashboard.learning.filter((row) => row.traderId === id);
  const samples = learning.reduce((sum, row) => sum + row.sampleCount, 0);
  const expectancy = samples ? learning.reduce((sum, row) => sum + row.expectancyR * row.sampleCount, 0) / samples : null;
  const pausedCells = learning.filter((row) => row.performanceGate?.state === "PAUSED");
  return <article className="clean-trader"><span className={`guard ${guard.state.toLowerCase()}`}>{guard.state}</span><h3>{info.code} {info.name}</h3><b>{info.setup}</b><p>{info.copy}</p><p>样本 n={samples} · W/S/L {learning.reduce((sum,row)=>sum+row.wins,0)}/{learning.reduce((sum,row)=>sum+Math.max(0,row.sampleCount-row.wins-row.losses),0)}/{learning.reduce((sum,row)=>sum+row.losses,0)} · Expectancy {fmtR(expectancy)} · 负期望暂停组合 {pausedCells.length} 个 · {guard.reason}</p>{pausedCells.slice(0,2).map((row)=><p className="negative" key={row.id}>{row.assetRegime} · {sideLabel(row.side)}：{row.performanceGate?.reason}</p>)}</article>;
}

function RadarCard({ item }: { item: Evaluation }) {
  const info = TRADER_INFO[item.traderId];
  return <article className="radar-card"><div className="card-head"><div className="symbol"><strong>{item.symbol.replace("_USDT", "")}</strong><small>{info.code} {info.name} · {item.assetRegime} · {fmtTime(item.observedAt)}</small></div><div><span className={`pill ${item.state === "ready" ? "long" : item.state === "blocked" ? "reject" : "wait"}`}>{item.state === "ready" ? "READY" : item.state === "watching" ? "WATCH" : "BLOCK"}</span><div style={{textAlign:"right",marginTop:8}}>{sideLabel(item.side)}</div></div></div><div className="score-grid"><div><span>Setup</span><b>{Math.round(item.setupScore)}</b></div><div><span>证据</span><b>{Math.round(item.evidenceScore)}</b></div><div><span>Confidence</span><b>{item.confidence}</b></div></div><ul className="reason-list">{item.reasons.slice(0,2).map((r)=><li key={r}>✓ {r}</li>)}{item.blockers.slice(0,2).map((r)=><li key={r}>· 等待：{r}</li>)}</ul></article>;
}

export default function CleanPage() {
  const [tab, setTab] = useState<Tab>("总览");
  const [snapshot, setSnapshot] = useState<CleanSnapshot | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [mainError, setMainError] = useState("");
  const [liveError, setLiveError] = useState("");
  const [message, setMessage] = useState("");
  const [coreSymbolsText, setCoreSymbolsText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [permissionsConfirmed, setPermissionsConfirmed] = useState(false);
  const mainInFlight = useRef(false);
  const liveInFlight = useRef(false);
  const emergencyTimer = useRef<number | null>(null);

  const refreshMain = useCallback(async (silent = false) => {
    if (mainInFlight.current) return;
    mainInFlight.current = true;
    try {
      const next = await readJson<CleanSnapshot>("/api/hte31");
      setSnapshot(next);
      setMainError("");
      if (!coreSymbolsText && next.dashboard?.settings.coreSymbols) setCoreSymbolsText(next.dashboard.settings.coreSymbols.join(", "));
    } catch (error) {
      setMainError(error instanceof Error ? error.message : "HTE 3.1 暂不可用");
      if (!silent) setSnapshot(null);
    } finally {
      mainInFlight.current = false;
      setLoading(false);
    }
  }, [coreSymbolsText]);

  const refreshLive = useCallback(async (silent = false) => {
    if (liveInFlight.current) return;
    liveInFlight.current = true;
    try { setLive(await readJson<LiveSnapshot>("/api/live/status")); setLiveError(""); }
    catch (error) { if (!silent) setLive(null); setLiveError(error instanceof Error ? error.message : "实盘状态暂不可用"); }
    finally { liveInFlight.current = false; }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refreshMain(), 0);
    const id = window.setInterval(() => void refreshMain(true), 20_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(id);
    };
  }, [refreshMain]);
  useEffect(() => {
    if (tab !== "实盘") return;
    const initialTimer = window.setTimeout(() => void refreshLive(), 0);
    const id = window.setInterval(() => void refreshLive(true), 12_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(id);
    };
  }, [tab, refreshLive]);

  const mutate = useCallback(async (url: string, init: RequestInit, success: string, refreshLiveAfter = false) => {
    setMessage("");
    try { await readJson(url, init); setMessage(success); await refreshMain(true); if (refreshLiveAfter) await refreshLive(true); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
  }, [refreshMain, refreshLive]);

  const dashboard = snapshot?.dashboard;
  const scanner = snapshot?.scanner.status;
  const position = snapshot?.position.status;
  const ageSeconds = snapshot?.scanner.ageMs == null ? null : Math.round(snapshot.scanner.ageMs / 1000);
  const healthBad = Boolean(mainError || scanner?.circuitOpen || (ageSeconds != null && ageSeconds > 90));
  const healthWarn = !healthBad && (snapshot?.degraded || scanner?.state === "starting" || scanner?.state === "error");
  const activeLiveOrders = live?.orders.filter((order) => ["submitting","open","protected","closing"].includes(order.state)) ?? [];

  const latestRadar = useMemo(() => {
    if (!dashboard) return [];
    const seen = new Set<string>();
    return dashboard.evaluations.filter((item) => {
      const key = `${item.symbol}:${item.traderId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0,24);
  }, [dashboard]);

  const statusText = mainError ? mainError
    : scanner?.circuitOpen ? `${scanner.lastError ?? "扫描暂时停止"}${scanner.retryAfter ? ` · ${fmtTime(scanner.retryAfter)} 后重试` : ""}`
      : scanner?.state === "starting" ? `扫描启动中${scanner.phase ? ` · ${scanner.phase}` : ""}`
        : ageSeconds != null && ageSeconds > 90 ? `扫描延迟 ${ageSeconds} 秒 · ${scanner?.lastError ?? "正在恢复"}`
          : `最近更新 ${snapshot?.observedAt ? fmtTime(snapshot.observedAt) : "--"}`;

  const saveCoreSymbols = () => {
    const coreSymbols = coreSymbolsText.split(/[,，\s]+/).map((v)=>v.trim().toUpperCase()).filter(Boolean).map((v)=>v.includes("_")?v:`${v}_USDT`);
    if (!coreSymbols.length) return setMessage("核心观察币种至少保留 1 个。");
    void mutate("/api/settings", { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({coreSymbols}) }, "核心观察币种已更新。", false);
  };
  const toggleScan = () => { const enabled = !(dashboard?.settings.scanEnabled ?? true); void mutate("/api/settings", {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({scanEnabled:enabled})}, enabled?"扫描已开启。":"扫描已暂停。", false); };
  const toggleLive = () => {
    if (!live) return;
    const enabled = !live.control.entryEnabled;
    void mutate("/api/live/control", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled})}, enabled ? "Auto Live 已开启；无合约可用余额时不会成交。" : "已关闭 Auto Live 新开仓。", true);
  };
  const saveCredentials = () => {
    if (!apiKey || !apiSecret || !permissionsConfirmed) return setMessage("请填写 API Key / Secret，并确认不授予提币权限。");
    void mutate("/api/live/credentials", {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({apiKey,apiSecret,permissionsConfirmed})}, "Gate 凭据已验证保存。", true).then(()=>{setApiKey("");setApiSecret("");});
  };
  const startEmergency = () => { if (emergencyTimer.current) window.clearTimeout(emergencyTimer.current); emergencyTimer.current = window.setTimeout(()=>{emergencyTimer.current=null;void mutate("/api/live/emergency",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"stop"})},"紧急停机已执行。",true);},1200); };
  const cancelEmergency = () => { if (emergencyTimer.current) { window.clearTimeout(emergencyTimer.current); emergencyTimer.current=null; } };

  return <main className="clean-shell">
    <header className="clean-header"><div className="clean-logo">O</div><div className="clean-title"><strong>Sentinel</strong><small>HTE 3.1 · 5 TRADERS</small></div><i className={`clean-health-dot ${healthBad?"bad":healthWarn?"warn":""}`} /></header>
    <div className={`clean-banner ${healthBad?"bad":healthWarn?"warn":""}`}><b>{healthBad?"运行异常":healthWarn?"恢复 / 启动":"系统运行中"}</b><p>{loading?"正在启动…":statusText}</p></div>
    {message && <div className="clean-banner"><b>系统消息</b><p>{message}</p></div>}

    {tab === "总览" && <>
      <section className="clean-panel">
        <span className="eyebrow">MARKET STATE</span>
        <div className="clean-market-title"><strong>{snapshot?.market?.label ?? "等待首轮扫描"}</strong><span className={`pill ${snapshot?.market?.permission === "YELLOW"?"wait":""}`}>{snapshot?.market?.permission ?? "START"}</span></div>
        <p className="clean-driver">10分钟 HTE：{dashboard?.activity.symbols ?? 0} 个币 · 五交易员评估 {dashboard?.activity.evaluations ?? 0} 次 · READY {dashboard?.activity.ready ?? 0} / WATCH {dashboard?.activity.watching ?? 0} / BLOCK {dashboard?.activity.blocked ?? 0} · 本轮目标 {snapshot?.scanner.readModel?.target?.replace("_USDT","") ?? "--"}</p>
        <div className="metric-grid"><div className="metric"><span>市场置信</span><b>{snapshot?.market?.confidence ?? 0}%</b></div><div className="metric"><span>稳定度</span><b>{snapshot?.market?.stability ?? 0}%</b></div><div className="metric"><span>切换风险</span><b>{snapshot?.market?.transitionRisk ?? 0}%</b></div><div className="metric"><span>方向偏置</span><b>{snapshot?.market?.bias === "LONG"?"偏多":snapshot?.market?.bias === "SHORT"?"偏空":"中性"}</b></div></div>
      </section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">RISK GOVERNOR</span><h2>{dashboard?.governance.state ?? "STARTING"}</h2></div><small>风险倍率 {Math.round((dashboard?.governance.riskMultiplier ?? 0)*100)}%</small></div><div className="clean-panel"><p className="clean-driver">{dashboard?.governance.reason ?? "等待风险状态"}</p></div></section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">5 INDEPENDENT TRADERS</span><h2>五位独立交易员</h2></div></div>{dashboard ? <div className="clean-trader-grid"><TraderCard id="dennis_trend" dashboard={dashboard}/><TraderCard id="raschke_pullback" dashboard={dashboard}/><TraderCard id="turtle_soup" dashboard={dashboard}/><TraderCard id="exhaustion_reversal" dashboard={dashboard}/><TraderCard id="higher_timeframe_swing" dashboard={dashboard}/></div> : <Empty title="等待交易员状态" />}</section>
    </>}

    {tab === "雷达" && <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">RADAR</span><h2>最近 15 分钟真实评估</h2></div><small>{latestRadar.length} 条</small></div>{latestRadar.length?<div className="radar-list">{latestRadar.map((item)=><RadarCard key={item.id} item={item}/>)}</div>:<Empty title="暂无评估" />}</section>}

    {tab === "订单" && <>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">SIMULATION</span><h2>模拟账户</h2></div></div>
        <div className="account-grid"><div className="metric"><span>模拟权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="metric"><span>已实现</span><b className={(dashboard?.account.realizedPnlUsdt??0)<0?"negative":"positive"}>{fmtMoney(dashboard?.account.realizedPnlUsdt)}</b></div><div className="metric"><span>未实现</span><b className={(dashboard?.account.unrealizedPnlUsdt??0)<0?"negative":"positive"}>{fmtMoney(dashboard?.account.unrealizedPnlUsdt)}</b></div><div className="metric"><span>可用保证金</span><b>{fmtMoney(dashboard?.account.availableMarginUsdt)}</b></div></div>
      </section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">OPEN</span><h2>当前模拟持仓</h2></div><small>{dashboard?.openTrades.length ?? 0} 笔</small></div>{dashboard?.openTrades.length?<div className="order-list">{dashboard.openTrades.map((trade)=><OrderCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps}/>)}</div>:<Empty title="暂无模拟持仓" />}</section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">CLOSED</span><h2>已平仓</h2></div><small>{dashboard?.closedTrades.length ?? 0} 笔</small></div>{dashboard?.closedTrades.length?<div className="order-list">{dashboard.closedTrades.map((trade)=><OrderCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps}/>)}</div>:<Empty title="暂无已平仓交易" />}</section>
    </>}

    {tab === "实盘" && <>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">GATE CONTRACT ACCOUNT</span><h2>合约账户</h2></div><small>{live?.credential.configured ? "Gate 已连接" : "未连接"}</small></div>
        <div className="account-grid"><div className="metric"><span>合约权益</span><b>{fmtMoney(live?.control.accountEquityLastUsdt)}</b></div><div className="metric"><span>当日已实现</span><b className={(live?.control.dailyRealizedPnlUsdt??0)<0?"negative":"positive"}>{fmtMoney(live?.control.dailyRealizedPnlUsdt)}</b></div><div className="metric"><span>最近成功对账</span><b>{fmtTime(live?.control.lastSuccessfulReconcileAt)}</b></div><div className="metric"><span>Auto Live</span><b>{live?.control.entryEnabled?"已开启":"已关闭"}</b></div></div>
        
      </section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">GATE LIVE</span><h2>实盘</h2></div></div>{liveError&&<div className="clean-banner bad"><b>实盘读取失败</b><p>{liveError}</p></div>}
        <div className="clean-live-grid"><article className="clean-panel"><span className="eyebrow">AUTO LIVE</span><div className="clean-market-title"><strong>{live?.control.entryEnabled?"已开启":"已关闭"}</strong></div><div className="clean-actions"><button className={live?.control.entryEnabled?"danger":"primary"} onClick={toggleLive}>{live?.control.entryEnabled?"关闭新实盘开仓":"开启 Auto Live"}</button><button onClick={()=>void mutate("/api/live/reconcile",{method:"POST"},"Gate 对账已完成。",true)}>立即对账</button><button className="danger" onPointerDown={startEmergency} onPointerUp={cancelEmergency} onPointerCancel={cancelEmergency} onPointerLeave={cancelEmergency}>按住 1.2 秒紧急停机</button></div></article>
        <article className="clean-panel"><span className="eyebrow">GATE API</span>{live?.credential.configured?<><div className="clean-market-title"><strong>已配置</strong></div><p className="clean-driver">{live.credential.keyHint ?? "Gate Live"} · {live.credential.status ?? "verified"}</p><div className="clean-actions"><button onClick={()=>void mutate("/api/live/credentials",{method:"DELETE"},"Gate API 凭据已删除。",true)}>删除凭据</button></div></>:<div className="clean-form"><label><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(e)=>setApiKey(e.target.value)}/></label><label><span>API Secret</span><input type="password" autoComplete="off" value={apiSecret} onChange={(e)=>setApiSecret(e.target.value)}/></label><label className="checkbox"><input type="checkbox" checked={permissionsConfirmed} onChange={(e)=>setPermissionsConfirmed(e.target.checked)}/><span>确认只授予 Gate 合约交易所需权限，不授予提币权限。</span></label><button className="primary" onClick={saveCredentials}>验证并保存</button></div>}</article></div>
      </section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">ACTIVE LIVE ORDERS</span><h2>真实持仓 / 活动订单</h2></div><small>{activeLiveOrders.length} 笔</small></div>{activeLiveOrders.length?<div className="order-list">{activeLiveOrders.map((order)=><article className="order-card" key={order.id}><div className="card-head"><div className="symbol"><strong>{order.symbol.replace("_USDT","")}</strong><small>{order.strategyLabel ?? "Live lifecycle"} · {order.state}</small></div><span className={`pill ${order.side === "LONG"?"long":"short"}`}>{sideLabel(order.side)}</span></div><div className="order-numbers"><div><span>参考价</span><b>{fmtPrice(order.referencePrice)}</b></div><div><span>成交价</span><b>{fmtPrice(order.fillPrice)}</b></div><div><span>止损</span><b>{fmtPrice(order.stopLossPrice)}</b></div><div><span>止盈</span><b>{fmtPrice(order.takeProfitPrice)}</b></div></div>{order.strategyThesis&&<p className="order-thesis">{order.strategyThesis}</p>}</article>)}</div>:<Empty title="没有活动实盘订单" />}</section>
    </>}

    {tab === "设置" && <>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">RUNTIME</span><h2>运行设置</h2></div></div><div className="clean-panel"><div className="system-facts"><div className="system-fact"><span>Scanner</span><b>{scanner?.state ?? "starting"}</b></div><div className="system-fact"><span>Scanner Phase</span><b>{scanner?.phase ?? "idle"}</b></div><div className="system-fact"><span>Trade Manager</span><b>{position?.state ?? "starting"}</b></div><div className="system-fact"><span>模拟样本</span><b>{dashboard?.stats.sampleCount ?? 0}</b></div><div className="system-fact"><span>Profit Factor</span><b>{dashboard?.stats.profitFactor == null?"--":dashboard.stats.profitFactor.toFixed(2)}</b></div></div><div className="clean-actions"><button className="primary" onClick={toggleScan}>{dashboard?.settings.scanEnabled?"暂停扫描":"开启扫描"}</button></div></div></section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">UNIVERSE</span><h2>核心观察币</h2></div></div><div className="clean-panel clean-form"><label><span>币种，以逗号或空格分隔</span><input value={coreSymbolsText} onChange={(e)=>setCoreSymbolsText(e.target.value)} placeholder="BTC, ETH, SOL, HYPE"/></label><button className="primary" onClick={saveCoreSymbols}>保存核心观察币</button></div></section>
    </>}

    <nav className="clean-nav" aria-label="主导航">{TABS.map((item)=><button type="button" className={tab===item?"active":""} onClick={()=>setTab(item)} key={item}>{item}</button>)}</nav>
  </main>;
}
