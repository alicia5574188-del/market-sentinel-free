import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/slow-maker-feasibility.json";
const ARCHIVE = "https://download.gatedata.org/futures_usdt/orderbooks";
const SYMBOLS = ["BTC_USDT", "SOL_USDT", "SUI_USDT"];
const ERAS = [
  { label: "era1", ymdh: "2023101512" },
  { label: "era2", ymdh: "2024101512" },
  { label: "era3", ymdh: "2025101512" },
  { label: "late", ymdh: "2026071512" },
];
const SPREAD_THRESHOLDS_BPS = [1, 2, 4, 8, 12, 20];
const STABILITY_MS = [2_000, 6_000, 30_000];
const VIP0_MAKER_ONE_WAY_BPS_REFERENCE = 2;
const VIP0_MAKER_ROUND_TRIP_BPS_REFERENCE = 4;
const STRESS_MAKER_ROUND_TRIP_BPS_REFERENCE = 8;
const MIN_VALID_BOOK_SECONDS = 3_000;
const MAX_CROSSED_GROUP_RATIO = 0.005;

function numericConst(text, name) {
  const match = text.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)`));
  return match ? Number(match[1].replaceAll("_", "")) : null;
}
function percentile(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * q)))];
}
function weightedPercentile(rows, q) {
  const sorted = rows.filter((r) => Number.isFinite(r.value) && r.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, r) => s + r.weight, 0);
  if (!total) return null;
  const target = total * q;
  let acc = 0;
  for (const row of sorted) {
    acc += row.weight;
    if (acc >= target) return row.value;
  }
  return sorted.at(-1)?.value ?? null;
}
function median(values) { return percentile(values, 0.5); }
function spreadBps(bid, ask) {
  const mid = (bid + ask) / 2;
  return mid > 0 && ask > bid ? (ask - bid) / mid * 10_000 : null;
}
async function fetchRetry(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "market-sentinel-research", Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw last;
}
function recomputeBest(map, bidSide) {
  let best = bidSide ? -Infinity : Infinity;
  for (const price of map.keys()) {
    if (bidSide ? price > best : price < best) best = price;
  }
  return Number.isFinite(best) ? best : null;
}
function inferBidSign(rows) {
  const positive = rows.filter((r) => r.action === "set" && r.size > 0).map((r) => r.price);
  const negative = rows.filter((r) => r.action === "set" && r.size < 0).map((r) => r.price);
  if (!positive.length || !negative.length) return null;
  const posMid = median(positive);
  const negMid = median(negative);
  if (!(posMid > 0) || !(negMid > 0) || posMid === negMid) return null;
  return posMid < negMid ? 1 : -1;
}

async function analyzeHour(symbol, ymdh) {
  const ym = ymdh.slice(0, 6);
  const url = `${ARCHIVE}/${ym}/${symbol}-${ymdh}.csv.gz`;
  const response = await fetchRetry(url);
  const compressedBytes = Number(response.headers.get("content-length") ?? 0);
  const input = Readable.fromWeb(response.body).pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });

  const bids = new Map();
  const asks = new Map();
  let bestBid = null;
  let bestAsk = null;
  let bidSign = null;
  let currentTs = null;
  let group = [];
  let lineCount = 0;
  let groupCount = 0;
  let outOfOrder = 0;
  let missingTake = 0;
  let crossedGroups = 0;
  let validGroups = 0;
  let firstTs = null;
  let lastTs = null;
  let prevObsTs = null;
  let prevBid = null;
  let prevAsk = null;
  let prevSpread = null;
  let validBookTimeMs = 0;
  let lastUpdateEndId = null;
  let sequenceGapCount = 0;
  let sequenceBackwards = 0;
  const sequenceGapExamples = [];
  const spreadWeights = [];
  const spreadTimeMs = Object.fromEntries(SPREAD_THRESHOLDS_BPS.map((x) => [x, 0]));
  let stateStart = null;
  let stateSpread = null;
  const states = [];

  function sideMap(size) {
    if (bidSign == null || !size) return null;
    return Math.sign(size) === bidSign ? { map: bids, bid: true } : { map: asks, bid: false };
  }
  function updateBestFor(side, price, existedAfter) {
    if (side.bid) {
      if (existedAfter && (bestBid == null || price > bestBid)) bestBid = price;
      else if (!existedAfter && bestBid === price) bestBid = recomputeBest(bids, true);
    } else {
      if (existedAfter && (bestAsk == null || price < bestAsk)) bestAsk = price;
      else if (!existedAfter && bestAsk === price) bestAsk = recomputeBest(asks, false);
    }
  }
  function applyRows(rows) {
    if (bidSign == null) bidSign = inferBidSign(rows);
    if (bidSign == null) throw new Error(`${symbol} ${ymdh}: unable to infer signed book sides`);
    for (const row of rows) {
      const side = sideMap(row.size);
      if (!side) continue;
      const amount = Math.abs(row.size);
      if (row.action === "set") {
        if (amount > 0) side.map.set(row.price, amount);
        else side.map.delete(row.price);
        updateBestFor(side, row.price, amount > 0);
      } else if (row.action === "make") {
        const next = (side.map.get(row.price) ?? 0) + amount;
        if (next > 0) side.map.set(row.price, next);
        updateBestFor(side, row.price, next > 0);
      } else if (row.action === "take") {
        const current = side.map.get(row.price) ?? 0;
        if (!(current > 0)) {
          missingTake += 1;
          continue;
        }
        const next = current - amount;
        if (next > 1e-12) side.map.set(row.price, next);
        else side.map.delete(row.price);
        updateBestFor(side, row.price, next > 1e-12);
      }
    }
  }
  function finalizeState(endTs) {
    if (stateStart == null || stateSpread == null || !(endTs > stateStart)) return;
    states.push({ durationMs: endTs - stateStart, spreadBps: stateSpread });
  }
  function observe(ts) {
    groupCount += 1;
    const valid = bestBid != null && bestAsk != null && bestAsk > bestBid;
    if (!valid) {
      if (bestBid != null && bestAsk != null && bestBid >= bestAsk) crossedGroups += 1;
      prevObsTs = ts;
      prevBid = bestBid;
      prevAsk = bestAsk;
      prevSpread = null;
      stateStart = ts;
      stateSpread = null;
      return;
    }
    validGroups += 1;
    const spread = spreadBps(bestBid, bestAsk);
    if (prevObsTs != null && prevSpread != null && ts > prevObsTs) {
      const dt = ts - prevObsTs;
      validBookTimeMs += dt;
      spreadWeights.push({ value: prevSpread, weight: dt });
      for (const threshold of SPREAD_THRESHOLDS_BPS) if (prevSpread >= threshold) spreadTimeMs[threshold] += dt;
    }
    const bestChanged = stateStart == null || bestBid !== prevBid || bestAsk !== prevAsk;
    if (bestChanged) {
      if (stateStart != null) finalizeState(ts);
      stateStart = ts;
      stateSpread = spread;
    }
    prevObsTs = ts;
    prevBid = bestBid;
    prevAsk = bestAsk;
    prevSpread = spread;
  }
  function flushGroup() {
    if (currentTs == null || !group.length) return;
    applyRows(group);
    observe(currentTs);
    group = [];
  }

  for await (const line of rl) {
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const ts = Number(parts[0]) * 1000;
    const action = parts[1];
    const price = Number(parts[2]);
    const size = Number(parts[3]);
    const beginId = Number(parts[4]);
    const merged = Number(parts[5] ?? 1);
    if (![ts, price, size].every(Number.isFinite) || !(price > 0) || !["set", "make", "take"].includes(action)) continue;
    lineCount += 1;
    if (lastTs != null && ts < lastTs) outOfOrder += 1;
    firstTs ??= ts;
    lastTs = ts;
    if (action !== "set" && Number.isFinite(beginId) && beginId > 0) {
      const count = Number.isFinite(merged) && merged > 0 ? Math.floor(merged) : 1;
      if (lastUpdateEndId != null) {
        const expected = lastUpdateEndId + 1;
        if (beginId < expected) sequenceBackwards += 1;
        else if (beginId > expected) {
          sequenceGapCount += 1;
          if (sequenceGapExamples.length < 5) sequenceGapExamples.push({ expected, beginId, merged: count, ts });
        }
      }
      lastUpdateEndId = beginId + count - 1;
    }
    if (currentTs == null) currentTs = ts;
    if (ts !== currentTs) {
      flushGroup();
      currentTs = ts;
    }
    group.push({ action, price, size });
  }
  flushGroup();
  if (lastTs != null) finalizeState(lastTs);

  const durations = states.map((s) => s.durationMs);
  const timeInStableState = Object.fromEntries(STABILITY_MS.map((ms) => [ms, states.filter((s) => s.durationMs >= ms).reduce((sum, s) => sum + s.durationMs, 0)]));
  const stableWide = {};
  for (const spread of [4, 8]) {
    for (const ms of STABILITY_MS) {
      const key = `${spread}bp_${ms}ms`;
      const qualifying = states.filter((s) => s.spreadBps >= spread && s.durationMs >= ms);
      stableWide[key] = {
        segments: qualifying.length,
        seconds: qualifying.reduce((sum, s) => sum + s.durationMs, 0) / 1000,
        timeFraction: validBookTimeMs > 0 ? qualifying.reduce((sum, s) => sum + s.durationMs, 0) / validBookTimeMs : 0,
      };
    }
  }
  return {
    symbol, ymdh, url, compressedBytes, lineCount, groupCount, outOfOrder, missingTake, bidSign,
    firstTs, lastTs, validGroups, crossedGroups, sequenceGapCount, sequenceBackwards, sequenceGapExamples,
    crossedGroupRatio: groupCount ? crossedGroups / groupCount : 1,
    validBookSeconds: validBookTimeMs / 1000,
    spreadBps: {
      p50: weightedPercentile(spreadWeights, 0.5),
      p90: weightedPercentile(spreadWeights, 0.9),
      p99: weightedPercentile(spreadWeights, 0.99),
      timeAtOrAbove: Object.fromEntries(SPREAD_THRESHOLDS_BPS.map((x) => [x, validBookTimeMs ? spreadTimeMs[x] / validBookTimeMs : 0])),
    },
    bestQuoteStateMs: { p50: percentile(durations, 0.5), p90: percentile(durations, 0.9), p99: percentile(durations, 0.99) },
    timeInStableStateFraction: Object.fromEntries(STABILITY_MS.map((ms) => [ms, validBookTimeMs ? timeInStableState[ms] / validBookTimeMs : 0])),
    stableWide,
  };
}

const workerText = readFileSync("worker/index-clean.ts", "utf8");
const marketText = readFileSync("lib/gate-market.ts", "utf8");
const runtime = {
  loopMs: numericConst(workerText, "LOOP_MS"),
  authorityStaleAfterMs: numericConst(workerText, "AUTHORITY_STALE_AFTER_MS"),
  gatePublicTimeoutMs: numericConst(marketText, "GATE_PUBLIC_TIMEOUT_MS"),
  liveSubmissionUnconfirmedMs: Number((workerText.match(/now - entry\.missingSince >= ([0-9_]+)/)?.[1] ?? "6000").replaceAll("_", "")),
};

const records = [];
for (const era of ERAS) {
  for (const symbol of SYMBOLS) {
    try {
      const row = await analyzeHour(symbol, era.ymdh);
      records.push({ era: era.label, ok: true, ...row });
      console.log(`maker-audit ${era.label} ${symbol}: spread p50=${row.spreadBps.p50?.toFixed(3)}bp state p50=${row.bestQuoteStateMs.p50?.toFixed(0)}ms wide4/6s=${(row.stableWide["4bp_6000ms"].timeFraction * 100).toFixed(3)}% crossed=${(row.crossedGroupRatio * 100).toFixed(3)}% seqGap=${row.sequenceGapCount}`);
    } catch (error) {
      records.push({ era: era.label, symbol, ymdh: era.ymdh, ok: false, error: String(error?.stack ?? error) });
      console.error(`maker-audit ${era.label} ${symbol} failed:`, error);
    }
  }
}

function hourQualityPass(r) {
  return r.ok && r.validBookSeconds >= MIN_VALID_BOOK_SECONDS && r.crossedGroupRatio <= MAX_CROSSED_GROUP_RATIO
    && r.outOfOrder === 0 && r.sequenceGapCount === 0 && r.sequenceBackwards === 0;
}

const validRecords = records.filter(hourQualityPass);
const invalidRecords = records.filter((r) => !hourQualityPass(r));
const totalHours = ERAS.length * SYMBOLS.length;
const reconstructionCoverage = validRecords.length / totalHours;
const reconstructionPass = invalidRecords.length === 0;
const archiveQualityDecision = reconstructionPass ? "ALL_SAMPLED_HOURS_RECONSTRUCT_CLEANLY"
  : reconstructionCoverage >= 0.8 ? "ARCHIVE_USABLE_WITH_HOUR_QUALITY_GATING"
    : "ARCHIVE_RECONSTRUCTION_INSUFFICIENT";

const symbolPortability = Object.fromEntries(SYMBOLS.map((symbol) => {
  const rows = validRecords.filter((r) => r.symbol === symbol);
  const hasKnownWide4Failure = rows.some((r) => r.stableWide["4bp_6000ms"].timeFraction < 0.001);
  const hasKnownWide8Failure = rows.some((r) => r.stableWide["8bp_6000ms"].timeFraction < 0.001);
  const allEraWide4SixProven = rows.length === ERAS.length && rows.every((r) => r.stableWide["4bp_6000ms"].timeFraction >= 0.001);
  const allEraWide8SixProven = rows.length === ERAS.length && rows.every((r) => r.stableWide["8bp_6000ms"].timeFraction >= 0.001);
  const medianBestStateMs = median(rows.map((r) => r.bestQuoteStateMs.p50));
  const maxStableWide4SixPct = Math.max(0, ...rows.map((r) => r.stableWide["4bp_6000ms"].timeFraction * 100));
  return [symbol, { validEraCount: rows.length, hasKnownWide4Failure, hasKnownWide8Failure,
    allEraWide4SixProven, allEraWide8SixProven, medianBestStateMs, maxStableWide4SixPct }];
}));

const atTouchPortabilityRejected = Object.values(symbolPortability).every((x) => x.hasKnownWide4Failure);
const latencyMatchedWideEvidence = validRecords.some((r) => r.stableWide["4bp_6000ms"].timeFraction >= 0.001
  && r.bestQuoteStateMs.p50 >= Math.max(2_000, runtime.loopMs ?? 2_000));
const atTouchDecision = atTouchPortabilityRejected
  ? "AT_TOUCH_MAKER_REJECTED_NOT_PORTABLE_ACROSS_ERAS"
  : archiveQualityDecision === "ARCHIVE_RECONSTRUCTION_INSUFFICIENT" ? "AT_TOUCH_DECISION_BLOCKED_BY_ARCHIVE_QUALITY"
    : latencyMatchedWideEvidence ? "AT_TOUCH_MAKER_WORTH_FILL_TEST" : "AT_TOUCH_MAKER_NOT_MATCHED_TO_CURRENT_LATENCY";
const widePassiveDecision = archiveQualityDecision === "ARCHIVE_RECONSTRUCTION_INSUFFICIENT"
  ? "WIDE_PASSIVE_DATA_INSUFFICIENT"
  : "WIDE_PASSIVE_BOOK_DATA_USABLE_WITH_HOUR_QUALITY_GATING";

const outputCore = {
  research: "slow-maker-feasibility-v1",
  objective: "decide whether Gate historical order books plus the current 2s-class Cloudflare control loop justify an honest passive-liquidity research stage before writing any maker strategy",
  protocol: {
    symbols: SYMBOLS,
    eras: ERAS,
    archive: "official Gate futures_usdt/orderbooks hourly logs; full snapshot then 100ms-merged take/make updates",
    archiveSemantics: "set initializes full depth; signed futures size identifies side; make adds size, take removes size; begin-id plus merged count is checked for update continuity",
    sample: "one UTC hour per symbol in each separated era; structural feasibility audit, not a profitability backtest",
    spreadThresholdsBps: SPREAD_THRESHOLDS_BPS,
    quoteStabilityMs: STABILITY_MS,
    hourQuality: { minValidBookSeconds: MIN_VALID_BOOK_SECONDS, maxCrossedGroupRatio: MAX_CROSSED_GROUP_RATIO, requireOrderedTimestamps: true, requireContinuousUpdateIds: true },
    makerFeeReference: { vip0OneWayBps: VIP0_MAKER_ONE_WAY_BPS_REFERENCE, vip0RoundTripBps: VIP0_MAKER_ROUND_TRIP_BPS_REFERENCE, stressRoundTripHurdleBps: STRESS_MAKER_ROUND_TRIP_BPS_REFERENCE, note: "reference hurdle only; live account fee must be queried before execution" },
    runtimeSource: "main worker/index-clean.ts + lib/gate-market.ts",
  },
  runtime,
  reconstructionPass,
  reconstructionCoverage,
  archiveQualityDecision,
  validHours: validRecords.length,
  invalidHours: invalidRecords.map((r) => ({ era: r.era, symbol: r.symbol, ymdh: r.ymdh, validBookSeconds: r.validBookSeconds ?? null,
    crossedGroupRatio: r.crossedGroupRatio ?? null, sequenceGapCount: r.sequenceGapCount ?? null, sequenceBackwards: r.sequenceBackwards ?? null, error: r.error ?? null })),
  atTouchPortabilityRejected,
  latencyMatchedWideEvidence,
  atTouchDecision,
  widePassiveDecision,
  symbolPortability,
  records,
  interpretation: "A bad archive hour is quarantined rather than allowed to poison the whole study. At-touch maker is still rejected if every symbol has at least one clean sampled era with effectively no >=4bp spread state lasting >=6s. Wide-passive archive usability is a data-quality statement only and does not claim fills, positive markout, or profitability.",
};
const sha256 = createHash("sha256").update(JSON.stringify(outputCore)).digest("hex");
const output = { ...outputCore, sha256, generatedAt: new Date().toISOString() };
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`SLOW_MAKER_FEASIBILITY=${JSON.stringify({ reconstructionPass, reconstructionCoverage, archiveQualityDecision, validHours: validRecords.length, invalidHours: outputCore.invalidHours, atTouchPortabilityRejected, latencyMatchedWideEvidence, atTouchDecision, widePassiveDecision, runtime, symbolPortability, summary: records.map((r) => r.ok ? ({ era: r.era, symbol: r.symbol, qualityPass: hourQualityPass(r), p50SpreadBps: r.spreadBps.p50, p90SpreadBps: r.spreadBps.p90, p50BestStateMs: r.bestQuoteStateMs.p50, stableWide4SixPct: r.stableWide["4bp_6000ms"].timeFraction * 100, stableWide8SixPct: r.stableWide["8bp_6000ms"].timeFraction * 100, crossedGroupRatio: r.crossedGroupRatio, validBookSeconds: r.validBookSeconds, sequenceGapCount: r.sequenceGapCount, sequenceBackwards: r.sequenceBackwards }) : r), sha256 })}`);