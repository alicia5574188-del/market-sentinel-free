import type { Metadata, Viewport } from "next";
import { requireChatGPTUser } from "./chatgpt-auth";
import "./globals.css";
import "./human-trader.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://market-sentinel-free.alicia5574188.workers.dev"),
  title: "Market Sentinel｜Human Trader Engine 3.0",
  description: "Sentinel Human Trader Engine 3.0：三位独立交易员、环境识别、Risk Governor、模拟与 Gate 实盘统一工作台。",
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
    title: "Market Sentinel｜Human Trader Engine 3.0",
    description: "三位独立交易员 · 环境预警 · Risk Governor · 新账本学习",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Market Sentinel Human Trader Engine 3.0" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Market Sentinel｜Human Trader Engine 3.0",
    description: "三位独立交易员 · 环境预警 · Risk Governor · 新账本学习",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#071018",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireChatGPTUser("/");
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
