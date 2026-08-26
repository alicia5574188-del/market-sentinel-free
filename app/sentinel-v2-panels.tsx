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
};

const PERMISSION_COPY: Record<V2Market["permission"], string> = {
  GREEN: "正常交易",
  BLUE: "避免追价",
  YELLOW: "提高门槛",
  ORANGE: "只做最强机会",
  RED: "停止新增风险",
};

function findTargets(): PortalTargets {
  const opportunity = document.querySelector<HTMLElement>(".market-status");
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".utility-card"));
  const radar = cards.find((card) => card.querySelector(".eyebrow")?.textContent?.includes("数据雷达")) ?? null;
  const orders = document.querySelector<HTMLElement>(".utility-card.order-ledger");
  return { opportunity, radar, orders };
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
  const [targets, setTargets] = useState<PortalTargets>({ opportunity: null, radar: null, orders: null });

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
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const content = useMemo(() => {
    if (!packet?.market) return null;
    return {
      opportunity: <OpportunityPanel packet={packet}/>,
      radar: <RadarPanel packet={packet}/>,
      orders: <OrdersPanel packet={packet}/>,
    };
  }, [packet]);

  if (!content) return null;
  return <>
    {targets.opportunity && createPortal(content.opportunity, targets.opportunity)}
    {targets.radar && createPortal(content.radar, targets.radar)}
    {targets.orders && createPortal(content.orders, targets.orders)}
  </>;
}
