"use client";

import { useEffect } from "react";

function normalizeRiskCopy() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const original = node.textContent ?? "";
    let next = original;
    if (next.includes("Gate 权益较实盘峰值回撤")) {
      next = next.replace("Gate 权益较实盘峰值回撤", "旧版账户权益回撤");
    } else if (next.includes("峰值回撤")) {
      next = next.replaceAll("峰值回撤", "实盘交易回撤");
      if (!next.includes("资金划转不计")) next += "（资金划转不计）";
    }
    if (next !== original) node.textContent = next;
    node = walker.nextNode();
  }
}

function normalizeOrderLedgerHeading() {
  const ledger = document.querySelector<HTMLElement>(".order-ledger");
  const heading = ledger?.querySelector<HTMLElement>(".utility-heading");
  if (!heading) return;
  const eyebrow = heading.querySelector<HTMLElement>(".eyebrow");
  const title = heading.querySelector<HTMLElement>("strong");
  if (eyebrow?.textContent?.includes("1000U 模拟合约账户")) eyebrow.textContent = "模拟 + Gate 实盘 · 两套账本分开";
  if (title?.textContent?.includes("确认 → 持仓 → 平仓 → 复盘学习")) title.textContent = "订单账本与交易复盘";
}

function normalizeUiSemantics() {
  const banner = document.querySelector<HTMLElement>('[aria-label="数据状态"]');
  if (banner) {
    const source = banner.querySelector("span");
    if (source) {
      for (const node of Array.from(source.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Gate 实时")) {
          node.textContent = node.textContent.replace("Gate 实时", "Gate 行情实时");
        }
      }
    }

    const status = banner.querySelector("b");
    if (status?.textContent === "无交易权限") status.textContent = "实盘未配置";
    if (status?.textContent === "实盘关闭") status.textContent = "自动实盘关闭";
  }

  for (const label of Array.from(document.querySelectorAll<HTMLElement>(".credential-summary span"))) {
    if (label.textContent?.trim() === "合约可用") label.textContent = "验证时逐仓可用";
  }

  normalizeRiskCopy();
  normalizeOrderLedgerHeading();
}

export function UiStatusSemanticFix() {
  useEffect(() => {
    normalizeUiSemantics();
    const observer = new MutationObserver(normalizeUiSemantics);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
