import { readFileSync, writeFileSync } from 'node:fs';

const INPUT = process.env.RESEARCH_DATASET ?? '/tmp/gate-fbr-backward-12m.json';
const CONFIG = process.env.RESEARCH_CONFIG ?? 'research/frozen-fbr-rank123.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/fbr-frozen-backward-oos.json';
const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
const frozen = JSON.parse(readFileSync(CONFIG, 'utf8'));

const EXPECTED_MONTHS = ['202409','202410','202411','202412','202501','202502','202503','202504','202505','202506','202507','202508'];
if (raw.interval !== '5m') throw new Error(`Need 5m data, got ${raw.interval}`);
if (JSON.stringify(raw.months) !== JSON.stringify(EXPECTED_MONTHS)) throw new Error(`Need exact backward months ${EXPECTED_MONTHS.join(',')}`);
if (frozen.lanes?.length !== 13) throw new Error(`Need exact 13 frozen lanes, got ${frozen.lanes?.length}`);

const BASE = 0.0014;
const STRESS = 0.0022;
const SLIP = 0.00025;
const ADV = 0.00050;
const DAY = 86400;
const FROM = Date.UTC(2024, 8, 1) / 1000;
const TO = Date.UTC(2025, 8, 1) / 1000;
const DAYS = (TO - FROM) / DAY;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const med = (a) => {
  const b = [...a].sort((x, y) => x - y);
  if (!b.length) return 0;
  const i = Math.floor(b.length / 2);
  return b.length % 2 ? b[i] : (b[i - 1] + b[i]) / 2;
};
const data = new Map(raw.datasets.map((d) => [d.symbol, [...d.rows].sort((a, b) => a.time - b.time)]));
const syms = [...data.keys()];
if (syms.length < 15) throw new Error(`Only ${syms.length} usable symbols`);
const idx = new Map([...data].map(([s, r]) => [s, new Map(r.map((x, i) => [x.time, i]))]));
const times = [...new Set(raw.datasets.flatMap((d) => d.rows.map((x) => x.time))]
  .sort((a, b) => a - b)
  .filter((t) => t >= FROM && t < TO && t % 300 === 0);

const ret = (r, i, bars) => r[i].close / r[i - bars].close - 1;
const monthIndex = (t) => {
  const d = new Date(t * 1000);
  const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return EXPECTED_MONTHS.indexOf(key);
};
const session = (h) => h < 8 ? 'ASIA' : h < 16 ? 'EU' : 'US';
const volRatio = (r, i) => {
  if (i < 12) return 0;
  const base = med(r.slice(i - 12, i).map((x) => x.volume).filter((v) => Number.isFinite(v) && v > 0));
  return base > 0 ? r[i].volume / base : 0;
};
const conditionOk = (id, f) => id === 'ALL'
  || (id === 'EITHER_HIGH_200' && Math.max(f.loserVol, f.winnerVol) >= 2)
  || (id === 'BOTH_HIGH_150' && f.loserVol >= 1.5 && f.winnerVol >= 1.5)
  || (id === 'WINNER_HIGH_150' && f.winnerVol >= 1.5)
  || (id === 'LOSER_HIGH_150' && f.loserVol >= 1.5)
  || (id === 'WEEKDAY' && !f.weekend)
  || (id === 'US' && f.session === 'US')
  || (id === 'ASIA' && f.session === 'ASIA')
  || (id === 'WEEKEND_HIGH200' && f.weekend && Math.max(f.loserVol, f.winnerVol) >= 2);

const minCross = syms.length >= 18 ? 18 : Math.max(8, syms.length - 1);
const crossByLook = new Map();
for (const look of [...new Set(frozen.lanes.map((x) => x.look))]) {
  const bars = look / 5;
  if (!Number.isInteger(bars)) throw new Error(`Frozen look ${look} is not a 5m multiple`);
  const snapshots = [];
  for (const t of times) {
    const x = [];
    for (const s of syms) {
      const r = data.get(s);
      const i = idx.get(s)?.get(t);
      if (i == null || i < Math.max(bars, 12)) continue;
      if (r[i - bars].time !== t - bars * 300) continue;
      if (![r[i].close, r[i - bars].close].every((v) => Number.isFinite(v) && v > 0)) continue;
      x.push({ s, r, i, score: ret(r, i, bars), vr: volRatio(r, i) });
    }
    if (x.length < minCross) continue;
    const m = med(x.map((z) => z.score));
    const disp = med(x.map((z) => Math.abs(z.score - m)));
    const entryAt = t + 300;
    const d = new Date(entryAt * 1000);
    x.sort((p, q) => p.score - q.score || p.s.localeCompare(q.s));
    snapshots.push({
      t,
      entryAt,
      x,
      disp,
      session: session(d.getUTCHours()),
      weekend: [0, 6].includes(d.getUTCDay()),
    });
  }
  crossByLook.set(look, snapshots);
}

function laneEvents(lane) {
  const out = [];
  const busy = new Map();
  const holdBars = lane.hold / 5;
  if (!Number.isInteger(holdBars)) throw new Error(`Frozen hold ${lane.hold} is not a 5m multiple`);
  for (const z of crossByLook.get(lane.look) ?? []) {
    if (z.disp < lane.disp) continue;
    const q = lane.rank - 1;
    const loser = z.x[q];
    const winner = z.x[z.x.length - 1 - q];
    if (!loser || !winner || loser.s === winner.s) continue;
    const f = {
      loserVol: loser.vr,
      winnerVol: winner.vr,
      session: z.session,
      weekend: z.weekend,
    };
    if (!conditionOk(lane.condition, f)) continue;
    const pair = [loser.s, winner.s].sort().join('|');
    if ((busy.get(pair) ?? 0) > z.entryAt) continue;

    const li = loser.i + 1;
    const si = winner.i + 1;
    const lx = li + holdBars;
    const sx = si + holdBars;
    const exitAt = z.entryAt + lane.hold * 60;
    if (!loser.r[li]?.open || !winner.r[si]?.open || !loser.r[lx]?.open || !winner.r[sx]?.open) continue;
    if (loser.r[li].time !== z.entryAt || winner.r[si].time !== z.entryAt) continue;
    if (loser.r[lx].time !== exitAt || winner.r[sx].time !== exitAt) continue;

    const longEntry = loser.r[li].open * (1 + SLIP);
    const shortEntry = winner.r[si].open * (1 - SLIP);
    const adverseLongEntry = loser.r[li].open * (1 + ADV);
    const adverseShortEntry = winner.r[si].open * (1 - ADV);
    const longExit = loser.r[lx].open;
    const shortExit = winner.r[sx].open;
    const gross = ((longExit / longEntry - 1) + (1 - shortExit / shortEntry)) / 2;
    const grossAdv = ((longExit / adverseLongEntry - 1) + (1 - shortExit / adverseShortEntry)) / 2;
    const month = monthIndex(z.entryAt);
    if (month < 0) continue;
    out.push({
      lane: lane.id,
      rank: lane.rank,
      condition: lane.condition,
      pair,
      long: loser.s,
      short: winner.s,
      entryAt: z.entryAt,
      exitAt,
      holdMinutes: lane.hold,
      month,
      base: gross - BASE,
      stress: gross - STRESS,
      adverse: grossAdv - BASE,
    });
    busy.set(pair, exitAt);
  }
  return out;
}

const byLaneRows = frozen.lanes.map((lane) => ({ lane, events: laneEvents(lane) }));
const all = byLaneRows.flatMap((x) => x.events)
  .sort((a, b) => a.entryAt - b.entryAt || a.pair.localeCompare(b.pair) || a.lane.localeCompare(b.lane));
const seen = new Set();
const unique = [];
for (const e of all) {
  const key = `${e.entryAt}:${e.pair}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(e);
}

function calc(rows, field = 'base') {
  const gains = sum(rows.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(rows.filter((e) => e[field] <= 0).map((e) => e[field])));
  const net = sum(rows.map((e) => e[field]));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of [...rows].sort((a, b) => a.exitAt - b.exitAt || a.pair.localeCompare(b.pair))) {
    equity += e[field];
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades: rows.length,
    pairEventsPerDay: rows.length / DAYS,
    orderLegEntriesPerDay: 2 * rows.length / DAYS,
    net,
    net1000At1x: net * 1000,
    avgDaily1000At1x: net / DAYS * 1000,
    avgNet: rows.length ? net / rows.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: rows.length ? rows.filter((e) => e[field] > 0).length / rows.length : 0,
    maxDrawdown,
    maxDrawdown1000At1x: maxDrawdown * 1000,
  };
}
const stats = (rows) => ({ base: calc(rows), stress: calc(rows, 'stress'), adverse: calc(rows, 'adverse') });

const monthly = EXPECTED_MONTHS.map((month, i) => {
  const rows = unique.filter((e) => e.month === i);
  return { month, ...stats(rows) };
});
const byLane = byLaneRows.map(({ lane, events }) => ({ lane, ...stats(events) }));
const rankSummary = Object.fromEntries([1, 2, 3].map((rank) => {
  const rows = all.filter((e) => e.rank === rank);
  const rankSeen = new Set();
  const rankUnique = [];
  for (const e of rows) {
    const key = `${e.entryAt}:${e.pair}`;
    if (rankSeen.has(key)) continue;
    rankSeen.add(key);
    rankUnique.push(e);
  }
  return [rank, { lanes: frozen.lanes.filter((x) => x.rank === rank).length, ...stats(rankUnique) }];
}));

const portfolio = stats(unique);
const stressPositiveMonths = monthly.filter((x) => x.stress.net > 0).length;
const adversePositiveMonths = monthly.filter((x) => x.adverse.net > 0).length;
const backwardRobust = portfolio.stress.net > 0
  && portfolio.adverse.net > 0
  && portfolio.stress.pf >= 1.03
  && stressPositiveMonths >= 7;
const target12OrderLegs = backwardRobust && portfolio.stress.orderLegEntriesPerDay >= 12;

const report = {
  research: 'fbr-frozen-backward-oos-v1',
  period: { months: EXPECTED_MONTHS, from: FROM, to: TO, days: DAYS },
  protocol: {
    frozenBeforeBackwardTest: true,
    laneSelectionOnBackwardPeriod: false,
    laneCount: frozen.lanes.length,
    sourceCaveat: 'The 13 lanes were selected on the later 2025-09..2026-08 research period. This earlier 2024-09..2025-08 replay is the independent backward OOS test; the later source period is not treated as a holdout here.',
    entry: 'next 5m open after completed cross-sectional signal',
    pairTrade: 'long ranked loser and short ranked winner, equal-weight return',
    costs: { base: BASE, stress: STRESS, entrySlip: SLIP, adverseSlip: ADV },
  },
  universe: syms,
  minCross,
  frozenLanes: frozen.lanes,
  raw: stats(all),
  unique: portfolio,
  overlapRate: all.length ? 1 - unique.length / all.length : 0,
  stressPositiveMonths,
  adversePositiveMonths,
  backwardRobust,
  target12OrderLegs,
  monthly,
  byLane,
  rankSummary,
  note: backwardRobust
    ? 'The exact frozen 13-lane FBR portfolio survived the independent earlier 12-month backward OOS under stress and adverse-entry assumptions. No backward parameters were selected.'
    : 'The exact frozen 13-lane FBR portfolio failed the independent earlier 12-month backward OOS gate. Do not retune these frozen lanes on the backward period.',
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`FBR_FROZEN_BACKWARD_OOS=${JSON.stringify({
  research: report.research,
  universe: report.universe,
  minCross: report.minCross,
  laneCount: report.frozenLanes.length,
  raw: report.raw,
  unique: report.unique,
  overlapRate: report.overlapRate,
  stressPositiveMonths,
  adversePositiveMonths,
  backwardRobust,
  target12OrderLegs,
  monthly: report.monthly,
  rankSummary: report.rankSummary,
  note: report.note,
})}`);
