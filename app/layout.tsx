import type { Metadata, Viewport } from "next";
import { requireChatGPTUser } from "./chatgpt-auth";
import { LiveOrdersInline } from "./live-orders-inline";
import { Strategy2Dashboard } from "./strategy-2-dashboard";
import { UiStatusSemanticFix } from "./ui-status-semantic-fix";
import "./globals.css";
import "./polish.css";
import "./sentinel-v2.css";
import "./strategy-2-unified.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://market-sentinel-free.alicia5574188.workers.dev"),
  title: "Market Sentinel｜Strategy 2.0",
  description: "Sentinel Strategy 2.0：环境识别、多策略并行竞争、风险控制与交易学习统一展示。",
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
    title: "Market Sentinel｜Strategy 2.0",
    description: "环境识别 · 多策略竞争 · 风险控制 · 持续学习",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Market Sentinel Strategy 2.0" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Market Sentinel｜Strategy 2.0",
    description: "环境识别 · 多策略竞争 · 风险控制 · 持续学习",
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
        {children}
        <Strategy2Dashboard />
        <LiveOrdersInline />
        <UiStatusSemanticFix />
        <script src="/live-position-mode-helper.js" defer />
      </body>
    </html>
  );
}
