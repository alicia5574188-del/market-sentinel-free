"use client";

import { useEffect, useState } from "react";
import { chineseOperatorText, operatorLabel } from "../lib/operator-language";

type Account = {
  id: string;
  email: string;
  displayName: string;
  role: "owner" | "member";
  status: "active" | "disabled";
  signOutPath: string;
};

type AuditEvent = {
  id: string;
  severity: string;
  message: string;
  createdAt: number;
};

type LiveAuditSnapshot = {
  audit?: AuditEvent[];
  error?: string;
};

type PushKey = {
  available: boolean;
  publicKey?: string;
  error?: string;
};

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `${url} 请求失败 (${response.status})`);
  return payload;
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export default function ResonanceOperatorControls() {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountRequested, setAccountRequested] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open || accountRequested) return;
    queueMicrotask(() => setAccountRequested(true));
    void readJson<Account>("/api/account")
      .then(setAccount)
      .catch((error) => setMessage(error instanceof Error ? error.message : "账户信息读取失败"));
  }, [open, accountRequested]);

  useEffect(() => {
    if (!open || pushSubscribed !== null) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      queueMicrotask(() => setPushSubscribed(false));
      return;
    }
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setPushSubscribed(Boolean(subscription)))
      .catch(() => setPushSubscribed(false));
  }, [open, pushSubscribed]);

  async function enablePush() {
    setPushBusy(true);
    setMessage("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("当前浏览器不支持 消息推送；苹果手机请用 Safari 添加到主屏幕后再开启。");
      }
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission !== "granted") throw new Error("通知权限未开启。");
      const registration = await navigator.serviceWorker.ready;
      const key = await readJson<PushKey>("/api/push/key");
      if (!key.available || !key.publicKey) throw new Error(key.error ?? "推送服务尚未激活");
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(key.publicKey),
      });
      await readJson("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      setPushSubscribed(true);
      setMessage("通知已开启。正式提醒由服务器后台发送，关闭页面后仍可工作。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "推送订阅失败");
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePush() {
    setPushBusy(true);
    setMessage("");
    try {
      if (!("serviceWorker" in navigator)) throw new Error("当前浏览器没有可用的后台服务。");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await readJson("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setPushSubscribed(false);
      setMessage("通知已关闭。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "取消推送失败");
    } finally {
      setPushBusy(false);
    }
  }

  async function testPush() {
    setPushBusy(true);
    setMessage("");
    try {
      const result = await readJson<{ attempted: number; delivered: number }>("/api/push/test", { method: "POST" });
      setMessage(result.delivered ? "测试推送已送达。" : `已尝试 ${result.attempted} 个订阅，暂未确认送达。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试推送失败");
    } finally {
      setPushBusy(false);
    }
  }

  async function loadAudit() {
    setAuditBusy(true);
    setMessage("");
    try {
      const snapshot = await readJson<LiveAuditSnapshot>("/api/live/status");
      setAudit((snapshot.audit ?? []).slice(0, 12));
      if (!(snapshot.audit?.length)) setMessage("当前没有实盘安全审计记录。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "安全审计读取失败");
    } finally {
      setAuditBusy(false);
    }
  }

  return <>
    <button className="rz-operator-launcher" type="button" onClick={() => setOpen(true)} aria-label="账户与通知">
      账户 · 通知
    </button>
    {open && <div className="rz-operator-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <section className="rz-operator-drawer" role="dialog" aria-modal="true" aria-label="账户、通知与安全审计" onClick={(event) => event.stopPropagation()}>
        <div className="rz-operator-head">
          <div><span>账户中心</span><strong>账户与通知</strong></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="关闭">关闭</button>
        </div>

        <div className="rz-operator-block">
          <div className="rz-operator-title"><strong>当前账户</strong><span>按需读取，不参与页面轮询</span></div>
          {account ? <div className="rz-operator-account">
            <div><span>{account.role === "owner" ? "所有者" : "只读成员"}</span><strong>{account.displayName || account.email}</strong><small>{account.email}</small></div>
            <button type="button" onClick={() => window.location.assign(account.signOutPath)}>退出登录</button>
          </div> : <p className="rz-operator-copy">{accountRequested ? "正在读取账户…" : "打开面板后读取账户。"}</p>}
        </div>

        <div className="rz-operator-block">
          <div className="rz-operator-title"><strong>消息推送</strong><span>关闭页面后仍由后台发送</span></div>
          <p className="rz-operator-copy">当前状态：{pushSubscribed === null ? "检查中" : pushSubscribed ? "已开启" : "未开启"}</p>
          <div className="rz-operator-actions">
            <button type="button" disabled={pushBusy} onClick={() => void (pushSubscribed ? disablePush() : enablePush())}>{pushSubscribed ? "关闭通知" : "开启通知"}</button>
            <button type="button" disabled={pushBusy || !pushSubscribed} onClick={() => void testPush()}>测试推送</button>
          </div>
        </div>

        {account?.role === "owner" && <div className="rz-operator-block">
          <div className="rz-operator-title"><strong>实盘安全审计</strong><span>手动读取，不新增后台轮询</span></div>
          <div className="rz-operator-actions"><button type="button" disabled={auditBusy} onClick={() => void loadAudit()}>{auditBusy ? "读取中…" : "查看最近安全审计"}</button></div>
          {audit && <div className="rz-operator-audit">{audit.length ? audit.map((event) => <div key={event.id}><span>{operatorLabel(event.severity)}</span><strong>{chineseOperatorText(event.message)}</strong><small>{formatTime(event.createdAt)}</small></div>) : <p>暂无审计记录。</p>}</div>}
        </div>}

        {message && <div className="rz-operator-message" aria-live="polite">{message}</div>}
      </section>
    </div>}
  </>;
}
