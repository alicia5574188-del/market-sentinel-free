import type { Metadata, Viewport } from "next";
import { requireChatGPTUser } from "./chatgpt-auth";
import ResonanceOperatorControls from "./resonance-operator-controls";
import "./globals.css";
import "./resonance.css";
import "./resonance-operator-controls.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://market-sentinel-free.alicia5574188.workers.dev"),
  title: "共振量化｜短线交易台",
  description: "历史方向交易模拟：历史走势预测、当前决定、持仓保护与交易结果。",
  applicationName: "共振量化",
  manifest: "/manifest.webmanifest",
  formatDetection: { telephone: false },
  appleWebApp: {
    capable: true,
    title: "共振量化",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/resonance-icon-v1.svg",
    shortcut: "/resonance-icon-v1.svg",
    apple: "/resonance-icon-v1.svg",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title: "共振量化｜短线交易台",
    description: "历史方向交易 · 持仓保护 · 模拟验证",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Resonance" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "共振量化｜短线交易台",
    description: "历史方向交易 · 持仓保护 · 模拟验证",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#121411",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireChatGPTUser("/");
  return (
    <html lang="zh-CN">
      <body>
        <div className="rz-operator-bar"><span>北京时间</span><ResonanceOperatorControls /></div>
        {children}
      </body>
    </html>
  );
}
