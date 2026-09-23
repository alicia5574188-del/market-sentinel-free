import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./forward-dashboard.css";
import "./record-controls.css";
import "./member-access.css";
import "./live-priority.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "哨兵 · AnchorFlow | 前向实验",
  description: "真实行情驱动的5分钟区域生命周期、模拟交易与可审计演变；成熟区域的接受迁移与边界拒绝为当前交易权威",
  applicationName: "哨兵区域生命周期引擎",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0b111a" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
