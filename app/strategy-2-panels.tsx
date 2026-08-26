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
  riskAcceleration: number;
  permission: "GREEN" | "BLUE" | "YELLOW" | "ORANGE" | "RED";
  bias: "LONG" | "SHORT" | "NEUTRAL";
  breadth: { sampleSize: number; advancingRatio: number; decliningRatio: number; medianChangePct: number };
  volatility: { dispersionPct: number; ivPercentile: number | null; state: string };
  leverage: { crowdedRatio: number; averageFundingAbs: number; state: string };
  transition: Record<string, number>;
  warnings: Warning[];
  topDrivers: string[];
};

type Warning = {
  id: string;
  level: string;
  severity: number;
  confidence: number;
  relevance: number;
  title: string;
  detail: string;
  impact: string;
};

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
  globalRegime?: string;
  assetRegime?: string;
  experienceSamples?: number;
  expectancyR?: number | null;
  supportingPlaybooks?: string[];
  strategyConflict?: number;
  waitingFor: string[];
  rejectReasons: string[];
  reasons: string[];
  maxRisk: string | null;
};

type Thesis = {
  tradeId: string;
  playbook: string;
  entryRegime: string;
  currentRegime: string;
  entryTransitionRisk: number;
  currentTransitionRisk: number;
  thesisHealth: number;
  updatedAt: number;
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
  wins: number;
  losses: number;
  winRate: number | null;
  expectancyR: number | null;
  averageNetPct: number | null;
  stage: LearningStage;
  riskAction: string;
};

type LearningTrade = {
  tradeId: string;
  exitAt: number | null;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  side: "LONG" | "SHORT";
  netPct: number;
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

type PortalTargets = {
  opportunity: HTMLElement | null;
  radar: HTMLElement | null;
  orders: HTMLElement | null;
  decisionCard: HTMLElement | null;
  decisionConfidence: HTMLElement | null;
  decisionAction: HTMLElement | null;
  decisionTrigger: HTMLElement | null;
  decisionCounter: HTMLElement | null;
  selectedSymbol: string | null;
};

const PERMISSION_COPY: Record<Market["permission"], string> = {
  GREEN: "正常参与",
  BLUE: "避免追价",
  YELLOW: "缩小风险",
  ORANGE: "只做最强机会",
  RED: "停止新增风险",
};

const STATE_COPY: Record<Opportunity["state"], string> = {
  TRADE: "允许交易",
  WATCH: "继续观察",
  REJECT: "拒绝交易",
};

const REJECT_COPY: Record<string, string> = {
  DATA_UNSAFE: "市场数据不完整或不可靠",
  TRANSITION_HIGH: "环境切换风险过高",
  REGIME_CONFLICT: "个币机会与当前环境冲突",
  RR_LOW: "预期盈亏比不足",
  PORTFOLIO_CONCENTRATION: "加入后组合风险过度集中",
  CHASE_TOO_FAR: "价格已经偏离合理进场位置",
  LEVERAGE_EXTREME: "杠杆拥挤程度过高",
  LEARNED_EDGE_NEGATIVE: "该环境×策略组合的历史优势已经显著转负",
};

const STAGE_COPY: Record<LearningStage, string> = {
  exploration: "探索",
  calibrating: "校准",
  validated: "已验证",
  negative_edge: "负优势",
};

const UNIFIED_CSS = `
.market-status.strategy2-unified-market> :not(.v2-panel){display:none!important}
.order-ledger .memory-card{display:none!important}
.decision-card.strategy2-opportunity-detail-active .score-bars{display:none!important}
.decision-card.strategy2-opportunity-detail-active .confidence.strategy2-overridden>span,.decision-card.strategy2-opportunity-detail-active .confidence.strategy2-overridden>strong,.decision-card.strategy2-opportunity-detail-active .confidence.strategy2-overridden>small{display:none!important}
.decision-card.strategy2-opportunity-detail-active .action-callout.strategy2-overridden>.action-icon,.decision-card.strategy2-opportunity-detail-active .action-callout.strategy2-overridden>div:not(.strategy2-selected-action){display:none!important}
.decision-card.strategy2-opportunity-detail-active .trigger-row.strategy2-overridden>svg,.decision-card.strategy2-opportunity-detail-active .trigger-row.strategy2-overridden>div:not(.strategy2-selected-next){display:none!important}
.decision-card.strategy2-opportunity-detail-active .risk-note{display:none!important}
.decision-card.strategy2-opportunity-detail-active:not(.strategy2-show-legacy-analysis) .analysis-matrix,.decision-card.strategy2-opportunity-detail-active:not(.strategy2-show-legacy-analysis) .strategy2-analysis-heading{display:none!important}
.strategy2-selected-score{display:flex;align-items:baseline;justify-content:flex-end;gap:2px;width:100%}.strategy2-selected-score span{font-size:10px;color:#8290a7}.strategy2-selected-score strong{font-size:32px;line-height:1;color:#53cdf4}.strategy2-selected-score small{font-size:10px;color:#75839a}
.decision-card .action-callout.strategy2-overridden{display:block;padding:16px}.strategy2-selected-action{display:grid;gap:9px;width:100%}.strategy2-selected-action-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.strategy2-selected-state{padding:5px 8px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.04em;background:rgba(255,255,255,.05)}.strategy2-selected-state.trade{color:#62dfa2;background:rgba(53,199,129,.1)}.strategy2-selected-state.watch{color:#ffc45f;background:rgba(244,184,57,.1)}.strategy2-selected-state.reject{color:#ff7884;background:rgba(244,77,91,.12)}.strategy2-selected-action-head strong{font-size:11px;color:#9aa8bd}.strategy2-selected-action h3{margin:0;font-size:20px;color:#eef4ff}.strategy2-selected-action p{margin:0;color:#b5c0d1;font-size:12px;line-height:1.5}.strategy2-selected-scores{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.strategy2-selected-scores div{padding:8px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.055);display:flex;flex-direction:column;gap:2px}.strategy2-selected-scores span{font-size:9px;color:#78879d}.strategy2-selected-scores strong{font-size:14px}.strategy2-selected-meta{display:flex;gap:6px;flex-wrap:wrap}.strategy2-selected-meta span{font-size:9px;color:#8493aa;padding:5px 7px;border-radius:8px;background:rgba(255,255,255,.035)}
.decision-card .trigger-row.strategy2-overridden{display:block}.strategy2-selected-next{display:grid;gap:6px;width:100%}.strategy2-selected-next>span{font-size:10px;color:#7f8fa7}.strategy2-selected-next ul{list-style:none;margin:0;padding:0;display:grid;gap:4px}.strategy2-selected-next li{font-size:11px;line-height:1.4;color:#b8c3d4;padding-left:14px;position:relative}.strategy2-selected-next li:before{content:'•';position:absolute;left:2px;color:#56cfee}.strategy2-selected-next strong{font-size:11px;color:#aeb9ca}.strategy2-execution-note{font-size:9px!important;color:#718098!important;font-weight:500!important}
.strategy2-detail-toggle{margin:10px 0 0;width:100%;border:1px solid rgba(255,255,255,.08);border-radius:11px;padding:10px 12px;background:rgba(255,255,255,.025);color:#91a0b6;font-size:11px;font-weight:700;text-align:center}.strategy2-detail-toggle:active{background:rgba(255,255,255,.055)}
.strategy2-pool{margin:12px 0;padding:12px 14px;border-radius:14px;border:1px solid rgba(86,207,238,.18);background:rgba(28,93,119,.10)}.strategy2-pool-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}.strategy2-pool-head strong{font-size:12px;color:#dce9f7}.strategy2-pool-head span{font-size:11px;color:#62dfa2}.strategy2-pool p{margin:7px 0 0;font-size:11px;line-height:1.5;color:#93a5ba}.strategy2-pool small{display:block;margin-top:6px;font-size:10px;line-height:1.45;color:#74879d}
.strategy2-learning{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)}.strategy2-learning-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.strategy2-learning-head strong{font-size:13px;color:#e6eef9}.strategy2-learning-head span{font-size:10px;color:#7e90a7}.strategy2-learning-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:10px}.strategy2-learning-stats div{padding:9px;border-radius:10px;background:rgba(255,255,255,.035)}.strategy2-learning-stats span{display:block;font-size:9px;color:#77899f}.strategy2-learning-stats strong{display:block;margin-top:2px;font-size:15px;color:#eaf1fb}.strategy2-learning-list{display:grid;gap:7px;margin-top:10px}.strategy2-learning-row{padding:10px;border-radius:11px;border:1px solid rgba(255,255,255,.055);background:rgba(255,255,255,.025)}.strategy2-learning-row>div{display:flex;justify-content:space-between;gap:8px}.strategy2-learning-row strong{font-size:11px;color:#dce7f5}.strategy2-learning-row b{font-size:11px}.strategy2-learning-row p{margin:5px 0 0;font-size:10px;line-height:1.45;color:#8fa0b6}.strategy2-learning-row small{display:block;margin-top:5px;font-size:9px;color:#708198}.strategy2-positive{color:#62dfa2!important}.strategy2-negative{color:#ff7884!important}.strategy2-neutral{color:#ffc45f!important}
@media(max-width:480px){.strategy2-selected-scores,.strategy2-learning-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.strategy2-selected-action h3{font-size:18px}.strategy2-selected-score strong{font-size:29px}}
`;

function normalizeDisplayedSymbol(value: string | null) {
  const compact = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!compact) return null;
  if (compact.includes("_")) return compact;
  if (compact.endsWith("USDT")) return `${compact.slice(0, -4)}_USDT`;
  return compact;
}

function findTargets(): PortalTargets {
  const opportunity = document.querySelector<HTMLElement>(".market-status");
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".utility-card"));
  const radar = cards.find((card) => card.querySelector(".eyebrow")?.textContent?.includes("雷达")) ?? null;
  const orders = document.querySelector<HTMLElement>(".utility-card.order-ledger");
  const decisionCard = document.querySelector<HTMLElement>(".decision-card:not(.loading-card)");
  return {
    opportunity,
    radar,
    orders,
    decisionCard,
    decisionConfidence: decisionCard?.querySelector<HTMLElement>(".confidence") ?? null,
    decisionAction: decisionCard?.querySelector<HTMLElement>(".action-callout") ?? null,
    decisionTrigger: decisionCard?.querySelector<HTMLElement>(".trigger-row") ?? null,
    decisionCounter: decisionCard?.querySelector<HTMLElement>(".counter-section") ?? null,
    selectedSymbol: normalizeDisplayedSymbol(decisionCard?.querySelector<HTMLElement>(".ticker-line strong")?.textContent ?? null),
  };
}

function PermissionBadge({ permission }: { permission: Market["permission"] }) {
  return <span className={`v2-permission v2-${permission.toLowerCase()}`}>{permission} · {PERMISSION_COPY[permission]}</span>;
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
    <p>{pool ? `近 ${pool.windowMinutes} 分钟 ${pool.evaluations} 次评估 · ${pool.symbols} 个币 · TRADE ${pool.states.trade} / WATCH ${pool.states.watch} / REJECT ${pool.states.reject}` : "正在读取 Strategy 2.0 策略池活动"}</p>
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
    <div className="v2-panel-head"><div><span>Sentinel Strategy 2.0</span><strong>环境识别 · 多策略竞争 · 小风险探索</strong></div><PermissionBadge permission={market.permission}/></div>
    <MarketStrip market={market}/>
    <StrategyPoolPanel pool={packet.strategyPool}/>
    <div className="v2-state-counts"><span className="trade">TRADE <b>{trade.length}</b></span><span className="watch">WATCH <b>{watch.length}</b></span><span className="reject">REJECT <b>{reject.length}</b></span></div>
    {featured.length > 0 && <div className="v2-featured-list">{featured.map((item) => <div className={`v2-opportunity ${item.state.toLowerCase()}`} key={`${item.symbol}-${item.playbook}`}>
      <div><strong>{item.symbol.replace("_", "")} · {item.side}</strong><span>{item.playbookLabel}</span></div>
      <b>{item.opportunityScore}</b>
      <p>{item.state === "TRADE" ? item.reasons[0] : item.waitingFor[0] ?? "继续等待确认"}</p>
      <small>环境 {item.environmentFit} · 结构 {item.structure} · 时机 {item.timing} · 确认 {item.confirmation} · RR {item.riskReward.toFixed(1)} · 风险 {(item.riskMultiplier * 100).toFixed(0)}%</small>
    </div>)}</div>}
  </div>;
}

function SelectedScore({ opportunity }: { opportunity: Opportunity }) {
  return <div className="strategy2-selected-score"><span>机会评分</span><strong>{opportunity.opportunityScore}</strong><small>/100</small></div>;
}

function primaryExplanation(opportunity: Opportunity) {
  if (opportunity.state === "REJECT") return opportunity.rejectReasons.map((reason) => REJECT_COPY[reason] ?? reason).join("；") || "当前条件明确不适合交易";
  if (opportunity.state === "WATCH") return opportunity.waitingFor.join("；") || "机会质量尚未达到当前环境的交易门槛";
  return opportunity.reasons[0] ?? "Strategy 2.0 条件已经满足";
}

function SelectedAction({ opportunity, market }: { opportunity: Opportunity; market: Market }) {
  const mode = opportunity.tradeMode === "exploration" ? "探索" : opportunity.tradeMode === "high_conviction" ? "高置信" : "标准";
  return <div className="strategy2-selected-action">
    <div className="strategy2-selected-action-head"><span className={`strategy2-selected-state ${opportunity.state.toLowerCase()}`}>{opportunity.state} · {STATE_COPY[opportunity.state]}</span><strong>{opportunity.playbookLabel} · {mode}</strong></div>
    <h3>{opportunity.side === "WAIT" ? "保持空仓" : `${opportunity.side} · ${STATE_COPY[opportunity.state]}`}</h3>
    <p>{primaryExplanation(opportunity)}</p>
    <div className="strategy2-selected-scores"><div><span>环境</span><strong>{opportunity.environmentFit}</strong></div><div><span>结构</span><strong>{opportunity.structure}</strong></div><div><span>时机</span><strong>{opportunity.timing}</strong></div><div><span>确认</span><strong>{opportunity.confirmation}</strong></div></div>
    <div className="strategy2-selected-meta"><span>Global {market.regimeLabel}</span><span>Asset {opportunity.assetRegime ?? "--"}</span><span>样本 {opportunity.experienceSamples ?? 0}</span><span>Expectancy {opportunity.expectancyR == null ? "--" : `${opportunity.expectancyR.toFixed(2)}R`}</span><span>冲突 {opportunity.strategyConflict ?? 0}</span><span>风险 {(opportunity.riskMultiplier * 100).toFixed(0)}%</span></div>
  </div>;
}

function SelectedNext({ opportunity }: { opportunity: Opportunity }) {
  const items = opportunity.state === "REJECT" ? opportunity.rejectReasons.map((reason) => REJECT_COPY[reason] ?? reason) : opportunity.state === "WATCH" ? opportunity.waitingFor : ["Strategy 2.0 已通过，等待组合风险、仓位与 Execution Engine 最终复核"];
  const shown = items.length ? items.slice(0, 3) : ["继续等待更高质量确认"];
  return <div className="strategy2-selected-next"><span>{opportunity.state === "TRADE" ? "执行前复核" : opportunity.state === "WATCH" ? "还差什么" : "为什么拒绝"}</span><ul>{shown.map((item) => <li key={item}>{item}</li>)}</ul>{opportunity.maxRisk && <strong>最大风险：{opportunity.maxRisk}</strong>}<strong className="strategy2-execution-note">Strategy 2.0 机会通过后仍需组合风险与 Execution Engine 复核；实盘总开关始终拥有最终权限。</strong></div>;
}

function RadarPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const components = Object.entries(market.transition).sort((a, b) => b[1] - a[1]);
  const warnings = (market.warnings.length ? market.warnings : packet.warnings).slice(0, 5);
  return <div className="v2-panel v2-radar-panel">
    <div className="v2-panel-head"><div><span>MARKET PULSE · STRATEGY 2.0</span><strong>环境变化雷达</strong></div><PermissionBadge permission={market.permission}/></div>
    <MarketStrip market={market}/>
    <div className="v2-transition-grid">{components.map(([key, value]) => <div key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><strong className={value >= 70 ? "v2-danger" : value >= 50 ? "v2-warn" : ""}>{Math.round(value)}</strong><i><b style={{ width: `${Math.min(100, Math.max(0, value))}%` }}/></i></div>)}</div>
    <div className="v2-pulse-meta"><span>广度：涨 {(market.breadth.advancingRatio * 100).toFixed(0)}% / 跌 {(market.breadth.decliningRatio * 100).toFixed(0)}%</span><span>波动：{market.volatility.state} · 离散 {market.volatility.dispersionPct.toFixed(2)}%</span><span>杠杆：{market.leverage.state} · 拥挤 {(market.leverage.crowdedRatio * 100).toFixed(0)}%</span></div>
    <div className="v2-warning-list">{warnings.length ? warnings.map((warning) => <div key={warning.id}><span className={`v2-warning-level ${warning.level.toLowerCase()}`}>{warning.level}</span><div><strong>{warning.title}</strong><p>{warning.detail}</p><small>{warning.impact}</small></div><b>{warning.severity}</b></div>) : <p>当前没有达到展示阈值的环境异常。</p>}</div>
  </div>;
}

function stageClass(stage: LearningStage, expectancyR: number | null) {
  if (stage === "negative_edge" || (expectancyR ?? 0) < -0.10) return "strategy2-negative";
  if (stage === "validated" && (expectancyR ?? 0) > 0) return "strategy2-positive";
  return "strategy2-neutral";
}

function LearningPanel({ learning }: { learning: Learning | null }) {
  if (!learning) return <div className="strategy2-learning"><div className="strategy2-learning-head"><strong>Strategy 2.0 学习矩阵</strong><span>正在读取</span></div></div>;
  const recent = learning.recentTrades.slice(0, 4);
  const cells = learning.cells.slice(0, 5);
  return <div className="strategy2-learning">
    <div className="strategy2-learning-head"><strong>Strategy 2.0 学习矩阵</strong><span>Global × Asset × Playbook × Direction</span></div>
    <div className="strategy2-learning-stats"><div><span>真实完成样本</span><strong>{learning.totalSamples}</strong></div><div><span>已覆盖 Playbook</span><strong>{learning.playbookCoverage}/12</strong></div><div><span>精确环境单元</span><strong>{learning.exactCellCount}</strong></div><div><span>正/负优势单元</span><strong>{learning.positiveCells}/{learning.negativeCells}</strong></div></div>
    {recent.length > 0 && <div className="strategy2-learning-list">{recent.map((item) => <div className="strategy2-learning-row" key={item.tradeId}><div><strong>{item.playbook} · {item.side}</strong><b className={item.resultR >= 0 ? "strategy2-positive" : "strategy2-negative"}>{item.resultR >= 0 ? "+" : ""}{item.resultR.toFixed(2)}R</b></div><p>Global {item.globalRegime} · Asset {item.assetRegime} · 该单元样本 {item.cellSamples}</p><small className={stageClass(item.stage, item.cellExpectancyR)}>{STAGE_COPY[item.stage]} · Expectancy {item.cellExpectancyR == null ? "--" : `${item.cellExpectancyR.toFixed(2)}R`} · {item.riskAction}</small></div>)}</div>}
    {recent.length === 0 && <p className="v2-order-note">当前还没有 Strategy 2.0 完整平仓样本。新交易会按 Playbook × Global Regime × Asset Regime × Direction 进入探索学习，而不是再汇总成“BTC LONG”旧记忆。</p>}
    {cells.length > 0 && <div className="strategy2-learning-list">{cells.map((cell) => <div className="strategy2-learning-row" key={cell.key}><div><strong>{cell.playbook} · {cell.side}</strong><b className={stageClass(cell.stage, cell.expectancyR)}>{STAGE_COPY[cell.stage]}</b></div><p>{cell.globalRegime} × {cell.assetRegime} · n={cell.sampleCount} · 胜率 {cell.winRate == null ? "--" : `${(cell.winRate * 100).toFixed(0)}%`}</p><small>{cell.riskAction}</small></div>)}</div>}
  </div>;
}

function OrdersPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const portfolio = packet.portfolio;
  const weakest = packet.theses.slice().sort((a, b) => a.thesisHealth - b.thesisHealth).slice(0, 3);
  return <div className="v2-panel v2-orders-panel">
    <div className="v2-panel-head"><div><span>PORTFOLIO + LEARNING · STRATEGY 2.0</span><strong>账户风险、交易逻辑与学习状态</strong></div><PermissionBadge permission={market.permission}/></div>
    <div className="v2-portfolio-grid"><div><span>活动持仓</span><strong>{portfolio?.openCount ?? 0}</strong><small>多 {portfolio?.longCount ?? 0} / 空 {portfolio?.shortCount ?? 0}</small></div><div><span>方向集中</span><strong>{portfolio?.directionConcentration ?? 0}%</strong><small>同方向风险</small></div><div><span>组合风险</span><strong className={portfolio?.riskLevel === "CRITICAL" || portfolio?.riskLevel === "HIGH" ? "v2-danger" : portfolio?.riskLevel === "ELEVATED" ? "v2-warn" : "v2-good"}>{portfolio?.riskLevel ?? "--"}</strong><small>Transition {market.transitionRisk}</small></div><div><span>平均 Thesis Health</span><strong className={(portfolio?.averageThesisHealth ?? 100) < 45 ? "v2-danger" : (portfolio?.averageThesisHealth ?? 100) < 65 ? "v2-warn" : "v2-good"}>{portfolio?.averageThesisHealth ?? "--"}</strong><small>最弱 {portfolio?.weakestThesisHealth ?? "--"}</small></div></div>
    {weakest.length > 0 && <div className="v2-thesis-list">{weakest.map((thesis) => <div key={thesis.tradeId}><span>{thesis.playbook}</span><strong className={thesis.thesisHealth < 45 ? "v2-danger" : thesis.thesisHealth < 65 ? "v2-warn" : "v2-good"}>{thesis.thesisHealth}</strong><small>{thesis.entryRegime} → {thesis.currentRegime}</small></div>)}</div>}
    <p className="v2-order-note">当前动作：{portfolio?.currentAction ?? PERMISSION_COPY[market.permission]}。Thesis Health 与盈亏分开计算；学习矩阵只让历史经验调整评分和风险，不能突破安全上限。</p>
    <LearningPanel learning={packet.learning}/>
  </div>;
}

function LoadingPanel({ error }: { error?: string }) {
  return <div className="v2-panel v2-opportunity-panel"><div className="v2-panel-head"><div><span>Sentinel Strategy 2.0</span><strong>{error ?? "正在读取统一策略数据…"}</strong></div></div></div>;
}

function relabelLegacyShell() {
  const radar = Array.from(document.querySelectorAll<HTMLElement>(".utility-card")).find((card) => card.querySelector(".eyebrow")?.textContent?.includes("数据雷达"));
  if (radar) {
    const eyebrow = radar.querySelector<HTMLElement>(".utility-heading .eyebrow");
    const title = radar.querySelector<HTMLElement>(".utility-heading strong");
    if (eyebrow) eyebrow.textContent = "Strategy 2.0 数据与事件";
    if (title) title.textContent = "环境变化 + 数据源健康 + 高影响事件";
  }
  const orders = document.querySelector<HTMLElement>(".order-ledger");
  if (orders) {
    const eyebrow = orders.querySelector<HTMLElement>(".utility-heading .eyebrow");
    const title = orders.querySelector<HTMLElement>(".utility-heading strong");
    if (eyebrow) eyebrow.textContent = "Strategy 2.0 模拟交易账户";
    if (title) title.textContent = "交易 → 持仓 → 平仓 → 环境×策略学习";
    const calibration = orders.querySelector<HTMLElement>(".calibration-title");
    const calibrationTitle = calibration?.querySelector<HTMLElement>("span");
    const calibrationNote = calibration?.querySelector<HTMLElement>("small");
    if (calibrationTitle) calibrationTitle.textContent = "Strategy 2.0 机会评分校准";
    if (calibrationNote) calibrationNote.textContent = "入场评分 vs 实际正收益";
  }
  document.querySelectorAll<HTMLElement>(".lesson-card .section-title").forEach((section) => {
    const title = section.querySelector<HTMLElement>("span");
    const note = section.querySelector<HTMLElement>("small");
    if (title) title.textContent = "本单复盘已进入 Strategy 2.0 学习记录";
    if (note) note.textContent = "结构化结果已纳入经验矩阵";
  });
}

export function Strategy2Panels() {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [showLegacyAnalysis, setShowLegacyAnalysis] = useState(false);
  const [targets, setTargets] = useState<PortalTargets>({ opportunity: null, radar: null, orders: null, decisionCard: null, decisionConfidence: null, decisionAction: null, decisionTrigger: null, decisionCounter: null, selectedSymbol: null });

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
      relabelLegacyShell();
      setTargets(next);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => { setShowLegacyAnalysis(false); }, [targets.selectedSymbol]);

  const selectedOpportunity = useMemo(() => {
    if (!packet || !targets.selectedSymbol) return null;
    return packet.opportunities.find((item) => item.symbol === targets.selectedSymbol) ?? null;
  }, [packet, targets.selectedSymbol]);

  useEffect(() => {
    const card = targets.decisionCard;
    const controlled = [targets.decisionConfidence, targets.decisionAction, targets.decisionTrigger];
    const analysisHeading = card?.querySelector<HTMLElement>(".analysis-matrix")?.previousElementSibling as HTMLElement | null;
    if (analysisHeading) analysisHeading.classList.add("strategy2-analysis-heading");
    if (selectedOpportunity && card) {
      card.classList.add("strategy2-opportunity-detail-active");
      card.classList.toggle("strategy2-show-legacy-analysis", showLegacyAnalysis);
      controlled.forEach((target) => target?.classList.add("strategy2-overridden"));
    } else {
      card?.classList.remove("strategy2-opportunity-detail-active", "strategy2-show-legacy-analysis");
      controlled.forEach((target) => target?.classList.remove("strategy2-overridden"));
    }
    return () => {
      card?.classList.remove("strategy2-opportunity-detail-active", "strategy2-show-legacy-analysis");
      controlled.forEach((target) => target?.classList.remove("strategy2-overridden"));
      analysisHeading?.classList.remove("strategy2-analysis-heading");
    };
  }, [selectedOpportunity, showLegacyAnalysis, targets.decisionAction, targets.decisionCard, targets.decisionConfidence, targets.decisionTrigger]);

  const market = packet?.market ?? null;
  return <>
    <style>{UNIFIED_CSS}</style>
    {targets.opportunity && createPortal(market && packet ? <OpportunityPanel packet={packet}/> : <LoadingPanel error={packet?.error}/>, targets.opportunity)}
    {targets.radar && market && packet && createPortal(<RadarPanel packet={packet}/>, targets.radar)}
    {targets.orders && market && packet && createPortal(<OrdersPanel packet={packet}/>, targets.orders)}
    {selectedOpportunity && market && targets.decisionConfidence && createPortal(<SelectedScore opportunity={selectedOpportunity}/>, targets.decisionConfidence)}
    {selectedOpportunity && market && targets.decisionAction && createPortal(<SelectedAction opportunity={selectedOpportunity} market={market}/>, targets.decisionAction)}
    {selectedOpportunity && targets.decisionTrigger && createPortal(<SelectedNext opportunity={selectedOpportunity}/>, targets.decisionTrigger)}
    {selectedOpportunity && targets.decisionCounter && createPortal(<button type="button" className="strategy2-detail-toggle" onClick={() => setShowLegacyAnalysis((value) => !value)}>{showLegacyAnalysis ? "收起底层详细分析" : "查看底层详细分析"}</button>, targets.decisionCounter)}
  </>;
}
