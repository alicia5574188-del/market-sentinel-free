"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type StrategyPoolActivity = {
  windowMinutes: number;
  evaluations: number;
  symbols: number;
  playbookCount: number;
  playbooks: string[];
  states: { trade: number; watch: number; reject: number };
};

type Strategy2Packet = {
  strategyPool?: StrategyPoolActivity | null;
};

function playbookShortName(value: string) {
  return value.match(/^P\d+/)?.[0] ?? value;
}

export function Strategy2Visibility() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pool, setPool] = useState<StrategyPoolActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = () => {
      const panel = document.querySelector<HTMLElement>(".v2-opportunity-panel");
      const counts = panel?.querySelector<HTMLElement>(".v2-state-counts");
      const head = panel?.querySelector<HTMLElement>(".v2-panel-head");
      if (!panel || !counts || !head) return;
      const eyebrow = head.querySelector<HTMLElement>("div > span");
      const title = head.querySelector<HTMLElement>("div > strong");
      if (eyebrow && eyebrow.textContent !== "Sentinel Strategy 2.0") eyebrow.textContent = "Sentinel Strategy 2.0";
      if (title && title.textContent !== "12 策略并行竞争") title.textContent = "12 策略并行竞争";
      let node = panel.querySelector<HTMLElement>("#strategy2-pool-visibility");
      if (!node) {
        node = document.createElement("div");
        node.id = "strategy2-pool-visibility";
        counts.before(node);
      }
      if (!cancelled) setHost(node);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { cancelled = true; observer.disconnect(); };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/v2", { cache: "no-store" });
        if (!response.ok) return;
        const packet = await response.json() as Strategy2Packet;
        if (active) setPool(packet.strategyPool ?? null);
      } catch {}
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  if (!host) return null;
  const covered = pool?.playbooks.map(playbookShortName).join(" · ") ?? "等待策略池数据";
  return createPortal(
    <div style={{ margin: "12px 0", padding: "12px 14px", borderRadius: 14, border: "1px solid rgba(86,207,238,.18)", background: "rgba(28,93,119,.10)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12, color: "#dce9f7" }}>Strategy 2.0 策略池</strong>
        <span style={{ fontSize: 11, color: pool?.playbookCount === 12 ? "#62dfa2" : "#ffc45f" }}>Playbook {pool?.playbookCount ?? 0}/12</span>
      </div>
      <div style={{ marginTop: 7, fontSize: 11, lineHeight: 1.5, color: "#93a5ba" }}>
        {pool ? `近 ${pool.windowMinutes} 分钟 ${pool.evaluations} 次策略评估 · ${pool.symbols} 个币 · TRADE ${pool.states.trade} / WATCH ${pool.states.watch} / REJECT ${pool.states.reject}` : "正在读取最近的 Strategy 2.0 策略评估活动"}
      </div>
      <div style={{ marginTop: 6, fontSize: 10, lineHeight: 1.45, color: "#74879d" }}>{covered}</div>
      <div style={{ marginTop: 7, fontSize: 10, lineHeight: 1.45, color: "#7f91a8" }}>下方三张卡只显示每个币当前排名最高的冠军策略；它们都显示 P1 并不代表后台只运行 P1。</div>
    </div>,
    host,
  );
}
