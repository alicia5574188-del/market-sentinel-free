"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type Market = {
  regime: string;
  regimeLabel: string;
  confidence: number;
  stability: number;
  transitionRisk: number;
  transitionVelocity: number;
  permission: "GREEN" | "BLUE" | "YELLOW" | "ORANGE" | "RED";
  bias: "LONG" | "SHORT" | "NEUTRAL";
  breadth: { advancingRatio: number; decliningRatio: number };
  volatility: { dispersionPct: number; state: string };
  leverage: { crowdedRatio: number; state: string };
  transition: Record<string, number>;
  warnings: Warning[];
  topDrivers: string[];
};

type Warning = { id: string; level: string; severity: number; title: string; detail: string; impact: string };

type Opportunity = {
  symbol: string;
  playbook: string;
  playbookLabel: string;
  side: "LONG" | "SHORT" | "WAIT";
  state: "TRADE" | "WATCH" | "REJECT";
  tradeMode?: "exploration" | "standard" | "high_conviction";
  opportunityScore: number;
  environmentFit: number;
  structure: number;
  timing: number;
  confirmation: number;
  riskReward: number;
  portfolioImpact: number;
  riskMultiplier: number;
  assetRegime?: string;
  experienceSamples?: number;
  expectancyR?: number | null;
  strategyConflict?: number;
  waitingFor: string[];
  rejectReasons: string[];
  reasons: string[];
  maxRisk: string | null;
};

type StrategyPool = {
  windowMinutes: number;
  evaluations: number;
  symbols: number;
  playbookCount: number;
  playbooks: string[];
  states: { trade: number; watch: number; reject: number };
};

type LearningStage = "exploration" | "calibrating" | "validated" | "negative_edge";
type LearningCell = {
  key: string;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  side: "LONG" | "SHORT";
  sampleCount: number;
  winRate: number | null;
  expectancyR: number | null;
  stage: LearningStage;
  riskAction: string;
};
type LearningTrade = {
  tradeId: string;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  side: "LONG" | "SHORT";
  resultR: number;
  cellSamples: number;
  cellExpectancyR: number | null;
  stage: LearningStage;
  riskAction: string;
};
type Learning = {
  totalSamples: number;
  playbookCoverage: number;
  exactCellCount: number;
  positiveCells: number;
  negativeCells: number;
  cells: LearningCell[];
  recentTrades: LearningTrade[];
};

type Thesis = { tradeId: string; playbook: string; entryRegime: string; currentRegime: string; thesisHealth: number };
type Packet = {
  observedAt: number;
  version: string;
  market: Market | null;
  opportunities: Opportunity[];
  strategyPool: StrategyPool | null;
  learning: Learning | null;
  warnings: Warning[];
  theses: Thesis[];
  portfolio: null | {
    openCount: number;
    longCount: number;
    shortCount: number;
    directionConcentration: number;
    riskLevel: string;
    currentAction: string;
    averageThesisHealth: number | null;
    weakestThesisHealth: number | null;
  };
  error?: string;
};

type Targets = {
  opportunity: HTMLElement | null;
  radar: HTMLElement | null;
  orders: HTMLElement | null;
  card: HTMLElement | null;
  confidence: HTMLElement | null;
  action: HTMLElement | null;
  trigger: HTMLElement | null;
  counter: HTMLElement | null;
  symbol: string | null;
};

const PERMISSION: Record<Market["permission"], string> = { GREEN: "正常参与", BLUE: "避免追价", YELLOW: "缩小风险", ORANGE: "只做最强机会", RED: "停止新增风险" };
const STATE: Record<Opportunity["state"], string> = { TRADE: "允许交易", WATCH: "继续观察", REJECT: "拒绝交易" };
const STAGE: Record<LearningStage, string> = { exploration: "探索", calibrating: "校准", validated: "已验证", negative_edge: "负优势" };
const REJECT: Record<string, string> = {
  DATA_UNSAFE: "市场数据不完整或不可靠",
  TRANSITION_HIGH: "环境切换风险过高",
  RR_LOW: "预期盈亏比不足",
  PORTFOLIO_CONCENTRATION: "组合风险过度集中",
  CHASE_TOO_FAR: "价格已经偏离合理进场位置",
  LEVERAGE_EXTREME: "杠杆拥挤程度过高",
  LEARNED_EDGE_NEGATIVE: "该环境×策略组合的历史优势已经显著转负",
};

function normalizeSymbol(value: string | null) {
  const compact = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!compact) return null;
  if (compact.includes("_")) return compact;
  return compact.endsWith("USDT") ? `${compact.slice(0, -4)}_USDT` : compact;
}

function findTargets(): Targets {
  const opportunity = document.querySelector<HTMLElement>(".market-status");
  const radar = Array.from(document.querySelectorAll<HTMLElement>(".utility-card")).find((card) => Boolean(card.querySelector(".data-table") && card.querySelector(".event-list"))) ?? null;
  const orders = document.querySelector<HTMLElement>(".order-ledger");
  const card = document.querySelector<HTMLElement>(".decision-card:not(.loading-card)");
  return {
    opportunity,
    radar,
    orders,
    card,
    confidence: card?.querySelector<HTMLElement>(".confidence") ?? null,
    action: card?.querySelector<HTMLElement>(".action-callout") ?? null,
    trigger: card?.querySelector<HTMLElement>(".trigger-row") ?? null,
    counter: card?.querySelector<HTMLElement>(".counter-section") ?? null,
    symbol: normalizeSymbol(card?.querySelector<HTMLElement>(".ticker-line strong")?.textContent ?? null),
  };
}

function setText(node: HTMLElement | null | undefined, value: string) {
  if (node && node.textContent !== value) node.textContent = value;
}

function relabelShell() {
  const radar = Array.from(document.querySelectorAll<HTMLElement>(".utility-card")).find((card) => Boolean(card.querySelector(".data-table") && card.querySelector(".event-list")));
  setText(radar?.querySelector<HTMLElement>(".utility-heading .eyebrow"), "Strategy 2.0 数据与事件");
  setText(radar?.querySelector<HTMLElement>(".utility-heading strong"), "环境变化 + 数据源健康 + 高影响事件");

  const orders = document.querySelector<HTMLElement>(".order-ledger");
  setText(orders?.querySelector<HTMLElement>(".utility-heading .eyebrow"), "Strategy 2.0 模拟交易账户");
  setText(orders?.querySelector<HTMLElement>(".utility-heading strong"), "交易 → 持仓 → 平仓 → 环境×策略学习");
  setText(orders?.querySelector<HTMLElement>(".calibration-title span"), "Strategy 2.0 机会评分校准");
  setText(orders?.querySelector<HTMLElement>(".calibration-title small"), "入场评分 vs 实际正收益");

  document.querySelectorAll<HTMLElement>(".lesson-card .section-title").forEach((section) => {
    setText(section.querySelector<HTMLElement>("span"), "本单复盘已进入 Strategy 2.0 学习记录");
    setText(section.querySelector<HTMLElement>("small"), "结构化结果已纳入经验矩阵");
  });
}

function PermissionBadge({ market }: { market: Market }) {
  return <span className={`v2-permission v2-${market.permission.toLowerCase()}`}>{market.permission} · {PERMISSION[market.permission]}</span>;
}

function MarketStrip({ market }: { market: Market }) {
  return <div className="v2-market-strip">
    <div><span>Global Regime</span><strong>{market.regimeLabel}</strong><small>置信 {market.confidence}</small></div>
    <div><span>稳定度</span><strong>{market.stability}</strong><small>/100</small></div>
    <div><span>切换风险</span><strong className={market.transitionRisk >= 61 ? "v2-danger" : market.transitionRisk >= 41 ? "v2-warn" : "v2-good"}>{market.transitionRisk}</strong><small>{market.transitionVelocity > 0 ? `↑ +${market.transitionVelocity.toFixed(1)}/h` : `${market.transitionVelocity.toFixed(1)}/h`}</small></div>
    <div><span>方向背景</span><strong>{market.bias}</strong><small>{market.volatility.state}</small></div>
  </div>;
}

function StrategyPoolPanel({ pool }: { pool: StrategyPool | null }) {
  const covered = pool?.playbooks.map((value) => value.match(/^P\d+/)?.[0] ?? value).join(" · ") ?? "等待策略池数据";
  return <div className="strategy2-pool">
    <div className="strategy2-pool-head"><strong>12 Playbook 并行策略池</strong><span>Playbook {pool?.playbookCount ?? 0}/12</span></div>
    <p>{pool ? `近 ${pool.windowMinutes} 分钟 ${pool.evaluations} 次评估 · ${pool.symbols} 个币 · TRADE ${pool.states.trade} / WATCH ${pool.states.watch} / REJECT ${pool.states.reject}` : "正在读取策略池活动"}</p>
    <small>{covered}</small>
  </div>;
}

function OpportunityPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const trade = packet.opportunities.filter((item) => item.state === "TRADE").sort((a, b) => b.opportunityScore - a.opportunityScore);
  const watch = packet.opportunities.filter((item) => item.state === "WATCH").sort((a, b) => b.opportunityScore - a.opportunityScore);
  const reject = packet.opportunities.filter((item) => item.state === "REJECT");
  const featured = [...trade, ...watch].slice(0, 3);
  return <div className="v2-panel v2-opportunity-panel">
    <div className="v2-panel-head"><div><span>Sentinel Strategy 2.0</span><strong>环境识别 · 多策略竞争 · 小风险探索</strong></div><PermissionBadge market={market}/></div>
    <MarketStrip market={market}/>
    <StrategyPoolPanel pool={packet.strategyPool}/>
    <div className="v2-state-counts"><span className="trade">TRADE <b>{trade.length}</b></span><span className="watch">WATCH <b>{watch.length}</b></span><span className="reject">REJECT <b>{reject.length}</b></span></div>
    {featured.length > 0 && <div className="v2-featured-list">{featured.map((item) => <div className={`v2-opportunity ${item.state.toLowerCase()}`} key={`${item.symbol}-${item.playbook}`}><div><strong>{item.symbol.replace("_", "")} · {item.side}</strong><span>{item.playbookLabel}</span></div><b>{item.opportunityScore}</b><p>{item.state === "TRADE" ? item.reasons[0] : item.waitingFor[0] ?? "继续等待确认"}</p><small>环境 {item.environmentFit} · 结构 {item.structure} · 时机 {item.timing} · 确认 {item.confirmation} · RR {item.riskReward.toFixed(1)} · 风险 {(item.riskMultiplier * 100).toFixed(0)}%</small></div>)}</div>}
  </div>;
}

function SelectedScore({ opportunity }: { opportunity: Opportunity }) {
  return <div className="strategy2-selected-score"><span>机会评分</span><strong>{opportunity.opportunityScore}</strong><small>/100</small></div>;
}

function SelectedAction({ opportunity, market }: { opportunity: Opportunity; market: Market }) {
  const explanation = opportunity.state === "REJECT" ? opportunity.rejectReasons.map((reason) => REJECT[reason] ?? reason).join("；") : opportunity.state === "WATCH" ? opportunity.waitingFor.join("；") : opportunity.reasons[0] ?? "Strategy 2.0 条件已满足";
  const mode = opportunity.tradeMode === "exploration" ? "探索" : opportunity.tradeMode === "high_conviction" ? "高置信" : "标准";
  return <div className="strategy2-selected-action">
    <div className="strategy2-selected-action-head"><span className={`strategy2-selected-state ${opportunity.state.toLowerCase()}`}>{opportunity.state} · {STATE[opportunity.state]}</span><strong>{opportunity.playbookLabel} · {mode}</strong></div>
    <h3>{opportunity.side === "WAIT" ? "保持空仓" : `${opportunity.side} · ${STATE[opportunity.state]}`}</h3><p>{explanation}</p>
    <div className="strategy2-selected-scores"><div><span>环境</span><strong>{opportunity.environmentFit}</strong></div><div><span>结构</span><strong>{opportunity.structure}</strong></div><div><span>时机</span><strong>{opportunity.timing}</strong></div><div><span>确认</span><strong>{opportunity.confirmation}</strong></div></div>
    <div className="strategy2-selected-meta"><span>Global {market.regimeLabel}</span><span>Asset {opportunity.assetRegime ?? "--"}</span><span>样本 {opportunity.experienceSamples ?? 0}</span><span>Expectancy {opportunity.expectancyR == null ? "--" : `${opportunity.expectancyR.toFixed(2)}R`}</span><span>冲突 {opportunity.strategyConflict ?? 0}</span><span>风险 {(opportunity.riskMultiplier * 100).toFixed(0)}%</span></div>
  </div>;
}

function SelectedNext({ opportunity }: { opportunity: Opportunity }) {
  const items = opportunity.state === "REJECT" ? opportunity.rejectReasons.map((reason) => REJECT[reason] ?? reason) : opportunity.state === "WATCH" ? opportunity.waitingFor : ["Strategy 2.0 已通过，等待组合风险、仓位与 Execution Engine 最终复核"];
  return <div className="strategy2-selected-next"><span>{opportunity.state === "TRADE" ? "执行前复核" : opportunity.state === "WATCH" ? "还差什么" : "为什么拒绝"}</span><ul>{(items.length ? items : ["继续等待更高质量确认"]).slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>{opportunity.maxRisk && <strong>最大风险：{opportunity.maxRisk}</strong>}<strong className="strategy2-execution-note">Strategy 2.0 通过后仍需组合风险与 Execution Engine 复核；实盘总开关始终拥有最终权限。</strong></div>;
}

function RadarPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const warnings = (market.warnings.length ? market.warnings : packet.warnings).slice(0, 5);
  return <div className="v2-panel v2-radar-panel">
    <div className="v2-panel-head"><div><span>MARKET PULSE · STRATEGY 2.0</span><strong>环境变化雷达</strong></div><PermissionBadge market={market}/></div>
    <MarketStrip market={market}/>
    <div className="v2-transition-grid">{Object.entries(market.transition).sort((a, b) => b[1] - a[1]).map(([key, value]) => <div key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><strong className={value >= 70 ? "v2-danger" : value >= 50 ? "v2-warn" : ""}>{Math.round(value)}</strong><i><b style={{ width: `${Math.min(100, Math.max(0, value))}%` }}/></i></div>)}</div>
    <div className="v2-pulse-meta"><span>广度：涨 {(market.breadth.advancingRatio * 100).toFixed(0)}% / 跌 {(market.breadth.decliningRatio * 100).toFixed(0)}%</span><span>波动：{market.volatility.state} · 离散 {market.volatility.dispersionPct.toFixed(2)}%</span><span>杠杆：{market.leverage.state} · 拥挤 {(market.leverage.crowdedRatio * 100).toFixed(0)}%</span></div>
    <div className="v2-warning-list">{warnings.length ? warnings.map((warning) => <div key={warning.id}><span className={`v2-warning-level ${warning.level.toLowerCase()}`}>{warning.level}</span><div><strong>{warning.title}</strong><p>{warning.detail}</p><small>{warning.impact}</small></div><b>{warning.severity}</b></div>) : <p>当前没有达到展示阈值的环境异常。</p>}</div>
  </div>;
}

function learningClass(stage: LearningStage, expectancy: number | null) {
  if (stage === "negative_edge" || (expectancy ?? 0) < -0.10) return "strategy2-negative";
  if (stage === "validated" && (expectancy ?? 0) > 0) return "strategy2-positive";
  return "strategy2-neutral";
}

function LearningPanel({ learning }: { learning: Learning | null }) {
  if (!learning) return <div className="strategy2-learning"><div className="strategy2-learning-head"><strong>Strategy 2.0 学习矩阵</strong><span>正在读取</span></div></div>;
  const recent = learning.recentTrades.slice(0, 4);
  const cells = learning.cells.slice(0, 5);
  return <div className="strategy2-learning">
    <div className="strategy2-learning-head"><strong>Strategy 2.0 学习矩阵</strong><span>Global × Asset × Playbook × Direction</span></div>
    <div className="strategy2-learning-stats"><div><span>真实完成样本</span><strong>{learning.totalSamples}</strong></div><div><span>已覆盖 Playbook</span><strong>{learning.playbookCoverage}/12</strong></div><div><span>精确环境单元</span><strong>{learning.exactCellCount}</strong></div><div><span>正/负优势单元</span><strong>{learning.positiveCells}/{learning.negativeCells}</strong></div></div>
    {recent.length ? <div className="strategy2-learning-list">{recent.map((item) => <div className="strategy2-learning-row" key={item.tradeId}><div><strong>{item.playbook} · {item.side}</strong><b className={item.resultR >= 0 ? "strategy2-positive" : "strategy2-negative"}>{item.resultR >= 0 ? "+" : ""}{item.resultR.toFixed(2)}R</b></div><p>Global {item.globalRegime} · Asset {item.assetRegime} · 该单元样本 {item.cellSamples}</p><small className={learningClass(item.stage, item.cellExpectancyR)}>{STAGE[item.stage]} · Expectancy {item.cellExpectancyR == null ? "--" : `${item.cellExpectancyR.toFixed(2)}R`} · {item.riskAction}</small></div>)}</div> : <p className="v2-order-note">当前还没有 Strategy 2.0 完整平仓样本。新交易会按环境×策略组合学习，不再汇总成“BTC LONG”旧记忆。</p>}
    {cells.length > 0 && <div className="strategy2-learning-list">{cells.map((cell) => <div className="strategy2-learning-row" key={cell.key}><div><strong>{cell.playbook} · {cell.side}</strong><b className={learningClass(cell.stage, cell.expectancyR)}>{STAGE[cell.stage]}</b></div><p>{cell.globalRegime} × {cell.assetRegime} · n={cell.sampleCount} · 胜率 {cell.winRate == null ? "--" : `${(cell.winRate * 100).toFixed(0)}%`}</p><small>{cell.riskAction}</small></div>)}</div>}
  </div>;
}

function OrdersPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const portfolio = packet.portfolio;
  const weakest = packet.theses.slice().sort((a, b) => a.thesisHealth - b.thesisHealth).slice(0, 3);
  return <div className="v2-panel v2-orders-panel">
    <div className="v2-panel-head"><div><span>PORTFOLIO + LEARNING · STRATEGY 2.0</span><strong>账户风险、交易逻辑与学习状态</strong></div><PermissionBadge market={market}/></div>
    <div className="v2-portfolio-grid"><div><span>活动持仓</span><strong>{portfolio?.openCount ?? 0}</strong><small>多 {portfolio?.longCount ?? 0} / 空 {portfolio?.shortCount ?? 0}</small></div><div><span>方向集中</span><strong>{portfolio?.directionConcentration ?? 0}%</strong><small>同方向风险</small></div><div><span>组合风险</span><strong className={portfolio?.riskLevel === "CRITICAL" || portfolio?.riskLevel === "HIGH" ? "v2-danger" : portfolio?.riskLevel === "ELEVATED" ? "v2-warn" : "v2-good"}>{portfolio?.riskLevel ?? "--"}</strong><small>Transition {market.transitionRisk}</small></div><div><span>平均 Thesis Health</span><strong className={(portfolio?.averageThesisHealth ?? 100) < 45 ? "v2-danger" : (portfolio?.averageThesisHealth ?? 100) < 65 ? "v2-warn" : "v2-good"}>{portfolio?.averageThesisHealth ?? "--"}</strong><small>最弱 {portfolio?.weakestThesisHealth ?? "--"}</small></div></div>
    {weakest.length > 0 && <div className="v2-thesis-list">{weakest.map((thesis) => <div key={thesis.tradeId}><span>{thesis.playbook}</span><strong className={thesis.thesisHealth < 45 ? "v2-danger" : thesis.thesisHealth < 65 ? "v2-warn" : "v2-good"}>{thesis.thesisHealth}</strong><small>{thesis.entryRegime} → {thesis.currentRegime}</small></div>)}</div>}
    <p className="v2-order-note">当前动作：{portfolio?.currentAction ?? PERMISSION[market.permission]}。学习矩阵只让历史经验调整评分和风险，不能突破安全上限。</p>
    <LearningPanel learning={packet.learning}/>
  </div>;
}

export function Strategy2Dashboard() {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [targets, setTargets] = useState<Targets>({ opportunity: null, radar: null, orders: null, card: null, confidence: null, action: null, trigger: null, counter: null, symbol: null });
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/v2", { cache: "no-store" });
        const next = await response.json() as Packet;
        if (active) setPacket(next);
      } catch {
        if (active) setPacket((current) => current ?? { observedAt: Date.now(), version: "strategy-2.0", market: null, opportunities: [], strategyPool: null, learning: null, warnings: [], theses: [], portfolio: null, error: "Strategy 2.0 数据暂不可用" });
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = findTargets();
      next.opportunity?.classList.add("strategy2-unified-market");
      relabelShell();
      setTargets((current) => current.opportunity === next.opportunity && current.radar === next.radar && current.orders === next.orders && current.card === next.card && current.symbol === next.symbol ? current : next);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => { setShowDetails(false); }, [targets.symbol]);

  const selected = useMemo(() => packet && targets.symbol ? packet.opportunities.find((item) => item.symbol === targets.symbol) ?? null : null, [packet, targets.symbol]);

  useEffect(() => {
    const card = targets.card;
    const controlled = [targets.confidence, targets.action, targets.trigger];
    const analysisHeading = card?.querySelector<HTMLElement>(".analysis-matrix")?.previousElementSibling as HTMLElement | null;
    if (analysisHeading) analysisHeading.classList.add("strategy2-analysis-heading");
    if (selected && card) {
      card.classList.add("strategy2-opportunity-detail-active");
      card.classList.toggle("strategy2-show-legacy-analysis", showDetails);
      controlled.forEach((target) => target?.classList.add("strategy2-overridden"));
    } else {
      card?.classList.remove("strategy2-opportunity-detail-active", "strategy2-show-legacy-analysis");
      controlled.forEach((target) => target?.classList.remove("strategy2-overridden"));
    }
  }, [selected, showDetails, targets.action, targets.card, targets.confidence, targets.trigger]);

  const market = packet?.market ?? null;
  return <>
    {targets.opportunity && createPortal(market && packet ? <OpportunityPanel packet={packet}/> : <div className="v2-panel v2-opportunity-panel"><div className="v2-panel-head"><div><span>Sentinel Strategy 2.0</span><strong>{packet?.error ?? "正在读取统一策略数据…"}</strong></div></div></div>, targets.opportunity)}
    {targets.radar && market && packet && createPortal(<RadarPanel packet={packet}/>, targets.radar)}
    {targets.orders && market && packet && createPortal(<OrdersPanel packet={packet}/>, targets.orders)}
    {selected && targets.confidence && createPortal(<SelectedScore opportunity={selected}/>, targets.confidence)}
    {selected && market && targets.action && createPortal(<SelectedAction opportunity={selected} market={market}/>, targets.action)}
    {selected && targets.trigger && createPortal(<SelectedNext opportunity={selected}/>, targets.trigger)}
    {selected && targets.counter && createPortal(<button type="button" className="strategy2-detail-toggle" onClick={() => setShowDetails((value) => !value)}>{showDetails ? "收起底层详细分析" : "查看底层详细分析"}</button>, targets.counter)}
  </>;
}
