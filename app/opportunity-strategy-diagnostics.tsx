"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Diagnostics = {
  observedAt: number;
  symbol: string;
  dataQuality: number;
  sourceErrors: Record<string, string>;
  background: {
    active: boolean;
    scannerState: string | null;
    scannerLastRunAt: number | null;
    scannerLastSuccessAt: number | null;
    scannerLastError: string | null;
    scanCadenceSeconds: number | null;
    deepBatchSize: number | null;
  };
  regime: {
    kind: "trend" | "range" | "compression" | "mixed" | "stress";
    trendScore: number;
    atrPct: number | null;
    compressionRatio: number | null;
    rangeWidthPct: number | null;
    relativeStrength24h: number | null;
    reason: string;
  } | null;
  market: {
    futuresPrice: number;
    volumeUsd: number;
    changePercentage: number | null;
    fundingRate: number | null;
    openInterestChangePct: number | null;
    spotCvdRatio: number | null;
    orderBookImbalance: number | null;
    liquidationImbalance: number | null;
    multiTimeframeTrend: number | null;
    benchmarkMomentum: number | null;
  };
  strategies: {
    strategyId: string;
    label: string;
    state: "ready" | "watching" | "blocked";
    side: "LONG" | "SHORT" | "WAIT";
    score: number;
    confidence: number;
    reasons: string[];
    blockers: string[];
    entryPlanReady: boolean;
    checks: { key: string; label: string; passed: boolean; required: boolean; detail: string }[];
  }[];
};

const REGIME_LABEL: Record<NonNullable<Diagnostics["regime"]>["kind"], string> = {
  trend: "趋势",
  range: "震荡",
  compression: "压缩",
  mixed: "混合",
  stress: "风险拦截",
};

function pct(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function ratio(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}×`;
}

function time(value: number | null | undefined) {
  if (!value) return "--";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function selectedSymbolFromPage() {
  const query = new URLSearchParams(window.location.search).get("symbol");
  if (query && /^[A-Z0-9]{2,18}_USDT$/.test(query.toUpperCase())) return query.toUpperCase();
  const selected = document.querySelector<HTMLElement>(".opportunity-row.selected strong")?.textContent?.trim().toUpperCase() ?? "";
  if (selected.endsWith("USDT") && !selected.includes("_")) return `${selected.slice(0, -4)}_USDT`;
  return "BTC_USDT";
}

function strategyStateLabel(state: Diagnostics["strategies"][number]["state"]) {
  if (state === "ready") return "满足入场";
  if (state === "blocked") return "安全拦截";
  return "继续观察";
}

export function OpportunityStrategyDiagnostics() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [symbol, setSymbol] = useState("BTC_USDT");
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let current: HTMLElement | null = null;
    const sync = () => {
      const marketStatus = document.querySelector<HTMLElement>(".market-status");
      if (!marketStatus) {
        current?.remove();
        current = null;
        setHost(null);
        return;
      }
      let target = document.querySelector<HTMLElement>('[data-v3-opportunity-diagnostics="true"]');
      if (!target) {
        target = document.createElement("div");
        target.dataset.v3OpportunityDiagnostics = "true";
        marketStatus.insertAdjacentElement("afterend", target);
      }
      current = target;
      setHost((previous) => previous === target ? previous : target);
      const nextSymbol = selectedSymbolFromPage();
      setSymbol((previous) => previous === nextSymbol ? previous : nextSymbol);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      current?.remove();
    };
  }, []);

  const load = useCallback(async () => {
    if (!host) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/strategy-lab/diagnostics?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? `V3 策略诊断失败 (${response.status})`);
      setDiagnostics(payload as Diagnostics);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "V3 策略诊断失败");
    } finally {
      setLoading(false);
    }
  }, [host, symbol]);

  useEffect(() => {
    if (!host) return;
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [host, load]);

  if (!host) return null;

  const regime = diagnostics?.regime;
  const readyCount = diagnostics?.strategies.filter((strategy) => strategy.state === "ready").length ?? 0;
  const scannerAge = diagnostics?.background.scannerLastSuccessAt ? Date.now() - diagnostics.background.scannerLastSuccessAt : Number.POSITIVE_INFINITY;
  const scannerHealthy = Boolean(diagnostics?.background.active && diagnostics.background.scannerState === "live" && scannerAge < 150_000 && !diagnostics.background.scannerLastError);

  return createPortal(<section aria-label="V3策略监控" style={{ margin: "0 0 14px", border: "1px solid #1b2b39", borderRadius: 16, padding: 13, background: "linear-gradient(155deg,#0e1c29,#08131c)" }}>
    <div className="section-title" style={{ marginTop: 0 }}><span>V3 策略监控</span><small>{symbol.replace("_", "")} · 新策略专用数据</small></div>

    <div className={`invalid-box ${scannerHealthy ? "muted" : ""}`} style={{ marginBottom: 10 }}>
      <div>
        <span>{scannerHealthy ? "后台策略引擎运行中" : "后台策略引擎需要检查"}</span>
        <strong>{diagnostics ? `${diagnostics.background.scannerState ?? "--"} · 最近后台扫描 ${time(diagnostics.background.scannerLastSuccessAt)} · 当前诊断 ${time(diagnostics.observedAt)}` : loading ? "正在核对 V3 数据链…" : "等待诊断"}</strong>
        {diagnostics?.background.scannerLastError && <small className="danger">{diagnostics.background.scannerLastError}</small>}
      </div>
    </div>

    {error && <div className="live-error"><span>{error}</span><button className="text-button" onClick={() => void load()}>重试</button></div>}

    {diagnostics && <>
      <div className="live-status-grid">
        <div><span>V3 市场状态</span><strong>{regime ? REGIME_LABEL[regime.kind] : "--"}</strong></div>
        <div><span>趋势强度</span><strong>{regime ? `${regime.trendScore >= 0 ? "+" : ""}${regime.trendScore.toFixed(2)}` : "--"}</strong></div>
        <div><span>5m ATR</span><strong>{regime?.atrPct == null ? "--" : `${regime.atrPct.toFixed(2)}%`}</strong></div>
        <div><span>ATR 压缩</span><strong>{ratio(regime?.compressionRatio)}</strong></div>
        <div><span>近端区间宽度</span><strong>{regime?.rangeWidthPct == null ? "--" : `${regime.rangeWidthPct.toFixed(2)}%`}</strong></div>
        <div><span>相对 BTC/ETH</span><strong>{pct(regime?.relativeStrength24h)}</strong></div>
        <div><span>Spot CVD</span><strong>{diagnostics.market.spotCvdRatio == null ? "--" : pct(diagnostics.market.spotCvdRatio * 100, 1)}</strong></div>
        <div><span>OI 变化</span><strong>{pct(diagnostics.market.openInterestChangePct)}</strong></div>
        <div><span>订单簿不平衡</span><strong>{diagnostics.market.orderBookImbalance == null ? "--" : pct(diagnostics.market.orderBookImbalance * 100, 1)}</strong></div>
        <div><span>资金费率</span><strong>{diagnostics.market.fundingRate == null ? "--" : `${(diagnostics.market.fundingRate * 100).toFixed(4)}%`}</strong></div>
      </div>

      <div className="section-title"><span>四策略当前判定</span><small>{readyCount ? `${readyCount} 个达到影子入场条件` : "本轮没有完整入场条件"}</small></div>
      <div style={{ display: "grid", gap: 7 }}>
        {diagnostics.strategies.map((strategy) => {
          const failed = strategy.checks.filter((check) => check.required && !check.passed).slice(0, 3);
          const passed = strategy.checks.filter((check) => check.passed).slice(-2);
          return <div key={strategy.strategyId} style={{ border: "1px solid rgba(151,174,193,.12)", borderRadius: 11, padding: "9px 10px", background: "rgba(7,16,25,.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><strong>{strategy.label} · {strategy.side}</strong><b className={strategy.state === "ready" ? "good" : strategy.state === "blocked" ? "danger" : "warn"}>{strategyStateLabel(strategy.state)}</b></div>
            <span style={{ display: "block", color: "#8295a6", fontSize: 10, marginTop: 4 }}>可信度 {strategy.confidence}% · {strategy.blockers[0] ?? "无安全级阻塞"}</span>
            <div style={{ display: "grid", gap: 3, marginTop: 6 }}>
              {(failed.length ? failed : passed).map((check) => <span key={check.key} style={{ color: check.passed ? "#8295a6" : "#ffbd4a", fontSize: 9 }}>{check.passed ? "✓" : "待"} {check.label}：{check.detail}</span>)}
            </div>
          </div>;
        })}
      </div>
      <p className="risk-note" style={{ marginTop: 10 }}>这里展示的是 V3 新策略真正使用的派生数据和当前卡点；它与 Baseline 原策略并行监控。V3 仍只做影子模拟，不会直接触发 Gate 实盘。</p>
    </>}
  </section>, host);
}
