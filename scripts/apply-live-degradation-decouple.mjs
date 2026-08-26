import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, before, after) {
  const source = await readFile(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one match, found ${count}`);
  await writeFile(path, source.replace(before, after));
}

await replaceOnce(
  "lib/live-trading-engine.ts",
  `  if (account.margin_mode != null && Number(account.margin_mode) !== 0) {\n    throw new Error("Gate 账户已切换为统一/组合保证金模式；无法可靠确认实盘权益，已停止新开仓");\n  }\n  if (!closePage.complete) throw new Error("Gate 当日平仓记录达到 1000 条，无法确认日内盈亏完整性");\n  const accountEquityUsdt = gateAccountEquityUsdt(account);\n  if (accountEquityUsdt <= 0) throw new Error("Gate 合约账户权益无效或已归零");`,
  `  if (account.margin_mode != null && Number(account.margin_mode) !== 0) {\n    const reason = "Gate 账户已切换为统一/组合保证金模式；无法可靠确认实盘权益，已停止新开仓";\n    const current = await getLiveControl();\n    if (current.entryEnabled && current.state === "armed") await riskLock(reason);\n    throw new Error(reason);\n  }\n  if (!closePage.complete) {\n    const reason = "Gate 当日平仓记录达到 1000 条，无法确认日内盈亏完整性";\n    const current = await getLiveControl();\n    if (current.entryEnabled && current.state === "armed") await riskLock(reason);\n    throw new Error(reason);\n  }\n  const accountEquityUsdt = gateAccountEquityUsdt(account);\n  if (accountEquityUsdt <= 0) {\n    const reason = "Gate 合约账户权益无效或已归零";\n    const current = await getLiveControl();\n    if (current.entryEnabled && current.state === "armed") await riskLock(reason);\n    throw new Error(reason);\n  }`,
);

await replaceOnce(
  "lib/live-trading-engine.ts",
  `    const reason = \`更新保护止损失败，旧止损保持有效：\${errorMessage(error)}\`;\n    await addLiveAudit({ eventType: "protective_stop_update_failed", severity: "critical", liveOrderId: order.id, symbol: order.symbol, message: \`\${order.symbol} \${reason}\` });\n    await riskLock(\`\${order.symbol} \${reason}\`, order);\n    throw error;`,
  `    const reason = \`更新保护止损失败，旧止损保持有效：\${errorMessage(error)}\`;\n    await addLiveAudit({ eventType: "protective_stop_update_failed", severity: "warning", liveOrderId: order.id, symbol: order.symbol, message: \`\${order.symbol} \${reason}；本轮暂停新开仓并等待自动重试\` });\n    // The previous stop is still active at Gate. A transient read/write failure\n    // must pause the current reconciliation cycle, not permanently disarm Auto Live.\n    throw error;`,
);

await replaceOnce(
  "lib/live-trading-engine.ts",
  `          ? \`恢复成交后 TP2 预计净利润 \${filledExpectedNetTp2Usdt.toFixed(2)}U，低于当前权益 1.5% 门槛 \${minimumNetTp2Usdt.toFixed(2)}U\``,
  `          ? \`恢复成交后 TP2 预计净利润 \${filledExpectedNetTp2Usdt.toFixed(2)}U，低于当前权益 0.25% 门槛 \${minimumNetTp2Usdt.toFixed(2)}U\``,
);

await replaceOnce(
  "lib/live-trading-engine.ts",
  `  if (control.state === "emergency_stopped") return runEmergencyStop("system", control.emergencyReason ?? "紧急停机自动复核");\n  let client: GatePrivateClient;`,
  `  if (control.state === "emergency_stopped") return runEmergencyStop("system", control.emergencyReason ?? "紧急停机自动复核");\n  // If the previous cycle failed only because data/network was temporarily unavailable,\n  // keep the owner's Auto Live intent armed but require one fully clean recovery cycle\n  // before a new Gate entry is allowed. Existing positions remain protected/reconciled.\n  const recoveringFromTransientPause = control.entryEnabled && control.state === "armed" && Boolean(control.lastError);\n  let client: GatePrivateClient;`,
);

await replaceOnce(
  "lib/live-trading-engine.ts",
  `    if (updatedControl.entryEnabled && updatedControl.state === "armed" && updatedControl.enabledAt) {`,
  `    if (updatedControl.entryEnabled && updatedControl.state === "armed" && updatedControl.enabledAt && !recoveringFromTransientPause) {`,
);

await replaceOnce(
  "lib/live-trading-engine.ts",
  `    await patchLiveControl({\n      lastReconciledAt: Date.now(),\n      lastSuccessfulReconcileAt: Date.now(),\n      lastError: finalControl.state === "risk_locked"\n        ? finalControl.lastError\n        : conflictError,\n    });\n    if (credentialRecord.status === "error") await markLiveCredentialVerification(true);`,
  `    await patchLiveControl({\n      lastReconciledAt: Date.now(),\n      lastSuccessfulReconcileAt: Date.now(),\n      lastError: finalControl.state === "risk_locked"\n        ? finalControl.lastError\n        : conflictError,\n    });\n    if (recoveringFromTransientPause && finalControl.entryEnabled && finalControl.state === "armed" && !conflictError) {\n      await addLiveAudit({\n        eventType: "reconciliation_recovered",\n        severity: "info",\n        message: "Gate 后台对账已恢复；本轮仅完成安全复核，下一轮恢复新开仓",\n      });\n    }\n    if (credentialRecord.status === "error") await markLiveCredentialVerification(true);`,
);

await replaceOnce(
  "lib/live-trading-engine.ts",
  `  } catch (error) {\n    const reason = errorMessage(error);\n    const latest = await getLiveControl();\n    if (latest.entryEnabled && latest.state === "armed") await riskLock(\`后台对账失败：\${reason}\`);\n    else {\n      const activeOrderCount = await countActiveLiveOrders().catch(() => 0);\n      const nextError = latest.state === "risk_locked" ? latest.lastError : reason;\n      await patchLiveControl({ lastReconciledAt: Date.now(), lastError: nextError });\n      if (activeOrderCount > 0 && latest.lastError !== nextError) {\n        await addLiveAudit({ eventType: "active_reconciliation_failed", severity: "critical", message: \`已有实盘仓位对账失败：\${reason}\` }).catch(() => undefined);\n        await notifyLiveOwner("Gate 已有仓位对账失败", reason, \`live-active-reconcile-failed-\${Date.now()}\`);\n      }\n    }\n    if (isCredentialFailure(error)) await markLiveCredentialVerification(false, reason).catch(() => undefined);\n    throw error;\n  }`,
  `  } catch (error) {\n    const reason = errorMessage(error);\n    const latest = await getLiveControl();\n    const credentialFailure = isCredentialFailure(error);\n    if (latest.entryEnabled && latest.state === "armed") {\n      if (credentialFailure) {\n        // 401/403 or an explicit authentication failure is not transient.\n        await riskLock(\`Gate API 凭据失效：\${reason}\`);\n      } else {\n        // A failed observation/reconciliation cycle is fail-safe by construction:\n        // no candidate can be submitted because this function exits before the entry path.\n        // Keep the owner's Auto Live intent armed so a 429/5xx/timeout/D1 hiccup\n        // does not require manual re-arming after every short outage.\n        const pauseReason = \`后台对账暂时不可用：\${reason}\`;\n        const changed = latest.lastError !== pauseReason;\n        await patchLiveControl({ lastReconciledAt: Date.now(), lastError: pauseReason });\n        if (changed) {\n          const activeOrderCount = await countActiveLiveOrders().catch(() => 0);\n          await addLiveAudit({\n            eventType: "reconciliation_temporarily_paused",\n            severity: activeOrderCount > 0 ? "critical" : "warning",\n            message: activeOrderCount > 0\n              ? \`已有实盘仓位对账暂时不可用：\${reason}；交易所保护单保持生效，停止本轮新开仓并自动重试\`\n              : \`Gate 后台对账暂时不可用：\${reason}；Auto Live 保持开启，停止本轮新开仓并自动重试\`,\n          }).catch(() => undefined);\n        }\n      }\n    } else {\n      const activeOrderCount = await countActiveLiveOrders().catch(() => 0);\n      const nextError = latest.state === "risk_locked" ? latest.lastError : reason;\n      await patchLiveControl({ lastReconciledAt: Date.now(), lastError: nextError });\n      if (activeOrderCount > 0 && latest.lastError !== nextError) {\n        await addLiveAudit({ eventType: "active_reconciliation_failed", severity: "critical", message: \`已有实盘仓位对账失败：\${reason}\` }).catch(() => undefined);\n        await notifyLiveOwner("Gate 已有仓位对账失败", reason, \`live-active-reconcile-failed-\${Date.now()}\`);\n      }\n    }\n    if (credentialFailure) await markLiveCredentialVerification(false, reason).catch(() => undefined);\n    throw error;\n  }`,
);

await replaceOnce(
  "app/page.tsx",
  `<b>{liveTrading?.control.entryEnabled ? "自动实盘开启" : liveTrading?.credential.configured ? "实盘关闭" : "无交易权限"}</b>`,
  `<b>{!liveTrading ? "实盘状态读取中" : liveTrading.control.state === "emergency_stopped" ? "紧急停机" : liveTrading.control.state === "risk_locked" ? "实盘风控锁定" : liveTrading.control.entryEnabled ? liveTrading.control.lastError ? "自动实盘开启 · 新开仓暂缓" : "自动实盘开启" : liveTrading.credential.configured ? "实盘关闭" : "无交易权限"}</b>`,
);

console.log("live degradation decoupling patch applied");
