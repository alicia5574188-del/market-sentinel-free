"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Tab = "机会" | "雷达" | "订单" | "实盘" | "设置";
type TraderId = "dennis_trend" | "raschke_pullback" | "turtle_soup" | "exhaustion_reversal" | "higher_timeframe_swing" | "dennis_trend_v2" | "raschke_pullback_v2" | "turtle_soup_v2" | "higher_timeframe_swing_v2" | "range_rotation" | "compression_expansion" | "relative_strength" | "momentum_continuation";
type AnyTraderId = TraderId;
type FamilyId = "SF01" | "SF02" | "SF03" | "SF04" | "SF05" | "SF06" | "SF07" | "SF08" | "SF09";
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

type HistoricalAnalog = {
  label: string;
  minimumSamples?: number;
  sampleCount: number;
  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  bullishRatio: number;
  bearishRatio: number;
  medianForwardPct: number;
};

type MarketMemory = {
  short: HistoricalAnalog;
  swing: HistoricalAnalog;
  cycle: HistoricalAnalog;
  combinedBias: "LONG" | "SHORT" | "NEUTRAL";
  combinedConfidence: number;
  summary: string;
};

type MarketView = {
  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  environment: string;
  headline: string;
  reason: string;
  strongDirection: boolean;
};

type TradeAutopsy = {
  tradeId: string;
  symbol: string;
  traderId: string;
  setupId: string;
  resultR: number;
  primaryCause: string;
  causeLabel: string;
  explanation: string;
  evidence: string[];
  finalVerdict?: TradeFinalVerdict;
};

type SystemReview = {
  reviewNumber: number;
  completedTrades: number;
  nextReviewProgress: number;
  issue: string;
  issueLabel: string;
  headline: string;
  evidence: string[];
  action: string;
  status: "观察" | "验证中" | "已启用";
  directive: string;
  directives?: string[];
  latestAutopsy?: TradeAutopsy | null;
  pattern?: { sampleSize: number; repeatedCause: string; repeatedCount: number };
  challengerSetupId?: string | null;
  weakSetup?: { setupId: string; sampleCount: number; averageR: number; wins: number } | null;
  latest: { averageR: number; directionErrorRate: number; poorEntryRate: number; poorExitRate: number };
  previous: { averageR: number; directionErrorRate: number; poorEntryRate: number; poorExitRate: number } | null;
};

type EntryCheck = {
  key: string;
  label: string;
  passed: boolean;
  required: boolean;
  detail: string;
};

type ExitRule = {
  code: string;
  label: string;
  condition: string;
};

type EntryPlan = {
  ready: boolean;
  side: "LONG" | "SHORT";
  entryPrice: number;
  entryZone: [number, number];
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  riskPerUnit: number;
  plannedRiskPct: number;
  riskReward: number;
  maxHoldingMinutes: number;
  checks: EntryCheck[];
  exitRules: ExitRule[];
};

type Evaluation = {
  id: string;
  symbol: string;
  observedAt: number;
  traderId: AnyTraderId;
  state: "ready" | "watching" | "blocked";
  side: Side;
  confidence: number;
  assetRegime: string;
  thesis: string;
  reasons: string[];
  blockers: string[];
  entryPlan: EntryPlan | null;
};

type RouterCandidate = {
  traderId: AnyTraderId;
  strategyId: string;
  code: string;
  label: string;
  side: "LONG" | "SHORT";
  lane: "paper";
  storyFamily: string;
  familyId: FamilyId;
  variantId: string;
  tags: string[];
  currentScore: number;
  evidenceScore: number;
  combinedScore: number;
  evidence: { sampleCount: number; expectancyR: number; profitFactor: number | null; maximumDrawdownR: number; qualified: boolean };
};

type StrategyRouter = {
  authority: "paper_brain_live_parity";
  mode: "WAIT" | "SINGLE" | "COOPERATE" | "CONFLICT" | "SWITCH_WATCH";
  symbol: string;
  primary: RouterCandidate | null;
  selectedForExecution: RouterCandidate | null;
  supporting: RouterCandidate[];
  opposing: RouterCandidate[];
  familyAlternatives: RouterCandidate[];
  currentThesisState: "none" | "intact" | "uncertain" | "invalidated";
  replacementEligible: boolean;
  reason: string;
  executionRule: string;
  promotionRule: string;
};

type ShadowMetrics = {
  completed: number;
  pending: number;
  wins: number;
  losses: number;
  expectancyR: number;
  profitFactor: number | null;
  maximumDrawdownR: number;
};

type Trade = {
  id: string;
  symbol: string;
  status: "holding" | "closed";
  traderId: TraderId;
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

type Guard = { state: "ACTIVE" | "COOLDOWN" | "PAUSED"; lossStreak: number; reason: string };

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
  evaluations: Evaluation[];
  learning: Learning[];
  governance: {
    state: string;
    riskMultiplier: number;
    lossStreak: number;
    reason?: string;
    traderGuards: Record<TraderId, Guard>;
  };
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
      memory?: MarketMemory;
      marketView?: MarketView;
      review?: SystemReview;
      openReason?: string;
      router?: StrategyRouter;
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
  diagnostics: {
    shadow: Record<AnyTraderId, ShadowMetrics & { ready: ShadowMetrics; nearReady: ShadowMetrics; qualifiesForCalibration: boolean }>;
    policy: { maximumConcurrentPaperPositions: number; maximumPortfolioRiskRate: number; routerAuthority: string };
    strategyHealth: Record<AnyTraderId, StrategyHealth & { traderId: AnyTraderId; familyId: FamilyId }>;
    familyHealth: Record<FamilyId, StrategyHealth & { familyId: FamilyId; focusTraderId: AnyTraderId | null }>;
  } | null;
  degraded: boolean;
  errors: Record<string, string>;
};

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Observation = {
  horizonMinutes: number;
  status: string;
  favorableR: number | null;
  adverseR: number | null;
};

type ChartData = {
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strategy: { familyId: FamilyId; familyName: string; variantId: string; variantName: string; canonicalLabel: string; tags: string[] };
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

type StrategyHealth = {
  state: "LEARNING" | "ACTIVE" | "UNDERPERFORMING" | "DEGRADED" | "STARVED" | "REGIME_WAIT" | "RETEST" | "PAUSED";
  label: string;
  reason: string;
  action: string;
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
const TRADERS: { id: TraderId; code: string; name: string; setup: string; familyId: FamilyId; variant: string }[] = [
  { id: "dennis_trend", code: "HT1", name: "基础", setup: "趋势突破", familyId: "SF01", variant: "BASE" },
  { id: "dennis_trend_v2", code: "HT1-R", name: "接受回踩", setup: "突破接受/回踩", familyId: "SF01", variant: "ACCEPTED_RETEST" },
  { id: "raschke_pullback", code: "HT2", name: "基础", setup: "趋势回踩", familyId: "SF02", variant: "BASE" },
  { id: "raschke_pullback_v2", code: "HT2-R", name: "自适应深度", setup: "深浅回踩恢复", familyId: "SF02", variant: "ADAPTIVE_DEPTH" },
  { id: "turtle_soup", code: "HT3", name: "基础", setup: "失败突破", familyId: "SF03", variant: "BASE" },
  { id: "turtle_soup_v2", code: "HT3-R", name: "力度确认", setup: "量价力度假突破", familyId: "SF03", variant: "FORCE_AWARE" },
  { id: "exhaustion_reversal", code: "HT4", name: "基础", setup: "衰竭反转", familyId: "SF04", variant: "BASE" },
  { id: "higher_timeframe_swing", code: "HT5", name: "基础", setup: "大周期波段", familyId: "SF05", variant: "BASE" },
  { id: "higher_timeframe_swing_v2", code: "HT5-R", name: "环境上下文", setup: "周期化大结构", familyId: "SF05", variant: "REGIME_CONTEXT" },
  { id: "range_rotation", code: "HT6", name: "基础", setup: "区间轮动", familyId: "SF06", variant: "BASE" },
  { id: "compression_expansion", code: "HT7", name: "基础", setup: "压缩扩张", familyId: "SF07", variant: "BASE" },
  { id: "relative_strength", code: "HT8", name: "基础", setup: "相对强弱", familyId: "SF08", variant: "BASE" },
  { id: "momentum_continuation", code: "HT9", name: "基础", setup: "动量延续", familyId: "SF09", variant: "BASE" },
];
const STRATEGY_FAMILIES: { id: FamilyId; name: string; traderIds: TraderId[]; tags: string[] }[] = [
  { id: "SF01", name: "趋势突破", traderIds: ["dennis_trend", "dennis_trend_v2"], tags: ["趋势", "突破"] },
  { id: "SF02", name: "趋势回踩", traderIds: ["raschke_pullback", "raschke_pullback_v2"], tags: ["趋势", "回踩"] },
  { id: "SF03", name: "失败突破", traderIds: ["turtle_soup", "turtle_soup_v2"], tags: ["反转", "假突破"] },
  { id: "SF04", name: "衰竭反转", traderIds: ["exhaustion_reversal"], tags: ["反转", "衰竭"] },
  { id: "SF05", name: "大周期波段", traderIds: ["higher_timeframe_swing", "higher_timeframe_swing_v2"], tags: ["趋势", "大周期"] },
  { id: "SF06", name: "区间轮动", traderIds: ["range_rotation"], tags: ["区间", "轮动"] },
  { id: "SF07", name: "压缩扩张", traderIds: ["compression_expansion"], tags: ["波动率", "扩张"] },
  { id: "SF08", name: "相对强弱", traderIds: ["relative_strength"], tags: ["横截面", "强弱"] },
  { id: "SF09", name: "动量延续", traderIds: ["momentum_continuation"], tags: ["趋势", "动量"] },
];
const ALL_TRADERS = TRADERS;

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

function MemoryCard({ item, symbol }: { item: HistoricalAnalog; symbol?: string }) {
  const minimumSamples = item.minimumSamples ?? 8;
  const eligible = item.sampleCount >= minimumSamples;
  const moveLabel = item.medianForwardPct >= 0 ? "涨幅" : "跌幅";
  return <div className="rz-memory">
    <span>{symbol?.replace("_USDT", "") ?? "当前币种"} · {item.label}历史</span>
    <b>{eligible ? <Bias value={item.bias} confidence={item.confidence} /> : `样本不足 · ${item.sampleCount}/${minimumSamples}`}</b>
    <small>{eligible ? `有效独立样本 ${item.sampleCount} · 后续中位${moveLabel} ${item.medianForwardPct >= 0 ? "+" : ""}${item.medianForwardPct.toFixed(2)}%` : "暂不参与判断"}</small>
  </div>;
}

function SignalCard({ item }: { item: Evaluation }) {
  const trader = ALL_TRADERS.find((row) => row.id === item.traderId) ?? { code: "HT?", setup: item.traderId };
  const plan = item.entryPlan;
  const checks = plan?.checks ?? [];
  const exitRules = plan?.exitRules ?? [];
  const counterEvidence = Array.from(new Set([
    ...item.blockers,
    ...checks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`),
  ]));
  const triggerState = item.state === "ready" && plan?.ready ? "已确认" : item.state === "blocked" ? "已阻塞" : "观察中";

  return <details className="rz-panel rz-signal-card">
    <summary className="rz-signal-summary">
      <div className="rz-signal-title"><strong>{item.symbol.replace("_USDT", "")}</strong><small>{trader.code} {trader.setup} · {item.assetRegime}</small></div>
      <Bias value={item.side === "WAIT" ? "NEUTRAL" : item.side} confidence={item.confidence} />
      <div className="rz-radar-reason">{item.state === "ready" ? item.thesis : item.blockers[0] ?? item.reasons[0] ?? "继续观察"}</div>
      <span className="rz-signal-expand">查看完整计划</span>
    </summary>
    <div className="rz-signal-detail">
      <div className="rz-signal-levels">
        <div><span>方向</span><b>{sideText(item.side)}</b></div>
        <div><span>触发状态</span><b>{triggerState}</b></div>
        <div><span>入场区</span><b>{plan ? `${fmtPrice(plan.entryZone?.[0])} – ${fmtPrice(plan.entryZone?.[1])}` : "--"}</b></div>
        <div><span>入场价</span><b>{fmtPrice(plan?.entryPrice)}</b></div>
        <div><span>止损</span><b className="rz-negative">{fmtPrice(plan?.stopLossPrice)}</b></div>
        <div><span>TP1</span><b className="rz-positive">{fmtPrice(plan?.takeProfit1Price)}</b></div>
        <div><span>TP2</span><b className="rz-positive">{fmtPrice(plan?.takeProfit2Price)}</b></div>
        <div><span>计划</span><b>{plan ? `${plan.riskReward.toFixed(2)}R · ${plan.maxHoldingMinutes} 分钟` : "--"}</b></div>
      </div>

      <section className="rz-signal-block">
        <strong>触发与硬闸门</strong>
        <p>{item.thesis}</p>
        {checks.length ? <div className="rz-signal-list">{checks.map((check) => <div key={check.key}><span className={check.passed ? "pass" : "fail"}>{check.passed ? "通过" : "未通过"}</span><b>{check.label}{check.required ? " · 必须" : ""}</b><small>{check.detail}</small></div>)}</div> : <p>尚未形成完整交易计划。</p>}
      </section>

      <div className="rz-signal-evidence-grid">
        <section className="rz-signal-block"><strong>支持证据</strong>{item.reasons.length ? <ul>{item.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul> : <p>当前没有额外支持证据。</p>}</section>
        <section className="rz-signal-block"><strong>反证 / 缺失条件</strong>{counterEvidence.length ? <ul>{counterEvidence.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul> : <p>当前未发现硬性反证。</p>}</section>
      </div>

      <section className="rz-signal-block"><strong>失效条件</strong>{exitRules.length ? <ul>{exitRules.map((rule) => <li key={rule.code}><b>{rule.label}：</b>{rule.condition}</li>)}</ul> : <p>{plan ? "以结构止损及策略退出规则为准。" : "尚未形成完整交易计划。"}</p>}</section>
    </div>
  </details>;
}

function RouterCard({ router }: { router: StrategyRouter | undefined }) {
  if (!router) return <article className="rz-panel"><h3>策略大脑正在评估 9 个家族 / 13 个变体</h3><p className="rz-copy">完整 Setup 会进入统一模拟池，由大脑择优开仓。</p></article>;
  const modeLabel = ({ WAIT: "等待", SINGLE: "单一故事", COOPERATE: "同向协作", CONFLICT: "故事冲突", SWITCH_WATCH: "纠错换挡观察" } as const)[router.mode];
  return <article className="rz-panel rz-review">
    <div className="rz-review-line"><span className="rz-eyebrow">STRATEGY BRAIN · 模拟/实盘同链</span><span className={`rz-bias ${router.mode === "CONFLICT" || router.mode === "SWITCH_WATCH" ? "neutral" : router.primary?.side === "LONG" ? "long" : router.primary?.side === "SHORT" ? "short" : "neutral"}`}>{modeLabel}</span></div>
    <h3>{router.primary ? `${router.primary.label} · ${sideText(router.primary.side)}` : "本轮不强迫选择策略"}</h3>
    <p className="rz-copy">{router.reason}</p>
    {router.primary && <div className="rz-trader-stats"><div><span>当前结构分</span><b>{router.primary.currentScore.toFixed(1)}</b></div><div><span>实际订单样本</span><b>{router.primary.evidence.sampleCount}</b></div><div><span>模拟 PF</span><b>{router.primary.evidence.profitFactor == null ? "--" : router.primary.evidence.profitFactor >= 99 ? "∞" : router.primary.evidence.profitFactor.toFixed(2)}</b></div></div>}
    {router.supporting.length > 0 && <p className="rz-copy"><strong>同向：</strong>{router.supporting.map((item) => item.label).join("、")}（分别记账，不重复放大仓位）</p>}
    {router.opposing.length > 0 && <p className="rz-copy rz-negative"><strong>反向：</strong>{router.opposing.map((item) => `${item.label} ${sideText(item.side)}`).join("、")}</p>}
    {router.familyAlternatives?.length > 0 && <p className="rz-copy"><strong>同家族已合并：</strong>{router.familyAlternatives.map((item) => item.label).join("、")}（保留学习记录，本轮不重复开单）</p>}
    <div className="rz-review-action"><strong>当前权限：</strong>{router.executionRule}</div>
    <details className="rz-inline-details"><summary>查看学习规则</summary><p className="rz-copy">{router.promotionRule}</p></details>
  </article>;
}

function ReviewCard({ review }: { review: SystemReview | undefined }) {
  if (!review) return <article className="rz-panel rz-review"><h3>每笔交易都会立即复盘</h3><p className="rz-copy">5 笔只用于阶段汇总，不再是系统开始学习的门槛。</p></article>;
  return <article className="rz-panel rz-review">
    <div className="rz-review-line"><span className="rz-eyebrow">系统学习</span><span className="rz-bias neutral">{review.status}</span></div>
    <h3>{review.headline}</h3>
    {review.latestAutopsy && <div className="rz-autopsy"><strong>最近一笔：{review.latestAutopsy.finalVerdict?.label ?? review.latestAutopsy.causeLabel}</strong><span>{review.latestAutopsy.finalVerdict?.profitPath ?? review.latestAutopsy.explanation}</span></div>}
    <div className="rz-review-evidence">{review.evidence.map((line) => <span key={line}>{line}</span>)}</div>
    <div className="rz-review-action"><strong>下一步：</strong>{review.action}</div>
    <div className="rz-progress-label"><span>每笔立即复盘</span><span>阶段汇总 {review.nextReviewProgress}/5</span></div>
    <div className="rz-progress" aria-label={`阶段汇总 ${review.nextReviewProgress}/5`}><i style={{ width: `${review.nextReviewProgress / 5 * 100}%` }} /></div>
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
    {chart.observations?.length > 0 && <div className="rz-observer-row">{chart.observations.map((item) => <div key={item.horizonMinutes}><b>{horizonLabel(item.horizonMinutes)}</b><span>{item.status === "complete" ? `有利 ${fmtR(item.favorableR)} · 不利 ${fmtR(item.adverseR)}` : "观察中"}</span></div>)}</div>}
    <div className="rz-review-action"><strong>{chart.finalVerdict.final ? "最终结论" : "当前结论"}：</strong>{chart.finalVerdict.label} · {chart.finalVerdict.profitPath}<br />{chart.finalVerdict.recommendedAction}</div>
    <div className="rz-chart-copy">
      <span>{chart.diagnosis.label ?? "退出后仍在观察"}{chart.diagnosis.stopRecovery ? " · 疑似假止损" : ""}</span>
      {chart.counterfactual?.summary && <span>{chart.counterfactual.summary}</span>}
      {chart.upstreamError && <span>实时图层暂不可用：{chart.upstreamError}；仍显示已保存交易快照。</span>}
    </div>
  </>;
}

type StrategyFamilyStat = {
  id: FamilyId;
  name: string;
  tags: string[];
  variants: { id: TraderId; code: string; name: string; samples: number }[];
  samples: number;
  expectancy: number;
  pf: number | null;
  health?: StrategyHealth;
};

function StrategyFamilyCard({ family }: { family: StrategyFamilyStat }) {
  const state = family.health?.state ?? "LEARNING";
  const healthClass = ["DEGRADED", "UNDERPERFORMING", "PAUSED"].includes(state) ? "short" : state === "ACTIVE" ? "long" : "neutral";
  return <article className="rz-panel rz-trader">
    <div className="rz-trader-top"><div><strong>{family.id} {family.name}</strong><small>{family.tags.map((tag) => `#${tag}`).join(" ")}</small></div><span className={`rz-bias ${healthClass}`}>{family.health?.label ?? "学习中"}</span></div>
    <div className="rz-trader-stats"><div><span>样本</span><b>{family.samples}</b></div><div><span>Expectancy</span><b className={family.expectancy < 0 ? "rz-negative" : "rz-positive"}>{fmtR(family.expectancy)}</b></div><div><span>PF</span><b>{family.pf == null ? "--" : family.pf >= 99 ? "∞" : family.pf.toFixed(2)}</b></div></div>
    <p className="rz-copy"><strong>变体：</strong>{family.variants.map((variant) => `${variant.code} ${variant.name} (${variant.samples})`).join(" · ")}</p>
    {family.health && <p className="rz-copy">{family.health.reason}<br />计划：{family.health.action}</p>}
  </article>;
}

function TradeCard({ trade, roundTripCostBps }: { trade: Trade; roundTripCostBps: number }) {
  const [expanded, setExpanded] = useState(false);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(false);
  const trader = TRADERS.find((item) => item.id === trade.traderId)!;
  const pnl = trade.status === "holding" ? trade.unrealizedNetUsdt : trade.netPnlUsdt;
  const realizedR = trade.status === "closed" && trade.netPnlUsdt != null && trade.riskBudgetUsdt > 0 ? trade.netPnlUsdt / trade.riskBudgetUsdt : null;
  const plannedTp2Net = plannedTp2NetUsdt(trade, roundTripCostBps);
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
        <div className="rz-order-symbol"><strong>{trade.symbol.replace("_USDT", "")}</strong><small>{trader.code} {trader.name} · {trader.setup} · {trade.assetRegime}</small></div>
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
      <p className="rz-thesis">{trade.entryThesis}</p>
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
  const [coreSymbolsText, setCoreSymbolsText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [permissionsConfirmed, setPermissionsConfirmed] = useState(false);
  const [emergencyHolding, setEmergencyHolding] = useState(false);
  const emergencyTimer = useRef<number | null>(null);
  const mainSnapshotSeen = useRef(false);
  const lastSnapshotAt = useRef<number | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  const refreshMain = useCallback(async () => {
    try {
      const next = await readJson<Snapshot>("/api/hte31");
      setSnapshot(next);
      mainSnapshotSeen.current = true;
      lastSnapshotAt.current = next.observedAt;
      setError("");
      setRefreshWarning("");
      if (!coreSymbolsText && next.dashboard?.settings.coreSymbols) setCoreSymbolsText(next.dashboard.settings.coreSymbols.map((item) => item.replace("_USDT", "")).join(", "));
    } catch (reason) {
      if (mainSnapshotSeen.current) {
        setError("");
        setRefreshWarning(`数据刷新暂时延迟，正在显示 ${fmtTime(lastSnapshotAt.current)} 的最近可信快照；后台扫描与持仓保护独立运行。`);
      } else {
        setError(reason instanceof Error ? reason.message : "读取失败");
      }
    }
  }, [coreSymbolsText]);

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
  const memory = readModel?.memory;
  const marketView = readModel?.marketView;
  const review = readModel?.review;
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

  const latestRadar = useMemo(() => {
    if (!dashboard) return [];
    const seen = new Set<string>();
    return dashboard.evaluations.filter((item) => {
      const key = `${item.symbol}:${item.traderId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 24);
  }, [dashboard]);

  const radarCounts = useMemo(() => ({
    ready: latestRadar.filter((item) => item.state === "ready").length,
    watching: latestRadar.filter((item) => item.state === "watching").length,
    blocked: latestRadar.filter((item) => item.state === "blocked").length,
  }), [latestRadar]);

  const traderStats = useMemo(() => TRADERS.map((trader) => {
    const cells = dashboard?.learning.filter((cell) => cell.traderId === trader.id) ?? [];
    const samples = cells.reduce((sum, cell) => sum + cell.sampleCount, 0);
    const expectancy = samples ? cells.reduce((sum, cell) => sum + cell.expectancyR * cell.sampleCount, 0) / samples : 0;
    const profit = cells.reduce((sum, cell) => sum + cell.grossProfitR, 0);
    const loss = cells.reduce((sum, cell) => sum + cell.grossLossR, 0);
    const pf = loss > 0 ? profit / loss : profit > 0 ? 99 : null;
    return { ...trader, samples, expectancy, profit, loss, pf, guard: dashboard?.governance.traderGuards[trader.id], health: snapshot?.diagnostics?.strategyHealth?.[trader.id] };
  }), [dashboard, snapshot?.diagnostics?.strategyHealth]);

  const familyStats = useMemo<StrategyFamilyStat[]>(() => STRATEGY_FAMILIES.map((family) => {
    const variants = traderStats.filter((trader) => family.traderIds.includes(trader.id));
    const samples = variants.reduce((sum, variant) => sum + variant.samples, 0);
    const expectancy = samples ? variants.reduce((sum, variant) => sum + variant.expectancy * variant.samples, 0) / samples : 0;
    const profit = variants.reduce((sum, variant) => sum + variant.profit, 0);
    const loss = variants.reduce((sum, variant) => sum + variant.loss, 0);
    return {
      ...family,
      variants: variants.map((variant) => ({ id: variant.id, code: variant.code, name: variant.name, samples: variant.samples })),
      samples,
      expectancy,
      pf: loss > 0 ? profit / loss : profit > 0 ? 99 : null,
      health: snapshot?.diagnostics?.familyHealth?.[family.id],
    };
  }), [traderStats, snapshot?.diagnostics?.familyHealth]);

  const resetPaper = () => {
    if (!dashboard) return;
    if (dashboard.openTrades.length) return setMessage("当前还有模拟持仓，平仓后才能重置模拟本金。");
    if (!window.confirm(`将模拟本金重新从 ${fmtMoney(dashboard.settings.trialCapitalUsdt)} 开始？历史交易和学习数据不会删除。`)) return;
    void mutate("/api/hte31/paper-reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) }, "模拟本金已重置，历史学习继续保留。");
  };

  const saveSymbols = () => {
    const coreSymbols = coreSymbolsText.split(/[,，\s]+/).map((item) => item.trim().toUpperCase()).filter(Boolean).map((item) => item.includes("_") ? item : `${item}_USDT`);
    if (!coreSymbols.length) return setMessage("至少保留一个核心观察币种。");
    void mutate("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coreSymbols }) }, "核心观察币种已更新。");
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
      <div className="rz-brand"><strong>Resonance</strong><small>市场记忆 · 自适应交易</small></div>
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
          {memory && <div className="rz-memory-grid"><MemoryCard item={memory.short} symbol={readModel?.target} /><MemoryCard item={memory.swing} symbol={readModel?.target} /><MemoryCard item={memory.cycle} symbol={readModel?.target} /></div>}
        </article>
      </section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">系统有没有进步</span><h2>最新复盘</h2></div><small>{review?.completedTrades ? `${review.completedTrades} 笔已逐笔复盘` : "逐笔复盘"}</small></div><ReviewCard review={review} /></section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟账户</span><h2>资金状态</h2></div><button className="rz-text-action" type="button" onClick={() => setTab("设置")}>资金设置</button></div>
        <div className="rz-metric-grid">
          <div className="rz-metric"><span>权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div>
          <div className="rz-metric"><span>已实现</span><b className={(dashboard?.account.realizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.account.realizedPnlUsdt)}</b></div>
          <div className="rz-metric"><span>未实现</span><b className={(dashboard?.account.unrealizedPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.account.unrealizedPnlUsdt)}</b></div>
          <div className="rz-metric"><span>可用保证金</span><b>{fmtMoney(dashboard?.account.availableMarginUsdt)}</b></div>
        </div>
      </section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">正在做什么</span><h2>当前持仓</h2></div><small>{dashboard?.openTrades.length ?? 0} 笔</small></div>
        {dashboard?.openTrades.length ? <div className="rz-list">{dashboard.openTrades.slice(0, 5).map((trade) => <div className="rz-panel rz-position-preview" key={trade.id}><div><strong>{trade.symbol.replace("_USDT", "")}</strong><small>{TRADERS.find((item) => item.id === trade.traderId)?.setup} · {sideText(trade.side)}</small></div><div className={(trade.unrealizedNetUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}><strong>{fmtMoney(trade.unrealizedNetUsdt)}</strong></div></div>)}</div> : <Empty>当前没有模拟持仓</Empty>}
      </section>
    </div>}

    {tab === "雷达" && <div className="rz-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">整体市场</span><h2>{snapshot?.market?.label ?? "等待市场状态"}</h2></div><Bias value={snapshot?.market?.bias ?? "NEUTRAL"} confidence={snapshot?.market?.confidence ?? 0} /></div>
        <div className="rz-metric-grid"><div className="rz-metric"><span>稳定度</span><b>{snapshot?.market?.stability ?? 0}%</b></div><div className="rz-metric"><span>切换风险</span><b>{snapshot?.market?.transitionRisk ?? 0}%</b></div><div className="rz-metric"><span>READY</span><b>{radarCounts.ready}</b></div><div className="rz-metric"><span>观察 / 阻塞</span><b>{radarCounts.watching} / {radarCounts.blocked}</b></div></div>
        {snapshot?.market?.pendingLabel && <p className="rz-copy">检测到候选变化：{snapshot.market.pendingLabel}，确认 {snapshot.market.pendingConfirmations ?? 0}/{snapshot.market.requiredConfirmations ?? 0}，正式市场状态尚未翻转。</p>}
      </section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">市场雷达</span><h2>最近机会</h2></div><small>当前深扫 {readModel?.target?.replace("_USDT", "") ?? "--"}</small></div>
        {latestRadar.length ? <div className="rz-list">{latestRadar.map((item) => <SignalCard key={item.id} item={item} />)}</div> : <Empty>暂时没有新的市场评估</Empty>}
      </section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">实时策略大脑</span><h2>选择、并用与纠错</h2></div><small>模拟/实盘同一决策链</small></div><RouterCard router={readModel?.router} /></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">统一模拟策略池</span><h2>9 个策略家族由大脑择优</h2></div><small>13 个历史变体 · 最多 {snapshot?.diagnostics?.policy.maximumConcurrentPaperPositions ?? 5} 笔持仓</small></div>
        <p className="rz-copy">13 个旧策略身份完整保留并归入 9 个家族；同一家族同一轮只选一个变体，所有策略一视同仁。实盘直接继承大脑选中的准确变体与学习结果。</p>
        <div className="rz-list traders">{familyStats.map((family) => <StrategyFamilyCard key={family.id} family={family} />)}</div>
      </section>
    </div>}

    {tab === "订单" && <div className="rz-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟账户</span><h2>交易记录</h2></div><small>{dashboard?.stats.sampleCount ?? 0} 笔已完成</small></div>
        <div className="rz-metric-grid"><div className="rz-metric"><span>权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="rz-metric"><span>累计净值变化</span><b className={(dashboard?.stats.totalNetPnlUsdt ?? 0) < 0 ? "rz-negative" : "rz-positive"}>{fmtMoney(dashboard?.stats.totalNetPnlUsdt)}</b></div><div className="rz-metric"><span>胜 / 平 / 负</span><b>{dashboard?.stats.wins ?? 0} / {dashboard?.stats.scratches ?? 0} / {dashboard?.stats.losses ?? 0}</b></div><div className="rz-metric"><span>PF</span><b>{dashboard?.stats.profitFactor == null ? "--" : dashboard.stats.profitFactor >= 99 ? "∞" : dashboard.stats.profitFactor.toFixed(2)}</b></div></div>
      </section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">OPEN</span><h2>当前持仓</h2></div><small>{dashboard?.openTrades.length ?? 0} 笔</small></div>{dashboard?.openTrades.length ? <div className="rz-list">{dashboard.openTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div> : <Empty>暂无模拟持仓</Empty>}</section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">CLOSED</span><h2>已平仓</h2></div><small>{dashboard?.closedTrades.length ?? 0} 笔</small></div>{dashboard?.closedTrades.length ? <div className="rz-list">{dashboard.closedTrades.map((trade) => <TradeCard key={trade.id} trade={trade} roundTripCostBps={dashboard.settings.roundTripCostBps} />)}</div> : <Empty>暂无已平仓交易</Empty>}</section>
    </div>}

    {tab === "订单" && <div className="rz-stack rz-learning-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">逐笔复盘</span><h2>系统正在学什么</h2></div><small>{review ? `${review.completedTrades} 笔已复盘` : "--"}</small></div><ReviewCard review={review} /></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">学习结果</span><h2>策略健康与行动计划</h2></div><small>9 家族 / 13 变体</small></div><div className="rz-list traders">{familyStats.map((family) => <StrategyFamilyCard key={family.id} family={family} />)}</div></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">最差组合</span><h2>已经被数据否定的组合</h2></div></div>{dashboard?.learning.filter((cell) => cell.performanceGate?.state === "PAUSED").length ? <div className="rz-list">{dashboard.learning.filter((cell) => cell.performanceGate?.state === "PAUSED").slice(0, 12).map((cell) => <article className="rz-panel rz-radar" key={cell.id}><div><strong>{TRADERS.find((item) => item.id === cell.traderId)?.code} · {cell.assetRegime}</strong><small>{sideText(cell.side)} · {cell.sampleCount} 笔</small></div><span className="rz-negative">{fmtR(cell.expectancyR)}</span><div className="rz-radar-reason">{cell.performanceGate?.reason}</div></article>)}</div> : <Empty>目前没有达到暂停门槛的组合</Empty>}</section>
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

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">真实订单</span><h2>活动持仓</h2></div><small>{activeLiveOrders.length} 笔</small></div>{activeLiveOrders.length ? <div className="rz-list">{activeLiveOrders.map((order) => <article className="rz-panel rz-radar" key={order.id}><div><strong>{order.symbol.replace("_USDT", "")}</strong><small>{order.strategyLabel ?? "Resonance"} · {sideText(order.side)} · {order.state}{order.leverage ? ` · ${order.leverage}x` : ""}{order.marginMode ? ` · ${order.marginMode}` : ""}</small></div><span>{fmtMoney(order.realizedPnlUsdt)}</span><div className="rz-radar-reason">成交 {fmtPrice(order.fillPrice)} · 止损 {fmtPrice(order.stopLossPrice)} · 止盈 {fmtPrice(order.takeProfitPrice)}{order.strategyThesis ? ` · ${order.strategyThesis}` : ""}</div></article>)}</div> : <Empty>没有活动实盘持仓</Empty>}</section>

      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">紧急控制</span><h2>停机</h2></div></div><article className="rz-panel"><p className="rz-copy">只有真正需要立即停止实盘新开仓和执行紧急保护时才使用。</p><button className={`rz-button danger rz-hold-button ${emergencyHolding ? "holding" : ""}`} onPointerDown={(event) => { event.preventDefault(); startEmergency(); }} onPointerUp={cancelEmergency} onPointerCancel={cancelEmergency} onPointerLeave={cancelEmergency} onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()}>{emergencyHolding ? "继续按住…" : "按住 1.2 秒紧急停机"}</button></article></section>
    </div>}

    {tab === "设置" && <div className="rz-stack">
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">运行状态</span><h2>系统设置</h2></div><button className="rz-text-action" type="button" onClick={() => setTab("机会")}>返回机会</button></div><article className="rz-panel">
        <div className="rz-metric-grid"><div className="rz-metric"><span>Scanner</span><b>{scanner?.state ?? "--"}</b></div><div className="rz-metric"><span>当前阶段</span><b>{scanner?.phase ?? "idle"}</b></div><div className="rz-metric"><span>最近扫描</span><b>{fmtTime(scanner?.lastSuccessAt)}</b></div><div className="rz-metric"><span>Trade Manager</span><b>{snapshot?.position.status?.state ?? "--"}</b></div></div>
        {(scanner?.lastError || scanner?.circuitOpen || (ageSeconds != null && ageSeconds > 90)) && <div className="rz-runtime-alert"><strong>运行异常</strong><span>{scanner?.lastError ?? `已 ${ageSeconds} 秒没有完成新评估`}{scanner?.retryAfter ? ` · ${fmtTime(scanner.retryAfter)} 重试` : ""}</span></div>}
        <div className="rz-actions"><button onClick={toggleScan}>{dashboard?.settings.scanEnabled ? "暂停市场扫描" : "恢复市场扫描"}</button></div>
      </article></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">观察范围</span><h2>核心币种</h2></div></div><article className="rz-panel"><div className="rz-form"><label><span>币种，用逗号分隔</span><input value={coreSymbolsText} onChange={(event) => setCoreSymbolsText(event.target.value)} placeholder="BTC, ETH, SOL" /></label><button className="rz-button primary" onClick={saveSymbols}>保存</button></div></article></section>
      <section className="rz-section"><div className="rz-section-head"><div><span className="rz-eyebrow">模拟资金</span><h2>重新开始资金曲线</h2></div></div><article className="rz-panel"><div className="rz-metric-grid"><div className="rz-metric"><span>本轮本金</span><b>{fmtMoney(dashboard?.account.startingCapitalUsdt)}</b></div><div className="rz-metric"><span>当前权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="rz-metric"><span>开始时间</span><b>{fmtTime(dashboard?.account.epochStartedAt)}</b></div><div className="rz-metric"><span>累计学习样本</span><b>{dashboard?.stats.sampleCount ?? 0}</b></div></div><p className="rz-copy">重置只重新开始资金曲线，历史交易、逐笔复盘和学习结果全部保留。</p><div className="rz-actions"><button className="danger" disabled={Boolean(dashboard?.openTrades.length)} onClick={resetPaper}>重置模拟本金</button></div></article></section>
    </div>}

    <nav className="rz-nav">{NAV.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
  </main>;
}
