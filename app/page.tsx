"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HTE31_TRADER_DEFINITIONS,
  hte31AssetRegimeLabel,
  hte31CanonicalStrategyLabel,
} from "../lib/hte31-strategy-catalog";

type Tab = "机会" | "雷达" | "订单" | "实盘" | "设置";
type TraderId = "dennis_trend" | "raschke_pullback" | "turtle_soup" | "exhaustion_reversal" | "higher_timeframe_swing" | "dennis_trend_v2" | "raschke_pullback_v2" | "turtle_soup_v2" | "higher_timeframe_swing_v2" | "range_rotation" | "compression_expansion" | "relative_strength" | "momentum_continuation";
type Side = "LONG" | "SHORT" | "WAIT";

type TradeFinalVerdict = {
  final: boolean;
  code: string;
  label: string;
  shouldTrade: boolean | null;
  explanation: string;
  profitPath: string;
  recommendedAction: string;
};

type SchedulerStatus = {
  state: string;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  phase?: string | null;
  phaseAttempt?: number;
  circuitOpen?: boolean;
  retryAfter?: number | null;
};

type MarketView = {
  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  environment: string;
  headline: string;
  reason: string;
  strongDirection: boolean;
};

type Trade = {
  id: string;
  symbol: string;
  status: "holding" | "closed";
  traderId: TraderId | "direct_market_brain";
  decisionAuthority?: string;
  brainVersion?: string | null;
  side: "LONG" | "SHORT";
  assetRegime: string;
  entryAt: number;
  entryPrice: number;
  initialStopPrice: number;
  currentStopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  target1HitAt: number | null;
  riskBudgetUsdt: number;
  notionalUsdt: number;
  marginUsdt: number;
  leverage: number;
  entryThesis: string;
  lastPrice: number;
  unrealizedNetUsdt: number;
  progressR: number;
  exitAt: number | null;
  exitPrice: number | null;
  exitCode: string | null;
  exitReason: string | null;
  netPnlUsdt: number | null;
  mfePct: number | null;
  maePct: number | null;
  postExitLabel: string | null;
  exitEfficiency: number | null;
  entryMetricsJson: string;
};

type PositionDecisionView = {
  action: "HOLD" | "PROTECT" | "EXIT";
  reason: string;
};

function latestPositionDecision(trade: Trade): PositionDecisionView | null {
  try {
    const metrics = JSON.parse(trade.entryMetricsJson) as { key?: string; detail?: string }[];
    const row = metrics.find((item) => item.key === "direct-position-decision");
    if (!row?.detail) return null;
    const decision = JSON.parse(row.detail) as PositionDecisionView;
    return ["HOLD", "PROTECT", "EXIT"].includes(decision.action) && decision.reason ? decision : null;
  } catch {
    return null;
  }
}


type Dashboard = {
  account: {
    startingCapitalUsdt: number;
    epochStartedAt: number;
    realizedPnlUsdt: number;
    unrealizedPnlUsdt: number;
    equityUsdt: number;
    usedMarginUsdt: number;
    availableMarginUsdt: number;
  };
  openTrades: Trade[];
  closedTrades: Trade[];
  archivedTrades: Trade[];
  archiveCount: number;
  paperReset: {
    status: "pending" | "completed";
    requestedCapitalUsdt: number | null;
    requestedAt: number | null;
    completedAt: number | null;
    openPositions: number;
  };
  directRisk?: { state: string; riskRate: number; sampleCount: number; profitFactor: number | null; expectancyR: number; drawdownR: number; reason: string };
  stats: { sampleCount: number; wins: number; scratches: number; losses: number; profitFactor: number | null; totalNetPnlUsdt: number };
  settings: { scanEnabled: boolean; coreSymbols: string[]; universeLimit: number; trialCapitalUsdt: number; roundTripCostBps: number };
};

type Snapshot = {
  requestedAt: number;
  observedAt: number;
  account: { role: string };
  scanner: {
    status: SchedulerStatus | null;
    ageMs: number | null;
    readModel: {
      target?: string;
      marketView?: MarketView;
      openReason?: string;
      directCandidate?: DirectCandidate;
      directRadar?: DirectRadarItem[];
    } | null;
  };
  position: { status: SchedulerStatus | null };
  market: {
    label: string;
    bias: "LONG" | "SHORT" | "NEUTRAL";
    confidence: number;
    stability: number;
    transitionRisk: number;
    pendingLabel?: string | null;
    pendingConfirmations?: number;
    requiredConfirmations?: number;
  } | null;
  dashboard: Dashboard | null;
  staleSources?: string[];
  degraded: boolean;
  errors: Record<string, string>;
};

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Observation = {
  horizonMinutes: number;
  status: string;
  favorableR: number | null;
  adverseR: number | null;
  qualityStatus?: "PENDING" | "READY" | "STALE" | "UNAVAILABLE";
  coveragePct?: number | null;
};

type ChartData = {
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strategy: { familyId: string; familyName: string; variantId: string; variantName: string; canonicalLabel: string; tags: string[] };
  candles: Candle[];
  levels: { entry: number; initialStop: number; currentStop: number; takeProfit1: number; takeProfit2: number };
  markers: { kind: "ENTRY" | "EXIT"; time: number; price: number; label: string }[];
  postExitStartAt: number | null;
  observations: Observation[];
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
    entryQuality: {
      sampleSufficient: boolean;
      classification: string;
      classificationLabel: string;
      entryEfficiency: number | null;
      initialMaeR: number | null;
      timeToHalfRMinutes: number | null;
      timeToOneRMinutes: number | null;
      delayedEntries: {
        delayBars: 1 | 2 | 3;
        delayMinutes: number;
        valid: boolean;
        terminalR: number | null;
        improvementR: number | null;
        maxAdverseR: number | null;
        stopped: boolean | null;
      }[];
    } | null;
  };
  counterfactual: {
    summary: string;
    horizons?: { minutes: number; originalR: number; oppositeR: number }[];
    reversals?: { key: string; label: string; terminalR: number; maxFavorableR: number; maxAdverseR: number }[];
  } | null;
  finalVerdict: TradeFinalVerdict;
  upstreamError: string | null;
};

type DirectCandidate = {
  symbol: string;
  observedAt: number;
  freshness: "FRESH" | "STALE" | "UNAVAILABLE";
  scanStage: "LIGHT" | "DEEP";
  volumeRank: number;
  riskClusterId: string;
  btcCorrelation: number | null;
  location: "TOP" | "MIDDLE" | "BOTTOM" | "BREAKOUT" | "BREAKDOWN";
  paths: { up: number; down: number; rangeOrInvalid: number };
  directionalScore: number;
  netEdgeR: number;
  confidence: number;
  setup: "VOLUME_FORCE_FAILED_BREAKOUT" | "EXHAUSTION_REVERSAL" | "DENNIS_TREND_BREAKOUT";
  setupLabel: string;
  setupScore: number;
  decision: Side;
  entryZone: [number, number] | null;
  invalidationPrice: number | null;
  targets: number[];
  evidence: string[];
  counterEvidence: string[];
  checks: { key: string; label: string; passed: boolean; detail: string }[];
  maxHoldingMinutes: number;
};

type DirectRadarItem = {
  symbol: string;
  observedAt: number;
  volumeRank: number;
  volumeUsd: number;
  changePercentage: number;
  scanStage: "LIGHT" | "DEEP";
  freshness: "FRESH" | "STALE" | "UNAVAILABLE";
  candidate: DirectCandidate | null;
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
  leverage?: number | null;
  marginMode?: string | null;
  realizedPnlUsdt: number | null;
  strategyLabel?: string | null;
  strategyThesis?: string | null;
};

type LiveSnapshot = {
  observedAt?: number;
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
  credential: {
    configured: boolean;
    environment?: string;
    keyHint?: string;
    status?: string;
    lastVerifiedAt?: number | null;
    lastError?: string | null;
  };
  performanceGate?: { passed?: boolean; reason?: string | null };
  orders: LiveOrder[];
  audit?: { id: string; severity: string; message: string; createdAt: number }[];
  error?: string;
};

const NAV: Tab[] = ["机会", "雷达", "订单", "实盘", "设置"];
const MAIN_REFRESH_MS = 30_000;
const SNAPSHOT_STORAGE_KEY = "resonance:last-trustworthy-snapshot:v1";

function fmtMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 2)}`;
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return `$${value.toFixed(digits)}`;
}

function fmtTime(value: number | null | undefined) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function fmtR(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}%`;
}

function horizonLabel(minutes: number) {
  if (minutes === 0) return "出场";
  if (minutes < 60) return `${minutes}m`;
  return `${minutes / 60}h`;
}

function biasText(value: "LONG" | "SHORT" | "NEUTRAL") {
  return value === "LONG" ? "偏多" : value === "SHORT" ? "偏空" : "分歧";
}

function sideText(value: Side) {
  return value === "LONG" ? "做多" : value === "SHORT" ? "做空" : "等待";
}

const OPERATOR_TEXT_REPLACEMENTS = ([
  ...HTE31_TRADER_DEFINITIONS.map((item): [string, string] => [item.id, hte31CanonicalStrategyLabel(item.id)]),
  ["trend_breakout_challenger", "SF01 趋势突破 / 接受回踩 [HT1-R]"],
  ["trend_pullback_challenger", "SF02 趋势回踩 / 自适应深度 [HT2-R]"],
  ["failed_breakout_challenger", "SF03 失败突破 / 力度确认 [HT3-R]"],
  ["higher_timeframe_swing_challenger", "SF05 大周期波段 / 环境上下文 [HT5-R]"],
  ["trend_exhaustion_reversal", "SF04 衰竭反转 / 基础 [HT4]"],
  ["trend_breakout", "SF01 趋势突破 / 基础 [HT1]"],
  ["trend_pullback", "SF02 趋势回踩 / 基础 [HT2]"],
  ["failed_breakout", "SF03 失败突破 / 基础 [HT3]"],
  ...["leverage_liquidation", "expansion_down", "expansion_up", "compression", "transition", "trend_down", "trend_up", "range"]
    .map((item): [string, string] => [item, hte31AssetRegimeLabel(item) ?? item]),
] satisfies [string, string][]).sort((a, b) => b[0].length - a[0].length);

function operatorText(value: string | null | undefined) {
  return OPERATOR_TEXT_REPLACEMENTS.reduce((text, [raw, label]) => text.split(raw).join(label), value ?? "");
}

function plannedTp2NetUsdt(trade: Trade, roundTripCostBps: number) {
  if (!(trade.entryPrice > 0 && trade.notionalUsdt > 0)) return null;
  const direction = trade.side === "LONG" ? 1 : -1;
  const grossMoveRate = direction * (trade.takeProfit2Price / trade.entryPrice - 1);
  const costRate = Math.max(0, roundTripCostBps) / 10_000;
  return trade.notionalUsdt * (grossMoveRate - costRate);
}

function Bias({ value, confidence }: { value: "LONG" | "SHORT" | "NEUTRAL"; confidence?: number }) {
  return <span className={`rz-bias ${value === "LONG" ? "long" : value === "SHORT" ? "short" : "neutral"}`}>{biasText(value)}{confidence != null ? ` ${confidence}%` : ""}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rz-empty"><strong>{children}</strong></div>;
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `${url} 请求失败 (${response.status})`);
  return payload;
}

function DirectRadarCard({ item, expanded }: { item: DirectRadarItem; expanded: boolean }) {
  const candidate = item.candidate;
  const side = candidate?.decision ?? "WAIT";
  return <article className={`rz-panel rz-radar ${expanded ? "rz-direct-expanded" : ""}`}>
    <div>
      <strong>#{item.volumeRank} {item.symbol.replace("_USDT", "")}</strong>
      <small>{item.scanStage === "DEEP" ? "深扫" : "轻扫"} · 24h成交额 {(item.volumeUsd / 1_000_000).toFixed(0)}M · {item.freshness}</small>
    </div>
    <Bias value={side === "WAIT" ? "NEUTRAL" : side} confidence={candidate?.confidence} />
    <div className="rz-radar-reason">
      {candidate
        ? `${candidate.setupLabel} · ${candidate.location} · 上 ${candidate.paths.up.toFixed(1)}% / 下 ${candidate.paths.down.toFixed(1)}% / 震荡或失效 ${candidate.paths.rangeOrInvalid.toFixed(1)}%`
        : `24h ${item.changePercentage >= 0 ? "+" : ""}${item.changePercentage.toFixed(2)}% · 等待深扫`}
    </div>
    {expanded && candidate && <div className="rz-signal-detail">
      <div className="rz-signal-levels">
        <div><span>核心打法</span><b>{candidate.setupLabel}</b></div>
        <div><span>打法评分</span><b>{candidate.setupScore.toFixed(0)}</b></div>
        <div><span>方向</span><b>{sideText(candidate.decision)}</b></div>
        <div><span>触发状态</span><b>{candidate.decision === "WAIT" ? "等待" : "已确认"}</b></div>
        <div><span>位置</span><b>{candidate.location}</b></div>
        <div><span>风险簇</span><b>{candidate.riskClusterId}</b></div>
        <div><span>入场区</span><b>{candidate.entryZone ? `${fmtPrice(candidate.entryZone[0])} – ${fmtPrice(candidate.entryZone[1])}` : "--"}</b></div>
        <div><span>入场价</span><b>{candidate.entryZone ? fmtPrice((candidate.entryZone[0] + candidate.entryZone[1]) / 2) : "--"}</b></div>
        <div><span>止损 / 失效价</span><b>{fmtPrice(candidate.invalidationPrice)}</b></div>
        <div><span>TP1</span><b>{fmtPrice(candidate.targets[0])}</b></div>
        <div><span>TP2</span><b>{fmtPrice(candidate.targets[1])}</b></div>
        <div><span>最长持仓</span><b>{candidate.maxHoldingMinutes} 分钟</b></div>
      </div>
      <section className="rz-signal-block"><strong>触发与硬闸门</strong><div className="rz-signal-list">{candidate.checks.map((check) => <div key={check.key}><span className={check.passed ? "pass" : "fail"}>{check.passed ? "通过" : "未通过"}</span><b>{check.label} · 必须</b><small>{check.detail}</small></div>)}</div></section>
      <div className="rz-signal-evidence-grid">
        <section className="rz-signal-block"><strong>支持证据</strong><p>{candidate.evidence.join("；")}</p></section>
        <section className="rz-signal-block"><strong>反证 / 缺失条件</strong><p>{candidate.counterEvidence.join("；") || "当前未发现硬性反证。"}</p></section>
      </div>
      <section className="rz-signal-block"><strong>失效条件</strong><p>价格触及 {fmtPrice(candidate.invalidationPrice)}，或任一必需硬闸门失效。</p></section>
    </div>}
  </article>;
}

function MiniChart({ chart }: { chart: ChartData }) {
  const candles = chart.candles.slice(-180);
  if (candles.length < 2) return <Empty>K线数据不足</Empty>;
  const width = 820;
  const height = 300;
  const pad = { left: 12, right: 54, top: 14, bottom: 16 };
  const candleMs = (candle: Candle) => candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
  const prices = candles.flatMap((candle) => [candle.high, candle.low]);
  const levels = [chart.levels.entry, chart.levels.initialStop, chart.levels.currentStop, chart.levels.takeProfit1, chart.levels.takeProfit2].filter(Number.isFinite);
  const min = Math.min(...prices, ...levels);
  const max = Math.max(...prices, ...levels);
  const span = Math.max(max - min, Math.abs(max) * .001, 1e-9);
  const x = (index: number) => pad.left + index / Math.max(1, candles.length - 1) * (width - pad.left - pad.right);
  const y = (price: number) => pad.top + (max - price) / span * (height - pad.top - pad.bottom);
  const bodyWidth = Math.max(2, Math.min(7, (width - pad.left - pad.right) / candles.length * .58));
  const exitIndex = chart.postExitStartAt == null ? -1 : candles.findIndex((candle) => candleMs(candle) >= chart.postExitStartAt!);
  const line = (price: number, label: string, cls: string) => <g className={cls} key={`${label}-${price}`}><line x1={pad.left} x2={width - pad.right} y1={y(price)} y2={y(price)} /><text x={width - pad.right + 5} y={y(price) + 4}>{label}</text></g>;
  return <>
    <svg className="rz-chart rz-chart-detailed" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="交易进场出场与退出后K线复盘">
      {exitIndex >= 0 && <rect className="post-exit-zone" x={x(exitIndex)} y={pad.top} width={Math.max(0, width - pad.right - x(exitIndex))} height={height - pad.top - pad.bottom} />}
      {candles.map((candle, index) => {
        const cx = x(index);
        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        const up = candle.close >= candle.open;
        return <g key={`${candle.time}-${index}`}>
          <line className="wick" x1={cx} x2={cx} y1={y(candle.high)} y2={y(candle.low)} />
          <rect className={up ? "up" : "down"} x={cx - bodyWidth / 2} y={top} width={bodyWidth} height={Math.max(1.5, bottom - top)} rx="1" />
        </g>;
      })}
      {line(chart.levels.entry, "ENTRY", "level-entry")}
      {line(chart.levels.initialStop, "STOP", "level-stop")}
      {line(chart.levels.takeProfit1, "TP1", "level-tp")}
      {line(chart.levels.takeProfit2, "TP2", "level-tp")}
      {chart.markers.map((marker) => {
        const index = candles.findIndex((candle) => candleMs(candle) >= marker.time);
        if (index < 0) return null;
        return <g key={`${marker.kind}-${marker.time}`} className={marker.kind === "ENTRY" ? "marker-entry" : "marker-exit"}><circle cx={x(index)} cy={y(marker.price)} r="6" /><text x={x(index) + 9} y={y(marker.price) - 8}>{marker.kind}</text></g>;
      })}
    </svg>
    <div className="rz-review-metrics">
      <div><span>Entry Efficiency</span><b>{chart.diagnosis.entryQuality?.entryEfficiency == null ? "--" : `${chart.diagnosis.entryQuality.entryEfficiency.toFixed(1)}%`}</b></div>
      <div><span>进场归因</span><b>{chart.diagnosis.entryQuality?.classificationLabel ?? "观察中"}</b></div>
      <div><span>首次 +0.5R 前 MAE</span><b>{fmtR(chart.diagnosis.entryQuality?.initialMaeR)}</b></div>
      <div><span>达到 +0.5R / +1R</span><b>{chart.diagnosis.entryQuality ? `${chart.diagnosis.entryQuality.timeToHalfRMinutes ?? "--"} / ${chart.diagnosis.entryQuality.timeToOneRMinutes ?? "--"} 分钟` : "--"}</b></div>
      <div><span>仓内 MFE</span><b>{fmtPct(chart.diagnosis.mfePct)}</b></div>
      <div><span>仓内 MAE</span><b>{fmtPct(chart.diagnosis.maePct)}</b></div>
      <div><span>出场后 MFE</span><b>{fmtPct(chart.diagnosis.postExitMfePct)}</b></div>
      <div><span>出场后 MAE</span><b>{fmtPct(chart.diagnosis.postExitMaePct)}</b></div>
      <div><span>Exit Capture</span><b>{fmtPct(chart.diagnosis.exitCapturePct)}</b></div>
      <div><span>Exit Efficiency</span><b>{fmtPct(chart.diagnosis.exitEfficiency)}</b></div>
    </div>
    {chart.diagnosis.entryQuality?.delayedEntries?.length ? <div className="rz-entry-counterfactuals">
      {chart.diagnosis.entryQuality.delayedEntries.map((item) => <div key={item.delayBars}><b>晚 {item.delayMinutes} 分钟</b><span>{item.valid ? `结果 ${fmtR(item.terminalR)} · 改善 ${fmtR(item.improvementR)} · MAE ${fmtR(item.maxAdverseR)}${item.stopped ? " · 触发原止损" : ""}` : "原结构止损下不可形成有效入场"}</span></div>)}
    </div> : null}
    {chart.observations?.length > 0 && <div className="rz-observer-row">{chart.observations.map((item) => <div key={item.horizonMinutes}><b>{horizonLabel(item.horizonMinutes)}</b><span>{item.qualityStatus === "READY" ? `有利 ${fmtR(item.favorableR)} · 不利 ${fmtR(item.adverseR)} · 覆盖 ${Math.round(item.coveragePct ?? 0)}%` : item.qualityStatus === "STALE" ? "K线不完整" : item.qualityStatus === "UNAVAILABLE" ? "数据不可用" : "观察中"}</span></div>)}</div>}
    <div className="rz-review-action"><strong>{chart.finalVerdict.final ? "最终结论" : "当前结论"}：</strong>{chart.finalVerdict.label} · {chart.finalVerdict.profitPath}<br />{chart.finalVerdict.recommendedAction}</div>
    <div className="rz-chart-copy">
      <span>{chart.diagnosis.label ?? "退出后仍在观察"}{chart.diagnosis.stopRecovery ? " · 疑似假止损" : ""}</span>
      {chart.counterfactual?.summary && <span>{chart.counterfactual.summary}</span>}
      {chart.upstreamError && <span>实时图层暂不可用：{chart.upstreamError}；仍显示已保存交易快照。</span>}
    </div>
  </>;
}

function TradeCard({ trade, roundTripCostBps }: { trade: Trade; roundTripCostBps: number }) {
  const [expanded, setExpanded] = useState(false);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(false);
  const pnl = trade.status === "holding" ? trade.unrealizedNetUsdt : trade.netPnlUsdt;
  const realizedR = trade.status === "closed" && trade.netPnlUsdt != null && trade.riskBudgetUsdt > 0 ? trade.netPnlUsdt / trade.riskBudgetUsdt : null;
  const plannedTp2Net = plannedTp2NetUsdt(trade, roundTripCostBps);
  const positionDecision = latestPositionDecision(trade);
  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !chart && !loading) {
      setLoading(true);
      try { setChart(await readJson<ChartData>(`/api/hte31/chart?trade=${encodeURIComponent(trade.id)}`)); } catch { setChart(null); }
      finally { setLoading(false); }
    }
  };
  return <article className="rz-panel rz-order">
    <button className="rz-order-button" type="button" onClick={() => void toggle()}>
      <div className="rz-order-head">
        <div className="rz-order-symbol"><strong>{trade.symbol.replace("_USDT", "")}</strong><small>{hte31CanonicalStrategyLabel(trade.traderId, trade.assetRegime)}</small></div>
        <div className="rz-order-side"><span className={`rz-bias ${trade.side === "LONG" ? "long" : "short"}`}>{sideText(trade.side)}</span><div className={`rz-order-pnl ${(pnl ?? 0) < 0 ? "rz-negative" : "rz-positive"}`}>{fmtMoney(pnl)}</div></div>
      </div>
      <div className="rz-econ-grid">
        <div className="rz-econ"><span>入场</span><b>{fmtPrice(trade.entryPrice)}</b></div>
        <div className="rz-econ"><span>{trade.status === "holding" ? "现价" : "出场"}</span><b>{fmtPrice(trade.status === "holding" ? trade.lastPrice : trade.exitPrice)}</b></div>
        <div className="rz-econ"><span>原始 Stop</span><b>{fmtPrice(trade.initialStopPrice)}</b></div>
        <div className="rz-econ"><span>当前保护价</span><b>{fmtPrice(trade.currentStopPrice)}</b></div>
        <div className="rz-econ"><span>TP1</span><b>{fmtPrice(trade.takeProfit1Price)}</b></div>
        <div className="rz-econ"><span>TP2</span><b>{fmtPrice(trade.takeProfit2Price)}</b></div>
        <div className="rz-econ"><span>杠杆</span><b>{trade.leverage}x</b></div>
        <div className="rz-econ"><span>隔离保证金</span><b>{fmtMoney(trade.marginUsdt)}</b></div>
        <div className="rz-econ"><span>名义仓位</span><b>{fmtMoney(trade.notionalUsdt)}</b></div>
        <div className="rz-econ"><span>计划亏损</span><b>{fmtMoney(-trade.riskBudgetUsdt)}</b></div>
        <div className="rz-econ"><span>TP2预计净利</span><b className="rz-positive">{fmtMoney(plannedTp2Net)}</b></div>
        <div className="rz-econ"><span>{trade.status === "closed" ? "实际结果" : "当前进度"}</span><b>{trade.status === "closed" ? fmtR(realizedR) : fmtR(trade.progressR)}</b></div>
      </div>
      {positionDecision && <p className="rz-thesis"><strong>持仓判断：</strong>{positionDecision.action} · {operatorText(positionDecision.reason)}</p>}
      <p className="rz-thesis">{operatorText(trade.entryThesis)}</p>
      <p className="rz-thesis">{fmtTime(trade.entryAt)}{trade.exitAt ? ` → ${fmtTime(trade.exitAt)} · ${trade.exitReason ?? trade.exitCode ?? "已平仓"}` : " · 持仓中"} · 点击{expanded ? "收起" : "展开"}完整复盘</p>
    </button>
    {expanded && <div className="rz-review-chart">{loading ? <Empty>正在读取复盘</Empty> : chart ? <MiniChart chart={chart} /> : <Empty>暂时没有复盘数据</Empty>}</div>}
  </article>;
}

export default function ResonancePage() {
  const [tab, setTab] = useState<Tab>("机会");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshWarning, setRefreshWarning] = useState("");
  const [liveError, setLiveError] = useState("");
  const [message, setMessage] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [permissionsConfirmed, setPermissionsConfirmed] = useState(false);
  const [emergencyHolding, setEmergencyHolding] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const emergencyTimer = useRef<number | null>(null);
  const mainSnapshotSeen = useRef(false);
  const lastSnapshotAt = useRef<number | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY);
        if (!raw) return;
        const cached = JSON.parse(raw) as Snapshot;
        if (!cached || typeof cached.observedAt !== "number" || !cached.dashboard || !cached.scanner) return;
        setSnapshot(cached);
        mainSnapshotSeen.current = true;
        lastSnapshotAt.current = cached.observedAt;
        setRefreshWarning(`正在重新连接，显示 ${fmtTime(cached.observedAt)} 的只读快照。`);
      } catch {
        window.localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, []);

  const refreshMain = useCallback(async () => {
    try {
      const next = await readJson<Snapshot>("/api/hte31");
      setSnapshot(next);
      mainSnapshotSeen.current = true;
      lastSnapshotAt.current = next.observedAt;
      if (next.dashboard && next.scanner.readModel) {
        try { window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(next)); } catch { /* display cache is optional */ }
      }
      setError("");
      setRefreshWarning(next.staleSources?.length ? `部分数据刷新延迟，显示 ${fmtTime(next.observedAt)} 的最近可信值。` : "");
    } catch (reason) {
      if (mainSnapshotSeen.current) {
        setError("");
        setRefreshWarning(`数据刷新暂时延迟，正在显示 ${fmtTime(lastSnapshotAt.current)} 的最近可信快照；后台扫描与持仓保护独立运行。`);
      } else {
        setError(reason instanceof Error ? reason.message : "读取失败");
      }
    }
  }, []);

  const refreshLive = useCallback(async () => {
    try { setLive(await readJson<LiveSnapshot>("/api/live/status")); setLiveError(""); }
    catch (reason) { setLive(null); setLiveError(reason instanceof Error ? reason.message : "实盘状态暂不可用"); }
  }, []);

  useEffect(() => {
    const kickoff = window.setTimeout(() => void refreshMain(), 0);
    const timer = window.setInterval(() => void refreshMain(), MAIN_REFRESH_MS);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
    };
  }, [refreshMain]);

  useEffect(() => {
    if (tab !== "实盘") return;
    const kickoff = window.setTimeout(() => void refreshLive(), 0);
    const timer = window.setInterval(() => void refreshLive(), 20_000);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
    };
  }, [tab, refreshLive]);

  const dashboard = snapshot?.dashboard;
  const readModel = snapshot?.scanner.readModel;
  const marketView = readModel?.marketView;
  const ageSeconds = snapshot?.scanner.ageMs == null ? null : Math.round(snapshot.scanner.ageMs / 1000);
  const healthBad = Boolean(error || snapshot?.scanner.status?.circuitOpen || (ageSeconds != null && ageSeconds > 90));
  const healthWarn = !healthBad && Boolean(refreshWarning || snapshot?.degraded);

  const mutate = useCallback(async (url: string, init: RequestInit, success: string, refreshLiveAfter = false) => {
    setMessage("");
    try {
      await readJson(url, init);
      setMessage(success);
      await refreshMain();
      if (refreshLiveAfter) await refreshLive();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "操作失败"); }
  }, [refreshMain, refreshLive]);


  const resetPaper = async () => {
    if (!dashboard) return;
    const prompt = dashboard.openTrades.length
      ? `暂停新开仓，等待当前 ${dashboard.openTrades.length} 笔模拟持仓自然结束后，从 ${fmtMoney(dashboard.settings.trialCapitalUsdt)} 开始新一轮？`
      : `从 ${fmtMoney(dashboard.settings.trialCapitalUsdt)} 开始新一轮模拟资金？`;
    if (!window.confirm(prompt)) return;
    setMessage("");
    try {
      const result = await readJson<{ reset: Dashboard["paperReset"] }>("/api/hte31/paper-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      setMessage(result.reset.openPositions > 0
        ? `已排队：等待 ${result.reset.openPositions} 笔持仓自然结束后自动重置。`
        : "已排队，系统将在下一轮自动重置模拟本金。");
      await refreshMain();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "模拟本金重置失败");
    }
  };


  const toggleScan = () => {
    const enabled = !(dashboard?.settings.scanEnabled ?? true);
    void mutate("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scanEnabled: enabled }) }, enabled ? "扫描已开启。" : "扫描已暂停。");
  };

  const toggleLive = () => {
    if (!live) return;
    const enabled = !live.control.entryEnabled;
    void mutate("/api/live/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }, enabled ? "实盘新开仓已开启。" : "实盘新开仓已关闭。", true);
  };

  const saveCredentials = () => {
    if (!apiKey || !apiSecret || !permissionsConfirmed) return setMessage("请填写 API Key / Secret，并确认没有提币权限。");
    void mutate("/api/live/credentials", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey, apiSecret, permissionsConfirmed }) }, "Gate API 已验证保存。", true).then(() => { setApiKey(""); setApiSecret(""); });
  };

  const deleteCredentials = () => {
    if (!window.confirm("删除已保存的 Gate API 凭据？删除后实盘将无法继续下单。")) return;
    void mutate("/api/live/credentials", { method: "DELETE" }, "Gate API 凭据已删除。", true);
  };

  const startEmergency = () => {
    if (emergencyTimer.current) window.clearTimeout(emergencyTimer.current);
    setEmergencyHolding(true);
    emergencyTimer.current = window.setTimeout(() => {
      emergencyTimer.current = null;
      setEmergencyHolding(false);
      void mutate("/api/live/emergency", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) }, "紧急停机已执行。", true);
    }, 1200);
  };
  const cancelEmergency = () => {
    setEmergencyHolding(false);
    if (emergencyTimer.current) {
      window.clearTimeout(emergencyTimer.current);
      emergencyTimer.current = null;
    }
  };

  const activeLiveOrders = live?.orders.filter((order) => ["submitting", "open", "protected", "closing"].includes(order.state)) ?? [];
  const scanner = snapshot?.scanner.status;
  return <main className="rz-shell">
    <header className="rz-header">
      <div className="rz-mark">R</div>
      <div className="rz-brand"><strong>Resonance</strong><small>三套核心打法 · 模拟学习</small></div>
      <i className={`rz-health ${healthBad ? "bad" : healthWarn ? "warn" : ""}`} />
    </header>

    {error && <div className="rz-banner bad">{error}</div>}
    {refreshWarning && <div className="rz-banner warn">{refreshWarning}</div>}
    {message && <div className="rz-banner">{message}</div>}

    {tab === "机会" && <div className="rz-stack">
      <section className="rz-section">
        <div className="rz-section-head"><div><span className="rz-eyebrow">现在怎么看</span><h2>市场判断</h2></div><small>{fmtTime(snapshot?.observedAt)}</small></div>
        <article className="rz-panel rz-hero">
          <div className="rz-hero-top">
            <div className="rz-hero-copy"><Bias value={marketView?.bias ?? "NEUTRAL"} confidence={marketView?.confidence ?? 0} /><h1>{marketView?.headline ?? "正在建立市场判断"}</h1><p>{marketView?.reason ?? "等待新一轮扫描完成。"}</p></div>
            <div className="rz-score"><div><b>{marketView?.confidence ?? 0}</b><span>把握</span></div></div>
          </div>
          {readModel?.directCandidate && <div className="rz-signal-levels">
            <div><span>当前打法</span><b>{readModel.directCandidate.setupLabel}</b></div>
            <div><span>当前位置</span><b>{readModel.directCandidate.location}</b></div>
            <div><span>决定</span><b>{sideText(readModel.directCandidate.decision)}</b></div>
            <div><span>入场区</span><b>{readModel.directCandidate.entryZone ? `${fmtPrice(readModel.directCandidate.entryZone[0])} – ${fmtPrice(readModel.directCandidate.entryZone[1])}` : "--"}</b></div>
            <div><span>失效价</span><b>{fmtPrice(readModel.directCandidate.invalidationPrice)}</b></div>
            <div><span>目标 1</span><b>{fmtPrice(readModel.directCandidate.targets[0])}</b></div>
            <div><span>目标 2</span><b>{fmtPrice(readModel.directCandidate.targets[1])}</b></div>
          </div>}
        </article>
      </section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟账户</span><h2>资金状态</h2></div><button className="rz-text-action" type="button" onClick={() => setTab("设置")}>资金设置</button></div>
        <div className="rz-metric-grid">
          <div className="rz-metric"><span>权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div>
          <div className="rz-metric"><span>已实现</span><b className={(dashboard?.account.realizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.account.realizedPnlUsdt)}</b></div>
          <div className="rz-metric"><span>未实现</span><b className={(dashboard?.account.unrealizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.account.unrealizedPnlUsdt)}</b></div>
          <div className="rz-metric"><span>可用保证金</span><b>{fmtMoney(dashboard?.account.availableMarginUsdt)}</b></div>
        </div>
        {dashboard?.directRisk && <p className="rz-copy"><strong>风险档：</strong>{dashboard.directRisk.state} · 单笔 {(dashboard.directRisk.riskRate * 100).toFixed(2)}% · {dashboard.directRisk.reason}</p>}
      </section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">正在做什么</span><h2>当前持仓</h2></div><small>{dashboard?.openTrades.length ?? 0} 笔</small></div>
        {dashboard?.openTrades.length ? <div className="rz-list">{dashboard.openTrades.slice(0, 5).map((trade) => <div className="rz-panel rz-position-preview" key={trade.id}><div><strong>{trade.symbol.replace("_USDT", "")}</strong><small>{hte31CanonicalStrategyLabel(trade.traderId, trade.assetRegime)} · {sideText(trade.side)}</small></div><div className={(trade.unrealizedNetUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}><strong>{fmtMoney(trade.unrealizedNetUsdt)}</strong></div></div>)}</div> : <Empty>当前没有模拟持仓</Empty>}
      </section>
    </div>}

    {tab === "雷达" && <div className="rz-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">整体市场</span><h2>{snapshot?.market?.label ?? "等待市场状态"}</h2></div><Bias value={snapshot?.market?.bias ?? "NEUTRAL"} confidence={snapshot?.market?.confidence ?? 0} /></div>
        <div className="rz-metric-grid"><div className="rz-metric"><span>扫描范围</span><b>15 币</b></div><div className="rz-metric"><span>深扫池</span><b>6 币</b></div><div className="rz-metric"><span>持仓上限</span><b>3 笔</b></div><div className="rz-metric"><span>当前深扫</span><b>{readModel?.target?.replace("_USDT", "") ?? "--"}</b></div></div>
        {snapshot?.market?.pendingLabel && <p className="rz-copy">检测到候选变化：{snapshot.market.pendingLabel}，确认 {snapshot.market.pendingConfirmations ?? 0}/{snapshot.market.requiredConfirmations ?? 0}，正式市场状态尚未翻转。</p>}
      </section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">市场雷达</span><h2>成交额前十五</h2></div><small>前三展开</small></div>
        {readModel?.directRadar?.length ? <div className="rz-list">{readModel.directRadar.map((item, index) => <DirectRadarCard key={item.symbol} item={item} expanded={index < 3} />)}</div> : <Empty>等待首轮十五币扫描</Empty>}
      </section>
    </div>}

    {tab === "订单" && <div className="rz-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟账户</span><h2>本轮交易</h2></div><small>{dashboard?.stats.sampleCount ?? 0} 笔已完成</small></div>
        <div className="rz-metric-grid"><div className="rz-metric"><span>权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="rz-metric"><span>本轮净值变化</span><b className={(dashboard?.stats.totalNetPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.stats.totalNetPnlUsdt)}</b></div><div className="rz-metric"><span>胜 / 平 / 负</span><b>{dashboard?.stats.wins ?? 0} / {dashboard?.stats.scratches ?? 0} / {dashboard?.stats.losses ?? 0}</b></div><div className="rz-metric"><span>PF</span><b>{dashboard?.stats.profitFactor == null ? "--" : dashboard.stats.profitFactor >= 99 ? "∞" : dashboard.stats.profitFactor.toFixed(2)}</b></div></div>
      </section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">OPEN</span><h2>当前持仓</h2></div><small>{dashboard?.openTrades.length ?? 0} 笔</small></div>{dashboard?.openTrades.length ? <div className="rz-list">{dashboard.openTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div> : <Empty>暂无模拟持仓</Empty>}</section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">CLOSED</span><h2>已平仓</h2></div><small>{dashboard?.closedTrades.length ?? 0} 笔</small></div>{dashboard?.closedTrades.length ? <div className="rz-list">{dashboard.closedTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div> : <Empty>暂无已平仓交易</Empty>}</section>
      {(dashboard?.archiveCount ?? 0) > 0 && <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">ARCHIVE</span><h2>历史归档</h2></div><button className="rz-text-action" type="button" onClick={() => setArchiveOpen((value) => !value)}>{archiveOpen ? "收起" : `查看 ${dashboard?.archiveCount ?? 0} 笔`}</button></div>{archiveOpen && <div className="rz-list">{dashboard?.archivedTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div>}</section>}
    </div>}

    {tab === "实盘" && <div className="rz-stack">
      {liveError && <div className="rz-banner bad">{liveError}</div>}
      {live?.control.lastError && <div className="rz-banner bad">实盘控制：{live.control.lastError}</div>}
      {live?.control.emergencyReason && <div className="rz-banner bad">紧急停机锁：{live.control.emergencyReason}</div>}
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">实盘账户</span><h2>Gate 合约账户</h2></div><small>{live?.credential.configured ? "已连接" : "未连接"}</small></div>
        <div className="rz-metric-grid"><div className="rz-metric"><span>账户权益</span><b>{fmtMoney(live?.control.accountEquityLastUsdt)}</b></div><div className="rz-metric"><span>今日已实现</span><b className={(live?.control.dailyRealizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(live?.control.dailyRealizedPnlUsdt)}</b></div><div className="rz-metric"><span>新开仓</span><b>{live?.control.entryEnabled ? "开启" : "关闭"}</b></div><div className="rz-metric"><span>最近成功对账</span><b>{fmtTime(live?.control.lastSuccessfulReconcileAt)}</b></div></div>
        {live?.performanceGate && <p className={`rz-copy ${live.performanceGate.passed ? "" : "rz-negative"}`}><strong>实盘资格：</strong>{live.performanceGate.passed ? "通过" : "未通过"}{live.performanceGate.reason ? ` · ${live.performanceGate.reason}` : ""}</p>}
        <div className="rz-actions inline"><button className={live?.control.entryEnabled ? "danger" : "primary"} onClick={toggleLive}>{live?.control.entryEnabled ? "关闭新开仓" : "开启实盘"}</button><button onClick={() => void mutate("/api/live/reconcile", { method: "POST" }, "实盘对账已完成。", true)}>立即对账</button></div>
      </section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">交易所连接</span><h2>Gate API</h2></div></div><article className="rz-panel">
        {live?.credential.configured ? <>
          <div className="rz-live-credential"><div><strong>{live.credential.keyHint ?? "已配置"}</strong><small>{live.credential.environment ?? "live"} · {live.credential.status ?? "verified"}{live.credential.lastVerifiedAt ? ` · ${fmtTime(live.credential.lastVerifiedAt)} 验证` : ""}</small></div><span className={`rz-bias ${live.credential.status === "error" ? "short" : "long"}`}>{live.credential.status ?? "verified"}</span></div>
          {live.credential.lastError && <p className="rz-copy rz-negative">{live.credential.lastError}</p>}
          <div className="rz-actions"><button className="danger" onClick={deleteCredentials}>删除凭据</button></div>
        </> : <div className="rz-form"><label><span>Gate API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><label><span>Gate API Secret</span><input type="password" autoComplete="off" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} /></label><label className="rz-check"><input type="checkbox" checked={permissionsConfirmed} onChange={(event) => setPermissionsConfirmed(event.target.checked)} /><span>确认只授予合约交易所需权限，不授予提币权限。</span></label><button className="rz-button primary" onClick={saveCredentials}>验证并保存</button></div>}
      </article></section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">真实订单</span><h2>活动持仓</h2></div><small>{activeLiveOrders.length} 笔</small></div>{activeLiveOrders.length ? <div className="rz-list">{activeLiveOrders.map((order) => <article className="rz-panel rz-radar" key={order.id}><div><strong>{order.symbol.replace("_USDT", "")}</strong><small>{operatorText(order.strategyLabel ?? "Resonance")} · {sideText(order.side)} · {order.state}{order.leverage ? ` · ${order.leverage}x` : ""}{order.marginMode ? ` · ${order.marginMode}` : ""}</small></div><span>{fmtMoney(order.realizedPnlUsdt)}</span><div className="rz-radar-reason">成交 {fmtPrice(order.fillPrice)} · 止损 {fmtPrice(order.stopLossPrice)} · 止盈 {fmtPrice(order.takeProfitPrice)}{order.strategyThesis ? ` · ${operatorText(order.strategyThesis)}` : ""}</div></article>)}</div> : <Empty>没有活动实盘持仓</Empty>}</section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">紧急控制</span><h2>停机</h2></div></div><article className="rz-panel"><p className="rz-copy">只有真正需要立即停止实盘新开仓和执行紧急保护时才使用。</p><button className={`rz-button danger rz-hold-button ${emergencyHolding ? "holding" : ""}`} onPointerDown={(event) => { event.preventDefault(); startEmergency(); }} onPointerUp={cancelEmergency} onPointerCancel={cancelEmergency} onPointerLeave={cancelEmergency} onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()}>{emergencyHolding ? "继续按住…" : "按住 1.2 秒紧急停机"}</button></article></section>
    </div>}

    {tab === "设置" && <div className="rz-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">运行状态</span><h2>系统设置</h2></div><button className="rz-text-action" type="button" onClick={() => setTab("机会")}>返回机会</button></div><article className="rz-panel">
        <div className="rz-metric-grid"><div className="rz-metric"><span>Scanner</span><b>{scanner?.state ?? "--"}</b></div><div className="rz-metric"><span>当前阶段</span><b>{scanner?.phase ?? "idle"}</b></div><div className="rz-metric"><span>最近扫描</span><b>{fmtTime(scanner?.lastSuccessAt)}</b></div><div className="rz-metric"><span>Trade Manager</span><b>{snapshot?.position.status?.state ?? "--"}</b></div></div>
        {(scanner?.lastError || scanner?.circuitOpen || (ageSeconds != null && ageSeconds > 90)) && <div className="rz-runtime-alert"><strong>运行异常</strong><span>{scanner?.lastError ?? `已 ${ageSeconds} 秒没有完成新评估`}{scanner?.retryAfter ? ` · ${fmtTime(scanner.retryAfter)} 重试` : ""}</span></div>}
        <div className="rz-actions"><button onClick={toggleScan}>{dashboard?.settings.scanEnabled ? "暂停市场扫描" : "恢复市场扫描"}</button></div>
      </article></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">交易核心</span><h2>只保留三套打法</h2></div></div><article className="rz-panel"><div className="rz-metric-grid"><div className="rz-metric"><span>高频机会</span><b>量价力度假突破</b></div><div className="rz-metric"><span>极端机会</span><b>衰竭反转</b></div><div className="rz-metric"><span>低频基线</span><b>经典趋势突破</b></div><div className="rz-metric"><span>最大持仓</span><b>3 笔</b></div></div></article></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟资金</span><h2>重新开始资金曲线</h2></div></div><article className="rz-panel"><div className="rz-metric-grid"><div className="rz-metric"><span>本轮本金</span><b>{fmtMoney(dashboard?.account.startingCapitalUsdt)}</b></div><div className="rz-metric"><span>当前权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="rz-metric"><span>开始时间</span><b>{fmtTime(dashboard?.account.epochStartedAt)}</b></div><div className="rz-metric"><span>本轮已平仓</span><b>{dashboard?.stats.sampleCount ?? 0}</b></div></div>{dashboard?.paperReset.status === "pending" && <p className="rz-copy">待重置 · 剩余 {dashboard.paperReset.openPositions} 笔持仓</p>}<div className="rz-actions"><button className="danger" disabled={dashboard?.paperReset.status === "pending"} onClick={() => void resetPaper()}>{dashboard?.paperReset.status === "pending" ? "等待持仓结束" : "重置模拟本金"}</button></div></article></section>
    </div>}

    <nav className="rz-nav">{NAV.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
  </main>;
}
