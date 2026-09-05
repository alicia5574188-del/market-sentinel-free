"use client";

import { HistoricalForecastCard } from "./historical-forecast-card";
import type { HistoricalForecast } from "../lib/historical-forecast";
import { useCallback, useEffect, useRef, useState } from "react";
import { chineseOperatorText, operatorLabel, riskClusterLabel } from "../lib/operator-language";
import { DIRECT_MARKET_BRAIN_VERSION } from "../lib/direct-market-types";
import { retainDashboardSnapshot } from "../lib/dashboard-snapshot";
import type { DirectSetupActivity } from "../lib/direct-market-types";
import {
  HTE31_TRADER_DEFINITIONS,
  hte31AssetRegimeLabel,
  hte31CanonicalStrategyLabel,
} from "../lib/hte31-strategy-catalog";

type Tab = "大脑" | "订单" | "管理";
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
  setupId: string;
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
  maxHoldingMinutes: number;
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
  version: string;
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
  twelveHourReview: TwelveHourReview | null;
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
  volumeUsd: number;
  riskClusterId: string;
  btcCorrelation: number | null;
  location: "TOP" | "MIDDLE" | "BOTTOM" | "BREAKOUT" | "BREAKDOWN";
  paths: { up: number; down: number; rangeOrInvalid: number };
  directionalScore: number;
  netEdgeR: number;
  confidence: number;
  setup: "ANALOG_PATH" | "MINUTE_PULLBACK" | "HISTORICAL_ANALOG" | "VOLUME_FORCE_FAILED_BREAKOUT" | "EXHAUSTION_REVERSAL" | "MULTI_TIMEFRAME_RESONANCE";
  analogIntent?: import("../lib/analog-path-strategy").AnalogIntent;
  forecast?: HistoricalForecast;
  candles5m?: Candle[];
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

type SetupReview = {
  setup: DirectCandidate["setup"];
  setupLabel: string;
  status: "发力" | "正常" | "观察" | "拖后腿" | "暂无机会";
  openedTrades: number;
  openTrades: number;
  sampleCount: number;
  wins: number;
  scratches: number;
  losses: number;
  winRate: number | null;
  netPnlUsdt: number;
  averageR: number | null;
  averageWinR: number | null;
  averageLossR: number | null;
  realizedPayoffRatio: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  maxLosingStreak: number;
  evaluations12h: number;
  triggeredSignals12h: number;
  qualifiedSignals12h: number;
  selectedSignals12h: number;
  blockedEntries12h: number;
  openedTrades12h: number;
  closedTrades12h: number;
  netPnl12h: number;
  leadingBlocker12h: string | null;
  latestQualifiedSelection?: DirectSetupActivity["latestQualifiedSelection"] | null;
};

type TwelveHourReview = {
  windowStartAt: number;
  windowEndAt: number;
  generatedAt: number;
  complete: boolean;
  coverageMs: number;
  evaluations: number;
  triggeredSignals: number;
  qualifiedSignals: number;
  selectedSignals: number;
  blockedEntries: number;
  openedTrades: number;
  closedTrades: number;
  netPnlUsdt: number;
  headline: string;
  nextAction: string;
  setups: SetupReview[];
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

const NAV: Tab[] = ["大脑", "订单", "管理"];
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
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function fmtR(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}倍`;
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}%`;
}

function horizonLabel(minutes: number) {
  if (minutes === 0) return "出场";
  if (minutes < 60) return `${minutes}分钟`;
  return `${minutes / 60}小时`;
}

function biasText(value: "LONG" | "SHORT" | "NEUTRAL") {
  return value === "LONG" ? "偏多" : value === "SHORT" ? "偏空" : "分歧";
}

function sideText(value: Side) {
  return value === "LONG" ? "做多" : value === "SHORT" ? "做空" : "等待";
}

function setupLabel(value: string) {
  return ({
    VOLUME_FORCE_FAILED_BREAKOUT: "量价力度假突破",
    EXHAUSTION_REVERSAL: "衰竭反转",
    MULTI_TIMEFRAME_RESONANCE: "多周期综合共振",
  } as Record<string, string>)[value] ?? value;
}

function tradeStrategyLabel(trade: Trade) {
  return trade.decisionAuthority === "direct_market_brain"
    ? setupLabel(trade.setupId)
    : chineseOperatorText(hte31CanonicalStrategyLabel(trade.traderId, trade.assetRegime));
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
  return chineseOperatorText(OPERATOR_TEXT_REPLACEMENTS.reduce((text, [raw, label]) => text.split(raw).join(label), value ?? ""));
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

function operatorDecision(snapshot: Snapshot | null, unavailable: boolean) {
  if (!snapshot) return { title: "正在读取运行状态", detail: "数据就绪后显示当前决定。" };
  if (unavailable) return { title: "运行数据需要检查", detail: "当前信息可能延迟，请在管理页检查运行状态。" };
  const dashboard = snapshot.dashboard;
  if (dashboard?.paperReset.status === "pending") return { title: "等待新一轮模拟开始", detail: "重置完成前不再新开仓，原有记录保留。" };
  if (dashboard?.settings.scanEnabled === false) return { title: "市场扫描已暂停", detail: "恢复扫描可在管理页操作。" };
  if (dashboard?.directRisk?.state === "PAUSED") return { title: "风险保护中", detail: "新开仓已暂停，已有订单请在订单页查看。" };
  const candidate = snapshot.scanner.readModel?.directCandidate;
  if (candidate && candidate.decision !== "WAIT") return {
    title: `${candidate.symbol.replace("_USDT", "")} 信号待复核`,
    detail: `${candidate.setupLabel}出现${candidate.decision === "LONG" ? "做多" : "做空"}信号，不代表已开仓；成交结果以订单页为准。`,
  };
  return { title: "等待入场确认", detail: candidate?.counterEvidence[0] ?? "当前候选的入场条件尚未确认；已有持仓与成交结果请看订单。" };
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...(!init?.method || init.method === "GET" ? { signal: AbortSignal.timeout(12_000) } : {}), ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `${url} 请求失败 (${response.status})`);
  return payload;
}

function DecisionEvidenceCard({ candidate }: { candidate: DirectCandidate }) {
  const side = candidate.decision;
  return <article className="rz-panel rz-radar rz-direct-expanded">
    <div>
      <strong>#{candidate.volumeRank} {candidate.symbol.replace("_USDT", "")}</strong>
      <small>当前判断证据 · 24小时成交额 {(candidate.volumeUsd / 100_000_000).toFixed(2)}亿 · {operatorLabel(candidate.freshness)}</small>
    </div>
    <Bias value={side === "WAIT" ? "NEUTRAL" : side} confidence={candidate.confidence} />
    <div className="rz-radar-reason">
      {candidate.setupLabel} · {operatorLabel(candidate.location)} · 向上 {candidate.paths.up.toFixed(1)}% / 向下 {candidate.paths.down.toFixed(1)}% / 震荡或失效 {candidate.paths.rangeOrInvalid.toFixed(1)}%
    </div>
    <div className="rz-signal-detail">
      <div className="rz-signal-levels">
        <div><span>核心打法</span><b>{candidate.setupLabel}</b></div>
        <div><span>打法评分</span><b>{candidate.setupScore.toFixed(0)}</b></div>
        <div><span>方向</span><b>{sideText(candidate.decision)}</b></div>
        <div><span>触发状态</span><b>{candidate.decision === "WAIT" ? "等待" : "已确认"}</b></div>
        <div><span>位置</span><b>{operatorLabel(candidate.location)}</b></div>
        <div><span>关联风险</span><b>{riskClusterLabel(candidate.riskClusterId)}</b></div>
        <div><span>入场区</span><b>{candidate.entryZone ? `${fmtPrice(candidate.entryZone[0])} – ${fmtPrice(candidate.entryZone[1])}` : "--"}</b></div>
        <div><span>入场价</span><b>{candidate.entryZone ? fmtPrice((candidate.entryZone[0] + candidate.entryZone[1]) / 2) : "--"}</b></div>
        <div><span>止损 / 失效价</span><b>{fmtPrice(candidate.invalidationPrice)}</b></div>
        <div><span>第一止盈</span><b>{fmtPrice(candidate.targets[0])}</b></div>
        <div><span>第二止盈</span><b>{fmtPrice(candidate.targets[1])}</b></div>
        <div><span>最长持仓</span><b>{candidate.maxHoldingMinutes} 分钟</b></div>
      </div>
      <section className="rz-signal-block"><strong>触发与硬闸门</strong><div className="rz-signal-list">{candidate.checks.map((check) => <div key={check.key}><span className={check.passed ? "pass" : "fail"}>{check.passed ? "通过" : "未通过"}</span><b>{operatorText(check.label)} · 必须</b><small>{operatorText(check.detail)}</small></div>)}</div></section>
      <div className="rz-signal-evidence-grid">
        <section className="rz-signal-block"><strong>支持证据</strong><p>{operatorText(candidate.evidence.join("；"))}</p></section>
        <section className="rz-signal-block"><strong>反证 / 缺失条件</strong><p>{operatorText(candidate.counterEvidence.join("；")) || "当前未发现硬性反证。"}</p></section>
      </div>
      <section className="rz-signal-block"><strong>失效条件</strong><p>价格触及 {fmtPrice(candidate.invalidationPrice)}，或任一必需硬闸门失效。</p></section>
    </div>
  </article>;
}

function StrategyPerformanceCard({ setup }: { setup: SetupReview }) {
  const tone = setup.status === "发力" ? "power" : setup.status === "拖后腿" ? "drag" : setup.status === "观察" ? "watch" : "quiet";
  return <article className={`rz-panel rz-strategy-performance ${tone}`}>
    <div className="rz-strategy-head">
      <div><strong>{setup.setupLabel}</strong><small>近12小时开仓 {setup.openedTrades12h} · 当前持仓 {setup.openTrades}</small><details><summary>为什么开单或等待</summary><small>全量评估 {setup.evaluations12h} · 原始触发 {setup.triggeredSignals12h} · 通过条件 {setup.qualifiedSignals12h} · 入场拦截 {setup.blockedEntries12h}</small></details></div>
      <span>{setup.status}</span>
    </div>
    {setup.sampleCount > 0 && <div className="rz-strategy-numbers">
      <div><span>总样本 / 胜率</span><b>{setup.sampleCount} / {setup.winRate == null ? "--" : `${setup.winRate.toFixed(0)}%`}</b></div>
      <div><span>累计净收益</span><b className={setup.netPnlUsdt < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(setup.netPnlUsdt)}</b></div>
      <div><span>平均风险倍数 / 盈利因子</span><b>{fmtR(setup.averageR)} / {setup.profitFactor == null ? "--" : setup.profitFactor >= 99 ? "∞" : setup.profitFactor.toFixed(2)}</b></div>
      <div><span>实际平均盈 / 亏</span><b>{fmtR(setup.averageWinR)} / {fmtR(setup.averageLossR)}</b></div>
      <div><span>实际盈亏比</span><b>{setup.realizedPayoffRatio == null ? "--" : setup.realizedPayoffRatio.toFixed(2)}</b></div>
      <div><span>最大回撤 / 连亏</span><b>{setup.maxDrawdownR.toFixed(2)}倍 / {setup.maxLosingStreak}</b></div>
    </div>}
    {setup.latestQualifiedSelection && !setup.latestQualifiedSelection.selected
      ? <p>最近合格信号：{setup.latestQualifiedSelection.symbol.replace("_USDT", "")} · {fmtTime(setup.latestQualifiedSelection.observedAt)}；同币择优采用{setup.latestQualifiedSelection.preferredSetupLabel}，本策略未入选。</p>
      : !setup.latestQualifiedSelection && setup.qualifiedSignals12h > 0 && setup.selectedSignals12h === 0
        ? <p>已有合格信号在同币择优时未入选；这条旧统计未保存当时对比，后续信号会保留具体原因。</p>
        : null}
    <p>{setup.leadingBlocker12h ? `近12小时常见等待原因：${operatorText(setup.leadingBlocker12h)}` : setup.sampleCount < 8 ? `已完成 ${setup.sampleCount} 笔；统计持续更新，风险保护即时生效。` : `胜 / 平 / 负：${setup.wins} / ${setup.scratches} / ${setup.losses}`}</p>
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
      {line(chart.levels.entry, "入场", "level-entry")}
      {line(chart.levels.initialStop, "止损", "level-stop")}
      {line(chart.levels.takeProfit1, "止盈一", "level-tp")}
      {line(chart.levels.takeProfit2, "止盈二", "level-tp")}
      {chart.markers.map((marker) => {
        const index = candles.findIndex((candle) => candleMs(candle) >= marker.time);
        if (index < 0) return null;
        return <g key={`${marker.kind}-${marker.time}`} className={marker.kind === "ENTRY" ? "marker-entry" : "marker-exit"}><circle cx={x(index)} cy={y(marker.price)} r="6" /><text x={x(index) + 9} y={y(marker.price) - 8}>{operatorLabel(marker.kind)}</text></g>;
      })}
    </svg>
    <div className="rz-review-metrics">
      <div><span>入场效率</span><b>{chart.diagnosis.entryQuality?.entryEfficiency == null ? "--" : `${chart.diagnosis.entryQuality.entryEfficiency.toFixed(1)}%`}</b></div>
      <div><span>进场归因</span><b>{chart.diagnosis.entryQuality?.classificationLabel ?? "观察中"}</b></div>
      <div><span>首次盈利半倍风险前最大回撤</span><b>{fmtR(chart.diagnosis.entryQuality?.initialMaeR)}</b></div>
      <div><span>盈利半倍 / 一倍风险用时</span><b>{chart.diagnosis.entryQuality ? `${chart.diagnosis.entryQuality.timeToHalfRMinutes ?? "--"} / ${chart.diagnosis.entryQuality.timeToOneRMinutes ?? "--"} 分钟` : "--"}</b></div>
      <div><span>仓内最大浮盈</span><b>{fmtPct(chart.diagnosis.mfePct)}</b></div>
      <div><span>仓内最大浮亏</span><b>{fmtPct(chart.diagnosis.maePct)}</b></div>
      <div><span>出场后最大有利波动</span><b>{fmtPct(chart.diagnosis.postExitMfePct)}</b></div>
      <div><span>出场后最大不利波动</span><b>{fmtPct(chart.diagnosis.postExitMaePct)}</b></div>
      <div><span>收益捕获率</span><b>{fmtPct(chart.diagnosis.exitCapturePct)}</b></div>
      <div><span>退出效率</span><b>{fmtPct(chart.diagnosis.exitEfficiency)}</b></div>
    </div>
    {chart.diagnosis.entryQuality?.delayedEntries?.length ? <div className="rz-entry-counterfactuals">
      {chart.diagnosis.entryQuality.delayedEntries.map((item) => <div key={item.delayBars}><b>晚 {item.delayMinutes} 分钟</b><span>{item.valid ? `结果 ${fmtR(item.terminalR)} · 改善 ${fmtR(item.improvementR)} · 最大不利波动 ${fmtR(item.maxAdverseR)}${item.stopped ? " · 触发原止损" : ""}` : "原结构止损下不可形成有效入场"}</span></div>)}
    </div> : null}
    {chart.observations?.length > 0 && <div className="rz-observer-row">{chart.observations.map((item) => <div key={item.horizonMinutes}><b>{horizonLabel(item.horizonMinutes)}</b><span>{item.qualityStatus === "READY" ? `有利 ${fmtR(item.favorableR)} · 不利 ${fmtR(item.adverseR)} · 覆盖 ${Math.round(item.coveragePct ?? 0)}%` : item.qualityStatus === "STALE" ? "K线不完整" : item.qualityStatus === "UNAVAILABLE" ? "数据不可用" : "观察中"}</span></div>)}</div>}
    <div className="rz-review-action"><strong>{chart.finalVerdict.final ? "最终结论" : "当前结论"}：</strong>{chart.finalVerdict.label} · {operatorText(chart.finalVerdict.profitPath)}<br />{operatorText(chart.finalVerdict.recommendedAction)}</div>
    <div className="rz-chart-copy">
      <span>{chart.diagnosis.label ?? "退出后仍在观察"}{chart.diagnosis.stopRecovery ? " · 疑似假止损" : ""}</span>
      {chart.counterfactual?.summary && <span>{operatorText(chart.counterfactual.summary)}</span>}
      {chart.upstreamError && <span>实时图层暂不可用：{operatorText(chart.upstreamError)}；仍显示已保存交易快照。</span>}
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
    <button className="rz-order-button" type="button" aria-expanded={expanded} onClick={() => void toggle()}>
      <div className="rz-order-head">
        <div className="rz-order-symbol"><strong>{trade.symbol.replace("_USDT", "")}</strong><small>{tradeStrategyLabel(trade)}</small></div>
        <div className="rz-order-side"><span className={`rz-bias ${trade.side === "LONG" ? "long" : "short"}`}>{sideText(trade.side)}</span><div className={`rz-order-pnl ${(pnl ?? 0) < 0 ? "rz-negative" : "rz-positive"}`}>{fmtMoney(pnl)}</div></div>
      </div>
      <div className="rz-order-brief"><span>入场 <b>{fmtPrice(trade.entryPrice)}</b></span><span>{trade.status === "holding" ? "当前保护价" : "出场"} <b>{fmtPrice(trade.status === "holding" ? trade.currentStopPrice : trade.exitPrice)}</b></span><span>计划亏损 <b>{fmtMoney(-trade.riskBudgetUsdt)}</b></span></div>
      {expanded && <div className="rz-order-details">      <div className="rz-econ-grid">
        <div className="rz-econ"><span>入场</span><b>{fmtPrice(trade.entryPrice)}</b></div>
        <div className="rz-econ"><span>{trade.status === "holding" ? "现价" : "出场"}</span><b>{fmtPrice(trade.status === "holding" ? trade.lastPrice : trade.exitPrice)}</b></div>
        <div className="rz-econ"><span>原始止损</span><b>{fmtPrice(trade.initialStopPrice)}</b></div>
        <div className="rz-econ"><span>当前保护价</span><b>{fmtPrice(trade.currentStopPrice)}</b></div>
        <div className="rz-econ"><span>第一止盈</span><b>{fmtPrice(trade.takeProfit1Price)}</b></div>
        <div className="rz-econ"><span>第二止盈</span><b>{fmtPrice(trade.takeProfit2Price)}</b></div>
        <div className="rz-econ"><span>杠杆</span><b>{trade.leverage}倍</b></div>
        <div className="rz-econ"><span>隔离保证金</span><b>{fmtMoney(trade.marginUsdt)}</b></div>
        <div className="rz-econ"><span>名义仓位</span><b>{fmtMoney(trade.notionalUsdt)}</b></div>
        <div className="rz-econ"><span>计划亏损</span><b>{fmtMoney(-trade.riskBudgetUsdt)}</b></div>
        <div className="rz-econ"><span>第二止盈预计净利</span><b className="rz-positive">{fmtMoney(plannedTp2Net)}</b></div>
        <div className="rz-econ"><span>{trade.status === "closed" ? "实际结果" : "当前进度"}</span><b>{trade.status === "closed" ? fmtR(realizedR) : fmtR(trade.progressR)}</b></div>
      </div>
      </div>}
      {positionDecision && <p className="rz-thesis"><strong>持仓判断：</strong>{operatorLabel(positionDecision.action)} · {operatorText(positionDecision.reason)}</p>}
      {expanded && <p className="rz-thesis">{operatorText(trade.entryThesis)}</p>}
      <p className="rz-thesis">{fmtTime(trade.entryAt)}{trade.exitAt ? ` → ${fmtTime(trade.exitAt)} · ${operatorText(trade.exitReason ?? trade.exitCode ?? "已平仓")}` : " · 持仓中"} · 点击{expanded ? "收起" : "展开"}完整复盘</p>
    </button>
    {expanded && <div className="rz-review-chart">{loading ? <Empty>正在读取复盘</Empty> : chart ? <MiniChart chart={chart} /> : <Empty>暂时没有复盘数据</Empty>}</div>}
  </article>;
}

export default function ResonancePage() {
  const [tab, setTab] = useState<Tab>("大脑");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshWarning, setRefreshWarning] = useState("");
  const [liveError, setLiveError] = useState("");
  const [liveReadAt, setLiveReadAt] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [permissionsConfirmed, setPermissionsConfirmed] = useState(false);
  const [emergencyHolding, setEmergencyHolding] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const emergencyTimer = useRef<number | null>(null);
  const mainSnapshotSeen = useRef(false);
  const snapshotRef = useRef<Snapshot | null>(null);
  const lastSnapshotAt = useRef<number | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      if (snapshotRef.current) return;
      try {
        const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY);
        if (!raw) return;
        const cached = JSON.parse(raw) as Snapshot;
        if (!cached?.version || typeof cached.observedAt !== "number" || !cached.dashboard || !cached.scanner) return;
        snapshotRef.current = cached;
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
      const received = await readJson<Snapshot>("/api/hte31");
      const next = retainDashboardSnapshot(snapshotRef.current, received);
      snapshotRef.current = next;
      setSnapshot(next);
      mainSnapshotSeen.current = true;
      lastSnapshotAt.current = next.observedAt;
      if (!next.degraded && next.dashboard && next.scanner.readModel) {
        try { window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(next)); } catch { /* display cache is optional */ }
      }
      setError("");
      setRefreshWarning(next.degraded ? `部分数据刷新延迟，显示 ${fmtTime(next.observedAt)} 的最近可信值；缺少的数据正在重试。` : "");
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
    try { setLive(await readJson<LiveSnapshot>("/api/live/status")); setLiveReadAt(Date.now()); setLiveError(""); }
    catch (reason) { setLiveError(reason instanceof Error ? reason.message : "实盘状态暂不可用"); }
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
    if (tab !== "管理") return;
    const kickoff = window.setTimeout(() => void refreshLive(), 0);
    const timer = window.setInterval(() => void refreshLive(), 20_000);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
    };
  }, [tab, refreshLive]);

  const dashboard = snapshot?.dashboard;
  const readModel = snapshot?.scanner.readModel;
  const ageSeconds = snapshot?.scanner.ageMs == null ? null : Math.round(snapshot.scanner.ageMs / 1000);
  const healthBad = Boolean(error || snapshot?.scanner.status?.lastError || snapshot?.scanner.status?.circuitOpen);
  const healthWarn = !healthBad && Boolean(refreshWarning || snapshot?.degraded || (ageSeconds != null && ageSeconds > 90));
  const decisionSummary = operatorDecision(snapshot, Boolean(error || snapshot?.errors.scannerReadModel || snapshot?.staleSources?.includes("scannerReadModel") || (ageSeconds != null && ageSeconds > 360)));

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
  const review = snapshot?.twelveHourReview;
  return <main className="rz-shell" data-release={DIRECT_MARKET_BRAIN_VERSION}>
    <header className="rz-header">
      <div className="rz-mark" aria-hidden="true">共</div>
      <div className="rz-brand"><strong>共振量化</strong><small>历史方向交易 · 模拟验证</small></div>
      <span className={`rz-status-label ${healthBad || healthWarn ? "warn" : ""}`}><i className={`rz-health ${healthBad ? "bad" : healthWarn ? "warn" : ""}`} />{healthBad ? "状态异常" : healthWarn ? "数据延迟" : snapshot ? "已更新" : "连接中"}</span>
    </header>

    {error && <div className="rz-banner bad">{error}</div>}
    {refreshWarning && <div className="rz-banner warn">{refreshWarning}</div>}
    {message && <div className="rz-banner">{message}</div>}

    {tab === "大脑" && <div className="rz-stack rz-overview">
      <section className="rz-section rz-forecast-top"><div className="rz-section-head"><div><span className="rz-eyebrow">未来一小时 · 方向辅助</span><h2>历史相似走势与预测</h2></div></div>
        {readModel?.directCandidate?.forecast ? <><HistoricalForecastCard observedAt={snapshot?.requestedAt} symbol={readModel.directCandidate.symbol} forecast={readModel.directCandidate.forecast} candles={readModel.directCandidate.candles5m ?? []} /><p className="rz-copy">{readModel.directCandidate.checks.find(c=>c.key==='history-direction')?.detail ?? '历史方向尚不明确，暂不开单'} · {readModel.directCandidate.decision!=='WAIT'?'当前价格可入场，等待资金复核':readModel.directCandidate.counterEvidence[0]??'暂不开单'}</p></> : <Empty>正在读取历史对照；数据就绪后显示真实预测，不生成替代曲线。</Empty>}
      </section>

      <section className="rz-account-strip" aria-label="模拟账户概览">
        <div><span className="rz-eyebrow">模拟账户 · 当前权益</span><strong>{fmtMoney(dashboard?.account.equityUsdt)}</strong><small>本轮本金 {fmtMoney(dashboard?.account.startingCapitalUsdt)}</small></div>
        <div className="rz-account-result"><span>本轮已实现净收益</span><b className={(dashboard?.account.realizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.account.realizedPnlUsdt)}</b><button className="rz-text-action" onClick={() => setTab("管理")}>资金设置 ↗</button></div>
      </section>
      <section className="rz-section rz-now">
        <div className="rz-section-head"><div><span className="rz-eyebrow">当前决定</span><h2>大脑决定</h2></div><small>数据时间 {fmtTime(snapshot?.observedAt)}</small></div>
        <article className={`rz-panel rz-decision-summary ${healthBad || healthWarn ? "rz-decision-delayed" : ""}`}>
          <span className="rz-mode-label">历史总体方向 · 路径择价</span>
          <strong>{decisionSummary.title}</strong>
          <p className="rz-copy">{decisionSummary.detail}</p>
          <div className="rz-rule-strip"><span>五分钟更新历史判断</span><span>最长持仓一小时</span><span>单笔风险上限0.25%</span></div>
        </article>
      </section>
      <section className="rz-section rz-active-positions"><div className="rz-section-head"><div><h2>当前持仓</h2></div><button className="rz-text-action" onClick={() => setTab("订单")}>查看订单 ↗</button></div>
        {dashboard?.openTrades.length ? <div className="rz-list">{dashboard.openTrades.map((trade) => <button type="button" className="rz-panel rz-position-preview" key={trade.id} onClick={() => setTab("订单")}>
          <div><strong>{trade.symbol.replace("_USDT", "")} <small>{sideText(trade.side)}</small></strong><small>入场 {fmtTime(trade.entryAt)} · 当前保护价 {fmtPrice(trade.currentStopPrice)}</small><small>{["MINUTE_PULLBACK","ANALOG_PATH"].includes(trade.setupId) ? `最迟退出 ${fmtTime(trade.entryAt + (trade.maxHoldingMinutes ?? (trade.setupId==='ANALOG_PATH'?60:15)) * 60_000)}` : tradeStrategyLabel(trade)}</small></div>
          <div><strong className={(trade.unrealizedNetUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(trade.unrealizedNetUsdt)}</strong><small>未实现净收益</small></div>
        </button>)}</div> : <Empty><strong>{dashboard ? "当前空仓" : "正在读取订单数据"}</strong>{dashboard && "没有已成交订单；符合条件后由后台执行。"}</Empty>}
      </section>
      <section className="rz-section"><div className="rz-section-head"><div><h2>策略表现</h2></div><small>本轮模拟 · 扣除成本</small></div>
        <div className="rz-metric-grid rz-performance-strip">
          <div className="rz-metric"><span>完成交易</span><b>{dashboard?.stats.sampleCount ?? "--"}<small> 笔</small></b></div>
          <div className="rz-metric"><span>胜率</span><b>{dashboard && dashboard.stats.sampleCount > 0 ? `${(dashboard.stats.wins / dashboard.stats.sampleCount * 100).toFixed(0)}%` : "--"}</b></div>
          <div className="rz-metric"><span>持仓浮动</span><b className={(dashboard?.account.unrealizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.account.unrealizedPnlUsdt)}</b></div>
          <div className="rz-metric"><span>可用保证金</span><b>{fmtMoney(dashboard?.account.availableMarginUsdt)}</b></div>
        </div>
        <details className="rz-decision-detail"><summary>交易统计与等待原因</summary>{review?.setups?.length ? <div className="rz-strategy-grid">{review.setups.map((setup) => <StrategyPerformanceCard key={setup.setup} setup={setup} />)}</div> : <Empty>等待首轮策略统计</Empty>}</details>
      </section>




    </div>}

    {tab === "订单" && <div className="rz-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟账户</span><h2>本轮交易</h2></div><small>{dashboard?.stats.sampleCount ?? "--"} 笔已完成</small></div>
        <div className="rz-metric-grid"><div className="rz-metric"><span>权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="rz-metric"><span>本轮净值变化</span><b className={(dashboard?.stats.totalNetPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.stats.totalNetPnlUsdt)}</b></div><div className="rz-metric"><span>胜 / 平 / 负</span><b>{dashboard?.stats.wins ?? "--"} / {dashboard?.stats.scratches ?? "--"} / {dashboard?.stats.losses ?? "--"}</b></div><div className="rz-metric"><span>盈利因子</span><b>{dashboard?.stats.profitFactor == null ? "--" : dashboard.stats.profitFactor >= 99 ? "∞" : dashboard.stats.profitFactor.toFixed(2)}</b></div></div>
      </section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">持仓</span><h2>当前持仓</h2></div><small>{dashboard?.openTrades.length ?? "--"} 笔</small></div>{dashboard?.openTrades.length ? <div className="rz-list">{dashboard.openTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div> : <Empty>{dashboard ? "暂无模拟持仓" : "正在读取订单数据"}</Empty>}</section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">已结束</span><h2>已平仓</h2></div><small>{dashboard?.closedTrades.length ?? "--"} 笔</small></div>{dashboard?.closedTrades.length ? <div className="rz-list">{dashboard.closedTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div> : <Empty>{dashboard ? "暂无已平仓交易" : "正在读取订单数据"}</Empty>}</section>
      {(dashboard?.archiveCount ?? 0) > 0 && <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">历史</span><h2>历史归档</h2></div><button className="rz-text-action" type="button" onClick={() => setArchiveOpen((value) => !value)}>{archiveOpen ? "收起" : `查看 ${dashboard?.archiveCount ?? 0} 笔`}</button></div>{archiveOpen && <div className="rz-list">{dashboard?.archivedTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div>}</section>}
    </div>}

    {tab === "管理" && <div className="rz-stack rz-management-settings">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">运行状态</span><h2>系统设置</h2></div><button className="rz-text-action" type="button" onClick={() => setTab("大脑")}>返回大脑</button></div><article className="rz-panel">
        <div className="rz-metric-grid"><div className="rz-metric"><span>市场扫描</span><b>{operatorLabel(scanner?.state)}</b></div><div className="rz-metric"><span>当前阶段</span><b>{scanner ? operatorLabel(scanner.phase ?? "idle") : "--"}</b></div><div className="rz-metric"><span>最近扫描</span><b>{fmtTime(scanner?.lastSuccessAt)}</b></div><div className="rz-metric"><span>持仓管理</span><b>{operatorLabel(snapshot?.position.status?.state)}</b></div></div>
        {(scanner?.lastError || scanner?.circuitOpen || (ageSeconds != null && ageSeconds > 90)) && <div className="rz-runtime-alert"><strong>{scanner?.lastError || scanner?.circuitOpen ? "运行异常" : "决策数据延迟"}</strong><span>{scanner?.lastError ?? `当前展示的决策数据已过去 ${ageSeconds} 秒；后台状态请看最近扫描时间`}{scanner?.retryAfter ? ` · ${fmtTime(scanner.retryAfter)} 重试` : ""}</span></div>}
        <div className="rz-runtime-lines"><p><span>持仓最近检查</span><b>{fmtTime(snapshot?.position.status?.lastSuccessAt)}</b></p><p><span>下次持仓调度</span><b>{fmtTime(snapshot?.position.status?.nextRunAt)}</b></p><p><span>固定扫描范围</span><b>六个币 · 每分钟一轮</b></p></div>
        <p className="rz-copy">关闭页面后后台继续调度；这里展示最近读取的状态。</p>
        <div className="rz-actions"><button disabled={!dashboard} onClick={toggleScan}>{dashboard?.settings.scanEnabled ? "暂停市场扫描" : "恢复市场扫描"}</button></div>
      </article></section>
      <details className="rz-decision-detail"><summary>资源预算与运行方式</summary><div className="rz-panel rz-copy"><p>行情由后台统一获取，历史分批回补并缓存复用。持仓保护独立调度，失败后限速重试。</p><p>数据库实际用量由定时运维审计检查；本页没有实时额度数据，不把预算当作实际消耗。</p></div></details>
      {readModel?.directCandidate && <details className="rz-decision-detail"><summary>决策诊断（按需查看）</summary><p className="rz-panel rz-copy">最近执行结果：{operatorText(readModel.openReason) || "等待执行反馈"}</p><DecisionEvidenceCard candidate={readModel.directCandidate} /></details>}
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">交易核心</span><h2>短线执行规则</h2></div></div><article className="rz-panel"><div className="rz-metric-grid"><div className="rz-metric"><span>入场依据</span><b>历史整体偏多/偏空，直接比较当前价与等待价</b></div><div className="rz-metric"><span>方向依据</span><b>历史方向就是开仓依据；不再额外等回踩信号</b></div><div className="rz-metric"><span>快速退出</span><b>允许计划内逆向波动；偏离过大提前退出，最长一小时</b></div><div className="rz-metric"><span>含费计划风险</span><b>单笔最多0.25%，合计不超过0.75%；无固定笔数上限</b></div><div className="rz-metric rz-metric-wide"><span>固定币池</span><b>比特币、以太坊、索拉纳、币安币、瑞波币、狗狗币</b></div></div></article></section>
      <section className="rz-section"><div className="rz-section-head"><div><h2>资金保护</h2></div></div><article className="rz-panel">
        {dashboard?.directRisk ? <p className="rz-copy"><strong>风险档：</strong>{operatorLabel(dashboard.directRisk.state)} · 单笔风险上限 {(dashboard.directRisk.riskRate * 100).toFixed(2)}% · {operatorText(dashboard.directRisk.reason)}</p> : <p className="rz-copy">风险状态正在读取</p>}
        <div className="rz-rule-strip"><span>组合风险上限0.75%</span><span>三连亏暂停三十分钟</span><span>日亏1.5%暂停新开仓</span></div>
        <p className="rz-copy">已用保证金 {fmtMoney(dashboard?.account.usedMarginUsdt)} · 可用保证金 {fmtMoney(dashboard?.account.availableMarginUsdt)}</p>
      </article></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟资金</span><h2>重新开始资金曲线</h2></div></div><article className="rz-panel"><div className="rz-metric-grid"><div className="rz-metric"><span>本轮本金</span><b>{fmtMoney(dashboard?.account.startingCapitalUsdt)}</b></div><div className="rz-metric"><span>当前权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="rz-metric"><span>开始时间</span><b>{fmtTime(dashboard?.account.epochStartedAt)}</b></div><div className="rz-metric"><span>本轮已平仓</span><b>{dashboard?.stats.sampleCount ?? "--"}</b></div></div>{dashboard?.paperReset.status === "pending" && <p className="rz-copy">待重置 · 剩余 {dashboard.paperReset.openPositions} 笔持仓</p>}<div className="rz-actions"><button className="danger" disabled={!dashboard || dashboard.paperReset.status === "pending"} onClick={() => void resetPaper()}>{dashboard?.paperReset.status === "pending" ? "等待持仓结束" : "重置模拟本金"}</button></div></article></section>
    </div>}

    {tab === "管理" && <div className="rz-stack">
      {liveError && <div className="rz-banner bad">{liveError}{liveReadAt ? `；以下实盘数据为北京时间 ${fmtTime(liveReadAt)} 的最近成功读取，正在重试。` : ""}</div>}
      {live?.control.lastError && <div className="rz-banner bad">实盘控制：{live.control.lastError}</div>}
      {live?.control.emergencyReason && <div className="rz-banner bad">紧急停机锁：{operatorText(live.control.emergencyReason)}</div>}
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">实盘账户</span><h2>Gate 合约账户</h2></div><small>{liveError ? "读取异常" : !live ? "正在读取" : !live.credential.configured ? "未配置" : operatorLabel(live.credential.status ?? "configured")}</small></div>
        <div className="rz-metric-grid"><div className="rz-metric"><span>账户权益</span><b>{fmtMoney(live?.control.accountEquityLastUsdt)}</b></div><div className="rz-metric"><span>今日已实现</span><b className={(live?.control.dailyRealizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(live?.control.dailyRealizedPnlUsdt)}</b></div><div className="rz-metric"><span>新开仓</span><b>{!live ? "--" : live.control.entryEnabled ? "开启" : "关闭"}</b></div><div className="rz-metric"><span>最近成功对账</span><b>{fmtTime(live?.control.lastSuccessfulReconcileAt)}</b></div></div>
        {live?.performanceGate && <p className={`rz-copy ${live.performanceGate.passed ? "" : "rz-negative"}`}><strong>实盘资格：</strong>{live.performanceGate.passed ? "通过" : "未通过"}{live.performanceGate.reason ? ` · ${operatorText(live.performanceGate.reason)}` : ""}</p>}
        <div className="rz-actions inline"><button className={live?.control.entryEnabled ? "danger" : "primary"} disabled={!live || Boolean(liveError) || (!live.control.entryEnabled && !live.performanceGate?.passed)} onClick={toggleLive}>{live?.control.entryEnabled ? "关闭新开仓" : "开启实盘"}</button><button disabled={!live || Boolean(liveError)} onClick={() => void mutate("/api/live/reconcile", { method: "POST" }, "实盘对账已完成。", true)}>立即对账</button></div>
      </section>

      <section className="rz-section"><div className="rz-section-head"><div><h2>交易所连接</h2></div></div><article className="rz-panel">
        {!live ? <p className="rz-copy">{liveError ? "连接状态暂时无法读取，请稍后重试。" : "正在读取已保存的连接状态…"}</p> : live.credential.configured ? <>
          <div className="rz-live-credential"><div><strong>{live.credential.keyHint ?? "已配置"}</strong><small>{live.credential.environment === "testnet" ? "测试环境" : "实盘环境"} · {operatorLabel(live.credential.status ?? "configured")}{live.credential.lastVerifiedAt ? ` · ${fmtTime(live.credential.lastVerifiedAt)} 验证` : ""}</small></div><span className={`rz-bias ${live.credential.status === "error" ? "short" : "long"}`}>{operatorLabel(live.credential.status ?? "configured")}</span></div>
          {live.credential.lastError && <p className="rz-copy rz-negative">{operatorText(live.credential.lastError)}</p>}
          <div className="rz-actions"><button className="danger" onClick={deleteCredentials}>删除凭据</button></div>
        </> : <div className="rz-form"><label><span>交易所访问密钥</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><label><span>交易所私密密钥</span><input type="password" autoComplete="off" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} /></label><label className="rz-check"><input type="checkbox" checked={permissionsConfirmed} onChange={(event) => setPermissionsConfirmed(event.target.checked)} /><span>确认只授予合约交易所需权限，不授予提币权限。</span></label><button className="rz-button primary" onClick={saveCredentials}>验证并保存</button></div>}
      </article></section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">真实订单</span><h2>活动持仓</h2></div><small>{live ? `${activeLiveOrders.length} 笔` : "--"}</small></div>{activeLiveOrders.length ? <div className="rz-list">{activeLiveOrders.map((order) => <article className="rz-panel rz-radar" key={order.id}><div><strong>{order.symbol.replace("_USDT", "")}</strong><small>{operatorText(order.strategyLabel ?? "Resonance")} · {sideText(order.side)} · {operatorLabel(order.state)}{order.leverage ? ` · ${order.leverage}倍` : ""}{order.marginMode ? ` · ${operatorLabel(order.marginMode)}` : ""}</small></div><span>{fmtMoney(order.realizedPnlUsdt)}</span><div className="rz-radar-reason">成交 {fmtPrice(order.fillPrice)} · 止损 {fmtPrice(order.stopLossPrice)} · 止盈 {fmtPrice(order.takeProfitPrice)}{order.strategyThesis ? ` · ${operatorText(order.strategyThesis)}` : ""}</div></article>)}</div> : <Empty>{!live ? "正在读取实盘持仓" : liveError ? "暂时无法确认最新持仓" : "没有活动实盘持仓"}</Empty>}</section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">紧急控制</span><h2>停机</h2></div></div><article className="rz-panel"><p className="rz-copy">只有真正需要立即停止实盘新开仓和执行紧急保护时才使用。</p><button className={`rz-button danger rz-hold-button ${emergencyHolding ? "holding" : ""}`} onPointerDown={(event) => { event.preventDefault(); startEmergency(); }} onPointerUp={cancelEmergency} onPointerCancel={cancelEmergency} onPointerLeave={cancelEmergency} onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()}>{emergencyHolding ? "继续按住…" : "按住 1.2 秒紧急停机"}</button></article></section>
    </div>}

    <nav className="rz-nav" aria-label="主导航">{NAV.map((item) => <button key={item} aria-current={tab === item ? "page" : undefined} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
  </main>;
}
