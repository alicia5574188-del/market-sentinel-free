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

type LearningStage = "exploration" | "calibrating" | "validated" | "negative_edge" | "degrading";
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
  degradingCells: number;
  forwardSamples: number;
  cells: LearningCell[];
  recentTrades: LearningTrade[];
};

type DecisionIntelligence = {
  symbol: string;
  playbook: string;
  side: "LONG" | "SHORT" | "WAIT";
  state: "TRADE" | "WATCH" | "REJECT";
  estimationMode: "shadow_estimate";
  expertWeight: number;
  estimatedWinProbability: number;
  grossExpectedR: number | null;
  estimatedCostBufferR: number;
  netExpectedR: number | null;
  decisionConfidence: number;
  modelDisagreement: number;
  outOfDistributionRisk: number;
  advisoryState: "NORMAL" | "REDUCE" | "BLOCK";
  advisoryReasons: string[];
};

type Intelligence = {
  version: string;
  regimeMigration: null | {
    currentRegime: string;
    currentLabel: string;
    candidateRegime: string | null;
    candidateLabel: string | null;
    transitionProbability: number;
    stage: "stable" | "forming" | "developing" | "switch_watch";
    explanation: string;
  };
  decisions: DecisionIntelligence[];
  experts: { playbook: string; playbookLabel: string; weight: number; confidence: number; learningState: string; sampleCount: number; expectancyR: number | null; bestEnvironmentFit: number }[];
  learningUpdate: null | { totalSamples: number; forwardSamples: number; positiveCells: number; negativeCells: number; degradingCells: number; playbookCoverage: number; headline: string; riskNote: string };
  counterfactual: { trackedDecisionCount: number; maturedDecisionCount: number; uniqueSymbols: number; windowHours: number; maturityMinutes: number; source: "persistent_v2_opportunity_archive" | "current_snapshot"; status: "collecting"; note: string };
  portfolio: { directionConcentration: number; regimeSideConcentration: number; dominantFactor: string | null; riskState: "NORMAL" | "CONCENTRATED" | "HIGH"; model: "regime_direction_factor_proxy" };
  authority: { mode: "shadow_only"; liveDecisionAuthority: false; canIncreaseRisk: false; canOverrideHardSafety: false; canAutoPromote: false; note: string };
  governance: { champion: string; mode: "shadow_first"; automaticPromotion: false; policy: string };
};

type Thesis = { tradeId: string; playbook: string; entryRegime: string; currentRegime: string; thesisHealth: number };
type Packet = {
  observedAt: number;
  version: string;
  market: Market | null;
  opportunities: Opportunity[];
  strategyPool: StrategyPool | null;
  learning: Learning | null;
  intelligence: Intelligence | null;
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
const STAGE: Record<LearningStage, string> = { exploration: "探索", calibrating: "校准", validated: "已验证", negative_edge: "负优势", degrading: "优势衰退" };
const MIGRATION_STAGE: Record<NonNullable<Intelligence["regimeMigration"]>["stage"], string> = { stable: "稳定", forming: "形成中", developing: "增强中", switch_watch: "切换观察" };
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
  setText(radar?.querySelector<HTMLElement>(".utility-heading .eyebrow"), "Strategy 2.0 市场智能");
  setText(radar?.querySelector<HTMLElement>(".utility-heading strong"), "环境迁移 + 风险预警 + 学习状态");

  const orders = document.querySelector<HTMLElement>(".order-ledger");
  setText(orders?.querySelector<HTMLElement>(".utility-heading .eyebrow"), "Strategy 2.0 执行与学习");
  setText(orders?.querySelector<HTMLElement>(".utility-heading strong"), "组合风险 → Thesis → Execution → Learning");
  setText(orders?.querySelector<HTMLElement>(".calibration-title span"), "Strategy 2.0 机会评分校准");
  setText(orders?.querySelector<HTMLElement>(".calibration-title small"), "概率 / EV / 实际结果");

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

function RegimeMigrationPanel({ intelligence }: { intelligence: Intelligence | null }) {
  const migration = intelligence?.regimeMigration;
  if (!migration) return null;
  return <div className={`strategy21-migration strategy21-${migration.stage}`}>
    <div><span>当前环境</span><strong>{migration.currentLabel}</strong></div>
    <i>→</i>
    <div><span>候选环境</span><strong>{migration.candidateLabel ?? "暂无"}</strong></div>
    <div className="strategy21-migration-risk"><span>{MIGRATION_STAGE[migration.stage]}</span><strong>{migration.transitionProbability}%</strong><small>迁移概率估计</small></div>
    <p>{migration.explanation}</p>
  </div>;
}

function StrategyPoolPanel({ pool, intelligence }: { pool: StrategyPool | null; intelligence: Intelligence | null }) {
  const covered = pool?.playbooks.map((value) => value.match(/^P\d+/)?.[0] ?? value).join(" · ") ?? "等待策略池数据";
  const leaders = intelligence?.experts.slice(0, 3) ?? [];
  return <div className="strategy2-pool">
    <div className="strategy2-pool-head"><strong>12 Playbook 并行策略池 · 动态专家权重</strong><span>Playbook {pool?.playbookCount ?? 0}/12</span></div>
    <p>{pool ? `近 ${pool.windowMinutes} 分钟 ${pool.evaluations} 次评估 · ${pool.symbols} 个币 · TRADE ${pool.states.trade} / WATCH ${pool.states.watch} / REJECT ${pool.states.reject}` : "正在读取策略池活动"}</p>
    <small>{covered}</small>
    {leaders.length > 0 && <div className="strategy21-experts">{leaders.map((expert) => <span key={expert.playbook}>{expert.playbook.match(/^P\d+/)?.[0] ?? expert.playbook} 权重 {(expert.weight * 100).toFixed(0)}% · 置信 {expert.confidence}</span>)}</div>}
  </div>;
}

function decisionFor(intelligence: Intelligence | null, item: Opportunity) {
  return intelligence?.decisions.find((decision) => decision.symbol === item.symbol && decision.playbook === item.playbook) ?? null;
}

function OpportunityCard({ item, intelligence }: { item: Opportunity; intelligence: Intelligence | null }) {
  const decision = decisionFor(intelligence, item);
  return <div className={`v2-opportunity ${item.state.toLowerCase()}`}>
    <div><strong>{item.symbol.replace("_", "")} · {item.side}</strong><span>{item.playbookLabel}</span></div>
    <b>{item.opportunityScore}</b>
    <p>{item.state === "TRADE" ? item.reasons[0] : item.waitingFor[0] ?? "继续等待确认"}</p>
    <small>环境 {item.environmentFit} · 结构 {item.structure} · 时机 {item.timing} · 确认 {item.confirmation} · RR {item.riskReward.toFixed(1)} · 风险 {(item.riskMultiplier * 100).toFixed(0)}%</small>
    {decision && <small className={`strategy21-decision-line strategy21-${decision.advisoryState.toLowerCase()}`}>影子 Net EV {decision.netExpectedR == null ? "--" : `${decision.netExpectedR >= 0 ? "+" : ""}${decision.netExpectedR.toFixed(2)}R`} · 胜率估计 {(decision.estimatedWinProbability * 100).toFixed(0)}% · 决策置信 {decision.decisionConfidence} · 分歧 {decision.modelDisagreement} · OOD {decision.outOfDistributionRisk}</small>}
  </div>;
}

function OpportunityPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const trade = packet.opportunities.filter((item) => item.state === "TRADE").sort((a, b) => b.opportunityScore - a.opportunityScore);
  const watch = packet.opportunities.filter((item) => item.state === "WATCH").sort((a, b) => b.opportunityScore - a.opportunityScore);
  const reject = packet.opportunities.filter((item) => item.state === "REJECT");
  const featured = [...trade, ...watch].slice(0, 3);
  return <div className="v2-panel v2-opportunity-panel">
    <div className="v2-panel-head"><div><span>Sentinel Strategy 2.0</span><strong>环境迁移 · 动态专家 · 概率 / EV 决策</strong></div><PermissionBadge market={market}/></div>
    <MarketStrip market={market}/>
    <RegimeMigrationPanel intelligence={packet.intelligence}/>
    <StrategyPoolPanel pool={packet.strategyPool} intelligence={packet.intelligence}/>
    <div className="v2-state-counts"><span className="trade">TRADE <b>{trade.length}</b></span><span className="watch">WATCH <b>{watch.length}</b></span><span className="reject">REJECT <b>{reject.length}</b></span></div>
    {featured.length > 0 && <div className="v2-featured-list">{featured.map((item) => <OpportunityCard key={`${item.symbol}-${item.playbook}`} item={item} intelligence={packet.intelligence}/>)}</div>}
  </div>;
}

function SelectedScore({ opportunity }: { opportunity: Opportunity }) {
  return <div className="strategy2-selected-score"><span>机会评分</span><strong>{opportunity.opportunityScore}</strong><small>/100</small></div>;
}

function SelectedAction({ opportunity, market, decision }: { opportunity: Opportunity; market: Market; decision: DecisionIntelligence | null }) {
  const explanation = opportunity.state === "REJECT" ? opportunity.rejectReasons.map((reason) => REJECT[reason] ?? reason).join("；") : opportunity.state === "WATCH" ? opportunity.waitingFor.join("；") : opportunity.reasons[0] ?? "Strategy 2.0 条件已满足";
  const mode = opportunity.tradeMode === "exploration" ? "探索" : opportunity.tradeMode === "high_conviction" ? "高置信" : "标准";
  return <div className="strategy2-selected-action">
    <div className="strategy2-selected-action-head"><span className={`strategy2-selected-state ${opportunity.state.toLowerCase()}`}>{opportunity.state} · {STATE[opportunity.state]}</span><strong>{opportunity.playbookLabel} · {mode}</strong></div>
    <h3>{opportunity.side === "WAIT" ? "保持空仓" : `${opportunity.side} · ${STATE[opportunity.state]}`}</h3><p>{explanation}</p>
    <div className="strategy2-selected-scores"><div><span>环境</span><strong>{opportunity.environmentFit}</strong></div><div><span>结构</span><strong>{opportunity.structure}</strong></div><div><span>时机</span><strong>{opportunity.timing}</strong></div><div><span>确认</span><strong>{opportunity.confirmation}</strong></div></div>
    <div className="strategy2-selected-meta"><span>Global {market.regimeLabel}</span><span>Asset {opportunity.assetRegime ?? "--"}</span><span>样本 {opportunity.experienceSamples ?? 0}</span><span>Expectancy {opportunity.expectancyR == null ? "--" : `${opportunity.expectancyR.toFixed(2)}R`}</span><span>冲突 {opportunity.strategyConflict ?? 0}</span><span>风险 {(opportunity.riskMultiplier * 100).toFixed(0)}%</span></div>
    {decision && <div className={`strategy21-selected-intelligence strategy21-${decision.advisoryState.toLowerCase()}`}><span>影子 Net EV <b>{decision.netExpectedR == null ? "--" : `${decision.netExpectedR >= 0 ? "+" : ""}${decision.netExpectedR.toFixed(2)}R`}</b></span><span>胜率估计 <b>{(decision.estimatedWinProbability * 100).toFixed(0)}%</b></span><span>决策置信 <b>{decision.decisionConfidence}</b></span><span>专家权重 <b>{(decision.expertWeight * 100).toFixed(0)}%</b></span><span>模型分歧 <b>{decision.modelDisagreement}</b></span><span>OOD <b>{decision.outOfDistributionRisk}</b></span></div>}
  </div>;
}

function SelectedNext({ opportunity, decision }: { opportunity: Opportunity; decision: DecisionIntelligence | null }) {
  const baseItems = opportunity.state === "REJECT" ? opportunity.rejectReasons.map((reason) => REJECT[reason] ?? reason) : opportunity.state === "WATCH" ? opportunity.waitingFor : ["Strategy 2.0 通过后仍需组合风险与 Execution Engine 复核"];
  const advisory = decision?.advisoryReasons ?? [];
  const items = [...advisory, ...baseItems];
  return <div className="strategy2-selected-next"><span>{opportunity.state === "TRADE" ? "执行前复核" : opportunity.state === "WATCH" ? "还差什么" : "为什么拒绝"}</span><ul>{(items.length ? items : ["继续等待更高质量确认"]).slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>{opportunity.maxRisk && <strong>最大风险：{opportunity.maxRisk}</strong>}<strong className="strategy2-execution-note">学习智能层只允许提示减风险或阻断，不自动提高实盘风险；Execution Engine 与实盘总开关始终拥有最终权限。</strong></div>;
}

function RadarPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const warnings = (market.warnings.length ? market.warnings : packet.warnings).slice(0, 5);
  return <div className="v2-panel v2-radar-panel">
    <div className="v2-panel-head"><div><span>MARKET PULSE · STRATEGY 2.0 · INTELLIGENCE</span><strong>环境迁移与领先风险雷达</strong></div><PermissionBadge market={market}/></div>
    <MarketStrip market={market}/>
    <RegimeMigrationPanel intelligence={packet.intelligence}/>
    <div className="v2-transition-grid">{Object.entries(market.transition).sort((a, b) => b[1] - a[1]).map(([key, value]) => <div key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><strong className={value >= 70 ? "v2-danger" : value >= 50 ? "v2-warn" : ""}>{Math.round(value)}</strong><i><b style={{ width: `${Math.min(100, Math.max(0, value))}%` }}/></i></div>)}</div>
    <div className="v2-pulse-meta"><span>广度：涨 {(market.breadth.advancingRatio * 100).toFixed(0)}% / 跌 {(market.breadth.decliningRatio * 100).toFixed(0)}%</span><span>波动：{market.volatility.state} · 离散 {market.volatility.dispersionPct.toFixed(2)}%</span><span>杠杆：{market.leverage.state} · 拥挤 {(market.leverage.crowdedRatio * 100).toFixed(0)}%</span></div>
    <div className="v2-warning-list">{warnings.length ? warnings.map((warning) => <div key={warning.id}><span className={`v2-warning-level ${warning.level.toLowerCase()}`}>{warning.level}</span><div><strong>{warning.title}</strong><p>{warning.detail}</p><small>{warning.impact}</small></div><b>{warning.severity}</b></div>) : <p>当前没有达到展示阈值的环境异常。</p>}</div>
  </div>;
}

function learningClass(stage: LearningStage, expectancy: number | null) {
  if (stage === "negative_edge" || (expectancy ?? 0) < -0.10) return "strategy2-negative";
  if (stage === "degrading") return "strategy2-negative";
  if (stage === "validated" && (expectancy ?? 0) > 0) return "strategy2-positive";
  return "strategy2-neutral";
}

function LearningPanel({ learning }: { learning: Learning | null }) {
  if (!learning) return <div className="strategy2-learning"><div className="strategy2-learning-head"><strong>Strategy 2.0 学习矩阵</strong><span>正在读取</span></div></div>;
  const recent = learning.recentTrades.slice(0, 4);
  const cells = learning.cells.slice(0, 5);
  return <div className="strategy2-learning">
    <div className="strategy2-learning-head"><strong>Strategy 2.0 学习矩阵</strong><span>Global × Asset × Playbook × Direction</span></div>
    <div className="strategy2-learning-stats"><div><span>真实完成样本</span><strong>{learning.totalSamples}</strong></div><div><span>前向样本</span><strong>{learning.forwardSamples}</strong></div><div><span>已覆盖 Playbook</span><strong>{learning.playbookCoverage}/12</strong></div><div><span>正/负/衰退</span><strong>{learning.positiveCells}/{learning.negativeCells}/{learning.degradingCells}</strong></div></div>
    {recent.length ? <div className="strategy2-learning-list">{recent.map((item) => <div className="strategy2-learning-row" key={item.tradeId}><div><strong>{item.playbook} · {item.side}</strong><b className={item.resultR >= 0 ? "strategy2-positive" : "strategy2-negative"}>{item.resultR >= 0 ? "+" : ""}{item.resultR.toFixed(2)}R</b></div><p>Global {item.globalRegime} · Asset {item.assetRegime} · 该单元样本 {item.cellSamples}</p><small className={learningClass(item.stage, item.cellExpectancyR)}>{STAGE[item.stage]} · Expectancy {item.cellExpectancyR == null ? "--" : `${item.cellExpectancyR.toFixed(2)}R`} · {item.riskAction}</small></div>)}</div> : <p className="v2-order-note">当前还没有 Strategy 2.0 完整平仓样本。新交易会按环境×策略组合学习，不再汇总成“BTC LONG”旧记忆。</p>}
    {cells.length > 0 && <div className="strategy2-learning-list">{cells.map((cell) => <div className="strategy2-learning-row" key={cell.key}><div><strong>{cell.playbook} · {cell.side}</strong><b className={learningClass(cell.stage, cell.expectancyR)}>{STAGE[cell.stage]}</b></div><p>{cell.globalRegime} × {cell.assetRegime} · n={cell.sampleCount} · 胜率 {cell.winRate == null ? "--" : `${(cell.winRate * 100).toFixed(0)}%`}</p><small>{cell.riskAction}</small></div>)}</div>}
  </div>;
}

function LearningIntelligencePanel({ intelligence }: { intelligence: Intelligence | null }) {
  if (!intelligence) return null;
  const update = intelligence.learningUpdate;
  const archiveLabel = intelligence.counterfactual.source === "persistent_v2_opportunity_archive" ? `${intelligence.counterfactual.windowHours}h 持久档案` : "当前快照";
  return <div className="strategy21-learning-intelligence">
    <div><strong>Learning Update</strong><span>{update?.headline ?? "正在积累学习样本"}</span></div>
    {update && <p>{update.riskNote}</p>}
    <div className="strategy21-learning-grid"><span>反事实留样 <b>{intelligence.counterfactual.trackedDecisionCount}</b></span><span>成熟留样 <b>{intelligence.counterfactual.maturedDecisionCount}</b></span><span>Regime×方向集中 <b>{intelligence.portfolio.regimeSideConcentration}%</b></span><span>治理 <b>Shadow-first</b></span></div>
    <small>反事实来源：{archiveLabel} · {intelligence.counterfactual.uniqueSymbols} 个币 · 成熟阈值 {intelligence.counterfactual.maturityMinutes} 分钟。</small>
    {intelligence.portfolio.dominantFactor && <small>主导风险因子代理：{intelligence.portfolio.dominantFactor} · {intelligence.portfolio.riskState}。这里只是 Regime×方向集中代理，不冒充真实收益相关系数。</small>}
    <small>{intelligence.authority.note}</small>
    <small>{intelligence.governance.policy}</small>
  </div>;
}

function OrdersPanel({ packet }: { packet: Packet }) {
  const market = packet.market!;
  const portfolio = packet.portfolio;
  const weakest = packet.theses.slice().sort((a, b) => a.thesisHealth - b.thesisHealth).slice(0, 3);
  return <div className="v2-panel v2-orders-panel">
    <div className="v2-panel-head"><div><span>PORTFOLIO + LEARNING · STRATEGY 2.0 · EXECUTION</span><strong>账户风险、交易逻辑与学习治理</strong></div><PermissionBadge market={market}/></div>
    <div className="v2-portfolio-grid"><div><span>活动持仓</span><strong>{portfolio?.openCount ?? 0}</strong><small>多 {portfolio?.longCount ?? 0} / 空 {portfolio?.shortCount ?? 0}</small></div><div><span>方向集中</span><strong>{portfolio?.directionConcentration ?? 0}%</strong><small>同方向风险</small></div><div><span>组合风险</span><strong className={portfolio?.riskLevel === "CRITICAL" || portfolio?.riskLevel === "HIGH" ? "v2-danger" : portfolio?.riskLevel === "ELEVATED" ? "v2-warn" : "v2-good"}>{portfolio?.riskLevel ?? "--"}</strong><small>Transition {market.transitionRisk}</small></div><div><span>平均 Thesis Health</span><strong className={(portfolio?.averageThesisHealth ?? 100) < 45 ? "v2-danger" : (portfolio?.averageThesisHealth ?? 100) < 65 ? "v2-warn" : "v2-good"}>{portfolio?.averageThesisHealth ?? "--"}</strong><small>最弱 {portfolio?.weakestThesisHealth ?? "--"}</small></div></div>
    {weakest.length > 0 && <div className="v2-thesis-list">{weakest.map((thesis) => <div key={thesis.tradeId}><span>{thesis.playbook}</span><strong className={thesis.thesisHealth < 45 ? "v2-danger" : thesis.thesisHealth < 65 ? "v2-warn" : "v2-good"}>{thesis.thesisHealth}</strong><small>{thesis.entryRegime} → {thesis.currentRegime}</small></div>)}</div>}
    <p className="v2-order-note">当前动作：{portfolio?.currentAction ?? PERMISSION[market.permission]}。学习结果只能调整排序、评分和风险收缩，不能突破硬风控。</p>
    <LearningIntelligencePanel intelligence={packet.intelligence}/>
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
        if (active) setPacket((current) => current ?? { observedAt: Date.now(), version: "strategy-2.0", market: null, opportunities: [], strategyPool: null, learning: null, intelligence: null, warnings: [], theses: [], portfolio: null, error: "Strategy 2.0 数据暂不可用" });
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

  useEffect(() => {
    const timer = window.setTimeout(() => setShowDetails(false), 0);
    return () => window.clearTimeout(timer);
  }, [targets.symbol]);

  const selected = useMemo(() => packet && targets.symbol ? packet.opportunities.find((item) => item.symbol === targets.symbol) ?? null : null, [packet, targets.symbol]);
  const selectedIntelligence = useMemo(() => selected && packet ? decisionFor(packet.intelligence, selected) : null, [packet, selected]);

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
    {selected && market && targets.action && createPortal(<SelectedAction opportunity={selected} market={market} decision={selectedIntelligence}/>, targets.action)}
    {selected && targets.trigger && createPortal(<SelectedNext opportunity={selected} decision={selectedIntelligence}/>, targets.trigger)}
    {selected && targets.counter && createPortal(<button type="button" className="strategy2-detail-toggle" onClick={() => setShowDetails((value) => !value)}>{showDetails ? "收起底层详细分析" : "查看底层详细分析"}</button>, targets.counter)}
  </>;
}
