import { getRuntimeBindings } from "./runtime-bindings";
import { decryptGateCredentials, encryptGateCredentials, gateKeyHint, normalizeGateCredentials, type GateCredentials } from "./credential-vault";
import { minimumTp2NetProfitUsdt } from "./contract-simulation.ts";
import { singleTradeRiskBudgetUsdt } from "./risk-policy.ts";
import {
  GateApiError,
  GatePrivateClient,
  verifyGateCredentials,
  type GateFuturesOrder,
  type GatePosition,
  type GatePositionClose,
  type GatePriceOrder,
} from "./gate-private";
import {
  MAX_LIVE_OPEN_POSITIONS,
  attributablePositionCloses,
  buildLiveEntryPlan,
  gateAccountEquityUsdt,
  liveAccountRiskLockReason,
  normalizeLiveProtectionPrices,
  projectedNetTp2Usdt,
  protectionTriggerRules,
  type LiveEntryPlan,
  type LiveTradeCandidate,
} from "./live-risk";
import {
  addLiveAudit,
  armLiveControl,
  clearEmergencyControl,
  countActiveLiveOrders,
  createLiveOrderIntent,
  deleteLiveCredentialRecord,
  disableLiveControl,
  getLiveControl,
  getLiveCredentialRecord,
  getLiveLinkedTrade,
  getLiveTradingSnapshot,
  latchEmergencyControl,
  listActiveLiveOrders,
  listLiveEntryCandidates,
  listLiveOrdersAwaitingRealizedPnl,
  markLiveCredentialVerification,
  patchLiveControl,
  patchLiveOrder,
  saveLiveCredentialRecord,
  type LiveOrderRecord,
} from "./live-trading-repository";
import { liveDirectionalExposureBlockReason } from "./live-portfolio-risk";
import { getSettings } from "./settings-repository";
import { resolveVapidConfig } from "./vapid-config";
import { sendAllPush } from "./web-push";

const PROGRAM_TEXT_PREFIX = "t-ms-";
const EMERGENCY_POSITION_BATCH = 10;
const EMERGENCY_PRICE_CANCEL_BATCH = 10;

type CredentialInput = GateCredentials & { permissionsConfirmed: boolean };

function errorMessage(error: unknown) {
  if (error instanceof GateApiError) return `${error.label ? `${error.label}: ` : ""}${error.message}`.slice(0, 500);
  return error instanceof Error ? error.message.slice(0, 500) : "未知实盘执行错误";
}

function isCredentialFailure(error: unknown) {
  return error instanceof GateApiError
    && (error.status === 401 || error.status === 403 || /key|sign|auth|forbidden/i.test(error.label ?? ""));
}

async function notifyLiveOwner(title: string, body: string, tag: string, symbol?: string | null) {
  try {
    const credential = await getLiveCredentialRecord();
    const config = resolveVapidConfig(getRuntimeBindings());
    if (!credential?.ownerAccountId || !config) return;
    await sendAllPush({
      title,
      body,
      url: symbol ? `/?symbol=${encodeURIComponent(symbol)}` : "/",
      tag,
      data: { type: "live-trading", symbol: symbol ?? null, observedAt: Date.now() },
    }, config, credential.ownerAccountId);
  } catch {
    // Notification failure must never interrupt live protection or reconciliation.
  }
}

function id(value: string | number | undefined | null) {
  return value == null ? null : String(value);
}

function number(value: string | number | undefined | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function liveClientText(liveOrderId: string) {
  return `${PROGRAM_TEXT_PREFIX}${liveOrderId.replace(/-/g, "").slice(0, 20)}`;
}

function isProgramOrder(order: { text?: string | null }) {
  return Boolean(order.text?.startsWith(PROGRAM_TEXT_PREFIX));
}

function gateOrderSummary(order: GateFuturesOrder | null | undefined) {
  if (!order) return {};
  return {
    id: id(order.id),
    contract: order.contract,
    status: order.status,
    finishAs: order.finish_as,
    size: order.size,
    left: order.left,
    fillPrice: order.fill_price,
    reduceOnly: order.reduce_only ?? order.is_reduce_only,
    text: order.text,
  };
}

function priceOrderSummary(order: GatePriceOrder | null | undefined) {
  if (!order) return {};
  return {
    id: id(order.id_string ?? order.id),
    status: order.status,
    finishAs: order.finish_as,
    reason: order.reason,
    contract: order.initial?.contract,
    text: order.initial?.text,
    triggerPrice: order.trigger?.price,
    triggerRule: order.trigger?.rule,
  };
}

async function loadClient() {
  const record = await getLiveCredentialRecord();
  if (!record) throw new Error("尚未保存 Gate API 凭据");
  const ownerToken = getRuntimeBindings().OWNER_ACCESS_TOKEN;
  if (!ownerToken) throw new Error("后台访问码未配置，无法解密 Gate API 凭据");
  const credentials = await decryptGateCredentials({
    ciphertext: record.ciphertext,
    iv: record.iv,
    cryptoVersion: record.cryptoVersion as 1,
  }, ownerToken);
  return { client: new GatePrivateClient(credentials), credentials, record };
}

async function riskLock(reason: string, order?: LiveOrderRecord | null) {
  const current = await getLiveControl();
  const changed = current.entryEnabled || current.state !== "risk_locked" || current.lastError !== reason;
  await patchLiveControl({ entryEnabled: false, state: "risk_locked", disabledAt: Date.now(), lastError: reason });
  if (changed) {
    await addLiveAudit({
      eventType: "risk_lock",
      severity: "critical",
      liveOrderId: order?.id,
      symbol: order?.symbol,
      message: `实盘新开仓已锁定：${reason}`,
    });
    await notifyLiveOwner("Gate 实盘风控已锁定", reason, `live-risk-lock-${Date.now()}`, order?.symbol);
  }
}

function activePosition(position: GatePosition) {
  return Boolean(position.contract && number(position.size) !== 0);
}

function positionClosePnl(record: GatePositionClose) {
  const total = Number(record.pnl);
  if (Number.isFinite(total)) return total;
  return [record.pnl_pnl, record.pnl_fund, record.pnl_fee].reduce<number>((sum, value) => sum + number(value), 0);
}

async function realizedPnlForOrder(client: GatePrivateClient, order: LiveOrderRecord) {
  const openedAtSeconds = Math.floor(order.createdAt / 1_000);
  const closedAtSeconds = Math.ceil((order.closedAt ?? Date.now()) / 1_000) + 60;
  const records = await client.positionCloses(Math.max(0, openedAtSeconds - 10), closedAtSeconds, 100);
  const matching = attributablePositionCloses(records, order);
  return matching.length ? matching.reduce((sum, record) => sum + positionClosePnl(record), 0) : null;
}

async function allPositionCloses(client: GatePrivateClient, from: number, to: number, maxRecords = 1_000) {
  const pageSize = 100;
  const records: GatePositionClose[] = [];
  for (let offset = 0; offset < maxRecords; offset += pageSize) {
    const page = await client.positionCloses(from, to, pageSize, offset);
    records.push(...page);
    if (page.length < pageSize) return { records, complete: true };
  }
  return { records, complete: false };
}

async function backfillRealizedPnl(client: GatePrivateClient) {
  const pending = await listLiveOrdersAwaitingRealizedPnl();
  for (const order of pending) {
    const realizedPnlUsdt = await realizedPnlForOrder(client, order).catch(() => null);
    await patchLiveOrder(order.id, { realizedPnlUsdt, lastReconciledAt: Date.now() });
  }
}

async function enforceLiveAccountRisk(client: GatePrivateClient, settings: Awaited<ReturnType<typeof getSettings>>) {
  void settings;
  const now = Date.now();
  const utcDay = new Date(now).toISOString().slice(0, 10);
  const from = Math.floor(Date.parse(`${utcDay}T00:00:00.000Z`) / 1_000);
  const to = Math.floor(now / 1_000);
  const [account, closePage] = await Promise.all([
    client.futuresAccount(),
    allPositionCloses(client, from, to),
  ]);
  if (account.margin_mode != null && Number(account.margin_mode) !== 0) {
    const reason = "Gate 账户已切换为统一/组合保证金模式；无法可靠确认实盘权益，已停止新开仓";
    const current = await getLiveControl();
    if (current.entryEnabled && current.state === "armed") await riskLock(reason);
    throw new Error(reason);
  }
  if (!closePage.complete) {
    const reason = "Gate 当日平仓记录达到 1000 条，无法确认日内盈亏完整性";
    const current = await getLiveControl();
    if (current.entryEnabled && current.state === "armed") await riskLock(reason);
    throw new Error(reason);
  }
  const accountEquityUsdt = gateAccountEquityUsdt(account);
  if (accountEquityUsdt <= 0) {
    const reason = "Gate 合约账户权益无效或已归零";
    const current = await getLiveControl();
    if (current.entryEnabled && current.state === "armed") await riskLock(reason);
    throw new Error(reason);
  }
  const dailyRealizedPnlUsdt = closePage.records.reduce((sum, record) => sum + positionClosePnl(record), 0);
  const control = await getLiveControl();
  const accountEquityPeakUsdt = Math.max(control.accountEquityPeakUsdt ?? accountEquityUsdt, accountEquityUsdt);
  await patchLiveControl({
    accountEquityPeakUsdt,
    accountEquityLastUsdt: accountEquityUsdt,
    dailyRealizedPnlUsdt,
    dailyPnlDate: utcDay,
    accountRiskCheckedAt: now,
  });
  const lockReason = liveAccountRiskLockReason({
    dailyRealizedPnlUsdt,
    accountEquityUsdt,
    accountEquityPeakUsdt,
  });
  if (lockReason) await riskLock(lockReason);
  return account;
}

async function closePosition(client: GatePrivateClient, position: GatePosition, reason: string) {
  const size = number(position.size);
  if (!position.contract || size === 0) return null;
  return client.createOrder({
    contract: position.contract,
    size: String(-size),
    price: "0",
    tif: "ioc",
    reduce_only: true,
    text: `${PROGRAM_TEXT_PREFIX}kill-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    action_mode: "FULL",
  }).catch((error) => {
    throw new Error(`${position.contract} 紧急平仓失败：${errorMessage(error)}（${reason}）`);
  });
}

function protectionBody(order: LiveOrderRecord, kind: "stop" | "takeProfit") {
  const rules = protectionTriggerRules(order.side);
  const isStop = kind === "stop";
  return {
    initial: {
      contract: order.symbol,
      size: "0",
      price: "0",
      close: true,
      tif: "ioc",
      text: `${order.clientOrderText}${isStop ? "s" : "p"}`,
      reduce_only: true,
      // For TP2, keep the same bounded exit-slippage assumption used by the
      // equity-scaled profit gate. For a protective stop, use Gate's contract
      // default so a tight profit-oriented cap does not make the exit unfillable.
      ...(isStop ? {} : { market_order_slip_ratio: order.marketOrderSlipRatio }),
    },
    trigger: {
      strategy_type: 0,
      price_type: 1,
      price: String(isStop ? order.stopLossPrice : order.takeProfitPrice),
      rule: isStop ? rules.stopLoss : rules.takeProfit,
    },
  };
}

function sameProtectionPrice(actual: string | number | null | undefined, expected: number) {
  const parsed = number(actual);
  return parsed > 0 && Math.abs(parsed - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-10);
}

function validProtectionOrder(order: LiveOrderRecord, gateOrder: GatePriceOrder | null | undefined, kind: "stop" | "takeProfit") {
  if (!gateOrder || gateOrder.status !== "open") return false;
  const isStop = kind === "stop";
  const rules = protectionTriggerRules(order.side);
  return gateOrder.initial?.contract === order.symbol
    && Boolean(gateOrder.initial.close || gateOrder.initial.reduce_only)
    && gateOrder.initial.text === `${order.clientOrderText}${isStop ? "s" : "p"}`
    && number(gateOrder.trigger?.rule) === (isStop ? rules.stopLoss : rules.takeProfit)
    && sameProtectionPrice(gateOrder.trigger?.price, isStop ? order.stopLossPrice : order.takeProfitPrice);
}

async function cancelPriceOrderQuietly(client: GatePrivateClient, orderId: string | null) {
  if (!orderId) return;
  await client.cancelPriceOrder(orderId).catch(() => undefined);
}

async function cancelPriceOrderIfPresent(client: GatePrivateClient, orderId: string) {
  try {
    await client.cancelPriceOrder(orderId);
  } catch (error) {
    if (!(error instanceof GateApiError) || error.status !== 404) throw error;
  }
}

async function cancelRegularOrderIfPresent(client: GatePrivateClient, orderId: string) {
  try {
    await client.cancelOrder(orderId);
  } catch (error) {
    if (!(error instanceof GateApiError) || error.status !== 404) throw error;
  }
}

async function removeOrphanProgramOrders(
  client: GatePrivateClient,
  tracked: LiveOrderRecord[],
  regularOrders: GateFuturesOrder[],
  priceOrders: GatePriceOrder[],
) {
  const expectedRegularIds = new Set(tracked.map((order) => order.entryOrderId).filter((value): value is string => Boolean(value)));
  const expectedRegularTexts = new Set(tracked.map((order) => order.clientOrderText));
  const expectedPriceIds = new Set(tracked.flatMap((order) => [order.stopLossOrderId, order.takeProfitOrderId]).filter((value): value is string => Boolean(value)));
  const orphanRegular = regularOrders.filter((order) => {
    if (!isProgramOrder(order)) return false;
    const orderId = id(order.id);
    return !(orderId && expectedRegularIds.has(orderId)) && !(order.text && expectedRegularTexts.has(order.text));
  });
  const orphanPrice = priceOrders.filter((order) => {
    if (!isProgramOrder({ text: order.initial?.text })) return false;
    const orderId = id(order.id_string ?? order.id);
    return !(orderId && expectedPriceIds.has(orderId));
  });
  const results = await Promise.allSettled([
    ...orphanRegular.map((order) => {
      const orderId = id(order.id);
      return orderId ? cancelRegularOrderIfPresent(client, orderId) : Promise.reject(new Error("Gate 普通委托缺少 ID"));
    }),
    ...orphanPrice.map((order) => {
      const orderId = id(order.id_string ?? order.id);
      return orderId ? cancelPriceOrderIfPresent(client, orderId) : Promise.reject(new Error("Gate 条件委托缺少 ID"));
    }),
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new Error(`清理本程序孤儿挂单失败：${failures.map((result) => errorMessage(result.reason)).join("；")}`);
  if (orphanRegular.length || orphanPrice.length) {
    await addLiveAudit({
      eventType: "orphan_orders_removed",
      severity: "warning",
      message: `已清理本程序孤儿挂单：普通 ${orphanRegular.length}，条件 ${orphanPrice.length}`,
    });
  }
}

async function failClosedPosition(client: GatePrivateClient, order: LiveOrderRecord, reason: string, options: {
  failureCode?: string;
  lockMessage?: string;
} = {}) {
  await patchLiveOrder(order.id, { state: "closing", failureCode: options.failureCode ?? "protection_failed", failureReason: reason });
  const positions = (await client.positions(true)).filter((position) => position.contract === order.symbol && activePosition(position));
  const closeResults = await Promise.allSettled(positions.map((position) => closePosition(client, position, reason)));
  const closeErrors = closeResults.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => errorMessage(result.reason));
  const remaining = (await client.positions(true)).filter((position) => position.contract === order.symbol && activePosition(position));
  if (remaining.length) {
    const failureReason = [reason, ...closeErrors, "自动平仓后仍检测到仓位，保留现有保护单并继续重试"].join("；");
    await patchLiveOrder(order.id, { state: "closing", failureReason });
    await riskLock(options.lockMessage ?? `${order.symbol} 保护单失败且未能确认平仓`, order);
    throw new Error(`${order.symbol} 仍有未确认平仓仓位`);
  }
  await Promise.all([
    cancelPriceOrderQuietly(client, order.stopLossOrderId),
    cancelPriceOrderQuietly(client, order.takeProfitOrderId),
  ]);
  const realizedPnlUsdt = await realizedPnlForOrder(client, order).catch(() => null);
  await patchLiveOrder(order.id, { state: "closed", closedAt: Date.now(), failureReason: reason, realizedPnlUsdt });
  await riskLock(options.lockMessage ?? `${order.symbol} 保护单未完整建立，已自动平仓`, order);
}

async function installProtection(client: GatePrivateClient, order: LiveOrderRecord) {
  let stopId = order.stopLossOrderId;
  let takeProfitId = order.takeProfitOrderId;
  try {
    if (!stopId || !takeProfitId) {
      const recoverable = await client.priceOrders("open", order.symbol);
      const recoveredStop = recoverable.find((item) => validProtectionOrder(order, item, "stop"));
      const recoveredTakeProfit = recoverable.find((item) => validProtectionOrder(order, item, "takeProfit"));
      stopId ??= id(recoveredStop?.id_string ?? recoveredStop?.id);
      takeProfitId ??= id(recoveredTakeProfit?.id_string ?? recoveredTakeProfit?.id);
      if (stopId || takeProfitId) {
        order = await patchLiveOrder(order.id, { stopLossOrderId: stopId, takeProfitOrderId: takeProfitId }) ?? order;
      }
    }
    if (!stopId) {
      const created = await client.createPriceOrder(protectionBody(order, "stop"));
      stopId = id(created.id_string ?? created.id);
      if (!stopId) throw new Error("Gate 未返回止损单 ID");
      order = await patchLiveOrder(order.id, { stopLossOrderId: stopId }) ?? order;
    }
    if (!takeProfitId) {
      const created = await client.createPriceOrder(protectionBody(order, "takeProfit"));
      takeProfitId = id(created.id_string ?? created.id);
      if (!takeProfitId) throw new Error("Gate 未返回止盈单 ID");
      order = await patchLiveOrder(order.id, { takeProfitOrderId: takeProfitId }) ?? order;
    }
    const openPriceOrders = await client.priceOrders("open", order.symbol);
    const byId = new Map(openPriceOrders.map((item) => [id(item.id_string ?? item.id), item]));
    if (!validProtectionOrder(order, byId.get(stopId), "stop") || !validProtectionOrder(order, byId.get(takeProfitId), "takeProfit")) {
      throw new Error("Gate 未确认止盈和止损的方向、价格及减仓属性全部正确");
    }
    const protectedOrder = await patchLiveOrder(order.id, {
      state: "protected",
      stopLossOrderId: stopId,
      takeProfitOrderId: takeProfitId,
      protectedAt: Date.now(),
      failureCode: null,
      failureReason: null,
      lastGateStatusJson: JSON.stringify({ priceOrders: openPriceOrders.filter((item) => [stopId, takeProfitId].includes(id(item.id_string ?? item.id) ?? "")).map(priceOrderSummary) }),
      lastReconciledAt: Date.now(),
    });
    await addLiveAudit({
      eventType: "protection_confirmed",
      liveOrderId: order.id,
      symbol: order.symbol,
      message: `${order.symbol} 交易所止盈和止损均已确认`,
      details: { stopLossOrderId: stopId, takeProfitOrderId: takeProfitId },
    });
    await notifyLiveOwner(
      `${order.symbol.replace("_", "")} ${order.side} · 实盘保护已确认`,
      `Gate 止损 ${order.stopLossPrice} 与 TP2 ${order.takeProfitPrice} 均处于活动状态`,
      `live-protected-${order.id}`,
      order.symbol,
    );
    return protectedOrder ?? order;
  } catch (error) {
    const reason = errorMessage(error);
    await failClosedPosition(client, { ...order, stopLossOrderId: stopId, takeProfitOrderId: takeProfitId }, reason);
    return null;
  }
}

function positionIntegrityIssue(order: LiveOrderRecord, positions: GatePosition[]) {
  if (positions.length !== 1) return `Gate 返回 ${positions.length} 个同币种仓位，预期为单向模式下 1 个`;
  const [position] = positions;
  const size = number(position.size);
  if (order.side === "LONG" ? size <= 0 : size >= 0) return "Gate 当前仓位方向与实盘账本不一致";
  const expectedSize = number(order.filledContracts) || number(order.requestedContracts);
  if (expectedSize <= 0 || Math.abs(Math.abs(size) - expectedSize) > Math.max(1e-9, expectedSize * 1e-9)) {
    return `Gate 当前仓位张数 ${Math.abs(size)} 与实盘账本 ${expectedSize} 不一致`;
  }
  if (position.pos_margin_mode ? position.pos_margin_mode !== "isolated" : number(position.leverage || position.lever) === 0) {
    return "Gate 当前仓位不是逐仓模式";
  }
  const leverage = number(position.leverage || position.lever);
  if (leverage > 0 && Math.abs(leverage - order.leverage) > 1e-9) return `Gate 当前杠杆 ${leverage}x 与计划 ${order.leverage}x 不一致`;
  const liquidationPrice = number(position.liq_price || position.liquidation_price);
  if (liquidationPrice > 0 && (order.side === "LONG" ? liquidationPrice >= order.stopLossPrice : liquidationPrice <= order.stopLossPrice)) {
    return `Gate 强平价 ${liquidationPrice} 可能先于结构止损 ${order.stopLossPrice} 到达`;
  }
  return null;
}

async function validateRecoveredPostFill(client: GatePrivateClient, order: LiveOrderRecord, positions: GatePosition[]) {
  const [contract, account, settings] = await Promise.all([
    client.contract(order.symbol),
    client.futuresAccount(),
    getSettings(),
  ]);
  const accountModeUnsupported = account.margin_mode != null && Number(account.margin_mode) !== 0;
  const contracts = positions.reduce((sum, position) => sum + Math.abs(number(position.size)), 0);
  const contractMultiplier = number(contract.quanto_multiplier);
  const weightedEntry = contracts > 0
    ? positions.reduce((sum, position) => sum + Math.abs(number(position.size)) * number(position.entry_price), 0) / contracts
    : 0;
  const fillPrice = weightedEntry || order.fillPrice || order.referencePrice;
  const accountEquityUsdt = gateAccountEquityUsdt(account);
  const minimumNetTp2Usdt = minimumTp2NetProfitUsdt(accountEquityUsdt);
  const riskBudgetUsdt = singleTradeRiskBudgetUsdt(accountEquityUsdt);
  const filledStopRiskUsdt = contracts * contractMultiplier * Math.abs(fillPrice - order.stopLossPrice);
  const gateRoundTripCostBps = Math.max(0, number(contract.taker_fee_rate)) * 2 * 10_000;
  const effectiveRoundTripCostBps = Math.max(0, settings.roundTripCostBps, gateRoundTripCostBps);
  const filledExpectedNetTp2Usdt = projectedNetTp2Usdt({
    side: order.side,
    entryPrice: fillPrice,
    takeProfitPrice: order.takeProfitPrice,
    contracts,
    contractMultiplier,
    roundTripCostBps: effectiveRoundTripCostBps,
    exitSlippageRatio: number(order.marketOrderSlipRatio),
  });
  const reason = accountModeUnsupported
    ? "Gate 账户在成交恢复期间变为不支持的统一/组合保证金模式"
    : accountEquityUsdt <= 0 || contractMultiplier <= 0 || contracts <= 0 || fillPrice <= 0
      ? "Gate 成交恢复数据不足，无法确认权益、合约乘数、张数或成交价"
      : filledStopRiskUsdt > riskBudgetUsdt + 0.01
        ? `恢复成交后的结构止损风险 ${filledStopRiskUsdt.toFixed(2)}U，超过 ${riskBudgetUsdt.toFixed(2)}U 单笔上限`
        : filledExpectedNetTp2Usdt < minimumNetTp2Usdt
          ? `恢复成交后 TP2 预计净利润 ${filledExpectedNetTp2Usdt.toFixed(2)}U，低于当前权益 0.25% 门槛 ${minimumNetTp2Usdt.toFixed(2)}U`
          : null;
  if (reason) {
    await addLiveAudit({ eventType: "recovered_post_fill_gate_failed", severity: "critical", liveOrderId: order.id, symbol: order.symbol, message: `${order.symbol} ${reason}，立即执行保护性平仓` });
    await failClosedPosition(client, order, reason, {
      failureCode: "recovered_post_fill_gate_failed",
      lockMessage: `${order.symbol} 恢复成交后的实盘风控未通过`,
    });
    return null;
  }
  return patchLiveOrder(order.id, {
    state: "open",
    filledContracts: String(contracts),
    fillPrice,
    expectedNetTp2Usdt: filledExpectedNetTp2Usdt,
    failureCode: null,
    failureReason: null,
    lastReconciledAt: Date.now(),
  });
}

async function replaceProtectiveStop(client: GatePrivateClient, order: LiveOrderRecord, stopLossPrice: number) {
  const oldStopId = order.stopLossOrderId;
  const candidate = { ...order, stopLossPrice, stopLossOrderId: null };
  try {
    const openOrders = await client.priceOrders("open", order.symbol);
    const recovered = openOrders.find((item) => validProtectionOrder(candidate, item, "stop"));
    let newStopId = id(recovered?.id_string ?? recovered?.id);
    if (!newStopId) {
      const created = await client.createPriceOrder(protectionBody(candidate, "stop"));
      newStopId = id(created.id_string ?? created.id);
    }
    if (!newStopId) throw new Error("Gate 未返回新止损单 ID");
    const confirmedOrders = await client.priceOrders("open", order.symbol);
    const confirmed = confirmedOrders.find((item) => id(item.id_string ?? item.id) === newStopId);
    if (!validProtectionOrder(candidate, confirmed, "stop")) throw new Error("Gate 未确认新止损单的价格、方向和减仓属性");
    const updated = await patchLiveOrder(order.id, {
      state: "protected",
      stopLossOrderId: newStopId,
      stopLossPrice,
      protectedAt: Date.now(),
      lastReconciledAt: Date.now(),
    });
    if (oldStopId && oldStopId !== newStopId) await cancelPriceOrderIfPresent(client, oldStopId);
    await addLiveAudit({
      eventType: "protective_stop_updated",
      liveOrderId: order.id,
      symbol: order.symbol,
      message: `${order.symbol} 新保护止损已先确认，再撤销旧止损`,
      details: { previousStopLossPrice: order.stopLossPrice, stopLossPrice, oldStopId, newStopId },
    });
    return updated ?? order;
  } catch (error) {
    const reason = `更新保护止损失败，旧止损保持有效：${errorMessage(error)}`;
    await addLiveAudit({ eventType: "protective_stop_update_failed", severity: "warning", liveOrderId: order.id, symbol: order.symbol, message: `${order.symbol} ${reason}；本轮暂停新开仓并等待自动重试` });
    // The previous stop is still active at Gate. A transient read/write failure
    // must pause the current reconciliation cycle, not permanently disarm Auto Live.
    throw error;
  }
}

function filledContracts(order: GateFuturesOrder, fallback: number) {
  const requested = Math.abs(number(order.size) || fallback);
  if (order.left == null) return order.finish_as === "filled" ? requested : 0;
  const left = Math.abs(number(order.left));
  return Math.max(0, requested - left);
}

async function rejectCandidate(trade: LiveTradeCandidate, activationEpoch: number, plan: LiveEntryPlan) {
  const liveOrderId = crypto.randomUUID();
  const now = Date.now();
  const created = await createLiveOrderIntent({
    id: liveOrderId,
    tradeCaseId: trade.id,
    clientOrderText: liveClientText(liveOrderId),
    symbol: trade.symbol,
    side: trade.side,
    state: "rejected",
    activationEpoch,
    requestedContracts: String(plan.contracts),
    filledContracts: "0",
    referencePrice: plan.markPrice || trade.entryPrice,
    stopLossPrice: plan.stopLossPrice || trade.currentStopPrice,
    takeProfitPrice: plan.takeProfitPrice || trade.takeProfit2Price,
    leverage: trade.leverage,
    marginMode: "isolated",
    marketOrderSlipRatio: plan.marketOrderSlipRatio,
    expectedNetTp2Usdt: plan.worstCaseNetTp2Usdt,
    failureCode: "live_preflight_rejected",
    failureReason: plan.reason,
    createdAt: now,
    updatedAt: now,
  });
  if (created) await addLiveAudit({ eventType: "entry_rejected", severity: "warning", liveOrderId: created.id, symbol: trade.symbol, message: `${trade.symbol} 未提交到 Gate：${plan.reason}` });
  return created;
}

async function submitCandidate(client: GatePrivateClient, trade: LiveTradeCandidate, activationEpoch: number, plan: LiveEntryPlan) {
  const liveOrderId = crypto.randomUUID();
  const clientOrderText = liveClientText(liveOrderId);
  const now = Date.now();
  let order = await createLiveOrderIntent({
    id: liveOrderId,
    tradeCaseId: trade.id,
    clientOrderText,
    symbol: trade.symbol,
    side: trade.side,
    state: "submitting",
    activationEpoch,
    requestedContracts: String(Math.abs(plan.signedContracts)),
    referencePrice: plan.markPrice,
    stopLossPrice: plan.stopLossPrice,
    takeProfitPrice: plan.takeProfitPrice,
    leverage: trade.leverage,
    marginMode: "isolated",
    marketOrderSlipRatio: plan.marketOrderSlipRatio,
    expectedNetTp2Usdt: plan.worstCaseNetTp2Usdt,
    createdAt: now,
    updatedAt: now,
  });
  if (!order || order.id !== liveOrderId) return order;
  const latestControl = await getLiveControl();
  if (!latestControl.entryEnabled || latestControl.state !== "armed" || latestControl.activationEpoch !== activationEpoch) {
    return patchLiveOrder(order.id, { state: "cancelled", failureCode: "entry_switch_changed", failureReason: "提交前自动开仓开关已变化" });
  }
  try {
    await client.setIsolatedLeverage(trade.symbol, trade.leverage);
    let gateOrder: GateFuturesOrder | null = null;
    try {
      gateOrder = await client.order(clientOrderText);
    } catch (error) {
      if (!(error instanceof GateApiError) || error.status !== 404) throw error;
    }
    if (!gateOrder) {
      gateOrder = await client.createOrder({
        contract: trade.symbol,
        size: String(plan.signedContracts),
        price: "0",
        tif: "ioc",
        text: clientOrderText,
        reduce_only: false,
        market_order_slip_ratio: plan.marketOrderSlipRatio,
        action_mode: "FULL",
      });
    }
    const gateOrderId = id(gateOrder.id);
    const responseFilled = filledContracts(gateOrder, Math.abs(plan.signedContracts));
    let symbolPositions = (await client.positions(true)).filter((position) => position.contract === trade.symbol && activePosition(position));
    let positionSize = symbolPositions.reduce((sum, position) => sum + Math.abs(number(position.size)), 0);
    if (responseFilled > 0 && positionSize <= 0) {
      symbolPositions = (await client.positions(true)).filter((position) => position.contract === trade.symbol && activePosition(position));
      positionSize = symbolPositions.reduce((sum, position) => sum + Math.abs(number(position.size)), 0);
      if (positionSize <= 0) throw new Error("Gate 返回已成交但仓位尚无法确认");
    }
    const effectiveFilled = positionSize;
    if (effectiveFilled <= 0) {
      await patchLiveOrder(order.id, {
        state: "rejected",
        entryOrderId: gateOrderId,
        filledContracts: "0",
        submittedAt: Date.now(),
        failureCode: "gate_ioc_unfilled",
        failureReason: "Gate 市价 IOC 未成交",
        lastGateStatusJson: JSON.stringify({ entry: gateOrderSummary(gateOrder) }),
      });
      await addLiveAudit({ eventType: "entry_unfilled", severity: "warning", liveOrderId: order.id, symbol: trade.symbol, message: `${trade.symbol} Gate 市价单未成交` });
      return order;
    }
    const positionEntryPrice = positionSize > 0
      ? symbolPositions.reduce((sum, position) => sum + Math.abs(number(position.size)) * number(position.entry_price), 0) / positionSize
      : 0;
    const fillPrice = number(gateOrder.fill_price) || positionEntryPrice || plan.markPrice;
    const filledExpectedNetTp2Usdt = projectedNetTp2Usdt({
      side: trade.side,
      entryPrice: fillPrice,
      takeProfitPrice: plan.takeProfitPrice,
      contracts: effectiveFilled,
      contractMultiplier: plan.contractMultiplier,
      roundTripCostBps: plan.effectiveRoundTripCostBps,
      exitSlippageRatio: number(plan.marketOrderSlipRatio),
    });
    order = await patchLiveOrder(order.id, {
      state: "open",
      entryOrderId: gateOrderId,
      filledContracts: String(effectiveFilled),
      fillPrice,
      expectedNetTp2Usdt: filledExpectedNetTp2Usdt,
      failureCode: "post_fill_validation_pending",
      failureReason: "Gate 成交已确认，成交后风控复核尚未完成",
      submittedAt: Date.now(),
      lastGateStatusJson: JSON.stringify({ entry: gateOrderSummary(gateOrder), positions: symbolPositions }),
    }) ?? order;
    const wrongDirection = symbolPositions.length !== 1 || symbolPositions.some((position) => trade.side === "LONG" ? number(position.size) <= 0 : number(position.size) >= 0);
    const wrongMarginMode = symbolPositions.some((position) => position.pos_margin_mode
      ? position.pos_margin_mode !== "isolated"
      : number(position.leverage || position.lever) === 0);
    const wrongLeverage = symbolPositions.some((position) => {
      const actualLeverage = number(position.leverage || position.lever);
      return actualLeverage > 0 && Math.abs(actualLeverage - trade.leverage) > 1e-9;
    });
    const liquidationBeforeStop = symbolPositions.some((position) => {
      const liquidationPrice = number(position.liq_price || position.liquidation_price);
      if (liquidationPrice <= 0) return false;
      return trade.side === "LONG" ? liquidationPrice >= plan.stopLossPrice : liquidationPrice <= plan.stopLossPrice;
    });
    await addLiveAudit({
      eventType: "entry_filled",
      liveOrderId: order.id,
      symbol: trade.symbol,
      message: `${trade.symbol} 已成交，正在确认交易所保护单`,
      details: { entryOrderId: gateOrderId, filledContracts: effectiveFilled, expectedNetTp2Usdt: filledExpectedNetTp2Usdt },
    });
    if (wrongDirection || wrongMarginMode || wrongLeverage || liquidationBeforeStop) {
      const reason = `Gate 成交仓位与计划不一致（方向 ${wrongDirection ? "异常" : "通过"}、逐仓 ${wrongMarginMode ? "异常" : "通过"}、杠杆 ${wrongLeverage ? "异常" : "通过"}、止损先于强平 ${liquidationBeforeStop ? "否" : "是"}）`;
      await addLiveAudit({ eventType: "post_fill_position_mismatch", severity: "critical", liveOrderId: order.id, symbol: trade.symbol, message: `${trade.symbol} ${reason}，立即执行保护性平仓` });
      await failClosedPosition(client, order, reason, { failureCode: "post_fill_position_mismatch" });
      return order;
    }
    const filledStopRiskUsdt = effectiveFilled * plan.contractMultiplier * Math.abs(fillPrice - plan.stopLossPrice);
    if (filledStopRiskUsdt > plan.riskBudgetUsdt + 0.01) {
      const reason = `真实成交后的结构止损风险 ${filledStopRiskUsdt.toFixed(2)}U，超过 ${plan.riskBudgetUsdt.toFixed(2)}U 单笔上限`;
      await addLiveAudit({ eventType: "post_fill_risk_gate_failed", severity: "critical", liveOrderId: order.id, symbol: trade.symbol, message: `${trade.symbol} ${reason}，立即执行保护性平仓` });
      await failClosedPosition(client, order, reason, { failureCode: "post_fill_risk_gate_failed" });
      return order;
    }
    if (filledExpectedNetTp2Usdt < plan.minimumNetTp2Usdt) {
      const reason = `真实成交后 TP2 预计净利润 ${filledExpectedNetTp2Usdt.toFixed(2)}U，低于当前权益 1.5% 门槛 ${plan.minimumNetTp2Usdt.toFixed(2)}U`;
      await addLiveAudit({ eventType: "post_fill_profit_gate_failed", severity: "critical", liveOrderId: order.id, symbol: trade.symbol, message: `${trade.symbol} ${reason}，立即执行保护性平仓` });
      await failClosedPosition(client, order, reason, { failureCode: "post_fill_profit_gate_failed" });
      return order;
    }
    return installProtection(client, order);
  } catch (error) {
    const reason = errorMessage(error);
    let current = await patchLiveOrder(order.id, { failureReason: reason });
    const protectionClosePending = current?.state === "closing" && Boolean(current.failureCode);
    if (!protectionClosePending) {
      current = await patchLiveOrder(order.id, { state: "closing", failureCode: "entry_submission_error", failureReason: reason });
    }
    let positions: GatePosition[];
    try {
      positions = (await client.positions(true)).filter((position) => position.contract === trade.symbol && activePosition(position));
    } catch (positionError) {
      await riskLock(`${trade.symbol} 下单异常且无法确认仓位：${errorMessage(positionError)}`, current);
      throw error;
    }
    if (positions.length && current) {
      if (protectionClosePending) await riskLock(`${trade.symbol} 保护失败平仓尚未完成`, current);
      else await failClosedPosition(client, current, reason);
    } else if (current) {
      const hadFill = number(current.filledContracts) > 0;
      const realizedPnlUsdt = hadFill ? await realizedPnlForOrder(client, current).catch(() => null) : null;
      await patchLiveOrder(current.id, hadFill
        ? { state: "closed", closedAt: Date.now(), realizedPnlUsdt }
        : {
            // A timed-out mutation can reach Gate after our immediate position
            // read. Keep the intent active so the next alarm resolves its unique
            // client text instead of allowing an untracked late fill.
            state: "submitting",
            failureCode: "entry_submission_ambiguous",
            failureReason: `${reason}；等待下一轮按客户端订单号确认是否到达 Gate`,
          });
      await riskLock(`${trade.symbol} 下单状态异常：${reason}`, current);
    }
    throw error;
  }
}

async function reconcileOrder(client: GatePrivateClient, order: LiveOrderRecord, positions: GatePosition[], priceOrders: GatePriceOrder[]) {
  const symbolPositions = positions.filter((position) => position.contract === order.symbol && activePosition(position));
  const positionSize = symbolPositions.reduce((sum, position) => sum + Math.abs(number(position.size)), 0);
  const priceById = new Map(priceOrders.map((item) => [id(item.id_string ?? item.id), item]));
  if (positionSize === 0 && order.state === "submitting") {
    let recovered: GateFuturesOrder | null = null;
    try {
      recovered = await client.order(order.clientOrderText);
    } catch (error) {
      if (!(error instanceof GateApiError) || error.status !== 404) throw error;
    }
    if (!recovered) {
      if (Date.now() - order.createdAt < 30_000) {
        const pending = await patchLiveOrder(order.id, {
          failureCode: "entry_submission_ambiguous",
          failureReason: "Gate 暂未索引唯一客户端订单号；保持待确认并继续禁止自动重提",
          lastReconciledAt: Date.now(),
        });
        await riskLock(`${order.symbol} Gate 进场请求状态仍不明确`, pending);
        return;
      }
      const reason = "Worker 中断后未在 Gate 找到对应客户端订单，禁止自动重提";
      const failed = await patchLiveOrder(order.id, { state: "error", failureCode: "submission_interrupted", failureReason: reason, lastReconciledAt: Date.now() });
      await riskLock(`${order.symbol} ${reason}`, failed);
      return;
    }
    if (recovered.status === "open") {
      const recoveredId = id(recovered.id);
      if (recoveredId) await client.cancelOrder(recoveredId);
      const reason = "恢复时发现异常未完成进场挂单，已撤销并锁定新开仓";
      const cancelled = await patchLiveOrder(order.id, { state: "cancelled", entryOrderId: recoveredId, failureCode: "recovered_open_entry", failureReason: reason, lastReconciledAt: Date.now() });
      await riskLock(`${order.symbol} ${reason}`, cancelled);
      return;
    }
    const recoveredFilled = filledContracts(recovered, number(order.requestedContracts));
    if (recoveredFilled > 0) {
      const realizedPnlUsdt = await realizedPnlForOrder(client, order).catch(() => null);
      const reason = "恢复到已成交记录但 Gate 当前无对应仓位，已停止新开仓等待人工复核";
      const closed = await patchLiveOrder(order.id, {
        state: "closed",
        entryOrderId: id(recovered.id),
        filledContracts: String(recoveredFilled),
        fillPrice: number(recovered.fill_price) || order.fillPrice,
        closedAt: Date.now(),
        realizedPnlUsdt,
        failureCode: "recovered_filled_without_position",
        failureReason: reason,
        lastReconciledAt: Date.now(),
      });
      await riskLock(`${order.symbol} ${reason}`, closed);
    } else {
      await patchLiveOrder(order.id, {
        state: "rejected",
        entryOrderId: id(recovered.id),
        filledContracts: "0",
        failureCode: "recovered_unfilled_entry",
        failureReason: "恢复确认 Gate 进场单未成交",
        lastReconciledAt: Date.now(),
      });
    }
    return;
  }
  if (positionSize === 0) {
    await Promise.all([
      cancelPriceOrderQuietly(client, order.stopLossOrderId),
      cancelPriceOrderQuietly(client, order.takeProfitOrderId),
    ]);
    if (["open", "protected", "closing"].includes(order.state)) {
      const realizedPnlUsdt = await realizedPnlForOrder(client, order).catch(() => null);
      await patchLiveOrder(order.id, {
        state: "closed",
        closedAt: Date.now(),
        realizedPnlUsdt,
        lastReconciledAt: Date.now(),
        lastGateStatusJson: JSON.stringify({ positionSize: 0 }),
      });
      await addLiveAudit({ eventType: "position_closed", liveOrderId: order.id, symbol: order.symbol, message: `${order.symbol} Gate 仓位已归零` });
      await notifyLiveOwner(
        `${order.symbol.replace("_", "")} ${order.side} · Gate 实盘已平仓`,
        realizedPnlUsdt == null ? "Gate 仓位已归零，单笔盈亏正在回填" : `实际已实现盈亏 ${realizedPnlUsdt >= 0 ? "+" : ""}${realizedPnlUsdt.toFixed(2)}U`,
        `live-closed-${order.id}`,
        order.symbol,
      );
    }
    return;
  }
  if (order.state === "closing" && order.failureCode) {
    const closeResults = await Promise.allSettled(symbolPositions.map((position) => closePosition(client, position, order.failureReason ?? "保护单建立失败")));
    const remaining = (await client.positions(true)).filter((position) => position.contract === order.symbol && activePosition(position));
    if (remaining.length) {
      const closeErrors = closeResults.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => errorMessage(result.reason));
      throw new Error(`${order.symbol} 保护失败平仓仍未完成${closeErrors.length ? `：${closeErrors.join("；")}` : ""}`);
    }
    await Promise.all([
      cancelPriceOrderQuietly(client, order.stopLossOrderId),
      cancelPriceOrderQuietly(client, order.takeProfitOrderId),
    ]);
    const realizedPnlUsdt = await realizedPnlForOrder(client, order).catch(() => null);
    await patchLiveOrder(order.id, { state: "closed", closedAt: Date.now(), lastReconciledAt: Date.now(), realizedPnlUsdt });
    return;
  }
  const linkedTrade = await getLiveLinkedTrade(order.tradeCaseId);
  if (linkedTrade && linkedTrade.status !== "holding") {
    await patchLiveOrder(order.id, { state: "closing", failureCode: null, failureReason: null });
    const closeResults = await Promise.allSettled(symbolPositions.map((position) => closePosition(client, position, linkedTrade.exitReason ?? "策略已结束")));
    const remaining = (await client.positions(true)).filter((position) => position.contract === order.symbol && activePosition(position));
    if (remaining.length) {
      const closeErrors = closeResults.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => errorMessage(result.reason));
      throw new Error(`${order.symbol} 策略结束后未能确认 Gate 平仓${closeErrors.length ? `：${closeErrors.join("；")}` : ""}`);
    }
    await Promise.all([
      cancelPriceOrderQuietly(client, order.stopLossOrderId),
      cancelPriceOrderQuietly(client, order.takeProfitOrderId),
    ]);
    const realizedPnlUsdt = await realizedPnlForOrder(client, order).catch(() => null);
    await patchLiveOrder(order.id, {
      state: "closed",
      closedAt: Date.now(),
      realizedPnlUsdt,
      lastReconciledAt: Date.now(),
      failureCode: null,
      failureReason: null,
      lastGateStatusJson: JSON.stringify({ strategyExitCode: linkedTrade.exitCode, strategyExitReason: linkedTrade.exitReason }),
    });
    await addLiveAudit({ eventType: "strategy_exit_executed", liveOrderId: order.id, symbol: order.symbol, message: `${order.symbol} 已按策略结束条件在 Gate 平仓` });
    await notifyLiveOwner(
      `${order.symbol.replace("_", "")} ${order.side} · 策略实盘已结束`,
      realizedPnlUsdt == null ? (linkedTrade.exitReason ?? "Gate 已确认平仓") : `${linkedTrade.exitReason ?? "策略结束"}｜实际已实现 ${realizedPnlUsdt >= 0 ? "+" : ""}${realizedPnlUsdt.toFixed(2)}U`,
      `live-strategy-exit-${order.id}`,
      order.symbol,
    );
    return;
  }
  if (order.state === "submitting") {
    let recovered: GateFuturesOrder | null = null;
    try {
      recovered = await client.order(order.clientOrderText);
    } catch (error) {
      if (!(error instanceof GateApiError) || error.status !== 404) throw error;
    }
    if (!recovered
      || Boolean(recovered.contract && recovered.contract !== order.symbol)
      || Boolean(recovered.text && recovered.text !== order.clientOrderText)) {
      const reason = "Gate 存在同币种仓位，但无法用唯一客户端订单号证明它属于本次进场";
      await addLiveAudit({ eventType: "recovered_position_unattributed", severity: "critical", liveOrderId: order.id, symbol: order.symbol, message: `${order.symbol} ${reason}，立即执行保护性平仓` });
      await failClosedPosition(client, order, reason, {
        failureCode: "recovered_position_unattributed",
        lockMessage: `${order.symbol} 恢复仓位归属无法确认`,
      });
      return;
    }
    if (recovered.status === "open") {
      const recoveredId = id(recovered.id);
      if (!recoveredId) throw new Error("Gate 恢复进场单缺少 ID，无法撤销未成交余量");
      await cancelRegularOrderIfPresent(client, recoveredId);
    }
    order = await patchLiveOrder(order.id, {
      state: "open",
      entryOrderId: id(recovered?.id) ?? order.entryOrderId,
      filledContracts: String(positionSize),
      fillPrice: number(recovered?.fill_price) || order.fillPrice || order.referencePrice,
      failureCode: "post_fill_validation_pending",
      failureReason: "Worker 恢复到 Gate 成交仓位，正在重新执行成交后风控复核",
      submittedAt: order.submittedAt ?? Date.now(),
      lastGateStatusJson: JSON.stringify({ recoveredEntry: gateOrderSummary(recovered), positions: symbolPositions }),
    }) ?? order;
  }
  const integrityIssue = positionIntegrityIssue(order, symbolPositions);
  if (integrityIssue) {
    await addLiveAudit({ eventType: "position_integrity_failed", severity: "critical", liveOrderId: order.id, symbol: order.symbol, message: `${order.symbol} ${integrityIssue}，立即保护性平仓` });
    await failClosedPosition(client, order, integrityIssue, {
      failureCode: "position_integrity_failed",
      lockMessage: `${order.symbol} 实盘仓位完整性检查失败`,
    });
    return;
  }
  if (order.failureCode === "post_fill_validation_pending") {
    const validated = await validateRecoveredPostFill(client, order, symbolPositions);
    if (!validated) return;
    order = validated;
  }
  if (linkedTrade?.status === "holding") {
    const contract = await client.contract(order.symbol);
    const normalizedStop = normalizeLiveProtectionPrices({
      side: order.side,
      stopLossPrice: linkedTrade.currentStopPrice,
      takeProfitPrice: order.takeProfitPrice,
      priceTick: number(contract.order_price_round || contract.mark_price_round),
    }).stopLossPrice;
    if (Math.abs(normalizedStop - order.stopLossPrice) > Math.max(1e-12, order.stopLossPrice * 1e-10)) {
      const moreProtective = order.side === "LONG" ? normalizedStop > order.stopLossPrice : normalizedStop < order.stopLossPrice;
      if (!moreProtective) {
        await riskLock(`${order.symbol} 策略试图放宽实盘止损，已保留原保护并锁定新开仓`, order);
        return;
      }
      await replaceProtectiveStop(client, order, normalizedStop);
      return;
    }
  }
  const stopGateOrder = order.stopLossOrderId ? priceById.get(order.stopLossOrderId) : null;
  const takeProfitGateOrder = order.takeProfitOrderId ? priceById.get(order.takeProfitOrderId) : null;
  const stopOpen = validProtectionOrder(order, stopGateOrder, "stop");
  const takeProfitOpen = validProtectionOrder(order, takeProfitGateOrder, "takeProfit");
  if (!stopOpen || !takeProfitOpen) {
    const staleStopId = stopOpen ? null : order.stopLossOrderId;
    const staleTakeProfitId = takeProfitOpen ? null : order.takeProfitOrderId;
    order = await patchLiveOrder(order.id, {
      stopLossOrderId: stopOpen ? order.stopLossOrderId : null,
      takeProfitOrderId: takeProfitOpen ? order.takeProfitOrderId : null,
      state: "open",
    }) ?? order;
    const protectedOrder = await installProtection(client, order);
    if (protectedOrder?.state === "protected") {
      if (staleStopId && staleStopId !== protectedOrder.stopLossOrderId) await cancelPriceOrderQuietly(client, staleStopId);
      if (staleTakeProfitId && staleTakeProfitId !== protectedOrder.takeProfitOrderId) await cancelPriceOrderQuietly(client, staleTakeProfitId);
    }
    return;
  }
  await patchLiveOrder(order.id, {
    state: "protected",
    filledContracts: String(positionSize),
    lastReconciledAt: Date.now(),
    lastGateStatusJson: JSON.stringify({
      positions: symbolPositions,
      stop: priceOrderSummary(priceById.get(order.stopLossOrderId)),
      takeProfit: priceOrderSummary(priceById.get(order.takeProfitOrderId)),
    }),
  });
}

export async function saveGateCredentials(input: CredentialInput, actorAccountId: string) {
  if (!input.permissionsConfirmed) throw new Error("请先确认 Gate 只开启永续合约读写，并关闭钱包和提现权限");
  if (input.environment !== "live") throw new Error("程序已停用 Gate TestNet 凭据；请填写 Gate 实盘 API");
  const control = await getLiveControl();
  if (control.entryEnabled) throw new Error("请先关闭自动开仓，再更换 Gate API 凭据");
  const existingCredential = await getLiveCredentialRecord();
  const credentials = normalizeGateCredentials(input);
  const verified = await verifyGateCredentials(credentials);
  const activeOrderCount = await countActiveLiveOrders();
  const sameGateAccount = Boolean(existingCredential
    && existingCredential.environment === credentials.environment
    && (existingCredential.gateUserId && existingCredential.gateUserId === verified.userId
      || !existingCredential.gateUserId && !verified.userId && existingCredential.keyHint === gateKeyHint(credentials.apiKey)));
  if (existingCredential && activeOrderCount > 0 && !sameGateAccount) {
    throw new Error("仍有实盘订单需要持续保护；只能轮换同一 Gate 用户、同一环境的 API 密钥，不能切换账户");
  }
  const ownerToken = getRuntimeBindings().OWNER_ACCESS_TOKEN;
  if (!ownerToken) throw new Error("后台访问码未配置，无法保存实盘凭据");
  const encrypted = await encryptGateCredentials(credentials, ownerToken);
  await saveLiveCredentialRecord({
    encrypted,
    environment: credentials.environment,
    keyHint: gateKeyHint(credentials.apiKey),
    gateUserId: verified.userId,
    ownerAccountId: actorAccountId,
    permissionSummary: {
      perpetualReadWrite: verified.perpetualReadWrite,
      ownerConfirmedMinimalPermissions: true,
      positionMode: verified.positionMode,
      accountMarginMode: verified.accountMarginMode,
      ipWhitelistConfigured: verified.ipWhitelistConfigured,
      availableUsdt: verified.availableUsdt,
      totalUsdt: verified.totalUsdt,
      equityUsdt: verified.equityUsdt,
    },
  });
  const verifiedEquity = verified.equityUsdt;
  await patchLiveControl({
    accountEquityPeakUsdt: sameGateAccount
      ? Math.max(control.accountEquityPeakUsdt ?? verifiedEquity, verifiedEquity)
      : verifiedEquity,
    accountEquityLastUsdt: verifiedEquity,
    dailyRealizedPnlUsdt: null,
    dailyPnlDate: null,
    accountRiskCheckedAt: null,
  });
  await addLiveAudit({
    eventType: "credentials_saved",
    actorAccountId,
    message: `Gate API 凭据已验证并加密保存（${gateKeyHint(credentials.apiKey)}）`,
    details: { environment: credentials.environment, userId: verified.userId, positionMode: verified.positionMode },
  });
  return getLiveTradingSnapshot();
}

export async function removeGateCredentials(actorAccountId: string) {
  const control = await disableLiveControl();
  if (control.entryEnabled) throw new Error("无法关闭自动开仓");
  if (control.state === "emergency_stopped") throw new Error("请先确认 Gate 已清空并解除紧急停机锁，再删除 API 凭据");
  if (await countActiveLiveOrders()) throw new Error("仍有实盘订单需要持续保护，不能删除 Gate API 凭据");
  const { client } = await loadClient();
  const positions = (await client.positions(true)).filter(activePosition);
  if (positions.length) throw new Error("Gate 仍有合约仓位，不能删除 API 凭据");
  await deleteLiveCredentialRecord();
  await addLiveAudit({ eventType: "credentials_deleted", severity: "warning", actorAccountId, message: "Gate API 凭据密文已删除" });
  return getLiveTradingSnapshot();
}

/**
 * Preserve the owner's Auto Live intent while temporarily blocking new entry.
 * The existing reconcile path treats an armed control with lastError as a
 * recovery cycle: current positions and exchange protection are reconciled, no
 * new candidate is submitted, and a clean cycle clears lastError so the next
 * alarm resumes entries automatically.
 */
export async function pauseAutomaticEntryForRecovery(reason: string, eventType = "automatic_entry_recovery_pause") {
  const control = await getLiveControl();
  if (!control.entryEnabled || control.state !== "armed") return getLiveTradingSnapshot();
  const pauseReason = `自动实盘安全复核：${reason}`.slice(0, 500);
  const changed = control.lastError !== pauseReason;
  await patchLiveControl({ lastError: pauseReason });
  if (changed) {
    await addLiveAudit({
      eventType,
      severity: "warning",
      message: `${pauseReason}；Auto Live 保持开启，本轮禁止新开仓，完成一轮干净对账后自动恢复`,
    });
  }
  return getLiveTradingSnapshot();
}

export async function setAutomaticEntry(enabled: boolean, actorAccountId: string) {
  if (!enabled) {
    await disableLiveControl();
    try {
      const { client } = await loadClient();
      const openOrders = await client.openOrders();
      await Promise.all(openOrders.filter((order) => isProgramOrder(order) && !(order.reduce_only ?? order.is_reduce_only)).map((order) => id(order.id)).filter((value): value is string => Boolean(value)).map((orderId) => client.cancelOrder(orderId)));
    } catch (error) {
      await patchLiveControl({ lastError: `自动开仓已关闭，但撤销进场挂单失败：${errorMessage(error)}` });
    }
    await addLiveAudit({ eventType: "automatic_entry_disabled", actorAccountId, message: "自动开仓已关闭；现有仓位继续保护和对账" });
    return getLiveTradingSnapshot();
  }

  const { client, credentials } = await loadClient();
  if (credentials.environment !== "live") throw new Error("旧 Gate TestNet 凭据不能开启自动交易，请更换为 Gate 实盘 API");
  let verified: Awaited<ReturnType<typeof verifyGateCredentials>>;
  try {
    verified = await verifyGateCredentials(credentials);
  } catch (error) {
    const reason = errorMessage(error);
    await markLiveCredentialVerification(false, reason).catch(() => undefined);
    throw error;
  }
  await markLiveCredentialVerification(true);
  const [positions, regularOrders, priceOrders, tracked] = await Promise.all([
    client.positions(true),
    client.openOrders(),
    client.priceOrders("open"),
    listActiveLiveOrders(),
  ]);
  const trackedSymbols = new Set(tracked.map((order) => order.symbol));
  const unmanagedPositions = positions.filter(activePosition).filter((position) => !trackedSymbols.has(position.contract ?? ""));
  if (unmanagedPositions.length) throw new Error(`Gate 存在未纳入本程序账本的仓位：${unmanagedPositions.map((position) => position.contract).join("、")}`);
  const unmanagedRegular = regularOrders.filter((order) => !isProgramOrder(order));
  const unmanagedPrice = priceOrders.filter((order) => !isProgramOrder({ text: order.initial?.text }));
  if (unmanagedRegular.length || unmanagedPrice.length) throw new Error("Gate 存在非本程序挂单；为避免订单冲突，请先处理后再开启自动开仓");
  if (verified.positionMode !== "single") throw new Error("Gate 必须使用单向持仓模式");
  await armLiveControl();
  try {
    await enforceLiveAccountRisk(client, await getSettings());
    const checkedControl = await getLiveControl();
    if (!checkedControl.entryEnabled || checkedControl.state !== "armed") {
      throw new Error(checkedControl.lastError ?? "Gate 实盘风控复核未通过");
    }
  } catch (error) {
    const checkedControl = await getLiveControl();
    if (checkedControl.entryEnabled && checkedControl.state === "armed") {
      await riskLock(`开启前 Gate 风控复核失败：${errorMessage(error)}`);
    }
    throw error;
  }
  await addLiveAudit({ eventType: "automatic_entry_enabled", actorAccountId, message: "自动开仓已手动开启；只处理开启后的新策略订单" });
  return getLiveTradingSnapshot();
}

export async function runEmergencyStop(actorAccountId: string, reason = "用户一键停机") {
  const existingControl = await getLiveControl();
  if (existingControl.state !== "emergency_stopped") {
    await latchEmergencyControl(reason);
    await addLiveAudit({ eventType: "emergency_stop_requested", severity: "critical", actorAccountId, message: `${reason}：开始撤单并清空 Gate USDT 永续仓位` });
  }
  let client: GatePrivateClient;
  try {
    ({ client } = await loadClient());
  } catch (error) {
    const finalError = `停机锁已生效，但无法读取 Gate API 凭据：${errorMessage(error)}`;
    await markLiveCredentialVerification(false, finalError).catch(() => undefined);
    await patchLiveControl({
      entryEnabled: false,
      state: "emergency_stopped",
      lastReconciledAt: Date.now(),
      lastError: finalError,
    });
    if (existingControl.lastError !== finalError) {
      await addLiveAudit({ eventType: "emergency_stop_incomplete", severity: "critical", actorAccountId, message: finalError });
    }
    return getLiveTradingSnapshot();
  }
  const errors: string[] = [];
  await client.cancelAllOrders(true).catch((error) => errors.push(`非减仓普通委托撤销失败：${errorMessage(error)}`));
  try {
    const initialPriceOrders = await client.priceOrders("open");
    const nonProtective = initialPriceOrders.filter((order) => !(order.initial?.reduce_only || order.initial?.close));
    const cancellations = await Promise.allSettled(nonProtective.slice(0, EMERGENCY_PRICE_CANCEL_BATCH).map((order) => {
      const orderId = id(order.id_string ?? order.id);
      return orderId ? client.cancelPriceOrder(orderId) : Promise.reject(new Error("Gate 条件委托缺少 ID"));
    }));
    cancellations.forEach((result) => { if (result.status === "rejected") errors.push(`非减仓条件委托撤销失败：${errorMessage(result.reason)}`); });
  } catch (error) {
    errors.push(`读取条件委托失败：${errorMessage(error)}`);
  }
  let initialPositionsKnown = true;
  const positions = (await client.positions(true).catch((error) => {
    initialPositionsKnown = false;
    errors.push(`读取仓位失败：${errorMessage(error)}`);
    return [] as GatePosition[];
  })).filter(activePosition);
  if (positions.length > EMERGENCY_POSITION_BATCH) errors.push(`检测到 ${positions.length} 个仓位，将按每轮 ${EMERGENCY_POSITION_BATCH} 个分批清仓`);
  const closeResults = await Promise.allSettled(initialPositionsKnown ? positions.slice(0, EMERGENCY_POSITION_BATCH).map((position) => closePosition(client, position, reason)) : []);
  closeResults.forEach((result) => { if (result.status === "rejected") errors.push(errorMessage(result.reason)); });
  let postClosePositionsKnown = true;
  const postClosePositions = (await client.positions(true).catch((error) => {
    postClosePositionsKnown = false;
    errors.push(`平仓后读取仓位失败：${errorMessage(error)}`);
    return positions;
  })).filter(activePosition);
  if (postClosePositionsKnown && !postClosePositions.length) {
    await client.cancelAllOrders(false).catch((error) => errors.push(`剩余普通委托撤销失败：${errorMessage(error)}`));
    await client.cancelAllPriceOrders().catch((error) => errors.push(`剩余条件委托撤销失败：${errorMessage(error)}`));
  }
  let remainingPositionsKnown = true;
  let remainingOrdersKnown = true;
  let remainingPriceOrdersKnown = true;
  const [remainingPositions, remainingOrders, remainingPriceOrders] = await Promise.all([
    client.positions(true).catch((error) => {
      remainingPositionsKnown = false;
      errors.push(`复核仓位失败：${errorMessage(error)}`);
      return positions;
    }),
    client.openOrders().catch((error) => {
      remainingOrdersKnown = false;
      errors.push(`复核普通挂单失败：${errorMessage(error)}`);
      return [] as GateFuturesOrder[];
    }),
    client.priceOrders("open").catch((error) => {
      remainingPriceOrdersKnown = false;
      errors.push(`复核条件挂单失败：${errorMessage(error)}`);
      return [] as GatePriceOrder[];
    }),
  ]);
  const notFlat = remainingPositions.filter(activePosition);
  const confirmedFlat = remainingPositionsKnown && remainingOrdersKnown && remainingPriceOrdersKnown
    && !notFlat.length && !remainingOrders.length && !remainingPriceOrders.length;
  if (!confirmedFlat && remainingPositionsKnown && remainingOrdersKnown && remainingPriceOrdersKnown) {
    errors.push(`停机尚未确认清空：仓位 ${notFlat.length}，普通挂单 ${remainingOrders.length}，条件挂单 ${remainingPriceOrders.length}`);
  }
  const activeOrders = await listActiveLiveOrders();
  if (confirmedFlat) {
    await Promise.all(activeOrders.map(async (order) => {
      const realizedPnlUsdt = await realizedPnlForOrder(client, order).catch(() => null);
      return patchLiveOrder(order.id, { state: "closed", closedAt: Date.now(), failureCode: "emergency_stop", failureReason: reason, realizedPnlUsdt });
    }));
  }
  await backfillRealizedPnl(client).catch(() => undefined);
  // The final Gate read-back is authoritative. Transient cancellation errors must
  // not leave an "incomplete" status after every position and order is confirmed gone.
  const finalError = confirmedFlat ? null : (errors.length ? errors.join("；").slice(0, 1_000) : "停机状态未能最终确认");
  await patchLiveControl({
    entryEnabled: false,
    state: "emergency_stopped",
    lastReconciledAt: Date.now(),
    lastSuccessfulReconcileAt: confirmedFlat ? Date.now() : undefined,
    lastError: finalError,
  });
  const outcomeChanged = existingControl.state !== "emergency_stopped" || existingControl.lastError !== finalError;
  if (outcomeChanged) {
    await addLiveAudit({
      eventType: finalError ? "emergency_stop_incomplete" : "emergency_stop_flat",
      severity: finalError ? "critical" : "warning",
      actorAccountId,
      message: finalError ?? "一键停机完成：Gate 仓位和挂单均已确认清空，停机锁保持生效",
    });
    await notifyLiveOwner(
      finalError ? "Gate 一键停机尚未完成" : "Gate 一键停机已完成",
      finalError ?? "仓位和挂单均已确认清空，停机锁保持生效",
      `live-emergency-${finalError ? "incomplete" : "flat"}-${Date.now()}`,
    );
  }
  return getLiveTradingSnapshot();
}

export async function resetEmergencyStop(actorAccountId: string) {
  const control = await getLiveControl();
  if (control.state !== "emergency_stopped") throw new Error("当前没有紧急停机锁");
  const { client } = await loadClient();
  const [positions, orders, priceOrders] = await Promise.all([client.positions(true), client.openOrders(), client.priceOrders("open")]);
  if (positions.some(activePosition) || orders.length || priceOrders.length) throw new Error("Gate 尚未完全清空，不能解除停机锁");
  await clearEmergencyControl();
  await addLiveAudit({ eventType: "emergency_stop_reset", severity: "warning", actorAccountId, message: "停机锁已手动解除；自动开仓仍保持关闭" });
  return getLiveTradingSnapshot();
}

export async function reconcileLiveTrading() {
  const control = await getLiveControl();
  const credentialRecord = await getLiveCredentialRecord();
  if (!credentialRecord) return getLiveTradingSnapshot();
  if (control.state === "emergency_stopped") return runEmergencyStop("system", control.emergencyReason ?? "紧急停机自动复核");
  // If the previous cycle failed only because data/network was temporarily unavailable,
  // keep the owner's Auto Live intent armed but require one fully clean recovery cycle
  // before a new Gate entry is allowed. Existing positions remain protected/reconciled.
  const recoveringFromTransientPause = control.entryEnabled && control.state === "armed" && Boolean(control.lastError);
  let client: GatePrivateClient;
  try {
    ({ client } = await loadClient());
  } catch (error) {
    const reason = errorMessage(error);
    if (control.entryEnabled && control.state === "armed") await riskLock(`Gate API 凭据不可用：${reason}`);
    else await patchLiveControl({ lastReconciledAt: Date.now(), lastError: reason });
    await markLiveCredentialVerification(false, reason).catch(() => undefined);
    throw error;
  }
  try {
    const [positions, regularOrders, priceOrders, tracked] = await Promise.all([
      client.positions(true),
      client.openOrders(),
      client.priceOrders("open"),
      listActiveLiveOrders(),
    ]);
    for (const order of tracked) await reconcileOrder(client, order, positions, priceOrders);
    await backfillRealizedPnl(client);
    const trackedAfterReconcile = await listActiveLiveOrders();
    await removeOrphanProgramOrders(client, trackedAfterReconcile, regularOrders, priceOrders);
    const [positionsAfterReconcile, regularOrdersAfterReconcile, priceOrdersAfterReconcile] = await Promise.all([
      client.positions(true),
      client.openOrders(),
      client.priceOrders("open"),
    ]);
    const trackedSymbols = new Set(trackedAfterReconcile.map((order) => order.symbol));
    const unmanaged = positionsAfterReconcile.filter(activePosition).filter((position) => !trackedSymbols.has(position.contract ?? ""));
    const unmanagedRegular = regularOrdersAfterReconcile.filter((order) => !isProgramOrder(order));
    const unmanagedPrice = priceOrdersAfterReconcile.filter((order) => !isProgramOrder({ text: order.initial?.text }));
    const conflictError = [
      unmanaged.length ? `检测到未纳入账本的 Gate 仓位：${unmanaged.map((position) => position.contract).join("、")}` : null,
      unmanagedRegular.length || unmanagedPrice.length ? `检测到非本程序 Gate 挂单：普通 ${unmanagedRegular.length}，条件 ${unmanagedPrice.length}` : null,
    ].filter((value): value is string => Boolean(value)).join("；") || null;
    if (conflictError) {
      const latest = await getLiveControl();
      if (latest.entryEnabled && latest.state === "armed") {
        await riskLock(conflictError);
      } else if (latest.lastError !== conflictError) {
        await patchLiveControl({ lastError: conflictError });
        await addLiveAudit({ eventType: "unmanaged_gate_exposure", severity: "critical", message: conflictError });
        await notifyLiveOwner("Gate 检测到未托管仓位或挂单", conflictError, `live-unmanaged-${Date.now()}`);
      }
    }
    const settings = await getSettings();
    // Account equity and realized PnL must remain current even while new entry
    // is disabled; existing positions and manual reconciliation still need an
    // accurate account-level safety view.
    const accountForCandidate = await enforceLiveAccountRisk(client, settings);
    const updatedControl = await getLiveControl();
    if (updatedControl.entryEnabled && updatedControl.state === "armed" && updatedControl.enabledAt && !recoveringFromTransientPause) {
      const activeCount = trackedAfterReconcile.length;
      if (activeCount < MAX_LIVE_OPEN_POSITIONS) {
        const candidates = await listLiveEntryCandidates(updatedControl.enabledAt);
        const activeSides = trackedAfterReconcile.map((order) => order.side);
        const candidate = candidates.find((item) => !liveDirectionalExposureBlockReason(activeSides, item.side));
        if (candidate) {
          const [contract, account] = await Promise.all([
            client.contract(candidate.symbol),
            Promise.resolve(accountForCandidate),
          ]);
          const trade: LiveTradeCandidate = {
            id: candidate.id,
            symbol: candidate.symbol,
            side: candidate.side,
            entryPrice: candidate.entryPrice,
            entryLow: candidate.entryLow,
            entryHigh: candidate.entryHigh,
            currentStopPrice: candidate.currentStopPrice,
            takeProfit2Price: candidate.takeProfit2Price,
            leverage: candidate.leverage,
            contractNotionalUsdt: candidate.contractNotionalUsdt,
          };
          const plan = buildLiveEntryPlan({
            trade,
            contract,
            account,
            roundTripCostBps: settings.roundTripCostBps,
          });
          if (plan.passed) await submitCandidate(client, trade, updatedControl.activationEpoch, plan);
          else await rejectCandidate(trade, updatedControl.activationEpoch, plan);
        }
      }
    }
    const finalControl = await getLiveControl();
    await patchLiveControl({
      lastReconciledAt: Date.now(),
      lastSuccessfulReconcileAt: Date.now(),
      lastError: finalControl.state === "risk_locked"
        ? finalControl.lastError
        : conflictError,
    });
    if (recoveringFromTransientPause && finalControl.entryEnabled && finalControl.state === "armed" && !conflictError) {
      await addLiveAudit({
        eventType: "reconciliation_recovered",
        severity: "info",
        message: "Gate 后台对账已恢复；本轮仅完成安全复核，下一轮恢复新开仓",
      });
    }
    if (credentialRecord.status === "error") await markLiveCredentialVerification(true);
  } catch (error) {
    const reason = errorMessage(error);
    const latest = await getLiveControl();
    const credentialFailure = isCredentialFailure(error);
    if (latest.entryEnabled && latest.state === "armed") {
      if (credentialFailure) {
        // 401/403 or an explicit authentication failure is not transient.
        await riskLock(`Gate API 凭据失效：${reason}`);
      } else {
        // A failed observation/reconciliation cycle is fail-safe by construction:
        // no candidate can be submitted because this function exits before the entry path.
        // Keep the owner's Auto Live intent armed so a 429/5xx/timeout/D1 hiccup
        // does not require manual re-arming after every short outage.
        const pauseReason = `后台对账暂时不可用：${reason}`;
        const changed = latest.lastError !== pauseReason;
        await patchLiveControl({ lastReconciledAt: Date.now(), lastError: pauseReason });
        if (changed) {
          const activeOrderCount = await countActiveLiveOrders().catch(() => 0);
          await addLiveAudit({
            eventType: "reconciliation_temporarily_paused",
            severity: activeOrderCount > 0 ? "critical" : "warning",
            message: activeOrderCount > 0
              ? `已有实盘仓位对账暂时不可用：${reason}；交易所保护单保持生效，停止本轮新开仓并自动重试`
              : `Gate 后台对账暂时不可用：${reason}；Auto Live 保持开启，停止本轮新开仓并自动重试`,
          }).catch(() => undefined);
        }
      }
    } else {
      const activeOrderCount = await countActiveLiveOrders().catch(() => 0);
      const nextError = latest.state === "risk_locked" ? latest.lastError : reason;
      await patchLiveControl({ lastReconciledAt: Date.now(), lastError: nextError });
      if (activeOrderCount > 0 && latest.lastError !== nextError) {
        await addLiveAudit({ eventType: "active_reconciliation_failed", severity: "critical", message: `已有实盘仓位对账失败：${reason}` }).catch(() => undefined);
        await notifyLiveOwner("Gate 已有仓位对账失败", reason, `live-active-reconcile-failed-${Date.now()}`);
      }
    }
    if (credentialFailure) await markLiveCredentialVerification(false, reason).catch(() => undefined);
    throw error;
  }
  return getLiveTradingSnapshot();
}

export async function liveAlarmDelayMs() {
  const [control, active] = await Promise.all([getLiveControl(), countActiveLiveOrders()]);
  if (control.state === "emergency_stopped") return control.lastError || active > 0 ? 10_000 : 60_000;
  return control.entryEnabled || active > 0 ? 10_000 : 60_000;
}

export { getLiveTradingSnapshot };
