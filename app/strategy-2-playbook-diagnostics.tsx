"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type PlaybookDiagnostic = {
  id: string;
  label: string;
  evaluations: number;
  trade: number;
  watch: number;
  reject: number;
  completedSamples: number;
  diagnosis: string;
};

type DiagnosticsPacket = {
  observedAt: number;
  observationOnly: true;
  strategyLogicChanged: false;
  windowMinutes: number;
  coverageCount: number;
  missingPlaybooks: { id: string; label: string }[];
  playbooks: PlaybookDiagnostic[];
  note?: string;
  error?: string;
};

function shortId(id: string) {
  return id.match(/^P\d+/)?.[0] ?? id;
}

export function Strategy2PlaybookDiagnostics() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [packet, setPacket] = useState<DiagnosticsPacket | null>(null);

  useEffect(() => {
    const syncTarget = () => {
      const next = document.querySelector<HTMLElement>(".strategy2-learning");
      setTarget((current) => current === next ? current : next);
    };
    syncTarget();
    const observer = new MutationObserver(syncTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/v2/playbook-diagnostics", { cache: "no-store" });
        const next = await response.json() as DiagnosticsPacket;
        if (active) setPacket(next);
      } catch {
        if (active) setPacket((current) => current ?? null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const missingDetails = useMemo(() => {
    if (!packet) return [];
    const missing = new Set(packet.missingPlaybooks.map((item) => item.id));
    return packet.playbooks.filter((item) => missing.has(item.id));
  }, [packet]);

  if (!target || !packet || packet.error) return null;

  return createPortal(
    <section className="strategy2-playbook-diagnostics" aria-label="Playbook 使用诊断">
      <div className="strategy2-playbook-diagnostics-head">
        <div><strong>Playbook 使用诊断</strong><span>观察模式 · 不改策略参数</span></div>
        <b>{packet.coverageCount}/12 已有完成样本</b>
      </div>

      {packet.missingPlaybooks.length > 0 ? (
        <div className="strategy2-playbook-missing">
          <span>未覆盖 Playbook</span>
          <strong>{packet.missingPlaybooks.map((item) => item.label).join(" · ")}</strong>
          <small>“未覆盖”只表示还没有完成学习样本，不等于策略没有运行。</small>
        </div>
      ) : (
        <div className="strategy2-playbook-missing covered">
          <span>学习覆盖</span><strong>12/12 全部已有完成样本</strong>
        </div>
      )}

      {missingDetails.map((item) => (
        <div className="strategy2-playbook-funnel focus" key={item.id}>
          <div><strong>{item.label}</strong><span>完成样本 {item.completedSamples}</span></div>
          <p>近 {packet.windowMinutes} 分钟：评估 {item.evaluations} · TRADE候选 {item.trade} · WATCH {item.watch} · REJECT {item.reject}</p>
          <small>{item.diagnosis}</small>
        </div>
      ))}

      <div className="strategy2-playbook-sample-grid">
        {packet.playbooks.map((item) => (
          <span className={item.completedSamples === 0 ? "missing" : ""} key={item.id} title={item.label}>
            {shortId(item.id)} <b>{item.completedSamples}</b>
          </span>
        ))}
      </div>

      <small className="strategy2-playbook-diagnostics-note">{packet.note}</small>
    </section>,
    target,
  );
}
