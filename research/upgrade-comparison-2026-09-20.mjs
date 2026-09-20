// Same-input old/new engineering comparison. No network, real orders or PnL backtest.
// Run: node --experimental-strip-types research/upgrade-comparison-2026-09-20.mjs [snapshot-directory]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const BASELINE = '401768ccd5ea75da6bf55b2855433aba2df5d1a5';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = resolve(process.argv[2] ?? join(ROOT, '../audit-input/量化项目'));
const baselineRoot = mkdtempSync(join(tmpdir(), 'quant-baseline-401768c-'));
execFileSync('tar', ['-x', '-C', baselineRoot], {
  input: execFileSync('git', ['archive', BASELINE, 'lib'], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 }),
});
const modules = async root => {
  const get = name => import(pathToFileURL(join(root, 'lib', `${name}.ts`)).href);
  return Object.assign({}, ...await Promise.all([
    'forward-relations', 'forward-market-state', 'forward-protection', 'live-parity', 'runtime-health', 'forward-evidence',
  ].map(get)));
};
const [old, next] = await Promise.all([modules(baselineRoot), modules(ROOT)]);
Object.assign(next, await import(pathToFileURL(join(ROOT, 'lib/forward-protection-checkpoint.ts')).href));
const T = 1790100000000, BAR = 300000;
const checks = [];
const check = (id, kind, before, after, passed, limitation = null) => {
  checks.push({ id, kind, before, after, passed, ...(limitation ? { limitation } : {}) });
};
const same = (id, before, after) => check(id, 'unchanged_normal_path', before, after, isDeepStrictEqual(before, after));
function paths(now, step, n = 12, spacing = 300, count = 13) {
  return Object.fromEntries(Array.from({ length: n }, (_, k) => {
    let price = 100;
    return [`M${k}_USDT`, Array.from({ length: count }, (_, i) => {
      const open = price; if (i) price *= 1 + step(i);
      return { time: now / 1000 - 300 - (count - 1 - i) * spacing, open, close: price,
        high: Math.max(open, price), low: Math.min(open, price), volume: 100 };
    })];
  }));
}
function pos(api, id = 'p', symbol = 'BTC_USDT', risk = 4.44) {
  return { id, symbol, side: 'LONG', openedAt: T, closedAt: null, status: 'OPEN', entryPrice: 100, exitPrice: null,
    quantity: 2, contracts: 2000, quantoMultiplier: .001, notional: 200, leverage: 2, margin: 100,
    plannedRisk: risk, stopPrice: 98, armPrice: 101.5, favorable: 0, adverse: 0, lastPrice: 100, lastQuoteAt: T,
    entryFee: .14, exitFee: 0, fundingAllowance: 0, grossPnl: null, netPnl: null, exitReason: null,
    relationFailureBars: 0, lastRelationBar: T, execution: 'REAL_QUOTE_PAPER_MODEL', liveEligible: false,
    exitControl: api.newExitControl(), rule: { id: 'r', signature: 'r', parentId: null, version: 1, createdAt: T - 1000,
      expiresAt: T + 3600000, status: 'EXPERIMENTAL', conditions: [], side: 'LONG', horizon: 60, stopRate: .02,
      armRate: .015, givebackRate: .007, exitMode: 'REACTION_DECAY', samples: 20, trainGroups: 3, checkGroups: 2,
      estimatedNetRate: .01, priorResponse: .02, recentResponse: .02, standardError: .003, reason: 'Synthetic',
      mutation: 'CREATE', grammar: 'fixture', liveEligible: false } };
}
function account(api, positions = [pos(api)]) {
  const s = api.initialForward(T - 3600000); s.balance = 1000; s.positions = positions;
  s.lastCycleAt = T + 90000; s.lastFitAt = T + 90000;
  s.exitPolicyUpgrade = { policy: 'timely-protection-v1', at: T - 1, equity: 1000, balance: 1000, resolved: 0, inheritedPositionIds: [] };
  return s;
}
function step(api, state, dt, price, fresh = true) {
  return api.advanceForward({ state, now: T + dt, paths: {}, contracts: {}, quotes: Object.fromEntries(state.positions.map(t => [
    t.symbol, { bestBid: price, bestAsk: price + .01, observedAt: T + dt, fresh }])) });
}
function financial(state) {
  const fields = t => ({ id: t.id, symbol: t.symbol, side: t.side, openedAt: t.openedAt, closedAt: t.closedAt,
    entryPrice: t.entryPrice, exitPrice: t.exitPrice, quantity: t.quantity, contracts: t.contracts,
    plannedRisk: t.plannedRisk, stopPrice: t.stopPrice, armPrice: t.armPrice, notional: t.notional,
    leverage: t.leverage, margin: t.margin, entryFee: t.entryFee, exitFee: t.exitFee,
    fundingAllowance: t.fundingAllowance, netPnl: t.netPnl, exitReason: t.exitReason });
  return { balance: state.balance, fees: state.fees, resolved: state.resolved, turnover: state.turnover,
    positions: state.positions.map(fields), history: state.history.map(fields) };
}
function highWater(api) {
  const armed = step(api, account(api), 100000, 102), peak = step(api, armed.state, 110000, 104);
  let durable = structuredClone(armed.state), checkpointUsed = false;
  if (peak.changed) durable = structuredClone(peak.state);
  else if (peak.protectionChanged && api.buildForwardProtectionCheckpoint && api.restoreForwardProtectionCheckpoint) {
    durable = api.restoreForwardProtectionCheckpoint(durable, api.buildForwardProtectionCheckpoint(peak.state));
    checkpointUsed = true;
  }
  const continuous = step(api, peak.state, 120000, 103), restarted = step(api, durable, 120000, 103);
  return { peakChanged: peak.changed, protectionChanged: Boolean(peak.protectionChanged), checkpointUsed,
    continuousOpen: continuous.state.positions.length, restartedOpen: restarted.state.positions.length,
    financiallyIdentical: isDeepStrictEqual(financial(continuous.state), financial(restarted.state)) };
}
{
  const a = highWater(old), b = highWater(next);
  check('durable_profit_high_water', 'correctness', a, b, !a.financiallyIdentical && b.financiallyIdentical,
    'Pure checkpoint round-trip only; Worker transaction and resource behavior need separate integration tests.');
}
function reduction(api) {
  const ps = Array.from({ length: 6 }, (_, i) => { const p = pos(api, `p${i}`, `M${i}_USDT`, 10);
    p.rule.stopRate = .0478; p.stopPrice = 95.22; return p; });
  const s = account(api, ps);
  s.marketState = api.updateMarketState(paths(T - BAR, () => 0), null, T - BAR);
  s.marketState = api.updateMarketState(paths(T, () => 0), s.marketState, T);
  const turn = { version: 'market-turn-shield-v1', threatenedSide: 'LONG', detectedAt: T + 90000, completedBarAt: T,
    until: T + 900000, markets: 12, adverseShare: 1, strongAdverseShare: 1, medianAdverseMove: .01,
    medianAcceleration: 3, directionalRiskRate: .06, concentration: 1, reason: 'Synthetic' };
  return { stateOnlyOpen: step(api, s, 100000, 99.8).state.positions.length,
    overlappingOpen: step(api, { ...s, turnProtection: turn }, 100000, 99.8).state.positions.length };
}
{
  const a = reduction(old), b = reduction(next);
  check('no_duplicate_portfolio_reduction', 'correctness', a, b,
    a.overlappingOpen < a.stateOnlyOpen && b.overlappingOpen === b.stateOnlyOpen && b.stateOnlyOpen === 1,
    'Preserving an allowed position avoids an erroneous close; it does not guarantee that position will profit.');
}
function missing(api) {
  let state = api.updateMarketState(paths(T, () => .003), null, T);
  state = api.updateMarketState(paths(T + BAR, () => .003), state, T + BAR);
  const f = api.updateTurnForecast(paths(T, i => i >= 10 ? -.002 : .003), null, T);
  const g = api.updateTurnForecast(paths(T + BAR, i => i >= 10 ? -.002 : .003, 7), f, T + BAR);
  return { beforePhase: f.phase, afterPhase: g.phase, fresh: g.fresh,
    retainedGuard: Boolean(api.turnForecastEntryGuard(g, 'LONG', 60, state)),
    previousLongCap: api.marketRiskBudget(state, 1000, 1000, f).longRate,
    nextLongCap: api.marketRiskBudget(state, 1000, 1000, g).longRate };
}
{
  const a = missing(old), b = missing(next);
  check('missing_data_does_not_prove_recovery', 'correctness', a, b,
    !a.retainedGuard && b.retainedGuard && b.nextLongCap <= b.previousLongCap);
}
function chronological(api, withRecovery) {
  let price = 100;
  const tape = Array.from({ length: withRecovery ? 58 : 32 }, (_, i) => {
    const open = price; price *= 1 + (i < 16 ? .003 : i < 32 ? -.004 : .004);
    return { time: T / 1000 + (i - 13) * 300, open, close: price, high: Math.max(open, price), low: Math.min(open, price), volume: 100 };
  });
  let forecast = null, state = null; const out = [];
  for (let i = 12; i < tape.length; i++) {
    const now = (tape[i].time + 300) * 1000;
    const p = Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`M${k}_USDT`, tape.slice(0, i + 1)]));
    forecast = api.updateTurnForecast(p, forecast, now); state = api.updateMarketState(p, state, now);
    out.push({ bar: i, phase: forecast.phase, state: state.mode, median15: forecast.median15,
      longBlocked: Boolean(api.turnForecastEntryGuard(forecast, 'LONG', 60, state)) });
  }
  return out;
}
{
  const a = chronological(old, true), b = chronological(next, true);
  const summarize = rows => ({ unblockedDuringContinuedDecline: rows.filter(r => r.bar >= 18 && r.bar < 32 && r.median15 < -.005 && !r.longBlocked).length,
    allowsRecoveredLong: rows.some(r => r.bar >= 40 && r.state === 'TREND_LONG' && !r.longBlocked) });
  const x = summarize(a), y = summarize(b);
  check('decline_and_real_recovery_handoff', 'correctness', x, y,
    x.unblockedDuringContinuedDecline > 0 && y.unblockedDuringContinuedDecline === 0 && y.allowsRecoveredLong);
}
{
  const p = paths(T, i => i >= 10 ? -.002 : .003, 12, 600);
  const a = old.updateTurnForecast(p, null, T), b = next.updateTurnForecast(p, null, T);
  check('gapped_120_minutes_not_a_60_minute_path', 'correctness', { fresh: a.fresh, phase: a.phase },
    { fresh: b.fresh, phase: b.phase }, a.fresh && !b.fresh);
}
function mirror(api, overloaded) {
  try {
    const r = api.buildProportionalMirror({ source: pos(api, 'ft-synthetic'), sourceEquity: 1000, equity: 1000,
      available: 500, entryPrice: 100, quantoMultiplier: .001, leverageMax: 20, maintenanceRate: .005,
      openRisk: overloaded ? 99 : 0, sameDirectionRisk: overloaded ? 64 : 0, openMargin: overloaded ? 300 : 0,
      openNotional: overloaded ? 3000 : 0, now: T + 100000, policy: 'participation-execution-v1.2',
      sizeRules: { enableDecimal: false, orderSizeMin: '1', orderSizeMax: '100000' }, mirrorRatio: 1, sourceRiskAuthority: true });
    return { allowed: true, intent: r.intent };
  } catch (e) { return { allowed: false, reason: String(e.message) }; }
}
{
  const a = mirror(old, true), b = mirror(next, true);
  check('live_aggregate_risk_enforced', 'correctness', { allowed: a.allowed }, b, a.allowed && !b.allowed);
  same('within_budget_live_mirror', mirror(old, false), mirror(next, false));
}
{
  const broken = { state: 'LIVE', stale: false, authorityReady: true, realtimeReadiness: { protectedMarketsReady: true },
    forward: { storage: { error: 'Synthetic storage failure' }, lastCycleAt: 0 } };
  check('forward_failure_not_reported_ready', 'correctness', old.runtimeReady(broken), next.runtimeReady(broken),
    old.runtimeReady(broken) && !next.runtimeReady(broken));
}
// Unaffected opportunity paths: same candidates, fills, fee accounting and outcomes.
function opening(api, side, symbolCount) {
  const now = T + 10 * BAR, names = Array.from({ length: symbolCount }, (_, k) => `M${k}_USDT`);
  const s = api.initialForward(T); s.lastFitAt = now;
  const rule = { ...pos(api).rule, id: 'fr-normal', signature: 'normal', side, createdAt: now - 1000, expiresAt: now + 3600000,
    conditions: [{ feature: 0, op: 'GE', threshold: -99 }], samples: 50, trainGroups: 6, checkGroups: 4, estimatedNetRate: .01 };
  rule.evidence = { policy: api.EVIDENCE_POLICY, scope: 'CROSS_ASSET', symbols: names, sourceKey: 'fixture', family: api.familyKey(rule),
    cap: .03, rawNet: .01, costRate: .0022, quality: 1, worstWithoutSymbol: .02,
    calibration: { groups: 0, effectiveGroups: 0, penalty: 0, meanResidual: 0, meanNet: 0, latestAt: 0, sourceKey: 'fixture' } };
  s.rules = [rule];
  const input = { state: s, now, paths: paths(now, () => 0, symbolCount, 300, 25),
    quotes: Object.fromEntries(names.map(n => [n, { bestBid: 100, bestAsk: 100.01, observedAt: now, fresh: true }])),
    contracts: Object.fromEntries(names.map(n => [n, { quantoMultiplier: .001, leverageMax: 20, maintenanceRate: .005 }])) };
  return api.advanceForward(input).state;
}
for (const side of ['LONG', 'SHORT']) for (const count of [1, 8]) {
  const a = financial(opening(old, side, count)), b = financial(opening(next, side, count));
  check(`normal_${side}_${count}_opportunities`, 'unchanged_normal_path', a, b,
    a.positions.length > 0 && isDeepStrictEqual(a, b));
}
for (const prices of [[100, 100.2, 100.5], [102, 103, 104], [100, 97, 96]]) {
  const run = api => { let s = account(api); for (const [i, p] of prices.entries()) s = step(api, s, 100000 + i * 10000, p).state;
    return financial(s); };
  same(`normal_price_path_${prices.join('_')}`, run(old), run(next));
}
same('stale_quote_cannot_close', financial(step(old, account(old), 100000, 90, false).state),
  financial(step(next, account(next), 100000, 90, false).state));
for (const direction of [-1, 1]) {
  const classify = api => {
    let state = null, f = null;
    for (let i = 0; i < 5; i++) { const now = T + i * BAR, p = paths(now, () => direction * .003);
      state = api.updateMarketState(p, state, now); f = api.updateTurnForecast(p, f, now); }
    return { mode: state.mode, phase: f.phase, long: Boolean(api.turnForecastEntryGuard(f, 'LONG', 60, state)),
      short: Boolean(api.turnForecastEntryGuard(f, 'SHORT', 60, state)), budget: api.marketRiskBudget(state, 1000, 1000, f) };
  };
  same(`normal_monotone_${direction}`, classify(old), classify(next));
}
// Real snapshot labels may compare the generator, but cannot reproduce execution paths.
const snapshots = readdirSync(INPUT).filter(f => f.endsWith('.json') && f.startsWith('forward-research-snapshot-2026-09-'));
const dataAudit = [], closed = new Set(); let greatestResolved = 0;
for (const file of snapshots.sort()) {
  const raw = readFileSync(join(INPUT, file)), j = JSON.parse(raw), f = j.forward;
  for (const t of f.history ?? []) closed.add(t.id); greatestResolved = Math.max(greatestResolved, f.resolved ?? 0);
  const generate = api => {
    const s = api.initialForward(f.startedAt); s.samples = structuredClone(j.measurements);
    s.history = structuredClone(f.history); api.synthesizeRules(s, j.exportedAt);
    return s.rules.map(r => ({ id: r.id, signature: r.signature, side: r.side, horizon: r.horizon, conditions: r.conditions,
      stopRate: r.stopRate, armRate: r.armRate, givebackRate: r.givebackRate, estimatedNetRate: r.estimatedNetRate }));
  };
  const a = generate(old), b = generate(next);
  check(`unchanged_generator_${file}`, 'unchanged_normal_path', { count: a.length, digest: createHash('sha256').update(JSON.stringify(a)).digest('hex') },
    { count: b.length, digest: createHash('sha256').update(JSON.stringify(b)).digest('hex') }, isDeepStrictEqual(a, b),
    'Same retained labels and partial feedback only. Not reconstruction of historical candidate availability or profit.');
  dataAudit.push({ file, sha256: createHash('sha256').update(raw).digest('hex'), exportedAt: j.exportedAt,
    measurementCount: j.measurements.length, retainedClosed: f.history.length,
    hasContinuousOHLCOrQuoteTape: Boolean(j.paths || j.candles || j.quotes || j.tape),
    measurementFields: Object.keys(j.measurements[0] ?? {}).sort() });
}
const correctness = checks.filter(c => c.kind === 'correctness'), normal = checks.filter(c => c.kind === 'unchanged_normal_path');
const candidateSourceHashes = Object.fromEntries([
  'lib/forward-relations.ts', 'lib/forward-market-state.ts', 'lib/forward-protection-checkpoint.ts',
  'lib/forward-protection.ts', 'lib/forward-evidence.ts', 'lib/forward-turn-protection.ts',
  'lib/live-parity.ts', 'lib/runtime-health.ts', 'lib/forward-store.ts', 'lib/forward-write-budget.ts',
  'lib/storage-codec.ts', 'lib/live-turnover.ts', 'worker/index-clean.ts', 'worker/member-executor.ts',
].map(file => [file, createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex')]));
console.log(JSON.stringify({ schema: 'quant-upgrade-engineering-comparison-v1', baselineCommit: BASELINE,
  candidateCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  candidateWorktreeMayContainUncommittedChanges: true,
  candidateSourceHashes,
  evidenceScope: 'Synthetic causal same-input correctness fixtures plus deterministic generation from retained real labels; no historical account PnL replay.',
  correctnessImproved: correctness.every(c => c.passed), normalPathsPreserved: normal.every(c => c.passed),
  checksPassed: checks.filter(c => c.passed).length, checksTotal: checks.length,
  profitabilityImprovementVerified: false, drawdownImprovementVerified: false,
  fullAccountReplayAvailable: false, resourceSafetyVerified: false, releaseEligible: false,
  resourceSafetyScope: 'No full-account 24-hour writes/requests/duration capacity certification. The earlier shared-budget peak-starves-exit counterexample has a separate durable protection lane and Worker regression tests; false does not assert that old counterexample remains unfixed.',
  releaseEligibilityScope: 'This comparison script alone does not approve deployment. The main task evaluates the finite correctness/resource/no-normal-path-regression gate in research/AUDITED_REPAIR_RELEASE_GATE.md together with Worker and exact-head release checks. This is not an overall release HOLD or a new requirement to certify unbounded whole-account capacity.',
  releaseEligibilityUnderStrictProfitImprovement: false,
  deploymentConclusion: 'The user asked for a demonstrably better version, not an explicit guarantee of higher net profit. This script provides same-input correctness and normal-path evidence; separate resource and Worker validation feed the main task\'s finite release gate. If strictly higher net profit or lower drawdown is required, current evidence is insufficient. This script does not independently authorize deployment.',
  dataAudit, uniqueRetainedClosedOrders: closed.size, greatestResolved, missingClosedOrderDetails: greatestResolved - closed.size,
  missingEvidence: ['Continuous ordered executable quote and completed-candle inputs covering both versions',
    'Complete version-bound source decision / order / fee / fill archives',
    'Frozen same-input old/new account comparison across temporal market segments'], checks }, null, 2));
process.exitCode = checks.every(c => c.passed) ? 0 : 1;
