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
  description: "Resonance：结合当前市场结构、历史相似行情、十三种统一模拟策略与阶段复盘的自适应交易系统。",
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
    description: "市场判断 · 历史记忆 · 策略大脑 · 模拟实盘同链",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Resonance" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Resonance｜自适应交易系统",
    description: "市场判断 · 历史记忆 · 策略大脑 · 模拟实盘同链",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#06131c",
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
