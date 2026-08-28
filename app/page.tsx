"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Tab = "总览" | "雷达" | "订单" | "实盘" | "设置";
type OpportunityState = "TRADE" | "WATCH" | "REJECT";
type TradeSide = "LONG" | "SHORT" | "WAIT";
type GovernorState = "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";

type MarketContext = {
  observedAt: number;
  regime: string;
  regimeLabel: string;
  confidence: number;
  stability: number;
  transitionRisk: number;
  transitionVelocity: number;
  riskAcceleration: number;
  developingRegime: string | null;
  currentRegimeProbability?: number;
  candidateProbability?: number;
  candidateMomentum?: number;
  permission: "GREEN" | "BLUE" | "YELLOW" | "ORANGE" | "RED";
  bias: "LONG" | "SHORT" | "NEUTRAL";
  breadth: {
    sampleSize: number;
    advancingRatio: number;
    decliningRatio: number;
    medianChangePct: number;
    bullishParticipation: number;
    bearishParticipation: number;
  };
  volatility: { dispersionPct: number; ivPercentile: number | null; state: string };
  leverage: { crowdedRatio: number; averageFundingAbs: number; state: string };
  transition: Record<string, number>;
  warnings: Warning[];
  topDrivers: string[];
  dataIntegrity: { valid: boolean; universeSize: number; stale: boolean; reason: string | null };
};

type Warning = {
  id?: string;
  level: string;
  status: string;
  severity: number;
  confidence: number;
  direction: string;
  title: string;
  detail: string;
  impact: string;
};

type Opportunity = {
  symbol: string;
  observedAt: number;
  playbook: string;
  playbookLabel: string;
  strategyId: string;
  side: TradeSide;
  state: OpportunityState;
  tradeMode: string;
  opportunityScore: number;
  environmentFit: number;
  playbookFit: number;
  structure: number;
  timing: number;
  confirmation: number;
  riskReward: number;
  portfolioImpact: number;
  riskMultiplier: number;
  globalRegime: string;
  assetRegime: string;
  learningScore: number;
  learningConfidence: number;
  learningState: string;
  explorationValue: number;
  experienceSamples: number;
  expectancyR: number | null;
  recentExpectancyR: number | null;
  t1HitRate: number | null;
  directionFailureRate: number | null;
  waitingFor: string[];
  rejectReasons: string[];
  reasons: string[];
  maxRisk: string | null;
};

type StrategyStats = {
  sampleCount: number;
  recentSampleCount?: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averageNetPct: number | null;
  recentAverageNetPct?: number | null;
  profitFactor: number | null;
  recentProfitFactor?: number | null;
  maxDrawdownPct?: number;
  averageHoldMinutes?: number | null;
};

type Trader = {
  id: string;
  label: string;
  mode: string;
  openCount: number;
  stats: StrategyStats;
};

type TraderLab = {
  observedAt: number;
  note: string;
  executionGovernor: { state: GovernorState; reason: string; lossStreak: number };
  baseline: { id: string; label: string; openCount: number; stats: StrategyStats };
  strategies: Trader[];
};

type UniverseTicker = {
  symbol: string;
  price: number;
  changePercentage: number;
  volumeUsd: number;
  fundingRate: number | null;
  coarseScore: number;
  confidence: number;
  state: string;
  stateLabel: string;
  side: TradeSide;
};

type Settings = {
  scanEnabled: boolean;
  pushEnabled: boolean;
  coreSymbols: string[];
  universeLimit: number;
  deepScanLimit: number;
  trialCapitalUsdt: number;
  roundTripCostBps: number;
  riskPolicy?: {
    singleTradeLossPct?: number;
    minimumTp2NetProfitPct?: number;
    maxMarginAllocationPct?: number;
    dailyRealizedLossPausePct?: number;
    peakDrawdownPct?: number;
    maxLiveOpenPositions?: number;
    maxSameSideLivePositions?: number;
  };
};

type Trade = {
  id: string;
  symbol: string;
  status: "holding" | "closed" | "archived";
  side: "LONG" | "SHORT";
  confidence: number;
  regime: string;
  entryAt: number;
  entryPrice: number;
  entryTrigger: string;
  entryThesis: string;
  currentStopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  riskBudgetUsdt: number;
  marginUsdt: number;
  contractNotionalUsdt: number;
  leverage: number;
  lastPrice: number;
  unrealizedNetPct: number;
  unrealizedNetUsdt: number;
  progressR: number;
  exitAt: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  netMovePct: number | null;
  netPnlUsdt: number | null;
  holdMinutes: number | null;
};

type OrderDashboard = {
  trades?: Trade[];
  openTrades?: Trade[];
  account?: {
    startingCapitalUsdt: number;
    realizedPnlUsdt: number;
    unrealizedPnlUsdt: number;
    realizedBalanceUsdt: number;
    equityUsdt: number;
    usedMarginUsdt: number;
    availableMarginUsdt: number;
  };
  lastScan?: {
    startedAt: number;
    status: string;
    universeSize: number;
    deepScanned: number;
    confirmedCount: number;
    preAlertCount: number;
    averageDataQuality: number | null;
    durationMs: number | null;
  } | null;
};

type HistoryStats = {
  emitted?: number;
  open?: number;
  closed?: number;
  wins?: number;
  winRate?: number | null;
  averageNetPct?: number | null;
  totalNetPnlUsdt?: number;
  maxDrawdownPct?: number;
  profitFactor?: number | null;
};

type HteSnapshot = {
  version: "human-trader-3.0";
  observedAt: number;
  account: { id: string; displayName: string; role: "owner" | "member"; status: string };
  scanner: {
    observedAt: number;
    universe: UniverseTicker[];
    openTrades: Trade[];
    settings: Settings;
    snapshotSource: string;
    snapshotAgeMs: number | null;
    error?: string;
  } | null;
  market: MarketContext | null;
  opportunities: Opportunity[];
  warnings: Warning[];
  traders: TraderLab | null;
  orders: OrderDashboard | null;
  stats: HistoryStats | null;
  background: {
    active?: boolean;
    overall?: string;
    scanner?: { state?: string; lastSuccessAt?: number | null; detail?: string } | null;
    position?: { state?: string; lastSuccessAt?: number | null; detail?: string } | null;
    live?: { state?: string; lastSuccessAt?: number | null; detail?: string } | null;
    issues?: { message: string }[];
  } | null;
  degraded: boolean;
  errors: Record<string, string>;
};

type LiveOrder = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  state: string;
  tradeCaseId: string;
  referencePrice: number;
  fillPrice: number | null;
  stopLossPrice: number;
  takeProfitPrice: number;
  requestedContracts: string;
  filledContracts: string;
  leverage: number;
  marginMode: string;
  realizedPnlUsdt: number | null;
  createdAt: number;
  closedAt: number | null;
  strategyLabel?: string | null;
  strategyTrigger?: string | null;
  strategyThesis?: string | null;
  strategyExitReason?: string | null;
};

type LiveSnapshot = {
  observedAt: number;
  control: {
    entryEnabled: boolean;
    state: "disabled" | "armed" | "risk_locked" | "emergency_stopped";
    lastError?: string | null;
    emergencyReason?: string | null;
    accountEquityLastUsdt?: number | null;
    dailyRealizedPnlUsdt?: number | null;
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

const TABS: Tab[] = ["总览", "雷达", "订单", "实盘", "设置"];
const TRADER_COPY: Record<string, { short: string; thesis: string }> = {
  trend_breakout: { short: "Dennis 趋势突破", thesis: "只做真正离开旧区间的趋势突破；不在区间里猜方向。" },
  trend_pullback: { short: "Raschke 趋势回踩", thesis: "等趋势成立、冲击完成、回踩受控，再等恢复而不是追第一根。" },
  failed_breakout: { short: "Turtle Soup 假突破", thesis: "专抓扫过前高/前低后重新收回区间的失败突破。" },
};

function fmtTime(value: number | null | undefined) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function fmtMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 2)}`;
}

function fmtPct(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(digits)}%`;
}

function fmtRatio(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function sideLabel(side: TradeSide) {
  return side === "LONG" ? "做多" : side === "SHORT" ? "做空" : "等待";
}

function stateLabel(state: OpportunityState) {
  return state === "TRADE" ? "可交易" : state === "WATCH" ? "等待触发" : "拒绝";
}

function traderNameFromRegime(regime: string) {
  if (regime.includes("HT1_")) return "HT1 Dennis 趋势突破";
  if (regime.includes("HT2_")) return "HT2 Raschke 趋势回踩";
  if (regime.includes("HT3_")) return "HT3 Turtle Soup 假突破";
  return "Human Trader";
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error(`${url} 返回了非 JSON 响应`);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `${url} 请求失败 (${response.status})`);
  return payload;
}

function MetricBar({ label, value }: { label: string; value: number }) {
  const safe = Math.max(0, Math.min(100, value));
  return <div className="hte-metric-row"><span>{label}</span><div className="hte-meter"><i style={{ width: `${safe}%` }} /></div><b>{Math.round(value)}</b></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="hte-empty"><strong>{title}</strong><span>{detail}</span></div>;
}

function OpportunityCard({ item }: { item: Opportunity }) {
  const detail = item.state === "REJECT" ? item.rejectReasons : item.waitingFor;
  return <article className={`hte-opportunity hte-state-${item.state.toLowerCase()}`}>
    <div className="hte-card-head">
      <div>
        <div className="hte-symbol-row"><strong>{item.symbol.replace("_USDT", "")}</strong><span>{item.playbookLabel.replace(/^HT\d\s*/, "")}</span></div>
        <small>{item.assetRegime} · {item.tradeMode === "exploration" ? "冷启动" : item.tradeMode === "high_conviction" ? "高确信" : "标准"}</small>
      </div>
      <div className="hte-op-state"><b>{stateLabel(item.state)}</b><span className={`hte-side hte-${item.side.toLowerCase()}`}>{sideLabel(item.side)}</span></div>
    </div>
    <div className="hte-op-scoreline">
      <div><span>Setup</span><b>{item.structure}</b></div>
      <div><span>证据</span><b>{item.confirmation}</b></div>
      <div><span>时机</span><b>{item.timing}</b></div>
      <div><span>RR</span><b>{item.riskReward ? item.riskReward.toFixed(1) : "--"}</b></div>
      <div><span>风险</span><b>{item.state === "TRADE" ? `${Math.round(item.riskMultiplier * 100)}%` : "0%"}</b></div>
    </div>
    <div className="hte-card-copy">
      {(item.reasons ?? []).slice(0, 2).map((reason) => <p key={reason}>{reason}</p>)}
      {detail?.slice(0, 2).map((reason) => <p className="muted" key={reason}>还差：{reason}</p>)}
    </div>
    <div className="hte-learning-line"><span>学习样本 n={item.experienceSamples}</span><span>期望 {item.expectancyR == null ? "--" : `${item.expectancyR.toFixed(2)}R`}</span><span>{item.learningState}</span></div>
  </article>;
}

export default function HumanTraderPage() {
  const [tab, setTab] = useState<Tab>("总览");
  const [snapshot, setSnapshot] = useState<HteSnapshot | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [mainError, setMainError] = useState("");
  const [liveError, setLiveError] = useState("");
  const [mutationMessage, setMutationMessage] = useState("");
  const [radarFilter, setRadarFilter] = useState<"ALL" | OpportunityState>("ALL");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [permissionsConfirmed, setPermissionsConfirmed] = useState(false);
  const [coreSymbolsText, setCoreSymbolsText] = useState("");
  const mainInFlight = useRef(false);
  const liveInFlight = useRef(false);
  const emergencyTimer = useRef<number | null>(null);

  const refreshMain = useCallback(async (silent = false) => {
    if (mainInFlight.current) return;
    mainInFlight.current = true;
    if (!silent) setLoading(true);
    try {
      const next = await readJson<HteSnapshot>("/api/hte");
      setSnapshot(next);
      setMainError("");
      if (!coreSymbolsText && next.scanner?.settings?.coreSymbols) setCoreSymbolsText(next.scanner.settings.coreSymbols.join(", "));
    } catch (error) {
      setMainError(error instanceof Error ? error.message : "Human Trader 快照暂不可用");
    } finally {
      mainInFlight.current = false;
      if (!silent) setLoading(false);
    }
  }, [coreSymbolsText]);

  const refreshLive = useCallback(async (silent = false) => {
    if (liveInFlight.current) return;
    liveInFlight.current = true;
    try {
      const next = await readJson<LiveSnapshot>("/api/live/status");
      setLive(next);
      setLiveError("");
    } catch (error) {
      if (!silent) setLive(null);
      setLiveError(error instanceof Error ? error.message : "实盘状态暂不可用");
    } finally {
      liveInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshMain(false);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshMain(true);
    }, 20_000);
    const onVisible = () => { if (!document.hidden) void refreshMain(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshMain]);

  useEffect(() => {
    if (tab !== "实盘" || snapshot?.account.role !== "owner") return;
    void refreshLive(false);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshLive(true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshLive, snapshot?.account.role, tab]);

  useEffect(() => () => {
    if (emergencyTimer.current) window.clearTimeout(emergencyTimer.current);
  }, []);

  const market = snapshot?.market ?? null;
  const governor = snapshot?.traders?.executionGovernor ?? null;
  const account = snapshot?.orders?.account ?? null;
  const trades = snapshot?.orders?.trades ?? [];
  const openTrades = snapshot?.orders?.openTrades ?? snapshot?.scanner?.openTrades ?? [];
  const opportunities = snapshot?.opportunities ?? [];
  const filteredOpportunities = useMemo(() => opportunities.filter((item) => radarFilter === "ALL" || item.state === radarFilter), [opportunities, radarFilter]);
  const topOpportunities = useMemo(() => [...opportunities].sort((a, b) => {
    const rank = (state: OpportunityState) => state === "TRADE" ? 3 : state === "WATCH" ? 2 : 1;
    return rank(b.state) - rank(a.state) || b.opportunityScore - a.opportunityScore;
  }).slice(0, 4), [opportunities]);
  const universe = useMemo(() => [...(snapshot?.scanner?.universe ?? [])].sort((a, b) => Math.abs(b.coarseScore) - Math.abs(a.coarseScore)).slice(0, 18), [snapshot?.scanner?.universe]);
  const closedTrades = useMemo(() => trades.filter((trade) => trade.status === "closed").sort((a, b) => (b.exitAt ?? b.entryAt) - (a.exitAt ?? a.entryAt)), [trades]);
  const activeLiveOrders = live?.orders?.filter((order) => ["submitting", "open", "protected", "closing"].includes(order.state)) ?? [];
  const closedLiveOrders = live?.orders?.filter((order) => order.state === "closed") ?? [];

  const mutate = useCallback(async (url: string, init: RequestInit, success: string, liveRefresh = false) => {
    setMutationMessage("处理中…");
    try {
      await readJson<Record<string, unknown>>(url, init);
      setMutationMessage(success);
      if (liveRefresh) await refreshLive(true);
      await refreshMain(true);
    } catch (error) {
      setMutationMessage(error instanceof Error ? error.message : "操作失败");
    }
  }, [refreshLive, refreshMain]);

  const toggleLive = () => {
    const enabled = !(live?.control.entryEnabled ?? false);
    void mutate("/api/live/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }, enabled ? "已请求开启 Auto Live" : "已关闭 Auto Live 新开仓", true);
  };

  const saveCredentials = () => {
    if (!apiKey || !apiSecret || !permissionsConfirmed) {
      setMutationMessage("请填写 API Key / Secret，并确认只授予合约交易所需权限。请勿授予提币权限。");
      return;
    }
    void mutate("/api/live/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, apiSecret, permissionsConfirmed }),
    }, "Gate 实盘凭据已验证保存；Auto Live 仍保持原开关状态。", true).then(() => {
      setApiKey("");
      setApiSecret("");
      setPermissionsConfirmed(false);
    });
  };

  const startEmergencyHold = () => {
    if (emergencyTimer.current) window.clearTimeout(emergencyTimer.current);
    emergencyTimer.current = window.setTimeout(() => {
      emergencyTimer.current = null;
      void mutate("/api/live/emergency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      }, "紧急停机已执行，正在核对 Gate 仓位与保护单。", true);
    }, 1_200);
  };

  const cancelEmergencyHold = () => {
    if (!emergencyTimer.current) return;
    window.clearTimeout(emergencyTimer.current);
    emergencyTimer.current = null;
  };

  const saveSettings = () => {
    const coreSymbols = coreSymbolsText.split(/[,，\s]+/).map((item) => item.trim().toUpperCase()).filter(Boolean).map((item) => item.includes("_") ? item : `${item}_USDT`);
    if (!coreSymbols.length) {
      setMutationMessage("核心观察币种至少保留 1 个。");
      return;
    }
    void mutate("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreSymbols }),
    }, "核心观察币种已更新。", false);
  };

  const toggleScan = () => {
    const enabled = !(snapshot?.scanner?.settings.scanEnabled ?? true);
    void mutate("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanEnabled: enabled }),
    }, enabled ? "市场扫描已开启。" : "市场扫描已暂停。", false);
  };

  return <main className="hte-root">
    <header className="hte-header">
      <div className="hte-brand">
        <div className="hte-mark"><span /></div>
        <div><b>Sentinel</b><span>HUMAN TRADER ENGINE 3.0</span></div>
      </div>
      <div className="hte-header-status">
        <span className={`hte-dot ${snapshot?.degraded || mainError ? "warn" : "ok"}`} />
        <div><b>{mainError ? "连接异常" : snapshot?.degraded ? "局部降级" : loading ? "同步中" : "运行中"}</b><span>{snapshot ? `更新 ${fmtTime(snapshot.observedAt)}` : "正在读取系统"}</span></div>
      </div>
    </header>

    {(mainError || snapshot?.scanner?.error) && <div className="hte-banner warning"><b>系统仍保持可操作</b><span>{mainError || snapshot?.scanner?.error}</span></div>}
    {mutationMessage && <button type="button" className="hte-banner action" onClick={() => setMutationMessage("")}><span>{mutationMessage}</span><b>关闭</b></button>}

    <section className="hte-content">
      {tab === "总览" && <>
        <section className="hte-hero">
          <div className="hte-hero-main">
            <span className="eyebrow">MARKET REGIME</span>
            <div className="hte-regime-line"><h1>{market?.regimeLabel ?? "等待市场快照"}</h1><span className={`hte-permission permission-${(market?.permission ?? "BLUE").toLowerCase()}`}>{market?.permission ?? "--"}</span></div>
            <p>{market?.topDrivers?.slice(0, 2).join(" · ") || "系统正在等待后台扫描器生成最新环境状态。"}</p>
            <div className="hte-hero-grid">
              <div><span>环境置信</span><b>{market?.confidence ?? "--"}<small>%</small></b></div>
              <div><span>稳定度</span><b>{market?.stability ?? "--"}<small>%</small></b></div>
              <div><span>切换风险</span><b>{market?.transitionRisk ?? "--"}<small>%</small></b></div>
              <div><span>方向偏置</span><b>{market?.bias === "LONG" ? "偏多" : market?.bias === "SHORT" ? "偏空" : market?.bias === "NEUTRAL" ? "中性" : "--"}</b></div>
            </div>
          </div>
          <aside className={`hte-governor governor-${(governor?.state ?? "NORMAL").toLowerCase()}`}>
            <span className="eyebrow">RISK GOVERNOR</span>
            <div className="hte-governor-state"><i /><strong>{governor?.state ?? "LOADING"}</strong></div>
            <p>{governor?.reason ?? "正在读取 Human Trader 专属风险状态。"}</p>
            <div className="hte-governor-foot"><span>连续亏损</span><b>{governor?.lossStreak ?? 0} 笔</b></div>
          </aside>
        </section>

        <section className="hte-section">
          <div className="hte-section-title"><div><span className="eyebrow">3 INDEPENDENT TRADERS</span><h2>三位交易员，各自等自己的机会</h2></div><small>不投票 · 不加分凑单 · 一单一主交易员</small></div>
          <div className="hte-trader-grid">
            {(snapshot?.traders?.strategies ?? []).map((trader, index) => {
              const copy = TRADER_COPY[trader.id] ?? { short: trader.label, thesis: "独立 Setup" };
              return <article className="hte-trader-card" key={trader.id}>
                <div className="hte-trader-index">0{index + 1}</div>
                <div className="hte-trader-title"><span>{trader.label.split(" ")[0]}</span><h3>{copy.short.replace(/^\w+\s*/, "")}</h3></div>
                <p>{copy.thesis}</p>
                <div className="hte-trader-stats">
                  <div><span>样本</span><b>{trader.stats.sampleCount}</b></div>
                  <div><span>胜率</span><b>{trader.stats.winRate == null ? "--" : `${Math.round(trader.stats.winRate * 100)}%`}</b></div>
                  <div><span>PF</span><b>{fmtRatio(trader.stats.profitFactor)}</b></div>
                  <div><span>均净收益</span><b>{fmtPct(trader.stats.averageNetPct)}</b></div>
                </div>
                <div className="hte-trader-foot"><span>{trader.openCount ? `当前 ${trader.openCount} 笔持仓` : "当前空仓"}</span><span>{trader.stats.sampleCount < 12 ? "冷启动学习" : "已有独立样本"}</span></div>
              </article>;
            })}
            {!snapshot?.traders?.strategies?.length && <EmptyState title="等待交易员状态" detail="新系统从零开始建立每位交易员自己的样本。" />}
          </div>
        </section>

        <section className="hte-section">
          <div className="hte-section-title"><div><span className="eyebrow">NOW</span><h2>当前最值得看的机会</h2></div><button type="button" onClick={() => setTab("雷达")}>打开完整雷达</button></div>
          <div className="hte-opportunity-list">
            {topOpportunities.map((item) => <OpportunityCard item={item} key={`${item.symbol}:${item.playbook}`} />)}
            {!topOpportunities.length && <EmptyState title="现在没有完整 Setup" detail="这是正常状态。三位交易员没有自己的 Trigger 时，系统宁愿等待也不会为了出单而放宽条件。" />}
          </div>
        </section>

        <section className="hte-two-column">
          <article className="hte-panel">
            <div className="hte-section-title compact"><div><span className="eyebrow">TRANSITION EARLY WARNING</span><h2>环境变化前兆</h2></div></div>
            {market ? <div className="hte-transition-list">
              <MetricBar label="趋势恶化" value={market.transition?.trendDeterioration ?? 0} />
              <MetricBar label="广度恶化" value={market.transition?.breadthDeterioration ?? 0} />
              <MetricBar label="资金流背离" value={market.transition?.flowDivergence ?? 0} />
              <MetricBar label="杠杆压力" value={market.transition?.leverageStress ?? 0} />
              <MetricBar label="波动切换" value={market.transition?.volatilityTransition ?? 0} />
              <MetricBar label="突破失败" value={market.transition?.breakoutFailure ?? 0} />
            </div> : <EmptyState title="等待环境数据" detail="后台扫描器尚未形成可信市场上下文。" />}
          </article>
          <article className="hte-panel">
            <div className="hte-section-title compact"><div><span className="eyebrow">WARNINGS</span><h2>当前风险事件</h2></div></div>
            <div className="hte-warning-list">
              {(snapshot?.warnings ?? market?.warnings ?? []).slice(0, 5).map((warning) => <div className="hte-warning-item" key={warning.id ?? warning.title}><span>{warning.level}</span><div><b>{warning.title}</b><p>{warning.detail}</p></div><strong>{warning.severity}</strong></div>)}
              {!(snapshot?.warnings ?? market?.warnings ?? []).length && <EmptyState title="暂无高优先级警报" detail="系统仍会持续观察资金流、OI、波动、广度和突破失败。" />}
            </div>
          </article>
        </section>
      </>}

      {tab === "雷达" && <>
        <section className="hte-page-head"><div><span className="eyebrow">OPPORTUNITY RADAR</span><h1>只展示三位交易员真正关心的状态</h1><p>排名分只负责排序；只有该交易员自己的 Router + Trigger + Invalidation 全部成立才可能进入 TRADE。</p></div><div className="hte-filter-row">{(["ALL", "TRADE", "WATCH", "REJECT"] as const).map((state) => <button key={state} className={radarFilter === state ? "active" : ""} onClick={() => setRadarFilter(state)}>{state === "ALL" ? "全部" : stateLabel(state)}</button>)}</div></section>
        <div className="hte-radar-grid">
          <section className="hte-opportunity-list">
            {filteredOpportunities.map((item) => <OpportunityCard item={item} key={`${item.symbol}:${item.playbook}`} />)}
            {!filteredOpportunities.length && <EmptyState title="没有符合筛选条件的机会" detail="这不是故障；Human Trader Engine 允许长时间等待。" />}
          </section>
          <aside className="hte-panel hte-universe-panel">
            <div className="hte-section-title compact"><div><span className="eyebrow">UNIVERSE</span><h2>市场扫描热度</h2></div><small>{snapshot?.scanner?.universe?.length ?? 0} 币种</small></div>
            <div className="hte-universe-list">{universe.map((ticker) => <div className="hte-universe-row" key={ticker.symbol}><div><b>{ticker.symbol.replace("_USDT", "")}</b><span>{fmtMoney(ticker.price)}</span></div><div><strong className={ticker.changePercentage >= 0 ? "positive" : "negative"}>{ticker.changePercentage >= 0 ? "+" : ""}{ticker.changePercentage.toFixed(2)}%</strong><span>粗筛 {Math.round(ticker.coarseScore)}</span></div></div>)}</div>
          </aside>
        </div>
      </>}

      {tab === "订单" && <>
        <section className="hte-page-head"><div><span className="eyebrow">SIMULATION LEDGER</span><h1>Human Trader 新账本</h1><p>旧 Strategy 2.0 / P1–P12 记录不进入这里，也不参与新学习。这里只统计本代 Human Trader Engine。</p></div></section>
        <section className="hte-account-strip">
          <div><span>模拟权益</span><b>{fmtMoney(account?.equityUsdt)}</b></div>
          <div><span>已实现</span><b className={(account?.realizedPnlUsdt ?? 0) >= 0 ? "positive" : "negative"}>{fmtMoney(account?.realizedPnlUsdt)}</b></div>
          <div><span>未实现</span><b className={(account?.unrealizedPnlUsdt ?? 0) >= 0 ? "positive" : "negative"}>{fmtMoney(account?.unrealizedPnlUsdt)}</b></div>
          <div><span>可用保证金</span><b>{fmtMoney(account?.availableMarginUsdt)}</b></div>
        </section>
        <section className="hte-section">
          <div className="hte-section-title"><div><span className="eyebrow">OPEN</span><h2>当前模拟持仓</h2></div><small>{openTrades.length} 笔</small></div>
          <div className="hte-order-list">{openTrades.map((trade) => <article className="hte-order-card" key={trade.id}><div className="hte-card-head"><div><div className="hte-symbol-row"><strong>{trade.symbol.replace("_USDT", "")}</strong><span>{traderNameFromRegime(trade.regime)}</span></div><small>{fmtTime(trade.entryAt)} · {trade.leverage}x · 风险 {fmtMoney(trade.riskBudgetUsdt)}</small></div><span className={`hte-side hte-${trade.side.toLowerCase()}`}>{sideLabel(trade.side)}</span></div><div className="hte-order-numbers"><div><span>入场</span><b>{fmtMoney(trade.entryPrice)}</b></div><div><span>现价</span><b>{fmtMoney(trade.lastPrice)}</b></div><div><span>止损</span><b>{fmtMoney(trade.currentStopPrice)}</b></div><div><span>TP2</span><b>{fmtMoney(trade.takeProfit2Price)}</b></div></div><div className="hte-pnl-line"><span>{trade.entryTrigger}</span><b className={trade.unrealizedNetUsdt >= 0 ? "positive" : "negative"}>{fmtMoney(trade.unrealizedNetUsdt)} · {fmtPct(trade.unrealizedNetPct)}</b></div></article>)}</div>
          {!openTrades.length && <EmptyState title="当前没有模拟持仓" detail="新账本从零开始；只有 HT1 / HT2 / HT3 的完整 Setup 才会生成新订单。" />}
        </section>
        <section className="hte-section">
          <div className="hte-section-title"><div><span className="eyebrow">CLOSED</span><h2>已平仓 · 新系统样本</h2></div><small>{closedTrades.length} 笔</small></div>
          <div className="hte-history-list">{closedTrades.slice(0, 50).map((trade) => <div className="hte-history-row" key={trade.id}><div><b>{trade.symbol.replace("_USDT", "")}</b><span>{traderNameFromRegime(trade.regime)} · {sideLabel(trade.side)}</span></div><div><b className={(trade.netPnlUsdt ?? 0) >= 0 ? "positive" : "negative"}>{fmtMoney(trade.netPnlUsdt)}</b><span>{trade.exitReason ?? "已结束"} · {fmtTime(trade.exitAt)}</span></div></div>)}</div>
          {!closedTrades.length && <EmptyState title="还没有新系统已平仓样本" detail="学习样本从 Human Trader Engine 3.0 上线后的新交易重新累计。" />}
        </section>
      </>}

      {tab === "实盘" && <>
        <section className="hte-page-head"><div><span className="eyebrow">GATE LIVE</span><h1>实盘是执行层，不是另一套策略</h1><p>实盘只接受 Human Trader Engine 已确认的新候选；Auto Live 默认关闭，保存 API 不会自动开启。</p></div></section>
        {snapshot?.account.role !== "owner" ? <EmptyState title="仅所有者可查看实盘" detail="成员账户只能查看市场、机会和模拟学习。" /> : <>
          {liveError && <div className="hte-banner warning"><b>实盘状态读取失败</b><span>{liveError}</span></div>}
          <section className="hte-live-control-grid">
            <article className="hte-panel hte-live-state">
              <span className="eyebrow">AUTO LIVE</span>
              <div className="hte-live-switch-line"><div><strong>{live?.control.entryEnabled ? "已开启" : "已关闭"}</strong><span>{live?.control.state ?? "读取中"}</span></div><button type="button" className={live?.control.entryEnabled ? "danger" : "primary"} onClick={toggleLive} disabled={!live}>{live?.control.entryEnabled ? "关闭新开仓" : "开启 Auto Live"}</button></div>
              <p>{live?.performanceGate?.passed === false ? live.performanceGate.reason : "开启后仍需 Performance Gate、组合风险、滑点、保证金和保护单全部通过。"}</p>
              <div className="hte-live-actions"><button type="button" onClick={() => void mutate("/api/live/reconcile", { method: "POST" }, "Gate 对账已完成。", true)}>立即对账</button>{live?.control.state === "emergency_stopped" ? <button type="button" onClick={() => void mutate("/api/live/emergency", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset" }) }, "紧急停机锁已解除；Auto Live 仍保持关闭。", true)}>解除停机锁</button> : <button type="button" className="emergency" onPointerDown={startEmergencyHold} onPointerUp={cancelEmergencyHold} onPointerCancel={cancelEmergencyHold} onPointerLeave={cancelEmergencyHold}>按住 1.2 秒紧急停机</button>}</div>
            </article>
            <article className="hte-panel">
              <span className="eyebrow">GATE API</span>
              {live?.credential.configured ? <div className="hte-credential-state"><div><strong>已配置</strong><span>{live.credential.keyHint ?? "Gate Live"} · {live.credential.status ?? "verified"}</span></div><button type="button" onClick={() => void mutate("/api/live/credentials", { method: "DELETE" }, "Gate API 凭据已删除；Auto Live 已保持关闭。", true)}>删除凭据</button></div> : <div className="hte-credential-form"><label><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><label><span>API Secret</span><input type="password" autoComplete="off" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} /></label><label className="hte-checkbox"><input type="checkbox" checked={permissionsConfirmed} onChange={(event) => setPermissionsConfirmed(event.target.checked)} /><span>确认只使用 Gate 实盘合约交易所需权限，不授予提币权限。</span></label><button type="button" className="primary" onClick={saveCredentials}>验证并保存</button></div>}
            </article>
          </section>
          <section className="hte-section">
            <div className="hte-section-title"><div><span className="eyebrow">ACTIVE LIVE ORDERS</span><h2>真实持仓 / 活动订单</h2></div><small>{activeLiveOrders.length} 笔</small></div>
            <div className="hte-order-list">{activeLiveOrders.map((order) => <article className="hte-order-card" key={order.id}><div className="hte-card-head"><div><div className="hte-symbol-row"><strong>{order.symbol.replace("_USDT", "")}</strong><span>{order.strategyLabel ?? "Human Trader"}</span></div><small>{order.state} · {order.leverage}x · {order.marginMode}</small></div><span className={`hte-side hte-${order.side.toLowerCase()}`}>{sideLabel(order.side)}</span></div><div className="hte-order-numbers"><div><span>参考价</span><b>{fmtMoney(order.referencePrice)}</b></div><div><span>成交价</span><b>{fmtMoney(order.fillPrice)}</b></div><div><span>止损</span><b>{fmtMoney(order.stopLossPrice)}</b></div><div><span>止盈</span><b>{fmtMoney(order.takeProfitPrice)}</b></div></div>{order.strategyThesis && <p className="hte-order-thesis">{order.strategyThesis}</p>}</article>)}</div>
            {!activeLiveOrders.length && <EmptyState title="当前没有真实活动订单" detail="已有真实仓位如果存在，会继续由独立 Order Lifecycle 管理；部署不会为了重置数据而丢弃保护链。" />}
          </section>
          <section className="hte-section">
            <div className="hte-section-title"><div><span className="eyebrow">REALIZED</span><h2>实盘已平仓</h2></div><small>{closedLiveOrders.length} 笔</small></div>
            <div className="hte-history-list">{closedLiveOrders.slice(0, 30).map((order) => <div className="hte-history-row" key={order.id}><div><b>{order.symbol.replace("_USDT", "")}</b><span>{order.strategyLabel ?? "Human Trader"} · {sideLabel(order.side)}</span></div><div><b className={(order.realizedPnlUsdt ?? 0) >= 0 ? "positive" : "negative"}>{fmtMoney(order.realizedPnlUsdt)}</b><span>{order.strategyExitReason ?? order.state} · {fmtTime(order.closedAt)}</span></div></div>)}</div>
          </section>
        </>}
      </>}

      {tab === "设置" && <>
        <section className="hte-page-head"><div><span className="eyebrow">SYSTEM</span><h1>新系统只保留真正需要的控制项</h1><p>旧 Strategy 2.0 的评分阈值、Playbook 面板和旧学习记录不再作为可调参数暴露。</p></div></section>
        <section className="hte-settings-grid">
          <article className="hte-panel">
            <div className="hte-settings-title"><div><b>市场扫描</b><span>后台持续扫描与 Human Trader Setup 检测</span></div><button type="button" className={snapshot?.scanner?.settings.scanEnabled ? "primary" : ""} onClick={toggleScan}>{snapshot?.scanner?.settings.scanEnabled ? "已开启" : "已暂停"}</button></div>
            <label className="hte-setting-field"><span>核心观察币种</span><textarea value={coreSymbolsText} onChange={(event) => setCoreSymbolsText(event.target.value)} rows={3} placeholder="BTC, ETH, SOL, HYPE" /></label>
            <button type="button" onClick={saveSettings}>保存核心币种</button>
          </article>
          <article className="hte-panel">
            <span className="eyebrow">FRESH START</span><h3>Human Trader Engine 3.0 新账本</h3><p>旧策略交易、旧学习记忆、旧机会缓存和旧市场快照会在本次迁移中重置。只有仍关联真实活动 Gate 订单的 trade case 会暂时保留，直到真实订单安全结束。</p>
            <div className="hte-reset-facts"><div><span>新学习</span><b>HT1 / HT2 / HT3 独立</b></div><div><span>模拟初始资金</span><b>{fmtMoney(snapshot?.scanner?.settings.trialCapitalUsdt)}</b></div><div><span>旧数据</span><b>不参与新统计</b></div></div>
          </article>
          <article className="hte-panel">
            <span className="eyebrow">RISK POLICY</span><h3>执行安全边界</h3><div className="hte-risk-list"><div><span>单笔风险</span><b>{snapshot?.scanner?.settings.riskPolicy?.singleTradeLossPct ?? 1}%</b></div><div><span>TP2 最低净利润</span><b>{snapshot?.scanner?.settings.riskPolicy?.minimumTp2NetProfitPct ?? 1.5}%</b></div><div><span>单笔保证金上限</span><b>{snapshot?.scanner?.settings.riskPolicy?.maxMarginAllocationPct ?? 20}%</b></div><div><span>日亏损暂停</span><b>{snapshot?.scanner?.settings.riskPolicy?.dailyRealizedLossPausePct ?? 3}%</b></div><div><span>峰值回撤保护</span><b>{snapshot?.scanner?.settings.riskPolicy?.peakDrawdownPct ?? 10}%</b></div></div>
          </article>
          <article className="hte-panel">
            <span className="eyebrow">RUNTIME</span><h3>运行状态</h3><div className="hte-risk-list"><div><span>主快照来源</span><b>{snapshot?.scanner?.snapshotSource ?? "--"}</b></div><div><span>快照年龄</span><b>{snapshot?.scanner?.snapshotAgeMs == null ? "--" : `${Math.round(snapshot.scanner.snapshotAgeMs / 1000)} 秒`}</b></div><div><span>最后扫描</span><b>{fmtTime(snapshot?.orders?.lastScan?.startedAt)}</b></div><div><span>页面数据版本</span><b>HTE 3.0</b></div></div><button type="button" onClick={() => void refreshMain(false)}>立即刷新</button>
          </article>
        </section>
      </>}
    </section>

    <nav className="hte-bottom-nav" aria-label="主导航">
      {TABS.map((item) => <button type="button" key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}><span className="hte-nav-icon" aria-hidden="true">{item === "总览" ? "◫" : item === "雷达" ? "⌁" : item === "订单" ? "≡" : item === "实盘" ? "◆" : "⚙"}</span><b>{item}</b></button>)}
    </nav>
  </main>;
}
