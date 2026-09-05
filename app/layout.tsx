import type { Metadata, Viewport } from "next";
import { requireChatGPTUser } from "./chatgpt-auth";
import ResonanceOperatorControls from "./resonance-operator-controls";
import "./globals.css";
import "./resonance.css";
import "./resonance-operator-controls.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://market-sentinel-free.alicia5574188.workers.dev"),
  title: "Resonance｜自适应交易系统",
  description: "Resonance：用历史相似走势预测、真实模拟结果和每12小时复盘驱动的自适应交易系统。",
  applicationName: "Resonance",
  manifest: "/manifest.webmanifest",
  formatDetection: { telephone: false },
  appleWebApp: {
    capable: true,
    title: "Resonance",
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
    title: "Resonance｜自适应交易系统",
    description: "历史走势对照 · 模拟验证 · 12小时复盘",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Resonance" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Resonance｜自适应交易系统",
    description: "历史走势对照 · 模拟验证 · 12小时复盘",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#080b13",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireChatGPTUser("/");
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <ResonanceOperatorControls />
      </body>
    </html>
  );
}
