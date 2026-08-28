import type { Metadata, Viewport } from "next";
import { requireChatGPTUser } from "./chatgpt-auth";
import "./globals.css";
import "./hte31.css";
import "./hte31-chart.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://market-sentinel-free.alicia5574188.workers.dev"),
  title: "Market Sentinel｜HTE 3.1 Clean",
  description: "Sentinel HTE 3.1 Clean：独立交易员、全新模拟账本、独立持仓管理与出场后复盘学习。",
  applicationName: "Market Sentinel",
  manifest: "/manifest.webmanifest",
  formatDetection: { telephone: false },
  appleWebApp: {
    capable: true,
    title: "行情哨兵",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/favicon.svg",
    apple: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title: "Market Sentinel｜HTE 3.1 Clean",
    description: "Clean Scanner · 独立交易员 · 新账本 · Post-Exit Observer",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Market Sentinel HTE 3.1 Clean" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Market Sentinel｜HTE 3.1 Clean",
    description: "Clean Scanner · 独立交易员 · 新账本 · Post-Exit Observer",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#06111a",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireChatGPTUser("/");
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
