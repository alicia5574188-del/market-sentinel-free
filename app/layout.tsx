import type { Metadata, Viewport } from "next";
import { requireChatGPTUser } from "./chatgpt-auth";
import { LiveOrdersInline } from "./live-orders-inline";
import { SentinelV2ContextBar } from "./sentinel-v2-context-bar";
import { UiStatusSemanticFix } from "./ui-status-semantic-fix";
import "./globals.css";
import "./polish.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://market-sentinel.alicia5574188.chatgpt.site"),
  title: "Market Sentinel｜行情哨兵",
  description: "面向 iPhone 的加密市场实时监测与证据驱动提醒：结论、理由、反证和失效条件一次说清。",
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
    title: "Market Sentinel｜行情哨兵",
    description: "实时监测 · 证据驱动 · 明确失效",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Market Sentinel 行情哨兵" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Market Sentinel｜行情哨兵",
    description: "实时监测 · 证据驱动 · 明确失效",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#071019",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireChatGPTUser("/");
  return (
    <html lang="zh-CN">
      <body>
        <SentinelV2ContextBar />
        {children}
        <LiveOrdersInline />
        <UiStatusSemanticFix />
        <script src="/live-position-mode-helper.js" defer />
      </body>
    </html>
  );
}
