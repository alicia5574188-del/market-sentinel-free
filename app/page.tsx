"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SignalState = "observing" | "pre_alert" | "confirmed" | "blocked";
type ViewState = SignalState | "holding" | "closed" | "cooldown";
type FilterState = "all" | "holding" | SignalState;
type Tab = "机会" | "雷达" | "订单" | "设置";
type AlertStyle = "early" | "balanced" | "confirmed";

type Metric = { key: string; label: string; score: number; detail: string; available: boolean };
type EntryCheck = { key: string; label: string; passed: boolean; required: boolean; detail: string };
type ExitRule = { code: string; label: string; condition: string };
type EntryPlan = {
  ready: boolean;
  side: "LONG" | "SHORT";
  entryPrice: number;
  entryZone: [number, number];
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  plannedRiskPct: number;
  riskReward: number;
  maxHoldingMinutes: number;
  checks: EntryCheck[];
  exitRules: ExitRule[];
};
type Decision = {
  state: SignalState;
  stateLabel: string;
  side: "LONG" | "SHORT" | "WAIT";
  confidence: number;
  directionalScore: number;
  posteriorLong: number;
  dataQuality: number;
  regime: string;
  action: string;
  thesis: string;
  entryZone: [number, number] | null;
  trigger: string;
  invalidation: string;
  expiresMinutes: number;
  entryPlan: EntryPlan | null;
  evidence: { title: string; detail: string; score: number }[];
  counterEvidence: { title: string; detail: string }[];
  metrics: Metric[];
  diagnostics: { confirmationCount: number; contradictionCount: number; staleSources: string[]; macroEventRisk: number; atrPct: number | null; experienceSampleCount: number; experienceAdjustment: number };
};
type Trade = {
  id: string;
  symbol: string;
  status: "holding" | "closed";
  side: "LONG" | "SHORT";
  confidence: number;
  dataQuality: number;
  regime: string;
  entryDirectionalScore: number;
  entryAt: number;
  entryPrice: number;
  entryLow: number;
  entryHigh: number;
  entryTrigger: string;
  entryThesis: string;
  entryChecks: EntryCheck[];
  exitRules: ExitRule[];
  entryEvidence: { title: string; detail: string; score: number }[];
  entryCounterEvidence: { title: string; detail: string }[];
  entryMetrics: Metric[];
  initialStopPrice: number;
  currentStopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  target1HitAt: number | null;
  maxHoldingMinutes: number;
  plannedRiskPct: number;
  riskReward: number;
  riskBudgetUsdt: number;
  suggestedNotionalUsdt: number;
  contractType: string;
  marginMode: string;
  leverage: number;
  leverageReason: string;
  marginUsdt: number;
  contractNotionalUsdt: number;
  quantity: number;
  estimatedLiquidationPrice: number | null;
  simulationModel: string;
  accountBalanceBeforeUsdt: number;
  accountBalanceAfterUsdt: number | null;
  lastPrice: number;
  lastEvaluatedAt: number;
  unrealizedGrossPct: number;
  unrealizedNetPct: number;
  unrealizedGrossUsdt: number;
  unrealizedNetUsdt: number;
  progressR: number;
  exitAt: number | null;
  exitPrice: number | null;
  exitCode: string | null;
  exitReason: string | null;
  exitEvidence: string[];
  exitMetrics: Metric[];
  grossMovePct: number | null;
  estimatedCostPct: number | null;
  netMovePct: number | null;
  grossPnlUsdt: number | null;
  estimatedCostUsdt: number | null;
  netPnlUsdt: number | null;
  mfePct: number | null;
  maePct: number | null;
  holdMinutes: number | null;
  lesson: { outcome: "profit" | "loss" | "flat"; summary: string; whatWorked: string[]; whatFailed: string[]; nextAdjustment: string[] } | null;
  learningApplied: boolean;
};
type LivePacket = {
  mode: "live" | "degraded";
  source?: string;
  observedAt: number;
  latencyMs?: number;
  symbol: string;
  error?: string;
  openTrade?: Trade | null;
  decision?: Decision;
  market?: {
    futuresPrice: number;
    volumeUsd: number;
    changePercentage: number | null;
    fundingRate: number | null;
    openInterestChangePct: number | null;
    basisPct: number | null;
    spotCvdRatio: number | null;
    orderBookImbalance: number | null;
    liquidationImbalance: number | null;
    multiTimeframeTrend: number | null;
  };
};
type UniverseTicker = {
  symbol: string;
  price: number;
  changePercentage: number;
  volumeUsd: number;
  fundingRate: number | null;
  basisPct: number | null;
  coarseScore: number;
  confidence: number;
  state: Exclude<SignalState, "invalidated">;
  stateLabel: string;
  side: "LONG" | "SHORT" | "WAIT";
};
type GlobalContext = {
  observedAt: number;
  benchmarkMomentum: number | null;
  optionsIvPercentile: number | null;
  macroEventRisk: number | null;
  macroEventLabel: string | null;
  nextEvents: { title: string; time: number; source: string; importance: string }[];
  options: { btcDvol: number | null; ethDvol: number | null; percentile30d: number | null };
  sources: Record<string, string>;
};
type Settings = {
  alertStyle: AlertStyle;
  universeLimit: number;
  deepScanLimit: number;
  minConfidence: number;
  roundTripCostBps: number;
  trialCapitalUsdt: number;
  maxRiskPerAlertUsdt: number;
  dailyPauseUsdt: number;
  maxDrawdownUsdt: number;
  scanEnabled: boolean;
  pushEnabled: boolean;
  coreSymbols: string[];
};
type BackgroundStatus = {
  mode: "foreground-only" | "cloudflare-free";
  active: boolean;
  observedAt: number;
  positionCadenceSeconds: number | null;
  scanCadenceSeconds: number | null;
  deepBatchSize: number | null;
  position: { state: string; lastRunAt: number | null; nextRunAt: number | null; lastSuccessAt: number | null; lastError: string | null; refreshed?: number } | null;
  scanner: { state: string; lastRunAt: number | null; nextRunAt: number | null; lastSuccessAt: number | null; lastError: string | null; analyzed?: number; symbols?: string[] } | null;
  error?: string;
};
type ScannerPacket = { observedAt: number; universe: UniverseTicker[]; context: GlobalContext; openTrades: Trade[]; settings: Settings; error?: string };
type AlertRow = {
  id: string;
  symbol: string;
  state: SignalState;
  displayState: SignalState;
  side: "LONG" | "SHORT" | "WAIT";
  confidence: number;
  observedAt: number;
  outcomeState: string;
  netMovePct: number | null;
  grossMovePct: number | null;
  estimatedCostPct: number | null;
  thesis: string;
};
type Dashboard = {
  alerts: AlertRow[];
  trades: Trade[];
  openTrades: Trade[];
  memories: { id: string; symbol: string; side: "LONG" | "SHORT"; sampleCount: number; wins: number; losses: number; bayesianWinRate: number; averageNetPct: number; averageMfePct: number; averageMaePct: number; profitFactor: number | null; stopRate: number; lastLesson: Trade["lesson"] }[];
  stats: {
    emitted: number;
    open: number;
    closed: number;
    wins: number;
    winRate: number | null;
    averageGrossPct: number | null;
    averageCostPct: number | null;
    averageNetPct: number | null;
    totalNetPnlUsdt: number;
    averageMfePct: number | null;
    averageMaePct: number | null;
    averageHoldMinutes: number | null;
    targetExits: number;
    stopExits: number;
    brierScore: number | null;
    maxDrawdownPct: number;
    calibration: { range: string; count: number; predicted: number | null; realized: number | null }[];
    uncalibrated: boolean;
  };
  account: {
    startingCapitalUsdt: number;
    realizedPnlUsdt: number;
    unrealizedPnlUsdt: number;
    realizedBalanceUsdt: number;
    equityUsdt: number;
    usedMarginUsdt: number;
    availableMarginUsdt: number;
  };
  archivedCount: number;
  lastScan: { startedAt: number; status: string; universeSize: number; deepScanned: number; confirmedCount: number; preAlertCount: number; averageDataQuality: number | null; durationMs: number | null } | null;
  settings: Settings;
};
type Account = {
  id: string;
  email: string;
  displayName: string;
  role: "owner" | "member";
  status: "active" | "disabled";
  createdAt: number;
  lastSeenAt: number;
  signOutPath: string;
};

const STATE_META: Record<ViewState, { label: string; short: string }> = {
  observing: { label: "持续观察", short: "观察" },
  pre_alert: { label: "预警等待触发", short: "预警" },
  confirmed: { label: "条件已确认", short: "确认" },
  blocked: { label: "风险拦截", short: "拦截" },
  holding: { label: "持仓中", short: "持仓" },
  closed: { label: "已平仓", short: "平仓" },
  cooldown: { label: "平仓冷却", short: "冷却" },
};
const STYLE_META: Record<AlertStyle, { label: string; note: string }> = {
  early: { label: "更早", note: "更早提示，噪声更多；仍不把初筛当成进场信号。" },
  balanced: { label: "平衡", note: "至少三类独立证据同向，并给出触发与失效条件。" },
  confirmed: { label: "更确认", note: "要求更多证据和更高数据完整度，信号更少。" },
};

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4M12 17h.01"/></>,
    x: <><path d="m6 6 12 12M18 6 6 18"/></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12"/><circle cx="12" cy="12" r="2.5"/></>,
    radar: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 6-6M12 3v2M3 12h2"/><circle cx="12" cy="12" r="1"/></>,
    log: <><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.7-2L20 9M4 15l2.2 2A7 7 0 0 0 18 15"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function displayPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  const digits = value >= 10_000 ? 1 : value >= 100 ? 2 : value >= 1 ? 3 : 6;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function displayPct(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
function displayUsdt(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(digits)}U`;
}
function displayVolume(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return value.toFixed(0);
}
function formatTime(value: number | null | undefined) {
  return value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
}
function formatDateTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function relativeEvent(value: number) {
  const minutes = Math.round((value - Date.now()) / 60_000);
  if (minutes <= 0) return "正在公布";
  if (minutes < 60) return `${minutes} 分钟后`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时后`;
  return `${Math.round(minutes / 1440)} 天后`;
}
function applicationServerKey(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `请求失败 ${response.status}`);
  return payload;
}
function ScoreBars({ decision }: { decision: Decision }) {
  const values = decision.metrics.slice(0, 12).map((metric) => Math.round(45 + Math.abs(metric.score) * 50));
  return <div className={`score-bars ${decision.state}`} aria-label="证据强度序列">{values.map((height, index) => <span key={`${decision.metrics[index]?.key}-${index}`} style={{ height: `${Math.max(16, height)}%` }}/>)}</div>;
}

function EntryPlanDetail({ plan }: { plan: EntryPlan }) {
  return <div className="execution-plan">
    <div className="section-title"><span>完整进场清单</span><small>{plan.checks.filter((item) => item.passed).length}/{plan.checks.length} 项通过</small></div>
    <div className="check-list">{plan.checks.map((check) => <div className={`check-item ${check.passed ? "passed" : "failed"}`} key={check.key}><span><Icon name={check.passed ? "check" : "x"} size={13}/></span><div><strong>{check.label}</strong><p>{check.detail}</p></div><b>{check.passed ? "通过" : "未通过"}</b></div>)}</div>
    <div className="plan-price-grid"><div><span>跟踪入场</span><strong>{displayPrice(plan.entryPrice)}</strong></div><div><span>结构止损</span><strong className="danger">{displayPrice(plan.stopLossPrice)}</strong></div><div><span>TP1 · 1R</span><strong>{displayPrice(plan.takeProfit1Price)}</strong></div><div><span>TP2 · 2R</span><strong className="good">{displayPrice(plan.takeProfit2Price)}</strong></div></div>
    <div className="section-title"><span>预设出场条件</span><small>开仓前固定</small></div>
    <div className="rule-list">{plan.exitRules.map((rule) => <div key={`${rule.code}-${rule.label}`}><span>{rule.label}</span><strong>{rule.condition}</strong></div>)}</div>
  </div>;
}

type ChartPacket = {
  tradeId: string;
  symbol: string;
  observedAt: number;
  live: boolean;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  currentPrice: number;
  levels: { entry: number; stop: number; takeProfit1: number; takeProfit2: number };
  markers: { kind: "B" | "S"; action: string; time: number; price: number }[];
};

function OrderChart({ trade }: { trade: Trade }) {
  const [packet, setPacket] = useState<ChartPacket | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const next = await responseJson<ChartPacket>(await fetch(`/api/chart?trade=${encodeURIComponent(trade.id)}`, { cache: "no-store" }));
        if (active) { setPacket(next); setError(""); }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Gate 行情图暂不可用");
      }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [trade.id]);

  const geometry = useMemo(() => {
    if (!packet?.candles.length) return null;
    const source = packet.candles;
    const step = Math.max(1, Math.ceil(source.length / 220));
    const candles = source.filter((_item, index) => index % step === 0 || index === source.length - 1);
    const levelValues = Object.values(packet.levels).filter(Number.isFinite);
    const prices = candles.flatMap((item) => [item.low, item.high]).concat(levelValues, packet.markers.map((item) => item.price));
    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);
    const padding = Math.max((rawMax - rawMin) * 0.08, rawMax * 0.001);
    const min = rawMin - padding;
    const max = rawMax + padding;
    const width = 420;
    const top = 14;
    const bottom = 214;
    const left = 8;
    const right = 58;
    const plotWidth = width - left - right;
    const y = (price: number) => top + (max - price) / Math.max(max - min, Number.EPSILON) * (bottom - top);
    const x = (index: number) => left + index / Math.max(candles.length - 1, 1) * plotWidth;
    const markerX = (time: number) => {
      const target = time > 10_000_000_000 ? time : time * 1000;
      let nearest = 0;
      let distance = Number.POSITIVE_INFINITY;
      candles.forEach((candle, index) => {
        const candleTime = candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
        const nextDistance = Math.abs(candleTime - target);
        if (nextDistance < distance) { distance = nextDistance; nearest = index; }
      });
      return x(nearest);
    };
    return { candles, min, max, width, top, bottom, left, right, plotWidth, y, x, markerX };
  }, [packet]);

  if (!packet || packet.tradeId !== trade.id || !geometry) return <section className="order-chart loading"><div className="section-title"><span>Gate 5m 行情 · B/S 点</span><small>15 秒刷新</small></div><p>{error || "正在读取真实 K 线…"}</p></section>;
  const lineLevels = [
    { key: "current", label: "现价", value: packet.currentPrice, color: "#b899ff" },
    { key: "entry", label: "入场", value: packet.levels.entry, color: "#43c7ef" },
    { key: "stop", label: "止损", value: packet.levels.stop, color: "#ff6e78" },
    { key: "takeProfit1", label: "TP1", value: packet.levels.takeProfit1, color: "#ffbd4a" },
    { key: "takeProfit2", label: "TP2", value: packet.levels.takeProfit2, color: "#3ee59a" },
  ];
  const candleWidth = Math.max(1.2, Math.min(4, geometry.plotWidth / Math.max(geometry.candles.length, 1) * .62));

  return <section className="order-chart">
    <div className="section-title"><span>Gate 5m 行情 · B/S 点</span><small>{packet.live ? `实时 · ${formatTime(packet.observedAt)}` : "历史订单窗口"}</small></div>
    <div className="chart-price-row"><span>最新 {displayPrice(packet.currentPrice)}</span><span className="buy-label">B 买入</span><span className="sell-label">S 卖出</span></div>
    <svg viewBox={`0 0 ${geometry.width} 232`} role="img" aria-label={`${trade.symbol} 5分钟K线，包含买卖点、止损和止盈线`}>
      {[0, .25, .5, .75, 1].map((ratio) => { const lineY = geometry.top + ratio * (geometry.bottom - geometry.top); const price = geometry.max - ratio * (geometry.max - geometry.min); return <g key={ratio}><line className="chart-grid" x1={geometry.left} y1={lineY} x2={geometry.width - geometry.right} y2={lineY}/><text className="chart-axis" x={geometry.width - geometry.right + 4} y={lineY + 3}>{displayPrice(price)}</text></g>; })}
      {geometry.candles.map((candle, index) => { const candleX = geometry.x(index); const up = candle.close >= candle.open; const bodyTop = geometry.y(Math.max(candle.open, candle.close)); const bodyHeight = Math.max(1, Math.abs(geometry.y(candle.open) - geometry.y(candle.close))); return <g className={up ? "candle-up" : "candle-down"} key={`${candle.time}-${index}`}><line x1={candleX} y1={geometry.y(candle.high)} x2={candleX} y2={geometry.y(candle.low)}/><rect x={candleX - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight}/></g>; })}
      {lineLevels.map((level) => <g key={level.key}><line className="price-level" style={{ stroke: level.color }} x1={geometry.left} y1={geometry.y(level.value)} x2={geometry.width - geometry.right} y2={geometry.y(level.value)}/><text className="level-label" style={{ fill: level.color }} x={geometry.width - geometry.right + 4} y={geometry.y(level.value) - 3}>{level.label}</text></g>)}
      {packet.markers.map((marker, index) => { const markerX = geometry.markerX(marker.time); const markerY = geometry.y(marker.price); const buy = marker.kind === "B"; const labelY = Math.max(12, Math.min(224, markerY + (buy ? 18 : -12))); return <g className={buy ? "buy-marker" : "sell-marker"} key={`${marker.kind}-${marker.time}-${index}`}><line x1={markerX} y1={markerY} x2={markerX} y2={labelY + (buy ? -5 : 5)}/><circle cx={markerX} cy={labelY} r="9"/><text x={markerX} y={labelY + 3}>{marker.kind}</text><title>{marker.action} · {displayPrice(marker.price)} · {formatDateTime(marker.time)}</title></g>; })}
    </svg>
    <p>长仓：B 开仓、S 平仓；短仓：S 开仓、B 平仓。强平价为保守近似，真实交易所维持保证金阶梯可能不同。</p>
  </section>;
}

function TradeDetail({ trade }: { trade: Trade }) {
  const isOpen = trade.status === "holding";
  const resultPct = isOpen ? trade.unrealizedNetPct : trade.netMovePct;
  const resultUsdt = isOpen ? trade.unrealizedNetUsdt : trade.netPnlUsdt;
  const metrics = isOpen ? trade.entryMetrics : trade.exitMetrics.length ? trade.exitMetrics : trade.entryMetrics;
  return <article className={`trade-detail ${isOpen ? "holding" : "closed"}`}>
    <div className="trade-hero"><div><span className={`state-pill ${isOpen ? "holding" : "closed"}`}>{isOpen ? "模拟合约持仓中" : "模拟合约 · 已平仓"}</span><strong>{trade.symbol.replace("_", "")} · {trade.side} · {trade.leverage}x</strong><p>{trade.regime} · 入场可信度 {trade.confidence}% · 数据质量 {Math.round(trade.dataQuality * 100)}%</p></div><div className={(resultUsdt ?? 0) >= 0 ? "good" : "danger"}><span>{isOpen ? "浮动净盈亏" : "已实现净盈亏"}</span><strong>{displayUsdt(resultUsdt)}</strong><small>{displayPct(resultPct)} · {isOpen ? `${trade.progressR.toFixed(2)}R` : `${trade.holdMinutes?.toFixed(0) ?? "--"} 分钟`}</small></div></div>
    <div className="plan-price-grid"><div><span>入场价</span><strong>{displayPrice(trade.entryPrice)}</strong></div><div><span>{trade.target1HitAt ? "保护止损" : "当前止损"}</span><strong className="danger">{displayPrice(trade.currentStopPrice)}</strong></div><div><span>TP1 · {trade.target1HitAt ? "已到达" : "等待"}</span><strong>{displayPrice(trade.takeProfit1Price)}</strong></div><div><span>TP2 · 完整止盈</span><strong className="good">{displayPrice(trade.takeProfit2Price)}</strong></div></div>
    <OrderChart trade={trade}/>
    <div className="contract-grid"><div><span>合约 / 保证金</span><b>USDT 永续 · 逐仓</b></div><div><span>自适应杠杆</span><b>{trade.leverage}x</b></div><div><span>保证金</span><b>{trade.marginUsdt.toFixed(2)}U</b></div><div><span>名义价值</span><b>{trade.contractNotionalUsdt.toFixed(2)}U</b></div><div><span>模拟数量</span><b>{trade.quantity.toFixed(6)}</b></div><div><span>预估强平价</span><b className="danger">≈ {displayPrice(trade.estimatedLiquidationPrice)}</b></div></div>
    <div className="leverage-reason"><span>为什么是 {trade.leverage}x</span><p>{trade.leverageReason}</p></div>
    <div className="trade-meta"><div><span>参考进场区间</span><b>{displayPrice(trade.entryLow)}–{displayPrice(trade.entryHigh)}</b></div><div><span>计划最大亏损</span><b>{trade.plannedRiskPct.toFixed(2)}% · {trade.riskBudgetUsdt.toFixed(2)}U</b></div><div><span>开仓前账户余额</span><b>{trade.accountBalanceBeforeUsdt.toFixed(2)}U</b></div><div><span>最长持仓</span><b>{trade.maxHoldingMinutes} 分钟</b></div></div>
    <div className="reason-block"><span>为什么进场</span><strong>{trade.entryThesis}</strong><p>{trade.entryTrigger}</p></div>
    <div className="section-title"><span>进场条件逐项存档</span><small>{trade.entryChecks.filter((item) => item.passed).length}/{trade.entryChecks.length} 通过</small></div>
    <div className="check-list">{trade.entryChecks.map((check) => <div className={`check-item ${check.passed ? "passed" : "failed"}`} key={check.key}><span><Icon name={check.passed ? "check" : "x"} size={13}/></span><div><strong>{check.label}</strong><p>{check.detail}</p></div><b>{check.passed ? "通过" : "失败"}</b></div>)}</div>
    <div className="section-title"><span>{isOpen ? "等待命中的出场条件" : "本单预设出场条件"}</span><small>不会因新预警重复开单</small></div>
    <div className="rule-list">{trade.exitRules.map((rule) => <div key={`${rule.code}-${rule.label}`}><span>{rule.label}</span><strong>{rule.condition}</strong></div>)}</div>
    <div className="section-title"><span>多方位分析快照</span><small>{metrics.filter((item) => item.available).length} 个有效维度</small></div>
    <div className="analysis-matrix">{metrics.map((item) => <div className={!item.available ? "muted" : item.score * (trade.side === "LONG" ? 1 : -1) >= 0 ? "support" : "oppose"} key={item.key}><span>{item.label}</span><b>{item.available ? `${item.score >= 0 ? "+" : ""}${item.score.toFixed(2)}` : "N/A"}</b><p>{item.detail}</p></div>)}</div>
    <div className="evidence-columns"><div><div className="section-title"><span>支持证据</span><small>入场时冻结</small></div>{trade.entryEvidence.map((item) => <p className="ledger-evidence" key={item.title}><Icon name="check" size={13}/><span><strong>{item.title}</strong>{item.detail}</span></p>)}</div><div><div className="section-title"><span>反证与已知风险</span><small>同样冻结</small></div>{trade.entryCounterEvidence.map((item) => <p className="ledger-evidence counter" key={item.title}><Icon name="alert" size={13}/><span><strong>{item.title}</strong>{item.detail}</span></p>)}</div></div>
    {!isOpen && <>
      <div className="exit-report"><div className="section-title"><span>实际出场</span><small>{trade.exitCode ?? "规则退出"}</small></div><strong>{trade.exitReason ?? "已按系统规则平仓"}</strong><p>{trade.exitEvidence.join("；")}</p><div className="exit-numbers"><span>出场 {displayPrice(trade.exitPrice)}</span><span>毛 {displayPct(trade.grossMovePct)} / {displayUsdt(trade.grossPnlUsdt)}</span><span>成本 -{trade.estimatedCostUsdt?.toFixed(2) ?? "--"}U</span><span>净 {displayPct(trade.netMovePct)} / {displayUsdt(trade.netPnlUsdt)}</span><span>平仓后余额 {trade.accountBalanceAfterUsdt?.toFixed(2) ?? "--"}U</span><span>MFE {displayPct(trade.mfePct)}</span><span>MAE {displayPct(trade.maePct)}</span></div></div>
      {trade.lesson && <div className="lesson-card"><div className="section-title"><span>本单复盘已写入策略记忆</span><small>{trade.learningApplied ? "已影响下一次分析" : "等待写入"}</small></div><strong>{trade.lesson.summary}</strong><div><span>做对了</span>{trade.lesson.whatWorked.map((item) => <p key={item}>· {item}</p>)}</div><div><span>没做好</span>{trade.lesson.whatFailed.length ? trade.lesson.whatFailed.map((item) => <p key={item}>· {item}</p>) : <p>· 本单没有新增失败项。</p>}</div><div><span>下一次调整</span>{trade.lesson.nextAdjustment.map((item) => <p key={item}>· {item}</p>)}</div></div>}
    </>}
    {isOpen && <p className="holding-lock"><Icon name="shield" size={15}/> 此币种已锁定为持仓中；只有命中上述平仓规则后，系统才允许产生下一张订单。</p>}
  </article>;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("机会");
  const [filter, setFilter] = useState<FilterState>("all");
  const [selectedSymbol, setSelectedSymbol] = useState(() => {
    if (typeof window === "undefined") return "BTC_USDT";
    const query = new URLSearchParams(window.location.search).get("symbol")?.toUpperCase();
    return query && /^[A-Z0-9]{2,18}_USDT$/.test(query) ? query : "BTC_USDT";
  });
  const [scanner, setScanner] = useState<ScannerPacket | null>(null);
  const [livePacket, setLivePacket] = useState<LivePacket | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("trade") ?? "");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [background, setBackground] = useState<BackgroundStatus | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [scanState, setScanState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [scanMessage, setScanMessage] = useState("等待首次深度扫描");
  const [notice, setNotice] = useState("未订阅");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [dashboardUpdatedAt, setDashboardUpdatedAt] = useState<number | null>(null);
  const [positionRefreshState, setPositionRefreshState] = useState<"idle" | "running" | "live" | "error">("idle");
  const [positionRefreshMessage, setPositionRefreshMessage] = useState("等待 Gate 持仓报价");
  const [saving, setSaving] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const startedForegroundScan = useRef(false);
  const deepScanRunning = useRef(false);
  const positionRefreshRunning = useRef(false);
  const canManage = account?.role === "owner";

  const loadAccount = useCallback(async () => {
    const current = await responseJson<Account>(await fetch("/api/account", { cache: "no-store" }));
    setAccount(current);
  }, []);

  const loadBackground = useCallback(async () => {
    try {
      const status = await responseJson<BackgroundStatus>(await fetch("/api/background", { cache: "no-store" }));
      setBackground(status);
      if (!status.active) return;
      const position = status.position;
      const scannerStatus = status.scanner;
      if (position?.lastSuccessAt) setDashboardUpdatedAt(position.lastSuccessAt);
      if (position?.state === "error") {
        setPositionRefreshState("error");
        setPositionRefreshMessage(position.lastError ?? "后台持仓重估失败");
      } else if (position?.state === "paused") {
        setPositionRefreshState("idle");
        setPositionRefreshMessage("后台监测已暂停");
      } else {
        setPositionRefreshState(position?.state === "starting" ? "running" : "live");
        setPositionRefreshMessage(position?.state === "starting" ? "免费后台正在启动" : `后台已重估 ${position?.refreshed ?? 0} 张持仓`);
      }
      if (scannerStatus?.lastSuccessAt && !deepScanRunning.current) {
        const symbols = scannerStatus.symbols?.map((symbol) => symbol.replace("_", "")).join("、");
        setScanState(scannerStatus.state === "error" ? "error" : "done");
        setScanMessage(scannerStatus.state === "error"
          ? `后台扫描异常 · ${scannerStatus.lastError ?? "等待自动恢复"}`
          : `免费后台每分钟复核 ${scannerStatus.analyzed ?? 0} 个标的${symbols ? ` · ${symbols}` : ""}`);
      }
    } catch (error) {
      setBackground({
        mode: "foreground-only",
        active: false,
        observedAt: Date.now(),
        positionCadenceSeconds: null,
        scanCadenceSeconds: null,
        deepBatchSize: null,
        position: null,
        scanner: null,
        error: error instanceof Error ? error.message : "后台状态不可用",
      });
    }
  }, []);

  const loadScanner = useCallback(async () => {
    try {
      const packet = await responseJson<ScannerPacket>(await fetch("/api/scanner", { cache: "no-store" }));
      setScanner(packet);
      setSettings(packet.settings);
      setSourceError("");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "全市场初筛暂不可用");
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const packet = await responseJson<Dashboard>(await fetch("/api/alerts?limit=120", { cache: "no-store" }));
      setDashboard(packet);
      setSettings(packet.settings);
      const latestPositionTime = packet.openTrades.reduce((latest, trade) => Math.max(latest, trade.lastEvaluatedAt), 0);
      if (latestPositionTime > 0) setDashboardUpdatedAt(latestPositionTime);
    } catch {
      // 首次部署迁移或数据源短暂失败时，主行情仍可继续工作。
    }
  }, []);

  const runDeepScan = useCallback(async (manual = false) => {
    if (!canManage) {
      if (manual) setScanMessage("当前账户为只读模式，深度扫描由系统统一运行");
      return;
    }
    if (deepScanRunning.current) return;
    deepScanRunning.current = true;
    setScanState("running");
    setScanMessage(manual ? "正在复核核心币与异动币…" : "前台监测正在刷新…");
    try {
      const result = await responseJson<{ analyzed: LivePacket[]; notifications: { attempted: number; delivered: number }; status: string }>(await fetch("/api/scan/run", { method: "POST", headers: { "Content-Type": "application/json" } }));
      const selected = result.analyzed?.find((item) => item.symbol === selectedSymbol);
      if (selected) setLivePacket(selected);
      const delivered = result.notifications?.delivered ?? 0;
      setScanMessage(`已深度复核 ${result.analyzed?.length ?? 0} 个标的${delivered ? `，送达 ${delivered} 条推送` : ""}`);
      setScanState("done");
      await Promise.all([loadScanner(), loadDashboard()]);
    } catch (error) {
      setScanState("error");
      setScanMessage(error instanceof Error ? error.message : "深度扫描失败");
    } finally {
      deepScanRunning.current = false;
    }
  }, [canManage, loadDashboard, loadScanner, selectedSymbol]);

  const refreshPositions = useCallback(async () => {
    if (positionRefreshRunning.current || document.hidden) return;
    positionRefreshRunning.current = true;
    setPositionRefreshState("running");
    try {
      const packet = await responseJson<{ observedAt: number; refreshed: number; failures: { symbol: string; error: string }[]; dashboard: Dashboard }>(await fetch("/api/positions/refresh", { method: "POST", headers: { "Content-Type": "application/json" } }));
      setDashboard(packet.dashboard);
      setSettings(packet.dashboard.settings);
      setDashboardUpdatedAt(packet.observedAt);
      setPositionRefreshState("live");
      setPositionRefreshMessage(packet.refreshed ? `已重估 ${packet.refreshed} 张持仓` : "当前无持仓，账户记录已同步");
    } catch (error) {
      setPositionRefreshState("error");
      setPositionRefreshMessage(error instanceof Error ? error.message : "Gate 持仓报价失败");
    } finally {
      positionRefreshRunning.current = false;
    }
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(async (registration) => {
        const subscription = await registration.pushManager.getSubscription();
        setPushSubscribed(Boolean(subscription));
        setNotice(subscription ? "通知已开启，可随时关闭" : "通知已关闭");
      }).catch(() => undefined);
    }
    const initialDashboard = window.setTimeout(() => void loadDashboard(), 0);
    const initialBackground = window.setTimeout(() => void loadBackground(), 0);
    const initialAccount = window.setTimeout(() => void loadAccount(), 0);
    return () => {
      window.clearTimeout(initialDashboard);
      window.clearTimeout(initialBackground);
      window.clearTimeout(initialAccount);
    };
  }, [loadAccount, loadBackground, loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void loadBackground(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadBackground]);

  useEffect(() => {
    if (!background?.active) return;
    const initial = window.setTimeout(() => void loadDashboard(), 500);
    const timer = window.setInterval(() => { if (!document.hidden) void loadDashboard(); }, 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [background?.active, loadDashboard]);

  useEffect(() => {
    let active = true;
    async function loadLive() {
      try {
        const packet = await responseJson<LivePacket>(await fetch(`/api/market?symbol=${encodeURIComponent(selectedSymbol)}`, { cache: "no-store" }));
        if (active) setLivePacket(packet);
      } catch (error) {
        if (active) setLivePacket({ mode: "degraded", observedAt: Date.now(), symbol: selectedSymbol, error: error instanceof Error ? error.message : "Gate 实时数据不可用" });
      }
    }
    void loadLive();
    const timer = window.setInterval(() => { if (!document.hidden) void loadLive(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedSymbol]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadScanner(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void loadScanner(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadScanner]);

  useEffect(() => {
    if (!background || background.active || settings?.scanEnabled === false) return;
    const initial = window.setTimeout(() => void refreshPositions(), 500);
    const timer = window.setInterval(() => { if (!document.hidden) void refreshPositions(); }, 10_000);
    const onVisibility = () => { if (!document.hidden) void refreshPositions(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [background, refreshPositions, settings?.scanEnabled]);

  useEffect(() => {
    if (!background || background.active || !settings?.scanEnabled || !canManage) return;
    let initial: number | undefined;
    if (!startedForegroundScan.current) {
      startedForegroundScan.current = true;
      initial = window.setTimeout(() => { if (!document.hidden) void runDeepScan(false); }, 3_000);
    }
    const timer = window.setInterval(() => { if (!document.hidden) void runDeepScan(false); }, 60_000);
    return () => { if (initial) window.clearTimeout(initial); window.clearInterval(timer); };
  }, [background, canManage, runDeepScan, settings?.scanEnabled]);

  const selectedPacket = livePacket?.symbol === selectedSymbol ? livePacket : null;
  const decision = selectedPacket?.decision ?? null;
  const market = selectedPacket?.market;
  const metric = (key: string) => decision?.metrics.find((item) => item.key === key);
  const context = scanner?.context;
  const openTrades = useMemo(() => dashboard?.openTrades ?? scanner?.openTrades ?? [], [dashboard?.openTrades, scanner?.openTrades]);
  const activeTrade = selectedPacket?.openTrade ?? openTrades.find((trade) => trade.symbol === selectedSymbol) ?? null;
  const openSymbols = useMemo(() => new Set(openTrades.map((trade) => trade.symbol)), [openTrades]);
  const universe = useMemo(() => (scanner?.universe ?? []).map((item) => {
    if (item.symbol !== selectedPacket?.symbol || !decision || !market) return item;
    return { ...item, price: market.futuresPrice, changePercentage: market.changePercentage ?? item.changePercentage, confidence: decision.confidence, state: decision.state, stateLabel: decision.stateLabel, side: decision.side };
  }), [decision, market, scanner?.universe, selectedPacket?.symbol]);
  const filtered = filter === "all" ? universe : filter === "holding" ? universe.filter((item) => openSymbols.has(item.symbol)) : universe.filter((item) => !openSymbols.has(item.symbol) && item.state === filter);
  const stateCounts = (state: FilterState) => state === "all" ? universe.length : state === "holding" ? universe.filter((item) => openSymbols.has(item.symbol)).length : universe.filter((item) => !openSymbols.has(item.symbol) && item.state === state).length;
  const focusedTrade = dashboard?.trades.find((trade) => trade.id === selectedTradeId) ?? dashboard?.openTrades[0] ?? dashboard?.trades[0] ?? null;
  const focusedMemory = focusedTrade ? dashboard?.memories.find((memory) => memory.symbol === focusedTrade.symbol && memory.side === focusedTrade.side) : null;

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings || saving || !canManage) return;
    setSaving(true);
    const optimistic = { ...settings, ...patch };
    setSettings(optimistic);
    try {
      const saved = await responseJson<Settings>(await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }));
      setSettings(saved);
      setScanMessage("设置已保存，下次扫描立即生效");
    } catch (error) {
      setSettings(settings);
      setScanMessage(error instanceof Error ? error.message : "设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
      setNotice("iPhone 请用 Safari 添加到主屏幕后再开启");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("通知权限未允许");
      const registration = await navigator.serviceWorker.ready;
      const key = await responseJson<{ publicKey: string }>(await fetch("/api/push/key"));
      const current = await registration.pushManager.getSubscription();
      const subscription = current ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key.publicKey) });
      await responseJson(await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription.toJSON()) }));
      setPushSubscribed(true);
      setNotice("通知已开启，可随时关闭");
      if (settings) setSettings({ ...settings, pushEnabled: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "推送订阅失败");
    }
  }

  async function disablePush() {
    if (!("serviceWorker" in navigator)) {
      setPushSubscribed(false);
      setNotice("通知已关闭");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await responseJson(await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }));
        await subscription.unsubscribe();
      }
      setPushSubscribed(false);
      setNotice("通知已关闭，点一下可重新开启");
      if (settings) setSettings({ ...settings, pushEnabled: false });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "关闭通知失败");
    }
  }

  async function togglePush() {
    if (pushSubscribed) await disablePush();
    else await enablePush();
  }

  async function signOut() {
    if (!account?.signOutPath) return;
    try {
      if (pushSubscribed) await disablePush();
    } finally {
      window.location.assign(account.signOutPath);
    }
  }

  async function testPush() {
    try {
      const result = await responseJson<{ attempted: number; delivered: number }>(await fetch("/api/push/test", { method: "POST" }));
      setNotice(result.delivered ? "测试推送已送达" : `已尝试 ${result.attempted} 个订阅，未确认送达`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "测试推送失败");
    }
  }

  const sourceRows = context ? [
    ["价格 / 多周期", "Gate 5m·15m·1h·4h", "live"],
    ["现货 CVD / 订单簿", "Gate spot + depth", "live"],
    ["OI / 资金费率 / 基差", "Gate derivatives", "live"],
    ["清算方向", "Gate liquidations", "live"],
    ["期权隐含波动率", "Deribit DVOL", context.sources.deribitDvol],
    ["宏观事件", "BLS + Federal Reserve", context.sources.blsCalendar === "live" ? "live" : "degraded"],
    ["ETF 净流", "尚未配置可靠实时源", "not-configured"],
  ] : [];

  return <>
    <main className="app-shell">
    <header className="topbar">
      <div className="brand-lockup"><div className="brand-mark"><Icon name="radar" size={20}/></div><div><strong>Market Sentinel</strong><span>全市场行情哨兵</span></div></div>
      <div className="topbar-actions"><button className="account-chip" onClick={() => setTab("设置")} aria-label="打开账户设置"><i>{(account?.displayName ?? account?.email ?? "账").slice(0, 1).toUpperCase()}</i><span><b>{account?.displayName ?? "邮箱账户"}</b><small>{account?.email ?? "正在读取账户"}</small></span></button><button className={`icon-button push-toggle ${pushSubscribed ? "push-on" : ""}`} onClick={() => void togglePush()} aria-label={pushSubscribed ? "关闭行情推送" : "开启行情推送"} aria-pressed={pushSubscribed}><Icon name="bell"/><i/></button></div>
    </header>

    <section className={`replay-banner ${decision ? "live" : selectedPacket?.mode === "degraded" ? "degraded" : "loading"}`} aria-label="数据状态">
      <span><i/>{decision ? "Gate 实时" : selectedPacket?.mode === "degraded" ? "数据降级" : "连接中"}</span>
      <p>{decision ? `15 秒更新 · 深度 ${Math.round(decision.dataQuality * 100)}% · ${formatTime(selectedPacket?.observedAt)}` : (selectedPacket?.error ?? sourceError) || "正在读取全市场行情"}</p>
      <b>无交易权限</b>
    </section>

    {tab === "机会" && <>
      <section className="market-status">
        <div><span className="eyebrow">全局风险与市场状态</span><strong>{decision?.regime ?? "等待实时结构"}</strong></div>
        <div className="status-score"><span>宏观风险</span><strong className={(context?.macroEventRisk ?? 0) >= .7 ? "danger" : ""}>{Math.round((context?.macroEventRisk ?? 0) * 100)}<small>/100</small></strong></div>
        <div className="status-grid">
          <div><span>多周期</span><b className={(metric("multi-timeframe")?.score ?? 0) >= 0 ? "good" : "warn"}>{metric("multi-timeframe")?.detail ? `${Math.round((metric("multi-timeframe")?.score ?? 0) * 100)}` : "--"}</b></div>
          <div><span>Spot CVD</span><b className={(metric("spot-flow")?.score ?? 0) >= 0 ? "good" : "warn"}>{market?.spotCvdRatio == null ? "--" : displayPct(market.spotCvdRatio * 100, 1)}</b></div>
          <div><span>BTC/ETH IV</span><b className={(context?.optionsIvPercentile ?? 0) > .8 ? "warn" : ""}>{context?.optionsIvPercentile == null ? "--" : `${Math.round(context.optionsIvPercentile * 100)}分位`}</b></div>
          <div><span>贝叶斯多头</span><b>{decision ? `${Math.round(decision.posteriorLong * 100)}%` : "--"}</b></div>
        </div>
      </section>

      {activeTrade ? <TradeDetail trade={activeTrade}/> : decision && market ? <section className={`decision-card ${decision.state}`}>
        <div className="decision-head"><div><div className="ticker-line"><strong>{selectedSymbol.replace("_", "")}</strong><span className={`state-pill ${decision.state}`}>{decision.stateLabel}</span></div><p>Gate USDT 永续 · 深度复核 · {formatTime(selectedPacket?.observedAt)}</p></div><div className="confidence"><span>可信度</span><strong>{decision.confidence}</strong><small>%</small></div></div>
        <div className="price-row"><div><span>实时价格</span><strong>{displayPrice(market.futuresPrice)}</strong><em>{displayPct(market.changePercentage)}</em></div><ScoreBars decision={decision}/></div>
        <div className="action-callout"><span className="action-icon"><Icon name={decision.state === "confirmed" ? "check" : decision.state === "blocked" ? "x" : "clock"}/></span><div><span>当前结论 · {decision.side}</span><strong>{decision.action}</strong><p>{decision.thesis}</p></div></div>
        <div className="entry-grid"><div><span>参考区间</span><strong>{decision.entryZone ? `${displayPrice(decision.entryZone[0])}–${displayPrice(decision.entryZone[1])}` : "当前不提供"}</strong></div><div><span>预警有效期</span><strong>{decision.expiresMinutes} 分钟</strong></div></div>
        <div className="trigger-row"><Icon name="target"/><div><span>{decision.state === "confirmed" ? "确认依据" : "仍缺少的进场条件"}</span><strong>{decision.trigger}</strong></div></div>
        {decision.entryPlan && <EntryPlanDetail plan={decision.entryPlan}/>}
        <div className="evidence-section"><div className="section-title"><span>为什么</span><small>{decision.evidence.length} 项支持证据</small></div>{decision.evidence.length ? decision.evidence.map((item) => <div className="evidence-row" key={item.title}><div className="evidence-check"><Icon name="check" size={13}/></div><div><strong>{item.title}</strong><p>{item.detail}</p></div><span className="evidence-score">{item.score}</span></div>) : <p className="empty-note">当前没有形成足够同向证据。</p>}</div>
        <div className="counter-section"><div className="section-title"><span>反证与风险</span><small>强制展示，不只挑好数据</small></div>{decision.counterEvidence.map((item) => <div className="counter-row" key={item.title}><Icon name="alert" size={15}/><div><strong>{item.title}</strong><p>{item.detail}</p></div></div>)}</div>
        <div className="section-title"><span>全部分析维度</span><small>缺失数据明确标 N/A</small></div><div className="analysis-matrix">{decision.metrics.map((item) => <div className={!item.available ? "muted" : item.score * (decision.side === "SHORT" ? -1 : 1) >= 0 ? "support" : "oppose"} key={item.key}><span>{item.label}</span><b>{item.available ? `${item.score >= 0 ? "+" : ""}${item.score.toFixed(2)}` : "N/A"}</b><p>{item.detail}</p></div>)}</div>
        <div className="invalid-box"><Icon name="shield"/><div><span>明确失效条件</span><strong>{decision.invalidation}</strong></div></div>
        <p className="risk-note">只有全部进场检查通过，深度扫描才会创建一张系统跟踪订单；随后显示“持仓中”，直到命中一条出场规则。系统不自动下单。</p>
      </section> : <section className="decision-card observing loading-card"><div className="utility-heading"><Icon name="radar"/><div><span className="eyebrow">深度分析</span><strong>{selectedPacket?.error ?? "正在合并实时证据…"}</strong></div></div><p>没有实时决策时不会用演示数据冒充信号。</p></section>}

      <section className="opportunity-section">
        <div className="section-head"><div><span className="eyebrow">Gate 成交额前 {settings?.universeLimit ?? 30} + 核心币</span><strong>全市场机会队列</strong><small>{scanMessage}</small></div><button className={scanState === "running" ? "spinning" : ""} onClick={() => void runDeepScan(true)} disabled={scanState === "running" || !canManage} aria-label="立即全量扫描" title={canManage ? "立即全量扫描" : "只读账户由系统统一扫描"}><Icon name="refresh" size={17}/></button></div>
        <div className="filter-row">{(["all", "holding", "pre_alert", "observing", "blocked"] as FilterState[]).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部" : STATE_META[item].short} <span>{stateCounts(item)}</span></button>)}</div>
        <div className="stage-guide"><span className="observing">1 观察</span><i/><span className="pre_alert">2 条件预警</span><i/><span className="holding">3 确认并持仓</span><i/><span className="closed">4 平仓复盘</span></div>
        <div className="opportunity-list">{filtered.length ? filtered.map((item) => { const holding = openSymbols.has(item.symbol); const position = openTrades.find((trade) => trade.symbol === item.symbol); return <button key={item.symbol} className={`opportunity-row ${selectedSymbol === item.symbol ? "selected" : ""}`} onClick={() => { setSelectedSymbol(item.symbol); window.history.replaceState(null, "", `?symbol=${encodeURIComponent(item.symbol)}`); window.scrollTo({ top: 84, behavior: "smooth" }); }}><span className={`signal-dot ${holding ? "holding" : item.state}`}/><div><strong>{item.symbol.replace("_", "")}</strong><span>{holding ? `持仓中 · ${position?.side} · ${position ? `${position.progressR.toFixed(2)}R` : "等待评估"}` : `${item.stateLabel} · ${item.side}`} · 量 {displayVolume(item.volumeUsd)}</span></div><div className="mini-price"><strong>{displayPrice(item.price)}</strong><span className={holding ? (position?.unrealizedGrossPct ?? 0) < 0 ? "negative" : "good" : item.changePercentage < 0 ? "negative" : ""}>{holding ? displayPct(position?.unrealizedGrossPct) : displayPct(item.changePercentage)}</span></div><div className="mini-confidence"><small>{holding ? "持仓" : item.state === "pre_alert" ? "初筛" : "可信度"}</small><strong>{holding ? "锁" : item.confidence}</strong></div></button>; }) : <p className="empty-note">暂时没有可用的全市场行情；系统不会填充虚假机会。</p>}</div>
      </section>
    </>}

    {tab === "雷达" && <section className="utility-card">
      <div className="utility-heading"><Icon name="radar" size={21}/><div><span className="eyebrow">数据雷达</span><strong>方向、杠杆、波动、事件同时看</strong></div></div>
      <div className="radar-health"><div><span>深度数据完整度</span><strong>{decision ? `${Math.round(decision.dataQuality * 100)}%` : "--"}</strong></div><div><span>当前事件风险</span><strong className={(context?.macroEventRisk ?? 0) >= .7 ? "danger" : "warn"}>{context ? `${Math.round((context.macroEventRisk ?? 0) * 100)}/100` : "--"}</strong></div></div>
      <div className="data-table">{sourceRows.map(([name, coverage, state]) => <div className="data-row" key={name}><div><strong>{name}</strong><span>{coverage}</span></div><span className={state === "live" ? "good" : state === "not-configured" ? "muted" : "warn"}>{state === "live" ? "实时" : state === "not-configured" ? "未接入" : "降级"}</span><small>{state === "live" ? "正常" : "不评分"}</small></div>)}</div>
      <div className="section-title event-title"><span>接下来高影响事件</span><small>{context?.macroEventLabel ? "临近时自动拦截" : "官方日历"}</small></div>
      <div className="event-list">{context?.nextEvents?.slice(0, 5).map((event) => <div className="event-row" key={`${event.time}-${event.title}`}><div><strong>{event.title}</strong><span>{event.source} · {formatDateTime(event.time)}</span></div><b>{relativeEvent(event.time)}</b></div>) ?? <p className="empty-note">事件日历加载中。</p>}</div>
      <div className="invalid-box muted"><Icon name="shield"/><div><span>降级规则</span><strong>关键源缺失或过期、资金费率拥挤、极端波动或高影响事件临近时，硬性停止确认信号。</strong></div></div>
    </section>}

    {tab === "订单" && <section className="utility-card order-ledger">
      <div className="utility-heading"><Icon name="log" size={21}/><div><span className="eyebrow">1000U 模拟合约账户</span><strong>确认 → 持仓 → 平仓 → 复盘学习</strong><small className={positionRefreshState === "error" ? "danger" : ""}>{settings?.scanEnabled === false ? "监测已暂停，持仓价格不会刷新" : positionRefreshState === "error" ? `实时重估失败 · ${positionRefreshMessage}` : `${background?.active ? "免费后台" : "网页前台"}每 10 秒按 Gate 重估 · 最近 ${formatTime(dashboardUpdatedAt)} · ${positionRefreshMessage}`}</small></div></div>
      {(dashboard?.archivedCount ?? 0) > 0 && <div className="invalid-box muted"><Icon name="shield"/><div><span>旧版记录已隔离</span><strong>{dashboard?.archivedCount} 条旧观察记录不再显示为合约订单，不计入持仓、盈亏、胜率或策略学习，也没有事后补算杠杆。</strong></div></div>}
      <div className="account-summary">
        <div><span>账户权益</span><strong className={(dashboard?.account.equityUsdt ?? 1000) >= 1000 ? "good" : "danger"}>{dashboard?.account.equityUsdt.toFixed(2) ?? "1000.00"}U</strong><small>初始 {dashboard?.account.startingCapitalUsdt.toFixed(0) ?? "1000"}U</small></div>
        <div><span>已实现盈亏</span><strong className={(dashboard?.account.realizedPnlUsdt ?? 0) >= 0 ? "good" : "danger"}>{displayUsdt(dashboard?.account.realizedPnlUsdt)}</strong><small>余额 {dashboard?.account.realizedBalanceUsdt.toFixed(2) ?? "--"}U</small></div>
        <div><span>浮动净盈亏</span><strong className={(dashboard?.account.unrealizedPnlUsdt ?? 0) >= 0 ? "good" : "danger"}>{displayUsdt(dashboard?.account.unrealizedPnlUsdt)}</strong><small>占用保证金 {dashboard?.account.usedMarginUsdt.toFixed(2) ?? "--"}U</small></div>
        <div><span>可用保证金</span><strong>{dashboard?.account.availableMarginUsdt.toFixed(2) ?? "--"}U</strong><small>逐仓模拟，不接交易所</small></div>
      </div>
      <div className="calibration-grid"><div><span>持仓中</span><strong>{dashboard?.stats.open ?? 0}</strong></div><div><span>已完成</span><strong>{dashboard?.stats.closed ?? 0}</strong></div><div><span>净胜率</span><strong>{dashboard?.stats.winRate == null ? "--" : `${dashboard.stats.winRate.toFixed(1)}%`}</strong></div></div>
      <div className="metric-strip"><div><span>累计净盈亏</span><b>{displayUsdt(dashboard?.stats.totalNetPnlUsdt)}</b></div><div><span>平均净变动</span><b>{displayPct(dashboard?.stats.averageNetPct)}</b></div><div><span>平均持仓</span><b>{dashboard?.stats.averageHoldMinutes == null ? "--" : `${dashboard.stats.averageHoldMinutes.toFixed(0)}m`}</b></div><div><span>止盈 / 止损</span><b>{dashboard?.stats.targetExits ?? 0} / {dashboard?.stats.stopExits ?? 0}</b></div></div>
      <div className="section-title"><span>持仓订单</span><small>同币活动订单上限 = 1</small></div>
      <div className="order-list">{dashboard?.openTrades.length ? dashboard.openTrades.map((trade) => <button className={`order-row ${focusedTrade?.id === trade.id ? "selected" : ""}`} key={trade.id} onClick={() => setSelectedTradeId(trade.id)}><span className="signal-dot holding"/><div><strong>{trade.symbol.replace("_", "")} · {trade.side} · {trade.leverage}x</strong><span>保证金 {trade.marginUsdt.toFixed(2)}U · 名义 {trade.contractNotionalUsdt.toFixed(2)}U</span></div><div><b className={trade.unrealizedNetUsdt >= 0 ? "good" : "danger"}>{displayUsdt(trade.unrealizedNetUsdt)}</b><small>{displayPct(trade.unrealizedNetPct)} · {formatTime(trade.lastEvaluatedAt)}</small></div></button>) : <p className="empty-note">当前没有系统跟踪持仓；只有全部进场条件通过才会创建。</p>}</div>
      <div className="section-title"><span>已平仓订单</span><small>每单都保留进出场证据</small></div>
      <div className="order-list closed-orders">{dashboard?.trades.filter((trade) => trade.status === "closed").map((trade) => <button className={`order-row ${focusedTrade?.id === trade.id ? "selected" : ""}`} key={trade.id} onClick={() => setSelectedTradeId(trade.id)}><span className="signal-dot closed"/><div><strong>{trade.symbol.replace("_", "")} · {trade.side} · {trade.leverage}x</strong><span>{trade.exitReason ?? trade.exitCode ?? "规则退出"}</span></div><div><b className={(trade.netPnlUsdt ?? 0) >= 0 ? "good" : "danger"}>{displayUsdt(trade.netPnlUsdt)}</b><small>{displayPct(trade.netMovePct)} · {formatDateTime(trade.exitAt ?? trade.entryAt)}</small></div></button>)}</div>
      {focusedTrade ? <><div className="section-title selected-order-title"><span>订单详情</span><small>ID {focusedTrade.id.slice(0, 8)}</small></div><TradeDetail trade={focusedTrade}/>{focusedMemory && <div className="memory-card"><div className="section-title"><span>{focusedMemory.symbol.replace("_", "")} {focusedMemory.side} 策略记忆</span><small>下一次评分会读取</small></div><div className="memory-grid"><div><span>完成样本</span><strong>{focusedMemory.sampleCount}</strong></div><div><span>贝叶斯胜率</span><strong>{(focusedMemory.bayesianWinRate * 100).toFixed(1)}%</strong></div><div><span>平均净结果</span><strong>{displayPct(focusedMemory.averageNetPct)}</strong></div><div><span>止损率</span><strong>{(focusedMemory.stopRate * 100).toFixed(1)}%</strong></div></div></div>}</> : <p className="empty-note">还没有完整订单。预警记录不会被伪装成订单。</p>}
      {dashboard?.stats.uncalibrated && <div className="invalid-box muted"><Icon name="alert"/><div><span>尚未校准</span><strong>需要至少 50 个完整平仓样本才能评价置信度；现在不展示虚假的“高胜率”。</strong></div></div>}
      <div className="section-title calibration-title"><span>置信度校准桶</span><small>预测 vs 实际正收益</small></div>
      <div className="calibration-list">{dashboard?.stats.calibration.map((bucket) => <div key={bucket.range}><span>{bucket.range}%</span><i><b style={{ width: `${bucket.realized ?? 0}%` }}/></i><strong>{bucket.count ? `${bucket.realized?.toFixed(0)}% / n=${bucket.count}` : "无样本"}</strong></div>)}</div>
    </section>}

    {tab === "设置" && <section className="utility-card">
      <div className="utility-heading"><Icon name="settings" size={21}/><div><span className="eyebrow">监测与风险边界</span><strong>{settings?.trialCapitalUsdt ?? 1000}U 模拟合约账户 · 不自动交易</strong></div></div>
      <div className="account-panel"><div className="account-avatar">{(account?.displayName ?? account?.email ?? "账").slice(0, 1).toUpperCase()}</div><div><span>当前邮箱账户 · {account?.role === "owner" ? "所有者" : "只读成员"}</span><strong>{account?.displayName ?? "账户加载中"}</strong><small>{account?.email ?? "--"}</small></div>{account?.signOutPath && <button className="sign-out-button" onClick={() => void signOut()}>退出登录</button>}</div>
      {!canManage && <div className="account-readonly"><Icon name="shield" size={15}/><span>此账户可查看实时行情、订单记录并单独管理自己的推送；系统量化参数只有所有者可以修改。</span></div>}
      <div className="setting-group"><span>提醒风格</span><div className="segmented">{(["early", "balanced", "confirmed"] as AlertStyle[]).map((style) => <button key={style} disabled={!canManage} className={settings?.alertStyle === style ? "active" : ""} onClick={() => void saveSettings({ alertStyle: style })}>{STYLE_META[style].label}</button>)}</div><p>{STYLE_META[settings?.alertStyle ?? "balanced"].note}</p></div>
      <div className="setting-row"><div><strong>Gate 全市场监测</strong><span>{background?.active ? `每分钟初筛成交额前 ${settings?.universeLimit ?? 30}；每批深度复核 ${background.deepBatchSize ?? 3} 个持仓、异动与轮换标的` : `成交额前 ${settings?.universeLimit ?? 30} 初筛；核心与异动前 ${settings?.deepScanLimit ?? 8} 深度复核`}</span></div><button disabled={!canManage} className={`switch ${settings?.scanEnabled ? "on" : ""}`} onClick={() => void saveSettings({ scanEnabled: !settings?.scanEnabled })} aria-label="切换全市场监测"><i/></button></div>
      <div className="setting-row"><div><strong>发出确认的最低可信度</strong><span>低于阈值只记录、不推送</span></div><label className="number-control"><input disabled={!canManage} type="number" min="55" max="90" value={settings?.minConfidence ?? 72} onChange={(event) => setSettings(settings ? { ...settings, minConfidence: Number(event.target.value) } : settings)} onBlur={(event) => void saveSettings({ minConfidence: Number(event.target.value) })}/><b>%</b></label></div>
      <div className="setting-row"><div><strong>单次最大计划亏损</strong><span>上限 10U = 初始本金 1%；先定风险，再计算杠杆与仓位</span></div><label className="number-control"><input disabled={!canManage} type="number" min="1" max="10" step="1" value={settings?.maxRiskPerAlertUsdt ?? 10} onChange={(event) => setSettings(settings ? { ...settings, maxRiskPerAlertUsdt: Number(event.target.value) } : settings)} onBlur={(event) => void saveSettings({ maxRiskPerAlertUsdt: Number(event.target.value) })}/><b>U</b></label></div>
      <div className="setting-row"><div><strong>日内暂停 / 最大回撤</strong><span>触及阈值后应停止人工试验，不继续加杠杆翻本</span></div><b>{settings?.dailyPauseUsdt ?? 30}U / {settings?.maxDrawdownUsdt ?? 100}U</b></div>
      <div className="setting-row"><div><strong>往返成本假设</strong><span>统计净结果时强制扣除手续费与滑点</span></div><b>{settings?.roundTripCostBps ?? 8} bps</b></div>
      <div className="setting-row"><div><strong>iPhone Web Push</strong><span>{notice}</span></div><button className={`text-button ${pushSubscribed ? "danger-button" : ""}`} onClick={() => void togglePush()}>{pushSubscribed ? "关闭通知" : "开启通知"}</button></div>
      <div className="setting-row"><div><strong>测试推送链路</strong><span>确认手机能收到服务端通知</span></div><button className="text-button" onClick={testPush}>测试</button></div>
      <div className="invalid-box muted"><Icon name="shield"/><div><span>权限边界</span><strong>只读公开行情，不请求 Gate API Key，不读取资产，不自动下单；高返佣不会被计入交易优势，也不会为了返佣增加交易次数。</strong></div></div>
      <p className="risk-note">{background?.active ? "免费后台已连接：即使关闭网页，持仓仍每 10 秒按 Gate 报价重估，全市场每分钟初筛并分批深度复核；符合进场、止盈、止损或平仓条件时由服务器发送推送。iPhone 仍需用 Safari 添加到主屏幕后开启通知。" : "iPhone 需要 Safari“添加到主屏幕”后开启通知。网页可见时：持仓每 10 秒按 Gate 报价重估，市场每 60 秒深度复核。关闭网页后，当前部署不会继续扫描；推送只能接收服务端已经产生的事件，不能自行启动扫描。"}</p>
    </section>}

    </main>
    <nav className="bottom-nav" aria-label="主导航">{(["机会", "雷达", "订单", "设置"] as Tab[]).map((item) => <button className={tab === item ? "active" : ""} onClick={() => { setTab(item); window.scrollTo({ top: 0, behavior: "smooth" }); }} key={item}><Icon name={{ 机会: "eye", 雷达: "radar", 订单: "log", 设置: "settings" }[item]}/><span>{item}</span></button>)}</nav>
  </>;
}
