"use client";

import { useCallback, useEffect, useState } from "react";

type Pulse = {
  observedAt: number;
  context: null | {
    regimeLabel: string;
    confidence: number;
    stability: number;
    transitionRisk: number;
    riskVelocity: number;
    permission: "GREEN" | "BLUE" | "YELLOW" | "ORANGE" | "RED";
    directionBias: "LONG" | "SHORT" | "NEUTRAL";
    developingRegime: string | null;
  };
  warnings: { label: string; severity: number; detail: string }[];
  recommended: unknown[];
  watch: unknown[];
  rejected: unknown[];
  error?: string;
};

function permissionLabel(permission: NonNullable<Pulse["context"]>["permission"]) {
  return permission === "GREEN" ? "正常"
    : permission === "BLUE" ? "避免追价"
      : permission === "YELLOW" ? "提高门槛"
        : permission === "ORANGE" ? "只做最强"
          : "停止新增风险";
}

function biasLabel(bias: NonNullable<Pulse["context"]>["directionBias"]) {
  return bias === "LONG" ? "偏多" : bias === "SHORT" ? "偏空" : "中性";
}

export function SentinelV2ContextBar() {
  const [pulse, setPulse] = useState<Pulse | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v2/pulse?symbol=BTC_USDT", { cache: "no-store" });
      const body = await response.json() as Pulse;
      if (response.ok || body.context) setPulse(body);
    } catch {
      // The core page remains usable when V2 telemetry is temporarily unavailable.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!pulse?.context) return null;
  const context = pulse.context;
  const rising = context.riskVelocity > 2;
  const topWarning = pulse.warnings[0] ?? null;

  return (
    <aside
      aria-label="Sentinel V2 市场环境"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 80,
        width: "min(1120px, calc(100% - 24px))",
        margin: "8px auto 0",
        padding: "10px 12px",
        border: "1px solid rgba(148, 163, 184, 0.18)",
        borderRadius: 14,
        background: "rgba(7, 16, 25, 0.93)",
        backdropFilter: "blur(16px)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
        <strong style={{ letterSpacing: ".08em", fontSize: 11, opacity: 0.78 }}>MARKET CONTEXT · SENTINEL V2</strong>
        <span style={{ fontWeight: 750 }}>{context.permission} · {permissionLabel(context.permission)}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8 }}>
        <div><div style={{ opacity: 0.55 }}>环境</div><b>{context.regimeLabel}</b></div>
        <div><div style={{ opacity: 0.55 }}>置信</div><b>{context.confidence}</b></div>
        <div><div style={{ opacity: 0.55 }}>稳定</div><b>{context.stability}</b></div>
        <div><div style={{ opacity: 0.55 }}>切换风险</div><b>{context.transitionRisk}{rising ? " ↑" : ""}</b></div>
        <div><div style={{ opacity: 0.55 }}>偏向</div><b>{biasLabel(context.directionBias)}</b></div>
      </div>
      {topWarning ? (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(148,163,184,.12)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ opacity: 0.58 }}>首要预警 · </span><b>{topWarning.label} {Math.round(topWarning.severity)}</b><span style={{ opacity: 0.72 }}> · {topWarning.detail}</span>
        </div>
      ) : null}
    </aside>
  );
}
