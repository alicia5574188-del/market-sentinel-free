"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type Rollup = {
  label: string;
  sampleCount: number;
  expectancyR: number | null;
  winRate: number | null;
  profitFactorR: number | null;
  cumulativeR: number;
  cumulativePnlUsdt: number;
  maxDrawdownR: number;
  maxLossStreak: number;
  t1HitRate: number | null;
};

type ExitProfile = {
  code: string;
  label: string;
  recentCount: number;
  previousCount: number;
  recentRate: number;
  previousRate: number;
  deltaPctPoints: number;
};

type Playbook = {
  playbook: string;
  sampleCount: number;
  expectancyR: number | null;
  recentExpectancyR: number | null;
  winRate: number | null;
  cumulativeR: number;
  state: "positive" | "negative" | "watch" | "collecting";
};

type HeatmapCell = {
  key: string;
  globalRegime: string;
  playbook: string;
  side: "LONG" | "SHORT";
  sampleCount: number;
  expectancyR: number | null;
  winRate: number | null;
  cumulativeR: number;
};

type Arena = {
  version: "learning-arena-v1";
  generatedAt: number;
  readOnly: true;
  champion: {
    name: string;
    all: Rollup;
    last20: Rollup;
    last50: Rollup;
    last100: Rollup;
    forward: Rollup;
    preForward: Rollup;
    governorState: "NORMAL" | "DEFENSIVE";
    governorReason: string;
  };
  trend: {
    state: "IMPROVING" | "FLAT" | "DEGRADING" | "COLLECTING";
    recent20ExpectancyR: number | null;
    previous20ExpectancyR: number | null;
    expectancyDeltaR: number | null;
    recent20ProfitFactor: number | null;
    previous20ProfitFactor: number | null;
  };
  forwardEvidence: {
    sampleCount: number;
    preForwardSampleCount: number;
    forwardExpectancyR: number | null;
    preForwardExpectancyR: number | null;
    periodDeltaR: number | null;
    interpretation: "period_shift_only";
    note: string;
  };
  learningProof: {
    status: "COLLECTING";
    learningAlphaR: null;
    frozenBaseline: "NOT_RECORDED";
    challenger: "NOT_ACTIVE";
    note: string;
  };
  exits: ExitProfile[];
  playbooks: Playbook[];
  heatmap: HeatmapCell[];
  safety: { note: string };
  error?: string;
};

const TREND_LABEL: Record<Arena["trend"]["state"], string> = {
  IMPROVING: "改善中",
  FLAT: "横向",
  DEGRADING: "退化中",
  COLLECTING: "样本收集中",
};

function signedR(value: number | null) {
  if (value == null) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function pf(value: number | null) {
  if (value == null) return "∞/--";
  return value.toFixed(2);
}

function pct(value: number | null) {
  return value == null ? "--" : `${(value * 100).toFixed(0)}%`;
}

function toneFromValue(value: number | null) {
  if (value == null) return "arena-neutral";
  if (value > 0.08) return "arena-positive";
  if (value < -0.08) return "arena-negative";
  return "arena-neutral";
}

function Metric({ label, value, meta, tone = "arena-neutral" }: { label: string; value: string; meta: string; tone?: string }) {
  return <div className="arena-metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{meta}</small></div>;
}

function ArenaPanel({ arena }: { arena: Arena }) {
  const importantExits = arena.exits.slice(0, 4);
  const importantPlaybooks = useMemo(() => {
    const negatives = arena.playbooks.filter((item) => item.state === "negative").slice(0, 3);
    const positives = arena.playbooks.filter((item) => item.state === "positive").slice(0, 3);
    const combined = [...negatives, ...positives];
    return combined.length ? combined : arena.playbooks.slice(0, 6);
  }, [arena.playbooks]);
  const cells = arena.heatmap.slice(0, 8);
  const deltaTone = arena.forwardEvidence.periodDeltaR == null ? "arena-neutral" : toneFromValue(arena.forwardEvidence.periodDeltaR);
  const trendTone = arena.trend.state === "IMPROVING" ? "arena-positive" : arena.trend.state === "DEGRADING" ? "arena-negative" : "arena-neutral";

  return <section className="strategy2-arena" data-research-only="true">
    <div className="strategy2-arena-head">
      <div><span>LEARNING ARENA · READ ONLY</span><strong>学习效果验证场</strong></div>
      <b className={arena.champion.governorState === "DEFENSIVE" ? "arena-negative" : "arena-positive"}>{arena.champion.governorState}</b>
    </div>

    <p className="strategy2-arena-lead">模拟账户继续负责完整执行结果；这里专门回答“策略有没有变聪明”。所有指标只读，不参与开仓和风控。</p>

    <div className="strategy2-arena-metrics">
      <Metric label="最近20笔 EV" value={signedR(arena.champion.last20.expectancyR)} meta={`PF ${pf(arena.champion.last20.profitFactorR)} · 胜率 ${pct(arena.champion.last20.winRate)}`} tone={toneFromValue(arena.champion.last20.expectancyR)} />
      <Metric label="最近50笔 EV" value={signedR(arena.champion.last50.expectancyR)} meta={`累计 ${signedR(arena.champion.last50.cumulativeR)} · DD ${arena.champion.last50.maxDrawdownR.toFixed(1)}R`} tone={toneFromValue(arena.champion.last50.expectancyR)} />
      <Metric label="Forward EV" value={signedR(arena.champion.forward.expectancyR)} meta={`${arena.champion.forward.sampleCount} 笔前向样本 · T1 ${pct(arena.champion.forward.t1HitRate)}`} tone={toneFromValue(arena.champion.forward.expectancyR)} />
      <Metric label="学习期前后 Δ" value={signedR(arena.forwardEvidence.periodDeltaR)} meta="时期差异，不等于 Learning Alpha" tone={deltaTone} />
    </div>

    <div className="strategy2-arena-trend">
      <div><span>Rolling Edge</span><strong className={trendTone}>{TREND_LABEL[arena.trend.state]}</strong></div>
      <p>最近20笔 {signedR(arena.trend.recent20ExpectancyR)} ← 前20笔 {signedR(arena.trend.previous20ExpectancyR)} · Δ {signedR(arena.trend.expectancyDeltaR)}</p>
      <small>{arena.champion.governorReason}</small>
    </div>

    <div className="strategy2-arena-proof">
      <div><span>Learning Alpha</span><strong>收集中</strong></div>
      <div className="strategy2-arena-proof-grid">
        <span>Champion<b>Strategy 2.0 Forward</b></span>
        <span>Frozen Baseline<b>尚未形成同市场结果</b></span>
        <span>Challenger<b>未启用实盘权限</b></span>
      </div>
      <p>{arena.learningProof.note}</p>
    </div>

    {importantExits.length > 0 && <div className="strategy2-arena-section">
      <div className="strategy2-arena-title"><strong>错误 / 退出形态变化</strong><span>最近50笔 vs 前50笔</span></div>
      <div className="strategy2-arena-exits">{importantExits.map((item) => <div key={item.code}><span>{item.label}</span><strong className={item.code === "stop_loss" && item.deltaPctPoints > 0 ? "arena-negative" : item.code === "stop_loss" && item.deltaPctPoints < 0 ? "arena-positive" : "arena-neutral"}>{item.deltaPctPoints >= 0 ? "+" : ""}{item.deltaPctPoints.toFixed(1)}pp</strong><small>{item.recentCount} → 前窗 {item.previousCount}</small></div>)}</div>
    </div>}

    {importantPlaybooks.length > 0 && <div className="strategy2-arena-section">
      <div className="strategy2-arena-title"><strong>Playbook Edge</strong><span>哪些策略正在改善 / 拖累</span></div>
      <div className="strategy2-arena-playbooks">{importantPlaybooks.map((item) => <div key={item.playbook}><span>{item.playbook}</span><strong className={toneFromValue(item.expectancyR)}>{signedR(item.expectancyR)}</strong><small>近窗 {signedR(item.recentExpectancyR)} · n={item.sampleCount}</small></div>)}</div>
    </div>}

    {cells.length > 0 && <div className="strategy2-arena-section">
      <div className="strategy2-arena-title"><strong>Regime × Playbook 热区</strong><span>按已完成样本排序</span></div>
      <div className="strategy2-arena-heatmap">{cells.map((cell) => <div key={cell.key} className={toneFromValue(cell.expectancyR)}><span>{cell.globalRegime} · {cell.playbook.match(/^P\d+/)?.[0] ?? cell.playbook} · {cell.side}</span><strong>{signedR(cell.expectancyR)}</strong><small>n={cell.sampleCount} · 胜率 {pct(cell.winRate)}</small></div>)}</div>
    </div>}

    <small className="strategy2-arena-safety">{arena.forwardEvidence.note} {arena.safety.note}</small>
  </section>;
}

export function Strategy2LearningArena() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [arena, setArena] = useState<Arena | null>(null);

  useEffect(() => {
    const syncTarget = () => {
      const next = document.querySelector<HTMLElement>(".order-ledger");
      setTarget((current) => current === next ? current : next);
    };
    syncTarget();
    const observer = new MutationObserver(syncTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let loading = false;
    let timeout: number | null = null;
    const load = async () => {
      if (document.hidden || loading) return;
      loading = true;
      try {
        const response = await fetch("/api/v2/learning-arena", { cache: "no-store" });
        if (!response.ok) return;
        const next = await response.json() as Arena;
        if (active && next?.version === "learning-arena-v1") setArena(next);
      } catch {
        // Keep the last trustworthy Arena snapshot. This research-only panel
        // must never turn a transient Worker/network error into a global UI error.
      } finally {
        loading = false;
      }
    };

    timeout = window.setTimeout(() => { void load(); }, 4_000);
    const timer = window.setInterval(() => { void load(); }, 5 * 60_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      if (timeout != null) window.clearTimeout(timeout);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!target || !arena) return null;
  return createPortal(<ArenaPanel arena={arena} />, target);
}
