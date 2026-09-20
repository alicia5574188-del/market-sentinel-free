// Read-only byte/key probe using exported real state fields. Missing fields are
// explicitly identified; synthetic padding measures storage, never profit.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialForward } from '../lib/forward-relations.ts';
import { prepareForwardWrite, prepareForwardProtectionWrite } from '../lib/forward-store.ts';
import { readForwardStore } from '../lib/forward-store.ts';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { PROTECTION_WRITE_CAP, PRIMARY_PLANNED_DO_ROWS, TWO_MEMBER_PLANNED_DO_ROWS, nextProtectionWriteBudget } from '../lib/forward-write-budget.ts';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = resolve(process.argv[2] ?? join(ROOT, '../audit-input/量化项目'));
const bytes = value => value instanceof Uint8Array ? value.byteLength : new TextEncoder().encode(JSON.stringify(value)).length;
const result = [];
for (const file of readdirSync(INPUT).filter(f => f.endsWith('.json') && f.startsWith('forward-research-snapshot-2026-09-')).sort()) {
  const j = JSON.parse(readFileSync(join(INPUT, file))), f = j.forward;
  const available = initialForward(f.startedAt);
  const compatible = key => key in f && typeof f[key] === typeof available[key]
    && Array.isArray(f[key]) === Array.isArray(available[key]);
  const missing = Object.keys(available).filter(k => !compatible(k) && k !== 'samples');
  for (const key of Object.keys(available)) if (compatible(key)) available[key] = structuredClone(f[key]);
  for (const key of ['policyUpgrade', 'policyUpgrades', 'exitPolicyUpgrade', 'participation', 'evidenceDiagnostics',
    'entryDiagnostics', 'marketState', 'turnProtection', 'turnForecast']) if (key in f) available[key] = structuredClone(f[key]);
  available.samples = structuredClone(j.measurements); available.storage = { persistedAt: j.exportedAt, error: null };
  available.peakEquity = Math.max(available.initialEquity, f.equity ?? 0);
  const variants = [{ label: 'available_export_fields_only_lower_bound', state: available }];
  const padded = structuredClone(available), baseHistory = structuredClone(available.history), baseEvents = structuredClone(available.events);
  while (padded.history.length < 256) { const i = padded.history.length; padded.history.push({ ...baseHistory[i % baseHistory.length], id: `synthetic-size-trade-${i}` }); }
  while (padded.events.length < 256) { const i = padded.events.length; padded.events.push({ ...baseEvents[i % baseEvents.length], id: `synthetic-size-event-${i}` }); }
  const markets = [...new Set(j.measurements.map(m => m.symbol))].slice(0, 30);
  for (const symbol of markets) {
    const m = j.measurements.find(row => row.symbol === symbol), frame = { symbol, at: f.lastCycleAt, seenAt: f.lastCycleAt, price: m.price, x: m.x };
    padded.frames[symbol] = frame; padded.lastBars[symbol] = f.lastCycleAt; padded.lastEntryBars[symbol] = f.lastCycleAt;
    for (const horizon of [15, 60, 180]) padded.pending[`${symbol}:${horizon}`] = { ...frame, horizon, dueAt: f.lastCycleAt + horizon * 60000 };
  }
  variants.push({ label: 'synthetic_hot_history256_events256_frames_pending_padding', state: padded });
  for (const { label, state } of variants) {
    const previous = structuredClone(state); previous.lastCycleAt -= 300000;
    const prepared = await prepareForwardWrite(previous, state, j.exportedAt);
    const compact = await prepareForwardWrite(previous, state, j.exportedAt, { compact: true });
    const memory = new Map(Object.entries(compact.entries));
    const restored = await readForwardStore({ async get(key) { return memory.get(key); } }, j.exportedAt);
    const roundTripEqual = isDeepStrictEqual(restored, state);
    if (!roundTripEqual) throw new Error(`Compact state round-trip mismatch: ${file}/${label}`);
    const entrySizes = Object.entries(prepared.entries).map(([key, value]) => ({ kind: key.includes('archive:') ? 'archive' : key.includes('chunk:') ? 'chunk' : 'head', bytes: bytes(value) }));
    const overlay = prepareForwardProtectionWrite(state);
    const smallHeadInlineFits120KiB = prepared.compression.storedBytes + 512 <= 120 * 1024;
    result.push({ file, label, unavailableExportStateFields: missing, historyRows: state.history.length, events: state.events.length,
      frames: Object.keys(state.frames).length, pending: Object.keys(state.pending).length,
      compression: prepared.compression, writes: prepared.writes, entrySizes,
      compact: { compression: compact.compression, writes: compact.writes, savedRows: prepared.writes - compact.writes,
        roundTripEqual, archiveKeysAndValuesUnchanged: isDeepStrictEqual(
          Object.entries(prepared.entries).filter(([k]) => k.includes('archive:')),
          Object.entries(compact.entries).filter(([k]) => k.includes('archive:'))) },
      protectionOverlayRows: overlay.writes, protectionOverlayBytes: bytes(Object.values(overlay.entries)[0]),
      protectionOverlayWithBudgetBytes: bytes({ ...Object.values(overlay.entries)[0],
        writeBudget: nextProtectionWriteBudget(null, j.exportedAt) }),
      hypotheticalLosslessInlineHead: { fits120KiB: smallHeadInlineFits120KiB,
        writes: smallHeadInlineFits120KiB ? prepared.writes - prepared.compression.chunks : prepared.writes,
        savedRowsPerFullCommit: smallHeadInlineFits120KiB ? prepared.compression.chunks : 0 },
      dailyAt288LearningCycles: { currentRows: prepared.writes * 288,
        compactRows: compact.writes * 288,
        inlineRows: (smallHeadInlineFits120KiB ? prepared.writes - prepared.compression.chunks : prepared.writes) * 288 } });
  }
}
const candidateSourceHashes = Object.fromEntries(['lib/forward-store.ts', 'lib/forward-write-budget.ts',
  'lib/forward-protection-checkpoint.ts', 'lib/storage-codec.ts', 'lib/live-turnover.ts', 'worker/index-clean.ts', 'worker/member-executor.ts']
  .map(file => [file, createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex')]));
console.log(JSON.stringify({ schema: 'resource-write-probe-v1', sourceScope: 'Three real exported summaries and measurements; missing state listed, padded stress is synthetic, not actual production full-state byte count.',
  candidateSourceHashes, declaredRowWorkloadModel: { primaryRowsPerDay: PRIMARY_PLANNED_DO_ROWS,
    primaryPlusTwoMembersRowsPerDay: TWO_MEMBER_PLANNED_DO_ROWS, independentProtectionCap: PROTECTION_WRITE_CAP,
    modelIsNotWholeAccount24HourCapacityCertification: true, requestsAndDurationVerifiedByThisProbe: false },
  implementationStatus: 'This probe does not edit production. Compares legacy prepareForwardWrite default with actual candidate {compact:true}; separate whole-state-inline arithmetic is a rejected alternative.', result }, null, 2));
