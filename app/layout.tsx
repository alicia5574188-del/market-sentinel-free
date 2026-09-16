import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./forward-dashboard.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "哨兵 · 关系引擎 | 前向实验",
  description: "真实行情驱动的关系观测、规则生成、模拟交易与可审计演变；新规则仅模拟",
  applicationName: "哨兵关系引擎",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#f3f4f0" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
