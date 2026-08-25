"use client";

import { useEffect } from "react";

function normalizeBannerStatus() {
  const banner = document.querySelector<HTMLElement>('[aria-label="数据状态"]');
  if (!banner) return;

  const source = banner.querySelector("span");
  if (source) {
    for (const node of Array.from(source.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Gate 实时")) {
        node.textContent = node.textContent.replace("Gate 实时", "Gate 行情实时");
      }
    }
  }

  const status = banner.querySelector("b");
  if (!status) return;
  if (status.textContent === "无交易权限") status.textContent = "实盘未配置";
  if (status.textContent === "实盘关闭") status.textContent = "自动实盘关闭";
}

export function UiStatusSemanticFix() {
  useEffect(() => {
    normalizeBannerStatus();
    const observer = new MutationObserver(normalizeBannerStatus);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
