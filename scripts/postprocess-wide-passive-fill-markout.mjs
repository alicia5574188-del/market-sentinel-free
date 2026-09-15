import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const INPUT = process.env.RESEARCH_RAW_OUTPUT ?? '/tmp/wide-passive-fill-markout-raw.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/wide-passive-fill-markout.json';
const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
const OFFSETS = raw.protocol.offsetsBps;
const H15 = '15000';
const MIN_FILLS = 20;

// These are exactly the same 12 archive hours audited independently in #252.
// #252 established 11 clean hours and quarantined only evaluation SOL_USDT 2026071512.
const CLEAN = new Set([
  'era1|BTC_USDT|2023101512','era1|SOL_USDT|2023101512','era1|SUI_USDT|2023101512',
  'era2|BTC_USDT|2024101512','era2|SOL_USDT|2024101512','era2|SUI_USDT|2024101512',
  'era3|BTC_USDT|2025101512','era3|SOL_USDT|2025101512','era3|SUI_USDT|2025101512',
  'evaluation|BTC_USDT|2026071512','evaluation|SUI_USDT|2026071512',
]);
const key = (r) => `${r.era}|${r.symbol}|${r.ymdh}`;
const records = raw.records.map((r) => ({ ...r, qualityPass: CLEAN.has(key(r)), qualitySource: CLEAN.has(key(r)) ? 'independent-252-hour-audit' : 'quarantined-by-252' }));

function weighted(rows, offset, horizon, field) {
  let n = 0, sum = 0;
  for (const r of rows) {
    const m = r.stats?.[offset]?.markout?.[horizon];
    if (m?.n > 0 && Number.isFinite(m[field])) { n += m.n; sum += m[field] * m.n; }
  }
  return { n, mean: n ? sum / n : null };
}
function aggregateEra(era, offset) {
  const rows = records.filter((r) => r.era === era && r.qualityPass && r.stats?.[offset]);
  let placements = 0, fills = 0, paired = 0, single = 0, pairN = 0, pairSum = 0;
  for (const r of rows) {
    const s = r.stats[offset];
    placements += s.placements;
    fills += s.firstFills;
    paired += s.pairedFills;
    single += s.singleFills;
    if (s.pairedFills > 0 && Number.isFinite(s.pairCaptureStressMean)) { pairN += s.pairedFills; pairSum += s.pairCaptureStressMean * s.pairedFills; }
  }
  const markout = {};
  for (const h of ['5000','15000','30000']) {
    const gross = weighted(rows, offset, h, 'grossMean');
    const maker = weighted(rows, offset, h, 'makerNetMean');
    const hybrid = weighted(rows, offset, h, 'hybridStressMean');
    const adverse = weighted(rows, offset, h, 'hybridAdverseMean');
    markout[h] = { n: gross.n, grossMean: gross.mean, makerNetMean: maker.mean, hybridStressMean: hybrid.mean, hybridAdverseMean: adverse.mean };
  }
  return {
    era, offsetBps: Number(offset), validHours: rows.length, placements, firstFills: fills,
    fillRate: placements ? fills / placements : 0,
    fillsPerSampleHour: rows.length ? fills / rows.length : 0,
    pairedFills: paired, pairedShare: fills ? paired / fills : 0, singleFills: single,
    pairCaptureStressMean: pairN ? pairSum / pairN : null,
    markout,
  };
}

const ERA_NAMES = ['era1','era2','era3','evaluation'];
const eraAggregates = Object.fromEntries(ERA_NAMES.map((era) => [era, Object.fromEntries(OFFSETS.map((o) => [o, aggregateEra(era, o)]))]));
const preQualifiedOffsetsBps = OFFSETS.filter((offset) => ['era1','era2','era3'].every((era) => {
  const x = eraAggregates[era][offset];
  return x.firstFills >= MIN_FILLS && x.markout[H15].makerNetMean != null && x.markout[H15].makerNetMean >= 0;
}));
const evaluationOpened = preQualifiedOffsetsBps.length > 0;
const evaluation = evaluationOpened ? Object.fromEntries(preQualifiedOffsetsBps.map((o) => [o, eraAggregates.evaluation[o]])) : null;
const evaluationSurvivors = evaluationOpened ? preQualifiedOffsetsBps.filter((o) => eraAggregates.evaluation[o].firstFills >= MIN_FILLS && eraAggregates.evaluation[o].markout[H15].makerNetMean >= 0) : [];
const decision = !evaluationOpened
  ? 'WIDE_PASSIVE_REJECTED_PRE_ERAS'
  : evaluationSurvivors.length
    ? 'WIDE_PASSIVE_STRUCTURAL_EDGE_SURVIVES_SCREEN'
    : 'WIDE_PASSIVE_PRE_EDGE_FAILS_GATED_EVALUATION';

const core = {
  research: 'wide-passive-fill-markout-v1',
  decision,
  protocol: { ...raw.protocol, qualityGateCorrection: 'raw run mistakenly applied update-id continuity to set snapshot rows; final quality membership reuses independent #252 audit on the exact same 12 archive hours without changing strategy parameters' },
  validHours: records.filter((r) => r.qualityPass).length,
  invalidHours: records.filter((r) => !r.qualityPass).map((r) => ({ era:r.era,symbol:r.symbol,ymdh:r.ymdh,crossedRatio:r.crossedRatio,validBookSeconds:r.validBookSeconds })),
  preQualifiedOffsetsBps,
  evaluationOpened,
  evaluation,
  evaluationSurvivors,
  eraAggregates,
  diagnostics: records.map((r) => ({ era:r.era,symbol:r.symbol,ymdh:r.ymdh,qualityPass:r.qualityPass,stats:r.stats })),
  rawPayloadSha256: raw.sha256,
  interpretation: 'Structural fill/toxicity screen only. Fill model is intentionally conservative on displayed queue position but historical orderbook removals cannot fully distinguish executions from cancellations; any surviving edge would still require actual-trade confirmation before production research.',
};
const sha256 = createHash('sha256').update(JSON.stringify(core)).digest('hex');
writeFileSync(OUTPUT, `${JSON.stringify({ ...core, sha256, generatedAt:new Date().toISOString() }, null, 2)}\n`);
console.log(`WIDE_PASSIVE_FINAL=${JSON.stringify({decision,validHours:core.validHours,preQualifiedOffsetsBps,evaluationOpened,evaluationSurvivors,eraAggregates,sha256})}`);
