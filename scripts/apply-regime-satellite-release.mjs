import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const write = (path, value) => writeFileSync(path, value);
const replaceOnce = (text, from, to, label) => {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`);
  return text.replace(from, to);
};
const replaceBetween = (text, start, end, replacement, label) => {
  const a = text.indexOf(start); const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`${label}: boundary not found`);
  return text.slice(0, a) + replacement + text.slice(b);
};

let regime = read("lib/regime-portfolio.ts");
regime = replaceOnce(regime,
`export const REGIME_UNIVERSE = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT",
  "ADA_USDT", "LINK_USDT", "LTC_USDT", "AVAX_USDT", "BCH_USDT"] as const;`,
`export const REGIME_UNIVERSE = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT",
  "ADA_USDT", "LINK_USDT", "LTC_USDT", "AVAX_USDT", "BCH_USDT"] as const;
export const REGIME_SATELLITE_UNIVERSE = ["SUI_USDT", "UNI_USDT"] as const;
export const REGIME_EXECUTION_UNIVERSE = [...REGIME_UNIVERSE, ...REGIME_SATELLITE_UNIVERSE] as const;
export const REGIME_SATELLITE_TRADE_RISK_RATE = .005;
export const REGIME_SATELLITE_ACCOUNT_RISK_CAP = .02;
export const REGIME_SATELLITE_DIRECTION_RISK_CAP = .015;
const REGIME_CORE_SET = new Set<string>(REGIME_UNIVERSE);
const REGIME_SATELLITE_SET = new Set<string>(REGIME_SATELLITE_UNIVERSE);`, "universe constants");

const synchronized = `function synchronizedFeatures(paths: Record<string, GateCandle[]>) {
  const eligible = Object.entries(paths).filter(([, rows]) => rows.length >= REGIME_HOURLY_REQUIRED_CANDLES);
  const contextEligible = eligible.filter(([symbol]) => REGIME_CORE_SET.has(symbol));
  if (contextEligible.length < 8) return null;
  const commonTime = Math.min(...contextEligible.map(([, rows]) => rows.at(-1)!.time));
  const rows: Omit<Feature, "relative24" | "relative7" | "context">[] = [];
  for (const [symbol, path] of eligible) {
    const index = path.findIndex((row) => row.time === commonTime);
    if (index < 720) continue;
    let contiguous = true;
    for (let offset = index - 720; offset < index; offset += 1) if (path[offset + 1].time !== path[offset].time + 3_600) { contiguous = false; break; }
    if (!contiguous) continue;
    const current = path[index]; const prior24 = path.slice(index - 24, index); const prior7 = path.slice(index - 168, index);
    const currentRanges = path.slice(index - 5, index + 1).map(rangeRate);
    const baselineRanges = path.slice(index - 168, index - 6).map(rangeRate);
    const recentVolume = sum(path.slice(index - 5, index + 1).map((row) => row.volume)) / 6;
    const baselineVolume = sum(path.slice(index - 48, index - 6).map((row) => row.volume)) / 42;
    rows.push({ symbol, current, r1: ret(path, index, 1), r6: ret(path, index, 6), r24: ret(path, index, 24),
      r7d: ret(path, index, 168), r30d: ret(path, index, 720), atr6: median(currentRanges),
      compression: median(currentRanges) / Math.max(median(baselineRanges), 1e-9),
      volumeBurst: recentVolume / Math.max(baselineVolume, 1e-9), high24: Math.max(...prior24.map((row) => row.high)),
      low24: Math.min(...prior24.map((row) => row.low)), high7d: Math.max(...prior7.map((row) => row.high)),
      low7d: Math.min(...prior7.map((row) => row.low)) });
  }
  const contextRows = rows.filter((row) => REGIME_CORE_SET.has(row.symbol));
  if (contextRows.length < 8) return null;
  const base = { median24: median(contextRows.map((row) => row.r24)), median7: median(contextRows.map((row) => row.r7d)),
    median30: median(contextRows.map((row) => row.r30d)), breadth24: contextRows.filter((row) => row.r24 > 0).length / contextRows.length,
    breadth7: contextRows.filter((row) => row.r7d > 0).length / contextRows.length,
    breadth30: contextRows.filter((row) => row.r30d > 0).length / contextRows.length,
    compression: median(contextRows.map((row) => row.compression)), markets: contextRows.length };
  const context: RegimeContext = { ...base, at: commonTime * 1_000, regime: classifyRegime(base) };
  return { context, features: rows.map((row) => ({ ...row, relative24: row.r24 - context.median24,
    relative7: row.r7d - context.median7, context })) as Feature[] };
}`;
regime = replaceBetween(regime, "function synchronizedFeatures(paths: Record<string, GateCandle[]>) {", "\n\nfunction signal", synchronized, "synchronized features");

const riskStart = "  const notionalMultiple = Math.min(.5, .015 / Math.max(stopRate + REGIME_FRICTION_RATE, 1e-9));";
const riskEnd = "  const leverage = selectSafeLeverage";
const riskA = regime.indexOf(riskStart); const riskB = regime.indexOf(riskEnd, riskA);
if (riskA < 0 || riskB < 0) throw new Error("trade risk block not found");
const riskReplacement = `  const satellite = REGIME_SATELLITE_SET.has(feature.symbol);
  const tradeRiskRate = satellite ? REGIME_SATELLITE_TRADE_RISK_RATE : .015;
  const notionalMultiple = Math.min(satellite ? .20 : .5,
    tradeRiskRate / Math.max(stopRate + REGIME_FRICTION_RATE, 1e-9));
  if (notionalMultiple < .05) return { trade: null, blocker: block(account, "MIN_NOTIONAL"), geometry };
  const contractNotional = entryPrice * multiplier;
  const contracts = Math.floor(account.equity * notionalMultiple / contractNotional);
  if (contracts < 1) return { trade: null, blocker: block(account, "MIN_CONTRACT"), geometry };
  const notional = contracts * contractNotional;
  const plannedRisk = notional * (stopRate + REGIME_FRICTION_RATE);
  if (satellite) {
    const satelliteOpen = Object.values(account.open).filter((row) => REGIME_SATELLITE_SET.has(row.symbol));
    const satelliteRisk = satelliteOpen.reduce((total, row) => total + row.plannedRisk, 0);
    const satelliteSideRisk = satelliteOpen.filter((row) => row.side === side)
      .reduce((total, row) => total + row.plannedRisk, 0);
    if (satelliteRisk + plannedRisk > account.equity * REGIME_SATELLITE_ACCOUNT_RISK_CAP + 1e-8
      || satelliteSideRisk + plannedRisk > account.equity * REGIME_SATELLITE_DIRECTION_RISK_CAP + 1e-8) {
      return { trade: null, blocker: block(account, "SATELLITE_RISK_CAP"), geometry };
    }
  }
  if (openRisk(account) + plannedRisk > account.equity * .10 + 1e-8
    || openRisk(account, side) + plannedRisk > account.equity * .065 + 1e-8) return { trade: null, blocker: block(account, "RISK_CAP"), geometry };
`;
regime = regime.slice(0, riskA) + riskReplacement + regime.slice(riskB);

regime = replaceOnce(regime,
`  })).sort((left, right) => right.found.strength - left.found.strength || left.config.id.localeCompare(right.config.id));`,
`  })).sort((left, right) => Number(REGIME_SATELLITE_SET.has(left.feature.symbol))
    - Number(REGIME_SATELLITE_SET.has(right.feature.symbol))
    || right.found.strength - left.found.strength || left.config.id.localeCompare(right.config.id));`, "core-first candidate sorting");
regime = replaceOnce(regime,
`  state.warmMarkets = Object.values(input.hourly).filter((rows) => rows.length >= REGIME_HOURLY_REQUIRED_CANDLES).length;`,
`  state.warmMarkets = REGIME_UNIVERSE.filter((symbol) => (input.hourly[symbol]?.length ?? 0) >= REGIME_HOURLY_REQUIRED_CANDLES).length;`, "core warm market count");
regime = replaceOnce(regime,
`      singleTradeRiskRate: .015, portfolioRiskCap: .10, correlatedRiskCap: .065, orderCopyRate: 1 } };`,
`      singleTradeRiskRate: .015, portfolioRiskCap: .10, correlatedRiskCap: .065, orderCopyRate: 1,
      coreUniverse: [...REGIME_UNIVERSE], satelliteUniverse: [...REGIME_SATELLITE_UNIVERSE],
      satelliteTradeRiskRate: REGIME_SATELLITE_TRADE_RISK_RATE,
      satelliteAccountRiskCap: REGIME_SATELLITE_ACCOUNT_RISK_CAP,
      satelliteCorrelatedRiskCap: REGIME_SATELLITE_DIRECTION_RISK_CAP } };`, "summary rules");
write("lib/regime-portfolio.ts", regime);

let worker = read("worker/index-clean.ts");
worker = replaceOnce(worker,
`  REGIME_HOURLY_REQUIRED_CANDLES, REGIME_PORTFOLIO_VERSION, REGIME_STRATEGIES, REGIME_SYSTEMS, REGIME_UNIVERSE, resetRegimePortfolio,`,
`  REGIME_EXECUTION_UNIVERSE, REGIME_HOURLY_REQUIRED_CANDLES, REGIME_PORTFOLIO_VERSION, REGIME_STRATEGIES, REGIME_SYSTEMS, REGIME_UNIVERSE, resetRegimePortfolio,`, "worker import");
worker = worker.replaceAll("Promise.all(REGIME_UNIVERSE.map(async", "Promise.all(REGIME_EXECUTION_UNIVERSE.map(async");
worker = worker.replaceAll("REGIME_UNIVERSE.find((item) =>", "REGIME_EXECUTION_UNIVERSE.find((item) =>");
worker = replaceOnce(worker,
`    const researchUniverse = REGIME_UNIVERSE.filter((symbol) => universe.has(symbol));`,
`    const researchUniverse = REGIME_EXECUTION_UNIVERSE.filter((symbol) => universe.has(symbol));`, "realtime research universe");
worker = replaceOnce(worker,
`        this.runtime.regimePortfolio.warmMarkets = Object.values(this.regimeHourly)
          .filter((rows) => rows.length >= REGIME_HOURLY_REQUIRED_CANDLES).length;`,
`        this.runtime.regimePortfolio.warmMarkets = REGIME_UNIVERSE
          .filter((symbol) => (this.regimeHourly[symbol]?.length ?? 0) >= REGIME_HOURLY_REQUIRED_CANDLES).length;`, "constructor warm markets");
write("worker/index-clean.ts", worker);

let test = read("tests/regime-portfolio.test.ts");
test = replaceOnce(test,
`import { classifyRegime, evaluateRegimePortfolio, initialRegimePortfolio, REGIME_STRATEGIES,
  normalizeRegimePortfolio, REGIME_SYSTEMS, type RegimeContractMeta } from "../lib/regime-portfolio.ts";`,
`import { classifyRegime, evaluateRegimePortfolio, initialRegimePortfolio, REGIME_EXECUTION_UNIVERSE,
  REGIME_SATELLITE_ACCOUNT_RISK_CAP, REGIME_SATELLITE_DIRECTION_RISK_CAP, REGIME_SATELLITE_TRADE_RISK_RATE,
  REGIME_SATELLITE_UNIVERSE, REGIME_STRATEGIES, REGIME_UNIVERSE,
  normalizeRegimePortfolio, REGIME_SYSTEMS, type RegimeContractMeta } from "../lib/regime-portfolio.ts";`, "test imports");
const extraTests = `

test("V1.1 keeps the frozen 11-market context and adds only SUI/UNI as satellite execution symbols", () => {
  assert.equal(REGIME_UNIVERSE.length, 11);
  assert.deepEqual(REGIME_SATELLITE_UNIVERSE, ["SUI_USDT", "UNI_USDT"]);
  assert.equal(REGIME_EXECUTION_UNIVERSE.length, 13);
  assert.equal(REGIME_SATELLITE_TRADE_RISK_RATE, .005);
  assert.equal(REGIME_SATELLITE_ACCOUNT_RISK_CAP, .02);
  assert.equal(REGIME_SATELLITE_DIRECTION_RISK_CAP, .015);

  const core = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT", "ADA_USDT", "LINK_USDT"];
  const hourly = Object.fromEntries([
    ...core.map((symbol) => [symbol, shockPath()] as const),
    ["SUI_USDT", balancedPath(1)], ["UNI_USDT", balancedPath(1)],
  ]);
  const now = 721 * 3_600_000;
  const quotes = Object.fromEntries(Object.keys(hourly).map((symbol) => [symbol,
    { midpoint: 91.2, bestBid: 91.19, bestAsk: 91.21, observedAt: now, fresh: true, completedMinuteAt: now }]));
  const meta: RegimeContractMeta = { quantoMultiplier: .001, maintenanceRate: .005, leverageMax: 50,
    fundingRate: 0, volume24hUsd: 1_000_000_000 };
  const contracts = Object.fromEntries(Object.keys(hourly).map((symbol) => [symbol, meta]));
  const state = evaluateRegimePortfolio({ state: initialRegimePortfolio(1), hourly, quotes, contracts, now });
  assert.equal(state.currentContext?.markets, 8, "satellites must never change core breadth/median sample size");
  assert.equal(state.currentContext?.regime, "SHOCK_TRANSITION");
  assert.equal(state.warmMarkets, 8, "warmMarkets reports core context readiness only");
});
`;
test += extraTests;
write("tests/regime-portfolio.test.ts", test);

unlinkSync("scripts/apply-regime-satellite-release.mjs");
unlinkSync(".github/workflows/regime-satellite-release-bootstrap.yml");
console.log("Applied Regime Core Satellite V1.1 production patch");
