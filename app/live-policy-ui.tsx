"use client";

import { useEffect } from "react";

const TEXT_REPLACEMENTS: Array<[string, string]> = [
  ["只有全部进场检查和 15U 净利润闸门通过", "只有全部进场检查和按当前模拟权益 1.5% 计算的净利润闸门通过"],
  ["TP2 预计净利润 ≥ 15U", "TP2 预计净利润 ≥ Gate 当前权益的 1.5%"],
  ["Gate TestNet", "旧 TestNet（需更换为 Gate 实盘）"],
];

function replaceLegacyPolicyText(root: ParentNode) {
  const targets = root.querySelectorAll<HTMLElement>(".risk-note, .safety-list, .credential-summary, .credential-form");
  for (const target of targets) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      let value = node.nodeValue ?? "";
      for (const [from, to] of TEXT_REPLACEMENTS) value = value.replaceAll(from, to);
      if (value !== node.nodeValue) node.nodeValue = value;
      node = walker.nextNode();
    }
  }
}

function enforceLiveOnlyEnvironmentUi(root: ParentNode) {
  const pickers = root.querySelectorAll<HTMLElement>(".live-environment");
  for (const picker of pickers) {
    picker.setAttribute("aria-label", "Gate 实盘 API");
    picker.title = "程序只接受 Gate 实盘 API；策略验证请使用程序内模拟交易";
    const buttons = picker.querySelectorAll<HTMLButtonElement>("button");
    const liveButton = buttons.item(0);
    const legacyTestnetButton = buttons.item(1);
    if (liveButton) {
      liveButton.classList.add("active");
      liveButton.setAttribute("aria-pressed", "true");
    }
    if (legacyTestnetButton) {
      legacyTestnetButton.hidden = true;
      legacyTestnetButton.tabIndex = -1;
      legacyTestnetButton.setAttribute("aria-hidden", "true");
    }
  }
}

function syncLivePolicyUi() {
  replaceLegacyPolicyText(document);
  enforceLiveOnlyEnvironmentUi(document);
}

/**
 * Compatibility shim for the existing single-file dashboard UI.
 *
 * The server is authoritative: credential saves are forced to environment=live
 * and the trading engine refuses legacy TestNet credentials. This client helper
 * only keeps the currently deployed large dashboard's labels and legacy picker
 * aligned with that server policy without risking a wholesale page rewrite.
 */
export function LivePolicyUiSync() {
  useEffect(() => {
    let scheduled = false;
    const scheduleSync = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        syncLivePolicyUi();
      });
    };
    scheduleSync();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
