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

function ensureLiveOrdersShortcut() {
  if (window.location.pathname !== "/") return;
  const card = document.querySelector<HTMLElement>(".live-trading-card");
  if (!card || card.querySelector('[data-live-orders-shortcut="true"]')) return;
  const heading = card.querySelector<HTMLElement>(".utility-heading");
  if (!heading) return;

  const row = document.createElement("div");
  row.dataset.liveOrdersShortcut = "true";
  row.style.display = "grid";
  row.style.gridTemplateColumns = "1fr auto";
  row.style.alignItems = "center";
  row.style.gap = "10px";
  row.style.margin = "10px 0 2px";
  row.style.padding = "10px 11px";
  row.style.border = "1px solid rgba(67,199,239,.24)";
  row.style.borderRadius = "12px";
  row.style.background = "rgba(67,199,239,.07)";

  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Gate 实盘订单";
  title.style.display = "block";
  title.style.fontSize = "12px";
  const note = document.createElement("span");
  note.textContent = "真实仓位、已平仓、盈亏和异常记录单独查看";
  note.style.display = "block";
  note.style.marginTop = "3px";
  note.style.fontSize = "10px";
  note.style.color = "#8295a6";
  copy.append(title, note);

  const link = document.createElement("a");
  link.href = "/live-orders";
  link.textContent = "查看实盘订单";
  link.style.color = "#43c7ef";
  link.style.textDecoration = "none";
  link.style.fontSize = "11px";
  link.style.fontWeight = "800";
  link.style.whiteSpace = "nowrap";
  link.style.padding = "8px 9px";
  link.style.border = "1px solid rgba(67,199,239,.34)";
  link.style.borderRadius = "9px";
  link.style.background = "rgba(67,199,239,.08)";

  row.append(copy, link);
  heading.insertAdjacentElement("afterend", row);
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
  ensureLiveOrdersShortcut();
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
