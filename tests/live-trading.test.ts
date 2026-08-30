import assert from "node:assert/strict";
import test from "node:test";
import { decryptGateCredentials, encryptGateCredentials, gateKeyHint } from "../lib/credential-vault.ts";
import { GatePrivateClient, gateSignature, verifyGateCredentials } from "../lib/gate-private.ts";
import {
  attributablePositionCloses,
  buildLiveEntryPlan,
  gateAccountEquityUsdt,
  liveAccountRiskLockReason,
  normalizeLiveProtectionPrices,
  protectionTriggerRules,
} from "../lib/live-risk.ts";

test("Gate API v4 signature matches the official create-order example", async () => {
  const body = '{"contract":"BTC_USD","type":"limit","size":100,"price":6800,"time_in_force":"gtc"}';
  const signature = await gateSignature("secret", "POST", "/api/v4/futures/orders", "", body, "1541993715");
  assert.equal(signature, "eae42da914a590ddf727473aff25fc87d50b64783941061f47a3fdb92742541fc4c2c14017581b4199a1418d54471c269c03a38d788d802e2c306c37636389f0");
});

test("Gate credentials round-trip through AES-GCM without plaintext persistence", async () => {
  const credentials = { apiKey: "api_key_1234567890", apiSecret: "secret_1234567890", environment: "live" as const };
  const encrypted = await encryptGateCredentials(credentials, "owner-access-token-1234567890");
  assert.doesNotMatch(encrypted.ciphertext, /api_key|secret_123/);
  assert.equal(encrypted.cryptoVersion, 1);
  assert.deepEqual(await decryptGateCredentials(encrypted, "owner-access-token-1234567890"), credentials);
  await assert.rejects(() => decryptGateCredentials(encrypted, "different-owner-token-123456"), /无法解密/);
  assert.equal(gateKeyHint(credentials.apiKey), "api_••••7890");
});

test("private Gate mutations are signed, bounded by expiry and keep legacy TestNet transport isolated to the low-level client", async () => {
  const requests: Request[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ id: "42", status: "finished", size: "2", left: "0" });
  };
  const client = new GatePrivateClient({ apiKey: "api_key_123456", apiSecret: "api_secret_123456", environment: "testnet" }, fetcher as typeof fetch);
  await client.createOrder({ contract: "BTC_USDT", size: "2", price: "0", tif: "ioc" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api-testnet.gateapi.io/api/v4/futures/usdt/orders");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.get("key"), "api_key_123456");
  assert.equal(requests[0].headers.get("x-gate-size-decimal"), "1");
  assert.match(requests[0].headers.get("sign") ?? "", /^[a-f0-9]{128}$/);
  assert.ok(Number(requests[0].headers.get("x-gate-exptime")) > Date.now());
  assert.deepEqual(await requests[0].json(), { contract: "BTC_USDT", size: "2", price: "0", tif: "ioc" });
});

test("credential verification rejects any detected non-futures write permission", async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/account/detail")) return Response.json({ user_id: 7, ip_whitelist: [] });
    if (url.pathname.endsWith("/futures/usdt/accounts")) return Response.json({ total: "1000", available: "1000", in_dual_mode: false });
    if (url.pathname.endsWith("/account/main_keys")) return Response.json([
      { key: "another_key", perms: [{ name: "wallet", read_only: true }] },
      { key: "api_key_123456", perms: [{ name: "futures", read_only: false }, { name: "wallet", read_only: false }] },
    ]);
    return Response.json({ label: "NOT_FOUND" }, { status: 404 });
  };
  await assert.rejects(
    () => verifyGateCredentials({ apiKey: "api_key_123456", apiSecret: "api_secret_123456", environment: "live" }, fetcher as typeof fetch),
    /非永续写权限：wallet/,
  );
});

test("credential verification rejects unsupported unified margin equity semantics", async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/account/detail")) return Response.json({ user_id: 7, ip_whitelist: [] });
    if (url.pathname.endsWith("/futures/usdt/accounts")) return Response.json({ available: "1000", position_mode: "single", margin_mode: 2 });
    if (url.pathname.endsWith("/account/main_keys")) return Response.json({ perms: [{ name: "futures", read_only: false }] });
    return Response.json({ label: "NOT_FOUND" }, { status: 404 });
  };
  await assert.rejects(
    () => verifyGateCredentials({ apiKey: "api_key_123456", apiSecret: "api_secret_123456", environment: "live" }, fetcher as typeof fetch),
    /仅支持 Gate 经典合约账户/,
  );
});

test("live Gate-size preflight rejects the QQQX micro-profit order", () => {
  const plan = buildLiveEntryPlan({
    trade: {
      id: "qqqx",
      symbol: "QQQX_USDT",
      side: "SHORT",
      entryPrice: 711.08,
      entryLow: 710.9,
      entryHigh: 711.2,
      currentStopPrice: 718.1908,
      takeProfit2Price: 709.830685714286,
      leverage: 3,
      contractNotionalUsdt: 595.66,
    },
    contract: {
      mark_price: "711.08",
      quanto_multiplier: "0.0001",
      leverage_max: "20",
      order_size_min: "1",
      order_size_max: "100000000",
      status: "trading",
    },
    account: { available: "1000", total: "1000", position_mode: "single" },
    roundTripCostBps: 8,
  });
  assert.equal(plan.passed, false);
  assert.equal(plan.expectedNetTp2Usdt, 0);
  assert.match(plan.reason ?? "", /TP2.*盈利空间/);
});

test("live preflight preserves a smaller HTE candidate risk while applying the HTE margin ceiling", () => {
  const plan = buildLiveEntryPlan({
    trade: {
      id: "worthwhile",
      symbol: "TEST_USDT",
      side: "LONG",
      entryPrice: 100,
      entryLow: 99.9,
      entryHigh: 100.1,
      currentStopPrice: 99,
      takeProfit2Price: 120,
      leverage: 1,
      contractNotionalUsdt: 1000,
    },
    contract: {
      mark_price: "100",
      quanto_multiplier: "0.01",
      leverage_max: "10",
      order_size_min: "1",
      order_size_max: "100000",
      market_order_slip_ratio: "0.01",
      status: "trading",
    },
    account: { available: "1000", total: "1000", position_mode: "single" },
    roundTripCostBps: 8,
  });
  assert.equal(plan.minimumNetTp2Usdt, 50);
  assert.equal(plan.riskBudgetUsdt, 10);
  assert.equal(plan.actualNotionalUsdt, 600);
  assert.equal(plan.passed, true);
  assert.ok(plan.expectedNetTp2Usdt > 119 && plan.expectedNetTp2Usdt < 120);
  assert.ok(plan.worstCaseNetTp2Usdt > 115 && plan.worstCaseNetTp2Usdt < 116);
  assert.equal(plan.marketOrderSlipRatio, "0.003");
  assert.deepEqual(protectionTriggerRules("LONG"), { takeProfit: 1, stopLoss: 2 });
  assert.deepEqual(protectionTriggerRules("SHORT"), { takeProfit: 2, stopLoss: 1 });
});

test("live preflight uses Gate taker fees, tick rounding and both-side slippage under the 5% TP2 floor", () => {
  const rounded = normalizeLiveProtectionPrices({ side: "LONG", stopLossPrice: 99.04, takeProfitPrice: 120.09, priceTick: 0.1 });
  assert.deepEqual(rounded, { stopLossPrice: 99.1, takeProfitPrice: 120 });
  const plan = buildLiveEntryPlan({
    trade: {
      id: "fees-and-ticks",
      symbol: "TEST_USDT",
      side: "LONG",
      entryPrice: 100,
      entryLow: 99.9,
      entryHigh: 100.1,
      currentStopPrice: 99.04,
      takeProfit2Price: 120.09,
      leverage: 1,
      contractNotionalUsdt: 1000,
    },
    contract: {
      mark_price: "100",
      quanto_multiplier: "0.01",
      leverage_max: "10",
      order_size_min: "1",
      order_size_max: "100000",
      order_price_round: "0.1",
      market_order_slip_ratio: "0.001",
      taker_fee_rate: "0.0008",
      status: "trading",
    },
    account: { available: "1000", total: "1000", position_mode: "single" },
    roundTripCostBps: 8,
  });
  assert.equal(plan.effectiveRoundTripCostBps, 16);
  assert.equal(plan.stopLossPrice, 99.1);
  assert.equal(plan.takeProfitPrice, 120);
  assert.equal(plan.minimumNetTp2Usdt, 50);
  assert.ok(plan.expectedNetTp2Usdt > plan.worstCaseNetTp2Usdt);
  assert.equal(plan.passed, true);
});

test("actual Gate equity includes unrealized PnL and close PnL is isolated to one position lifecycle", () => {
  assert.equal(gateAccountEquityUsdt({ total: "1000", available: "870", unrealised_pnl: "-80" }), 920);
  const firstOpenedAt = 1_700_000_000;
  const records = [
    { contract: "BTC_USDT", side: "long" as const, first_open_time: firstOpenedAt, time: firstOpenedAt + 300, pnl: "12.5" },
    { contract: "BTC_USDT", side: "long" as const, first_open_time: firstOpenedAt + 600, time: firstOpenedAt + 900, pnl: "30" },
    { contract: "BTC_USDT", side: "short" as const, first_open_time: firstOpenedAt, time: firstOpenedAt + 280, pnl: "99" },
  ];
  const matching = attributablePositionCloses(records, {
    symbol: "BTC_USDT",
    side: "LONG",
    createdAt: firstOpenedAt * 1_000,
    submittedAt: (firstOpenedAt + 2) * 1_000,
    closedAt: (firstOpenedAt + 300) * 1_000,
  });
  assert.deepEqual(matching.map((record) => record.pnl), ["12.5"]);
});

test("a 500U Gate account scales HTE risk and profit economics proportionally", () => {
  const plan = buildLiveEntryPlan({
    trade: {
      id: "small-live-balance",
      symbol: "TEST_USDT",
      side: "LONG",
      entryPrice: 100,
      entryLow: 99.9,
      entryHigh: 100.1,
      currentStopPrice: 99,
      takeProfit2Price: 110,
      leverage: 10,
      contractNotionalUsdt: 4000,
    },
    contract: {
      mark_price: "100",
      quanto_multiplier: "0.01",
      leverage_max: "20",
      order_size_min: "1",
      order_size_max: "100000",
      status: "trading",
    },
    account: { available: "500", total: "500", position_mode: "single" },
    roundTripCostBps: 8,
  });
  assert.equal(plan.minimumNetTp2Usdt, 25);
  assert.equal(plan.riskBudgetUsdt, 20);
  assert.ok(plan.targetNotionalUsdt > 1538 && plan.targetNotionalUsdt < 1539);
  assert.equal(plan.actualNotionalUsdt, 1538);
  assert.ok(plan.projectedStopLossUsdt > 19.98 && plan.projectedStopLossUsdt < 20.01);
  assert.equal(plan.passed, true);
  assert.ok(plan.worstCaseNetTp2Usdt > 100);
});

test("account risk locks daily trading loss but ignores raw Gate balance transfers", () => {
  assert.match(liveAccountRiskLockReason({
    dailyRealizedPnlUsdt: -30,
    dailyPauseUsdt: 30,
    accountEquityUsdt: 970,
    accountEquityPeakUsdt: 1000,
    maxDrawdownUsdt: 100,
  }) ?? "", /3% 暂停线/);
  assert.equal(liveAccountRiskLockReason({
    dailyRealizedPnlUsdt: 4,
    dailyPauseUsdt: 30,
    accountEquityUsdt: 900,
    accountEquityPeakUsdt: 1000,
    maxDrawdownUsdt: 100,
  }), null);
  assert.equal(liveAccountRiskLockReason({
    dailyRealizedPnlUsdt: -29.99,
    dailyPauseUsdt: 30,
    accountEquityUsdt: 970.01,
    accountEquityPeakUsdt: 1000,
    maxDrawdownUsdt: 100,
  }), null);
});
