import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/wide-passive-fill-markout.json';
const ARCHIVE = 'https://download.gatedata.org/futures_usdt/orderbooks';
const SYMBOLS = ['BTC_USDT', 'SOL_USDT', 'SUI_USDT'];
const ERAS = [
  { label: 'era1', ymdh: '2023101512', pre: true },
  { label: 'era2', ymdh: '2024101512', pre: true },
  { label: 'era3', ymdh: '2025101512', pre: true },
  { label: 'evaluation', ymdh: '2026071512', pre: false },
];
const OFFSETS_BPS = [2, 4, 8, 12];
const DECISION_MS = 2_000;
const QUOTE_LIFETIME_MS = 6_000;
const CANCEL_OTHER_DELAY_MS = 2_000;
const MARKOUT_MS = [5_000, 15_000, 30_000];
const HOUR_MIN_VALID_SECONDS = 3_000;
const MAX_CROSSED_RATIO = 0.005;
const MAKER_ONE_WAY = 0.0002;            // 2bp reference
const MAKER_MAKER_STRESS_RT = 0.0008;    // 8bp stress round-trip reference
const TAKER_STRESS_ONE_WAY = 0.0011;     // half of prior 22bp taker round-trip stress
const ADVERSE_EXTRA = 0.0005;            // extra execution stress
const HYBRID_STRESS_RT = MAKER_ONE_WAY + TAKER_STRESS_ONE_WAY;
const HYBRID_ADVERSE_RT = HYBRID_STRESS_RT + ADVERSE_EXTRA;
const MIN_PRE_ERA_FILLS = 20;

function percentile(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.max(0, Math.min(a.length - 1, Math.floor((a.length - 1) * q)))];
}
function mean(values) {
  const a = values.filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function median(values) { return percentile(values, 0.5); }
function pf(values) {
  let gp = 0, gl = 0;
  for (const x of values.filter(Number.isFinite)) {
    if (x > 0) gp += x; else gl += -x;
  }
  return gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
}
function spreadBps(bid, ask) {
  const mid = (bid + ask) / 2;
  return mid > 0 && ask > bid ? (ask - bid) / mid * 10_000 : null;
}
function recomputeBest(map, bidSide) {
  let best = bidSide ? -Infinity : Infinity;
  for (const p of map.keys()) if (bidSide ? p > best : p < best) best = p;
  return Number.isFinite(best) ? best : null;
}
function inferBidSign(rows) {
  const pos = rows.filter((r) => r.action === 'set' && r.size > 0).map((r) => r.price);
  const neg = rows.filter((r) => r.action === 'set' && r.size < 0).map((r) => r.price);
  const pm = median(pos), nm = median(neg);
  if (!(pm > 0) || !(nm > 0) || pm === nm) return null;
  return pm < nm ? 1 : -1;
}
function sideFromSize(size, bidSign) {
  if (!size || bidSign == null) return null;
  return Math.sign(size) === bidSign ? 'bid' : 'ask';
}
async function fetchRetry(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'market-sentinel-research', Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      last = e;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw last;
}
function nearestBidLevel(bids, target) {
  let chosen = null;
  for (const p of bids.keys()) if (p <= target && (chosen == null || p > chosen)) chosen = p;
  return chosen;
}
function nearestAskLevel(asks, target) {
  let chosen = null;
  for (const p of asks.keys()) if (p >= target && (chosen == null || p < chosen)) chosen = p;
  return chosen;
}
function newOffsetStats(offset) {
  return {
    offsetBps: offset,
    placements: 0,
    firstFills: 0,
    bidFirst: 0,
    askFirst: 0,
    pairedFills: 0,
    singleFills: 0,
    expiredNoFill: 0,
    queueAheadUsdProxy: [],
    timeToFirstFillMs: [],
    pairCaptureRaw: [],
    pairCaptureStress: [],
    markout: Object.fromEntries(MARKOUT_MS.map((h) => [h, { gross: [], makerNet: [], hybridStress: [], hybridAdverse: [] }])),
  };
}
function summarizeOffset(s, validHours) {
  const markout = {};
  for (const h of MARKOUT_MS) {
    const m = s.markout[h];
    markout[h] = {
      n: m.gross.length,
      grossMean: mean(m.gross),
      grossP50: median(m.gross),
      makerNetMean: mean(m.makerNet),
      makerNetPF: pf(m.makerNet),
      hybridStressMean: mean(m.hybridStress),
      hybridStressPF: pf(m.hybridStress),
      hybridAdverseMean: mean(m.hybridAdverse),
      hybridAdversePF: pf(m.hybridAdverse),
    };
  }
  return {
    offsetBps: s.offsetBps,
    placements: s.placements,
    firstFills: s.firstFills,
    fillRate: s.placements ? s.firstFills / s.placements : 0,
    fillsPerSampleHour: validHours ? s.firstFills / validHours : 0,
    bidFirst: s.bidFirst,
    askFirst: s.askFirst,
    pairedFills: s.pairedFills,
    pairedShare: s.firstFills ? s.pairedFills / s.firstFills : 0,
    singleFills: s.singleFills,
    expiredNoFill: s.expiredNoFill,
    timeToFirstFillMsP50: median(s.timeToFirstFillMs),
    timeToFirstFillMsP90: percentile(s.timeToFirstFillMs, 0.9),
    pairCaptureRawMean: mean(s.pairCaptureRaw),
    pairCaptureStressMean: mean(s.pairCaptureStress),
    pairCaptureStressPF: pf(s.pairCaptureStress),
    markout,
  };
}

async function analyzeHour(symbol, era) {
  const ym = era.ymdh.slice(0, 6);
  const url = `${ARCHIVE}/${ym}/${symbol}-${era.ymdh}.csv.gz`;
  const r = await fetchRetry(url);
  const input = Readable.fromWeb(r.body).pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });

  const bids = new Map();
  const asks = new Map();
  let bestBid = null, bestAsk = null, bidSign = null;
  let currentTs = null, group = [];
  let firstTs = null, lastTs = null, prevTs = null;
  let outOfOrder = 0, crossed = 0, groups = 0, validBookMs = 0;
  let seqGapCount = 0, seqBackwards = 0, nextSeq = null;

  const states = Object.fromEntries(OFFSETS_BPS.map((x) => [x, { nextDecisionTs: null, pair: null, pendingEvents: [], stats: newOffsetStats(x) }]));

  function updateBest(side, price, exists) {
    if (side === 'bid') {
      if (exists && (bestBid == null || price > bestBid)) bestBid = price;
      else if (!exists && bestBid === price) bestBid = recomputeBest(bids, true);
    } else {
      if (exists && (bestAsk == null || price < bestAsk)) bestAsk = price;
      else if (!exists && bestAsk === price) bestAsk = recomputeBest(asks, false);
    }
  }
  function applyBookRow(row) {
    const side = sideFromSize(row.size, bidSign);
    if (!side) return;
    const map = side === 'bid' ? bids : asks;
    const amount = Math.abs(row.size);
    if (row.action === 'set') {
      if (amount > 0) map.set(row.price, amount); else map.delete(row.price);
      updateBest(side, row.price, amount > 0);
    } else if (row.action === 'make') {
      const next = (map.get(row.price) ?? 0) + amount;
      if (next > 0) map.set(row.price, next);
      updateBest(side, row.price, next > 0);
    } else if (row.action === 'take') {
      const cur = map.get(row.price) ?? 0;
      const next = cur - amount;
      if (next > 1e-12) map.set(row.price, next); else map.delete(row.price);
      updateBest(side, row.price, next > 1e-12);
    }
  }
  function applyQueueDepletion(row) {
    if (row.action !== 'take' || bidSign == null) return;
    const side = sideFromSize(row.size, bidSign);
    const amount = Math.abs(row.size);
    for (const st of Object.values(states)) {
      const p = st.pair;
      if (!p) continue;
      if (!p.bidFilled && side === 'bid' && row.price === p.bidPrice) {
        p.bidQueue -= amount;
        if (p.bidQueue <= 0) p.bidQueueCleared = true;
      }
      if (!p.askFilled && side === 'ask' && row.price === p.askPrice) {
        p.askQueue -= amount;
        if (p.askQueue <= 0) p.askQueueCleared = true;
      }
    }
  }
  function markFilled(st, side, ts, mid) {
    const p = st.pair;
    if (!p) return;
    const price = side === 'bid' ? p.bidPrice : p.askPrice;
    if (side === 'bid') p.bidFilled = true; else p.askFilled = true;
    if (p.firstFillTs == null) {
      p.firstFillTs = ts;
      p.firstSide = side;
      p.firstFillPrice = price;
      p.firstMid = mid;
      p.cancelOtherAt = ts + CANCEL_OTHER_DELAY_MS;
      st.stats.firstFills += 1;
      st.stats.timeToFirstFillMs.push(ts - p.placedTs);
      if (side === 'bid') st.stats.bidFirst += 1; else st.stats.askFirst += 1;
      st.pendingEvents.push({
        fillTs: ts,
        side,
        fillPrice: price,
        horizons: new Set(),
      });
    } else if (p.bidFilled && p.askFilled && !p.pairedCounted) {
      p.pairedCounted = true;
      st.stats.pairedFills += 1;
      const raw = p.askPrice / p.bidPrice - 1;
      st.stats.pairCaptureRaw.push(raw);
      st.stats.pairCaptureStress.push(raw - MAKER_MAKER_STRESS_RT);
    }
  }
  function evaluateFills(ts) {
    if (!(bestBid > 0) || !(bestAsk > bestBid)) return;
    const mid = (bestBid + bestAsk) / 2;
    for (const st of Object.values(states)) {
      const p = st.pair;
      if (!p) continue;
      if (p.firstFillTs != null && ts >= p.cancelOtherAt) {
        if (!(p.bidFilled && p.askFilled) && !p.singleCounted) {
          p.singleCounted = true;
          st.stats.singleFills += 1;
        }
        st.pair = null;
        continue;
      }
      if (ts > p.expiryTs && p.firstFillTs == null) {
        st.stats.expiredNoFill += 1;
        st.pair = null;
        continue;
      }
      if (p.firstFillTs == null && ts > p.expiryTs) continue;
      // Conservative queue model: a side can fill only after all displayed queue ahead was removed
      // and the historical same-side best has moved through that quoted level.
      if (!p.bidFilled && p.bidQueueCleared && bestBid < p.bidPrice) markFilled(st, 'bid', ts, mid);
      if (!p.askFilled && p.askQueueCleared && bestAsk > p.askPrice) markFilled(st, 'ask', ts, mid);
    }
  }
  function updateMarkouts(ts) {
    if (!(bestBid > 0) || !(bestAsk > bestBid)) return;
    const mid = (bestBid + bestAsk) / 2;
    for (const st of Object.values(states)) {
      for (const e of st.pendingEvents) {
        for (const h of MARKOUT_MS) {
          if (e.horizons.has(h) || ts < e.fillTs + h) continue;
          const dir = e.side === 'bid' ? 1 : -1;
          const gross = dir * (mid / e.fillPrice - 1);
          const bucket = st.stats.markout[h];
          bucket.gross.push(gross);
          bucket.makerNet.push(gross - MAKER_ONE_WAY);
          bucket.hybridStress.push(gross - HYBRID_STRESS_RT);
          bucket.hybridAdverse.push(gross - HYBRID_ADVERSE_RT);
          e.horizons.add(h);
        }
      }
      st.pendingEvents = st.pendingEvents.filter((e) => e.horizons.size < MARKOUT_MS.length);
    }
  }
  function maybePlace(ts) {
    if (!(bestBid > 0) || !(bestAsk > bestBid)) return;
    const mid = (bestBid + bestAsk) / 2;
    for (const offset of OFFSETS_BPS) {
      const st = states[offset];
      if (st.nextDecisionTs == null) st.nextDecisionTs = ts;
      if (ts < st.nextDecisionTs) continue;
      while (st.nextDecisionTs <= ts) st.nextDecisionTs += DECISION_MS;
      if (st.pair) continue;
      const bidTarget = mid * (1 - offset / 10_000);
      const askTarget = mid * (1 + offset / 10_000);
      const bidPrice = nearestBidLevel(bids, bidTarget);
      const askPrice = nearestAskLevel(asks, askTarget);
      if (!(bidPrice > 0) || !(askPrice > bidPrice)) continue;
      const bidQueue = bids.get(bidPrice) ?? 0;
      const askQueue = asks.get(askPrice) ?? 0;
      if (!(bidQueue > 0) || !(askQueue > 0)) continue;
      st.pair = {
        placedTs: ts,
        expiryTs: ts + QUOTE_LIFETIME_MS,
        bidPrice, askPrice,
        bidQueue, askQueue,
        bidQueueCleared: false, askQueueCleared: false,
        bidFilled: false, askFilled: false,
        firstFillTs: null, firstSide: null, firstFillPrice: null, firstMid: mid,
        cancelOtherAt: null, pairedCounted: false, singleCounted: false,
      };
      st.stats.placements += 1;
      st.stats.queueAheadUsdProxy.push((bidQueue * bidPrice + askQueue * askPrice) / 2);
    }
  }
  function flushGroup() {
    if (currentTs == null || !group.length) return;
    if (bidSign == null) bidSign = inferBidSign(group);
    if (bidSign == null) throw new Error(`${symbol} ${era.ymdh}: cannot infer side sign`);
    for (const row of group) {
      if (row.beginId != null) {
        const start = row.beginId;
        const count = row.merged ?? 1n;
        if (nextSeq != null) {
          if (start < nextSeq) seqBackwards += 1;
          else if (start > nextSeq) seqGapCount += 1;
        }
        const endExclusive = start + count;
        if (nextSeq == null || endExclusive > nextSeq) nextSeq = endExclusive;
      }
      applyQueueDepletion(row);
      applyBookRow(row);
    }
    groups += 1;
    if (bestBid != null && bestAsk != null && bestBid >= bestAsk) crossed += 1;
    if (prevTs != null && bestBid != null && bestAsk != null && bestAsk > bestBid) validBookMs += Math.max(0, currentTs - prevTs);
    evaluateFills(currentTs);
    updateMarkouts(currentTs);
    maybePlace(currentTs);
    prevTs = currentTs;
    group = [];
  }

  for await (const line of rl) {
    if (!line) continue;
    const p = line.split(',');
    if (p.length < 4) continue;
    const ts = Number(p[0]) * 1000;
    const action = p[1];
    const price = Number(p[2]);
    const size = Number(p[3]);
    if (![ts, price, size].every(Number.isFinite) || !(price > 0) || !['set', 'make', 'take'].includes(action)) continue;
    if (lastTs != null && ts < lastTs) outOfOrder += 1;
    firstTs ??= ts;
    lastTs = ts;
    if (currentTs == null) currentTs = ts;
    if (ts !== currentTs) {
      flushGroup();
      currentTs = ts;
    }
    let beginId = null, merged = null;
    try {
      if (p[4] != null && p[4] !== '') beginId = BigInt(p[4]);
      if (p[5] != null && p[5] !== '') merged = BigInt(p[5]);
    } catch {}
    group.push({ action, price, size, beginId, merged });
  }
  flushGroup();

  const crossedRatio = groups ? crossed / groups : 1;
  const qualityPass = validBookMs / 1000 >= HOUR_MIN_VALID_SECONDS && crossedRatio <= MAX_CROSSED_RATIO && outOfOrder === 0 && seqGapCount === 0 && seqBackwards === 0;
  return {
    era: era.label,
    pre: era.pre,
    symbol,
    ymdh: era.ymdh,
    url,
    qualityPass,
    groups,
    validBookSeconds: validBookMs / 1000,
    crossedRatio,
    outOfOrder,
    seqGapCount,
    seqBackwards,
    stats: Object.fromEntries(OFFSETS_BPS.map((x) => [x, summarizeOffset(states[x].stats, qualityPass ? 1 : 0)])),
  };
}

const records = [];
for (const era of ERAS) {
  for (const symbol of SYMBOLS) {
    try {
      const row = await analyzeHour(symbol, era);
      records.push(row);
      console.log(`wide-passive ${era.label} ${symbol} quality=${row.qualityPass} crossed=${(row.crossedRatio*100).toFixed(3)}% ` + OFFSETS_BPS.map((o) => `${o}bp:${row.stats[o].firstFills}/${row.stats[o].placements}`).join(' '));
    } catch (error) {
      records.push({ era: era.label, pre: era.pre, symbol, ymdh: era.ymdh, qualityPass: false, error: String(error?.stack ?? error) });
      console.error(`wide-passive ${era.label} ${symbol} failed`, error);
    }
  }
}

function aggregateEra(eraLabel, offset) {
  const rows = records.filter((r) => r.era === eraLabel && r.qualityPass && r.stats?.[offset]);
  const out = newOffsetStats(offset);
  for (const r of rows) {
    const src = r.stats[offset];
    out.placements += src.placements;
    out.firstFills += src.firstFills;
    out.bidFirst += src.bidFirst;
    out.askFirst += src.askFirst;
    out.pairedFills += src.pairedFills;
    out.singleFills += src.singleFills;
    out.expiredNoFill += src.expiredNoFill;
    // summaries do not retain raw arrays, so aggregate means by reconstructing weighted synthetic values only where needed below.
  }
  // Exact performance arrays are collected directly from per-hour states only inside analyzeHour; for compactness,
  // reconstruct era screening from weighted hour-level means and counts.
  const markout = {};
  for (const h of MARKOUT_MS) {
    const weighted = (field) => {
      let n = 0, s = 0;
      for (const r of rows) {
        const m = r.stats[offset].markout[h];
        if (m.n > 0 && Number.isFinite(m[field])) { n += m.n; s += m[field] * m.n; }
      }
      return n ? { n, mean: s / n } : { n: 0, mean: null };
    };
    const gross = weighted('grossMean');
    const maker = weighted('makerNetMean');
    const hybrid = weighted('hybridStressMean');
    const adverse = weighted('hybridAdverseMean');
    markout[h] = { n: gross.n, grossMean: gross.mean, makerNetMean: maker.mean, hybridStressMean: hybrid.mean, hybridAdverseMean: adverse.mean };
  }
  let pairN = 0, pairStressSum = 0;
  for (const r of rows) {
    const s = r.stats[offset];
    if (s.pairedFills > 0 && Number.isFinite(s.pairCaptureStressMean)) {
      pairN += s.pairedFills;
      pairStressSum += s.pairCaptureStressMean * s.pairedFills;
    }
  }
  return {
    era: eraLabel,
    offsetBps: offset,
    validHours: rows.length,
    placements: out.placements,
    firstFills: out.firstFills,
    fillRate: out.placements ? out.firstFills / out.placements : 0,
    fillsPerSampleHour: rows.length ? out.firstFills / rows.length : 0,
    pairedFills: out.pairedFills,
    pairedShare: out.firstFills ? out.pairedFills / out.firstFills : 0,
    singleFills: out.singleFills,
    pairCaptureStressMean: pairN ? pairStressSum / pairN : null,
    markout,
  };
}

const eraAggregates = Object.fromEntries(ERAS.map((era) => [era.label, Object.fromEntries(OFFSETS_BPS.map((o) => [o, aggregateEra(era.label, o)]))]));
const preEras = ERAS.filter((x) => x.pre).map((x) => x.label);
const preQualified = [];
for (const offset of OFFSETS_BPS) {
  const perEra = preEras.map((e) => eraAggregates[e][offset]);
  const pass = perEra.every((x) => x.firstFills >= MIN_PRE_ERA_FILLS && x.markout[15_000].makerNetMean != null && x.markout[15_000].makerNetMean >= 0);
  if (pass) preQualified.push(offset);
}
const evaluationOpened = preQualified.length > 0;
const evaluation = evaluationOpened ? Object.fromEntries(preQualified.map((o) => [o, eraAggregates.evaluation[o]])) : null;
const decision = preQualified.length === 0
  ? 'WIDE_PASSIVE_REJECTED_ADVERSE_SELECTION_OR_FILL_ECONOMICS_FAIL_PRE_ERAS'
  : preQualified.some((o) => eraAggregates.evaluation[o]?.markout?.[15_000]?.makerNetMean >= 0)
    ? 'WIDE_PASSIVE_STRUCTURAL_EDGE_SURVIVES_SCREEN'
    : 'WIDE_PASSIVE_PRE_EDGE_FAILS_GATED_EVALUATION';

const outputCore = {
  research: 'wide-passive-fill-markout-v1',
  objective: 'test whether slow away-from-touch passive orders can earn enough spread compensation after conservative back-of-queue fills under the current 2s control cadence',
  protocol: {
    symbols: SYMBOLS,
    eras: ERAS,
    orderbookArchive: 'official Gate futures_usdt/orderbooks hourly set snapshot + signed take/make deltas',
    decisionCadenceMs: DECISION_MS,
    quoteLifetimeMs: QUOTE_LIFETIME_MS,
    cancelOtherAfterFirstFillMs: CANCEL_OTHER_DELAY_MS,
    offsetsBps: OFFSETS_BPS,
    markoutMs: MARKOUT_MS,
    fillModel: 'quote at nearest existing level at-or-farther than target offset; queue behind all displayed size; fill only after queue ahead is depleted and historical same-side best moves through quote; no same-group fill at placement',
    costReferences: {
      makerOneWayBps: MAKER_ONE_WAY * 10_000,
      makerMakerStressRoundTripBps: MAKER_MAKER_STRESS_RT * 10_000,
      hybridMakerPlusTakerStressRoundTripBps: HYBRID_STRESS_RT * 10_000,
      hybridAdverseRoundTripBps: HYBRID_ADVERSE_RT * 10_000,
    },
    hourQuality: { minValidBookSeconds: HOUR_MIN_VALID_SECONDS, maxCrossedRatio: MAX_CROSSED_RATIO, requireNoSequenceGaps: true },
    preAcceptance: `same offset must have >=${MIN_PRE_ERA_FILLS} fills and nonnegative 15s markout after one-way maker fee in every pre era before 2026 evaluation opens`,
  },
  validHours: records.filter((r) => r.qualityPass).length,
  invalidHours: records.filter((r) => !r.qualityPass).map((r) => ({ era: r.era, symbol: r.symbol, ymdh: r.ymdh, crossedRatio: r.crossedRatio, validBookSeconds: r.validBookSeconds, error: r.error ?? null })),
  preQualifiedOffsetsBps: preQualified,
  evaluationOpened,
  evaluation,
  decision,
  eraAggregates,
  records,
  interpretation: 'This is a structural toxicity/fill screen, not a production-ready maker backtest. Passing would only justify a larger multi-hour capacity and inventory-control study. Failing means slow passive fills do not compensate for adverse selection consistently enough under the current cadence.',
};
const sha256 = createHash('sha256').update(JSON.stringify(outputCore)).digest('hex');
writeFileSync(OUTPUT, `${JSON.stringify({ ...outputCore, sha256, generatedAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`WIDE_PASSIVE_RESULT=${JSON.stringify({ decision, validHours: outputCore.validHours, invalidHours: outputCore.invalidHours, preQualifiedOffsetsBps: preQualified, evaluationOpened, eraAggregates, sha256 })}`);
