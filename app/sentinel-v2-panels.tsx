"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type V2Market = {
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
  warnings: V2Warning[];
  topDrivers: string[];
};

type V2Warning = {
  id: string;
  level: string;
  severity: number;
  confidence: number;
  relevance: number;
  title: string;
  detail: string;
  impact: string;
};

type V2Opportunity = {
  symbol: string;
  playbookLabel: string;
  side: "LONG" | "SHORT" | "WAIT";
  state: "TRADE" | "WATCH" | "REJECT";
  opportunityScore: number;
  environmentFit: number;
  structure: number;
  timing: number;
  confirmation: number;
  riskReward: number;
  portfolioImpact: number;
  riskMultiplier: number;
  waitingFor: string[];
  rejectReasons: string[];
  reasons: string[];
  maxRisk: string | null;
};

type V2Thesis = {
  tradeId: string;
  playbook: string;
  entryRegime: string;
  currentRegime: string;
  entryTransitionRisk: number;
  currentTransitionRisk: number;
  thesisHealth: number;
  updatedAt: number;
};

type V2Packet = {
  observedAt: number;
  version: string;
  market: V2Market | null;
  opportunities: V2Opportunity[];
  warnings: V2Warning[];
  theses: V2Thesis[];
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

const PERMISSION_COPY: Record<V2Market["permission"], string> = {
  GREEN: "正常交易",
  BLUE: "避免追价",
  YELLOW: "提高门槛",
  ORANGE: "只做最强机会",
  RED: "停止新增风险",
};

const STATE_COPY: Record<V2Opportunity["state"], string> = {
  TRADE: "允许交易",
  WATCH: "继续观察",
  REJECT: "拒绝交易",
};

const REJECT_COPY: Record<string, string> = {
  DATA_UNSAFE: "市场数据不完整或不可靠",
  TRANSITION_HIGH: "环境切换风险过高",
  REGIME_CONFLICT: "个币机会与当前市场环境冲突",
  RR_LOW: "预期盈亏比不足",
  PORTFOLIO_CONCENTRATION: "加入后组合风险过度集中",
  CHASE_TOO_FAR: "价格已经偏离合理进场位置",
  LEVERAGE_EXTREME: "杠杆拥挤程度过高",
};

const OPPORTUNITY_DETAIL_CSS = `
.decision-card.v2-opportunity-detail-active .score-bars{display:none!important}
.decision-card.v2-opportunity-detail-active .confidence.v2-overridden>span,.decision-card.v2-opportunity-detail-active .confidence.v2-overridden>strong,.decision-card.v2-opportunity-detail-active .confidence.v2-overridden>small{display:none!important}
.decision-card.v2-opportunity-detail-active .action-callout.v2-overridden>.action-icon,.decision-card.v2-opportunity-detail-active .action-callout.v2-overridden>div:not(.v2-selected-action){display:none!important}
.decision-card.v2-opportunity-detail-active .trigger-row.v2-overridden>svg,.decision-card.v2-opportunity-detail-active .trigger-row.v2-overridden>div:not(.v2-selected-next){display:none!important}
.decision-card.v2-opportunity-detail-active .risk-note{display:none!important}
.decision-card.v2-opportunity-detail-active:not(.v2-show-legacy-analysis) .analysis-matrix,.decision-card.v2-opportunity-detail-active:not(.v2-show-legacy-analysis) .v2-analysis-heading{display:none!important}
.decision-card.v2-opportunity-detail-active .confidence.v2-overridden{min-width:82px}
.v2-selected-score{display:flex;align-items:baseline;justify-content:flex-end;gap:2px;width:100%}.v2-selected-score span{font-size:10px;color:#8290a7}.v2-selected-score strong{font-size:32px;line-height:1;color:#53cdf4}.v2-selected-score small{font-size:10px;color:#75839a}
.decision-card .action-callout.v2-overridden{display:block;padding:16px}.v2-selected-action{display:grid;gap:9px;width:100%}.v2-selected-action-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.v2-selected-state{padding:5px 8px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.04em;background:rgba(255,255,255,.05)}.v2-selected-state.trade{color:#62dfa2;background:rgba(53,199,129,.1)}.v2-selected-state.watch{color:#ffc45f;background:rgba(244,184,57,.1)}.v2-selected-state.reject{color:#ff7884;background:rgba(244,77,91,.12)}.v2-selected-action-head strong{font-size:11px;color:#9aa8bd}.v2-selected-action h3{margin:0;font-size:20px;color:#eef4ff}.v2-selected-action p{margin:0;color:#b5c0d1;font-size:12px;line-height:1.5}.v2-selected-scores{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.v2-selected-scores div{padding:8px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.055);display:flex;flex-direction:column;gap:2px}.v2-selected-scores span{font-size:9px;color:#78879d}.v2-selected-scores strong{font-size:14px}.v2-selected-meta{display:flex;gap:6px;flex-wrap:wrap}.v2-selected-meta span{font-size:9px;color:#8493aa;padding:5px 7px;border-radius:8px;background:rgba(255,255,255,.035)}
.decision-card .trigger-row.v2-overridden{display:block}.v2-selected-next{display:grid;gap:6px;width:100%}.v2-selected-next>span{font-size:10px;color:#7f8fa7}.v2-selected-next strong{font-size:12px;line-height:1.45;color:#dce5f3}.v2-selected-next ul{list-style:none;margin:0;padding:0;display:grid;gap:4px}.v2-selected-next li{font-size:11px;line-height:1.4;color:#b8c3d4;padding-left:14px;position:relative}.v2-selected-next li:before{content:'•';position:absolute;left:2px;color:#56cfee}.v2-execution-note{font-size:9px!important;color:#718098!important;font-weight:500!important}
.v2-detail-toggle{margin:10px 0 0;width:100%;border:1px solid rgba(255,255,255,.08);border-radius:11px;padding:10px 12px;background:rgba(255,255,255,.025);color:#91a0b6;font-size:11px;font-weight:700;text-align:center}.v2-detail-toggle:active{background:rgba(255,255,255,.055)}
@media(max-width:480px){.v2-selected-scores{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-selected-action h3{font-size:18px}.v2-selected-score strong{font-size:29px}}
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
  const radar = cards.find((card) => card.querySelector(".eyebrow")?.textContent?.includes("数据雷达")) ?? null;
  const orders = document.querySelector<HTMLElement>(".utility-card.order-ledger");
  const decisionCard = document.querySelector<HTMLElement>(".decision-card:not(.loading-card)");
  const decisionConfidence = decisionCard?.querySelector<HTMLElement>(".confidence") ?? null;
  const decisionAction = decisionCard?.querySelector<HTMLElement>(".action-callout") ?? null;
  const decisionTrigger = decisionCard?.querySelector<HTMLElement>(".trigger-row") ?? null;
  const decisionCounter = decisionCard?.querySelector<HTMLElement>(".counter-section") ?? null;
  const selectedSymbol = normalizeDisplayedSymbol(decisionCard?.querySelector<HTMLElement>(".ticker-line strong")?.textContent ?? null);
  return { opportunity, radar, orders, decisionCard, decisionConfidence, decisionAction, decisionTrigger, decisionCounter, selectedSymbol };
}

function PermissionBadge({ permission }: { permission: V2Market["permission"] }) {
  return <span className={`v2-permission v2-${permission.toLowerCase()}`}>{permission} · {PERMISSION_COPY[permission]}</span>;
}

function MarketStrip({ market }: { market: V2Market }) {
  return <div className="v2-market-strip">
    <div><span>当前环境</span><strong>{market.regimeLabel}</strong><small>置信 {market.confidence}</small></div>
    <div><span>稳定度</span><strong>{market.stability}</strong><small>/100</small></div>
    <div><span>切换风险</span><strong className={market.transitionRisk >= 61 ? "v2-danger" : market.transitionRisk >= 41 ? "v2-warn" : "v2-good"}>{market.transitionRisk}</strong><small>{market.transitionVelocity > 0 ? `↑ +${market.transitionVelocity.toFixed(1)}/h` : `${market.transitionVelocity.toFixed(1)}/h`}</small></div>
    <div><span>方向偏好</span><strong>{market.bias}</strong><small>{market.volatility.state}</small></div>
  </div>;
}

function OpportunityPanel({ packet }: { packet: V2Packet }) {
  const market = packet.market!;
  const trade = packet.opportunities.filter((item) => item.state === "TRADE").sort((a, b) => b.opportunityScore - a.opportunityScore);
  const watch = packet.opportunities.filter((item) => item.state === "WATCH").sort((a, b) => b.opportunityScore - a.opportunityScore);
  const reject = packet.opportunities.filter((item) => item.state === "REJECT");
  const featured = [...trade, ...watch].slice(0, 3);
  return <div className="v2-panel v2-opportunity-panel">
    <div className="v2-panel-head"><div><span>Sentinel Growth V2</span><strong>环境先于信号</strong></div><PermissionBadge permission={market.permission}/></div>
    <MarketStrip market={market}/>
    <div className="v2-state-counts"><span className="trade">TRADE <b>{trade.length}</b></span><span className="watch">WATCH <b>{watch.length}</b></span><span className="reject">REJECT <b>{reject.length}</b></span></div>
    {featured.length > 0 && <div className="v2-featured-list">{featured.map((item) => <div className={`v2-opportunity ${item.state.toLowerCase()}`} key={`${item.symbol}-${item.playbookLabel}`}>
      <div><strong>{item.symbol.replace("_", "")} · {item.side}</strong><span>{item.playbookLabel}</span></div>
      <b>{item.opportunityScore}</b>
      <p>{item.state === "TRADE" ? item.reasons[0] : item.waitingFor[0] ?? "继续等待确认"}</p>
      <small>环境 {item.environmentFit} · 结构 {item.structure} · 时机 {item.timing} · 确认 {item.confirmation} · RR {item.riskReward.toFixed(1)} · 风险倍率 {(item.riskMultiplier * 100).toFixed(0)}%</small>
    </div>)}</div>}
  </div>;
}

function SelectedScore({ opportunity }: { opportunity: V2Opportunity }) {
  return <div className="v2-selected-score"><span>机会评分</span><strong>{opportunity.opportunityScore}</strong><small>/100</small></div>;
}

function primaryExplanation(opportunity: V2Opportunity) {
  if (opportunity.state === "REJECT") return opportunity.rejectReasons.map((reason) => REJECT_COPY[reason] ?? reason).join("；") || "当前条件明确不适合交易";
  if (opportunity.state === "WATCH") return opportunity.waitingFor.join("；") || "机会质量尚未达到当前环境的交易门槛";
  return opportunity.reasons[0] ?? "V2 条件已经满足";
}

function SelectedAction({ opportunity, market }: { opportunity: V2Opportunity; market: V2Market }) {
  return <div className="v2-selected-action">
    <div className="v2-selected-action-head"><span className={`v2-selected-state ${opportunity.state.toLowerCase()}`}>{opportunity.state} · {STATE_COPY[opportunity.state]}</span><strong>{opportunity.playbookLabel}</strong></div>
    <h3>{opportunity.side === "WAIT" ? "保持空仓" : `${opportunity.side} · ${STATE_COPY[opportunity.state]}`}</h3>
    <p>{primaryExplanation(opportunity)}</p>
    <div className="v2-selected-scores">
      <div><span>环境</span><strong>{opportunity.environmentFit}</strong></div>
      <div><span>结构</span><strong>{opportunity.structure}</strong></div>
      <div><span>时机</span><strong>{opportunity.timing}</strong></div>
      <div><span>确认</span><strong>{opportunity.confirmation}</strong></div>
    </div>
    <div className="v2-selected-meta"><span>Transition {market.transitionRisk}</span><span>RR {opportunity.riskReward.toFixed(1)}</span><span>组合影响 {opportunity.portfolioImpact}</span><span>风险倍率 {(opportunity.riskMultiplier * 100).toFixed(0)}%</span></div>
  </div>;
}

function SelectedNext({ opportunity }: { opportunity: V2Opportunity }) {
  const items = opportunity.state === "REJECT"
    ? opportunity.rejectReasons.map((reason) => REJECT_COPY[reason] ?? reason)
    : opportunity.state === "WATCH"
      ? opportunity.waitingFor
      : ["V2 条件已满足，等待组合风险、仓位与实盘执行层最终复核"];
  const shown = items.length ? items.slice(0, 3) : ["继续等待更高质量确认"];
  return <div className="v2-selected-next">
    <span>{opportunity.state === "TRADE" ? "执行前复核" : opportunity.state === "WATCH" ? "还差什么" : "为什么拒绝"}</span>
    <ul>{shown.map((item) => <li key={item}>{item}</li>)}</ul>
    {opportunity.maxRisk && <strong>最大风险：{opportunity.maxRisk}</strong>}
    <strong className="v2-execution-note">V2 机会通过后仍需组合风险与 Execution Engine 复核；实盘总开关始终拥有最终权限。</strong>
  </div>;
}

function RadarPanel({ packet }: { packet: V2Packet }) {
  const market = packet.market!;
  const components = Object.entries(market.transition).sort((a, b) => b[1] - a[1]);
  const warnings = (market.warnings.length ? market.warnings : packet.warnings).slice(0, 5);
  return <div className="v2-panel v2-radar-panel">
    <div className="v2-panel-head"><div><span>MARKET PULSE · V2</span><strong>环境变化雷达</strong></div><PermissionBadge permission={market.permission}/></div>
    <MarketStrip market={market}/>
    <div className="v2-transition-grid">{components.map(([key, value]) => <div key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><strong className={value >= 70 ? "v2-danger" : value >= 50 ? "v2-warn" : ""}>{Math.round(value)}</strong><i><b style={{ width: `${Math.min(100, Math.max(0, value))}%` }}/></i></div>)}</div>
    <div className="v2-pulse-meta"><span>广度：涨 {(market.breadth.advancingRatio * 100).toFixed(0)}% / 跌 {(market.breadth.decliningRatio * 100).toFixed(0)}%</span><span>波动：{market.volatility.state} · 离散 {market.volatility.dispersionPct.toFixed(2)}%</span><span>杠杆：{market.leverage.state} · 拥挤 {(market.leverage.crowdedRatio * 100).toFixed(0)}%</span></div>
    <div className="v2-warning-list">{warnings.length ? warnings.map((warning) => <div key={warning.id}><span className={`v2-warning-level ${warning.level.toLowerCase()}`}>{warning.level}</span><div><strong>{warning.title}</strong><p>{warning.detail}</p><small>{warning.impact}</small></div><b>{warning.severity}</b></div>) : <p>当前没有达到展示阈值的环境异常。</p>}</div>
  </div>;
}

function OrdersPanel({ packet }: { packet: V2Packet }) {
  const market = packet.market!;
  const portfolio = packet.portfolio;
  const weakest = packet.theses.slice().sort((a, b) => a.thesisHealth - b.thesisHealth).slice(0, 3);
  return <div className="v2-panel v2-orders-panel">
    <div className="v2-panel-head"><div><span>PORTFOLIO CONTROL · V2</span><strong>账户风险与交易逻辑健康度</strong></div><PermissionBadge permission={market.permission}/></div>
    <div className="v2-portfolio-grid">
      <div><span>活动持仓</span><strong>{portfolio?.openCount ?? 0}</strong><small>多 {portfolio?.longCount ?? 0} / 空 {portfolio?.shortCount ?? 0}</small></div>
      <div><span>方向集中</span><strong>{portfolio?.directionConcentration ?? 0}%</strong><small>同方向风险</small></div>
      <div><span>组合风险</span><strong className={portfolio?.riskLevel === "CRITICAL" || portfolio?.riskLevel === "HIGH" ? "v2-danger" : portfolio?.riskLevel === "ELEVATED" ? "v2-warn" : "v2-good"}>{portfolio?.riskLevel ?? "--"}</strong><small>Transition {market.transitionRisk}</small></div>
      <div><span>平均逻辑健康</span><strong className={(portfolio?.averageThesisHealth ?? 100) < 45 ? "v2-danger" : (portfolio?.averageThesisHealth ?? 100) < 65 ? "v2-warn" : "v2-good"}>{portfolio?.averageThesisHealth ?? "--"}</strong><small>最弱 {portfolio?.weakestThesisHealth ?? "--"}</small></div>
    </div>
    {weakest.length > 0 && <div className="v2-thesis-list">{weakest.map((thesis) => <div key={thesis.tradeId}><span>{thesis.playbook}</span><strong className={thesis.thesisHealth < 45 ? "v2-danger" : thesis.thesisHealth < 65 ? "v2-warn" : "v2-good"}>{thesis.thesisHealth}</strong><small>{thesis.entryRegime} → {thesis.currentRegime}</small></div>)}</div>}
    {market.topDrivers.length > 0 && <div className="v2-driver-row"><span>环境风险主因</span>{market.topDrivers.map((driver) => <b key={driver}>{driver}</b>)}</div>}
    <p className="v2-order-note">当前动作：{portfolio?.currentAction ?? PERMISSION_COPY[market.permission]}。Thesis Health 与盈亏分开计算；浮盈也可能因为环境恶化而降低健康度。</p>
  </div>;
}

export function SentinelV2Panels() {
  const [packet, setPacket] = useState<V2Packet | null>(null);
  const [showLegacyAnalysis, setShowLegacyAnalysis] = useState(false);
  const [targets, setTargets] = useState<PortalTargets>({ opportunity: null, radar: null, orders: null, decisionCard: null, decisionConfidence: null, decisionAction: null, decisionTrigger: null, decisionCounter: null, selectedSymbol: null });

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/v2", { cache: "no-store" });
        if (!response.ok) return;
        const next = await response.json() as V2Packet;
        if (active) setPacket(next);
      } catch {
        // The legacy UI remains fully usable if the V2 dashboard endpoint is temporarily unavailable.
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const sync = () => setTargets(findTargets());
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
    if (analysisHeading) analysisHeading.classList.add("v2-analysis-heading");
    if (selectedOpportunity && card) {
      card.classList.add("v2-opportunity-detail-active");
      card.classList.toggle("v2-show-legacy-analysis", showLegacyAnalysis);
      controlled.forEach((target) => target?.classList.add("v2-overridden"));
    } else {
      card?.classList.remove("v2-opportunity-detail-active", "v2-show-legacy-analysis");
      controlled.forEach((target) => target?.classList.remove("v2-overridden"));
    }
    return () => {
      card?.classList.remove("v2-opportunity-detail-active", "v2-show-legacy-analysis");
      controlled.forEach((target) => target?.classList.remove("v2-overridden"));
      analysisHeading?.classList.remove("v2-analysis-heading");
    };
  }, [selectedOpportunity, showLegacyAnalysis, targets.decisionAction, targets.decisionCard, targets.decisionConfidence, targets.decisionTrigger]);

  const content = useMemo(() => {
    if (!packet?.market) return null;
    return {
      opportunity: <OpportunityPanel packet={packet}/>,
      radar: <RadarPanel packet={packet}/>,
      orders: <OrdersPanel packet={packet}/>,
    };
  }, [packet]);

  if (!content || !packet?.market) return null;
  return <>
    <style>{OPPORTUNITY_DETAIL_CSS}</style>
    {targets.opportunity && createPortal(content.opportunity, targets.opportunity)}
    {targets.radar && createPortal(content.radar, targets.radar)}
    {targets.orders && createPortal(content.orders, targets.orders)}
    {selectedOpportunity && targets.decisionConfidence && createPortal(<SelectedScore opportunity={selectedOpportunity}/>, targets.decisionConfidence)}
    {selectedOpportunity && targets.decisionAction && createPortal(<SelectedAction opportunity={selectedOpportunity} market={packet.market}/>, targets.decisionAction)}
    {selectedOpportunity && targets.decisionTrigger && createPortal(<SelectedNext opportunity={selectedOpportunity}/>, targets.decisionTrigger)}
    {selectedOpportunity && targets.decisionCounter && createPortal(<button type="button" className="v2-detail-toggle" onClick={() => setShowLegacyAnalysis((value) => !value)}>{showLegacyAnalysis ? "收起底层详细分析" : "查看底层详细分析"}</button>, targets.decisionCounter)}
  </>;
}
