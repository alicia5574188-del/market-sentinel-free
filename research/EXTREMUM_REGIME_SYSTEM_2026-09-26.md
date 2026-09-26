# Extremum Regime System — 2026-09-26

## Scope and invariants

This is a strategy-core replacement plus Execution-tab redesign only. It must not remove or narrow any existing product capability: owner/member auth, account reset, PAPER history/export/equity, 30-market scanning, bounded 1m confirmation, realtime BBO, multi-source public market resilience, persistent storage, LIVE settings, Gate credentials, LIVE settlement/turnover, or owner-controlled LIVE intent.

The existing LIVE mirror contract remains authoritative and unchanged: current PAPER is the only source; every new source trade must retain one immutable source ID, side, entry, stop, leverage, sizing/risk fields and lifecycle so the existing serialized PAPER->LIVE reconciler can copy it. No strategy release may enable LIVE, rewrite owner intent, catch up pre-enable trades, or perform a real-money verification order.

The old Forward Path Relation / Region / Structural Interrupt stack loses new-entry authority after cutover. Existing pre-cutover positions keep their frozen source fields and drain through compatibility lifecycle; account totals, history and bound LIVE identities remain intact.

## One closed-loop strategy

### 1. Universe selection

Keep the external scan at 30 Gate USDT perpetuals. Rank the pool by tradability, not volume alone:

- 40% executable liquidity: Gate 24h USD turnover and spread/execution readiness.
- 35% usable movement: recent 5m realized range times path efficiency, rewarding movement that is large enough to pay costs but not pure one-tick noise.
- 25% data quality: independent public-source coverage, consensus stability and freshness.

BTC/ETH/SOL remain continuity anchors. Symbols without a valid Gate contract never become executable. Multi-source weakness lowers confidence instead of stalling the whole engine.

### 2. Data roles

- 5m completed candles define structure and regime.
- 1m completed candles confirm local extremum/restart events for the bounded urgent lane.
- Realtime BBO supplies executable entry/exit price and post-entry feedback.
- Independent public sources provide consensus/source-count/disagreement. They are analysis evidence only; Gate remains actual execution/account truth.
- Missing non-Gate public sources never replace Gate fills and never invent prices.

### 3. Continuous state per symbol

Each symbol owns four continuously updated scores:

- TOP_PRESSURE 0..100
- BOTTOM_PRESSURE 0..100
- UP_SURVIVAL 0..100
- DOWN_SURVIVAL 0..100

TOP/BOTTOM answer “is price forming a tradable local extremum?” Trend survival answers “is the prior directional process still alive?”. Extremum location and trend direction are deliberately separate.

Extremum pressure uses:
1. normalized extension from recent balance/extreme;
2. diminishing effort/result: more range/volume with less net displacement;
3. failed extension / rejection wick / close retention;
4. 1m local structure break;
5. cross-source divergence or widening disagreement;
6. failed reclaim/retest confirmation.

Trend survival uses:
1. 5m path efficiency;
2. higher-high/higher-low or lower-high/lower-low structure;
3. pullback depth relative to recent impulse;
4. recovery speed after pullback;
5. follow-through after new high/low;
6. cross-source directional agreement.

### 4. Regime state machine with hysteresis

Per symbol:
- TREND_UP
- TREND_DOWN
- SWING
- WEAKENING
- TRANSITION

TREND_UP/TREND_DOWN require high survival and directional path efficiency. They remain active until survival falls through a materially lower exit threshold, avoiding rapid TREND/SWING oscillation.

WEAKENING means the trend still owns direction but new chase entries are reduced. TRANSITION means the old trend has materially failed; old-direction additions stop, but the engine does not automatically reverse.

A Momentum Override suppresses counter-trend entry when completed 5m expansion, path efficiency and source agreement remain extreme. A high TOP/BOTTOM score in this state protects profit; it does not authorize reversal.

### 5. Entry modes

There are only four executable entry modes:

1. SWING_BOTTOM_LONG
   - SWING regime
   - BOTTOM_PRESSURE high
   - 1m structure breaks upward
   - shallow retest/reclaim holds
   - fresh BBO confirms positive restart

2. SWING_TOP_SHORT
   - exact mirror of SWING_BOTTOM_LONG

3. TREND_PULLBACK_LONG / TREND_RALLY_SHORT
   - active trend survival high
   - controlled counter-move creates a local extremum
   - trend direction recovers before structure dies
   - entry occurs on restart, not at the first falling/rising candle

4. IMPULSE_CONTINUATION_LONG / SHORT
   - strong completed 5m expansion
   - high path efficiency and source agreement
   - no meaningful opposite structure break
   - 1m shallow pause/restart or second continuation event
   - used so vertical trends are attacked rather than ignored

No other legacy family or relation rule may open a new trade.

### 6. Immediate post-entry validation

Every new entry starts an event-based validation window. A good extremum/restart entry should gain favorable distance quickly.

The trade is downgraded or closed early when:
- no meaningful favorable progress appears;
- price repeatedly reclaims the entry area against the thesis;
- the confirming 1m structure breaks back;
- source disagreement expands against the position.

This avoids waiting for the full structural stop on trades that immediately prove they were not entered near a useful location.

### 7. Exit hierarchy

1. Native structural stop — hard safety boundary.
2. Immediate thesis failure — fast exit when post-entry validation fails.
3. Profit floor — once favorable movement clears modeled friction plus an R threshold, lock a dynamic fraction of peak profit.
4. Opposite extremum:
   - in SWING: confirmed opposite extremum exits and may later authorize reversal;
   - in TREND: opposite extremum first tightens/protects profit, not automatic reversal.
5. Trend death:
   - survival collapses;
   - local structure breaks;
   - reclaim attempt fails;
   - only then can the old trend transition toward the opposite direction.
6. No-progress/time decay — exit when expected movement fails to materialize.

Exit and reversal are separate events. Closing a LONG does not by itself manufacture a SHORT.

### 8. Risk and sizing

Keep the existing hard portfolio boundaries:
- total structural risk <= 10% of applicable equity;
- same-direction risk <= 6.5%;
- margin budget <= existing 75% boundary;
- real Gate sizing remains downward-quantized and never silently enlarged.

Sizing is driven by structural stop width and candidate quality inside those caps. There is no fixed position-seat count and no forced daily trade quota.

### 9. One source identity for PAPER and LIVE

Every new PAPER trade still emits the current Trade contract:
- stable trade ID
- symbol / side
- entry / stop / arm/protection reference
- contracts / quanto multiplier / notional / leverage / margin
- planned risk
- immutable entry context and reason
- lifecycle timestamps

The existing serialized LIVE loop consumes that exact persisted source. Strategy code never sends Gate orders directly.

### 10. Execution page

Keep all existing tabs and account functionality. Redesign only the Execution tab around the new state machine.

Top section:
- 30 scanned / executable count
- TREND_UP / TREND_DOWN / SWING / TRANSITION counts
- current risk use
- LIVE mirror health and copied/missing eligible count

Candidate cards:
- symbol / intended action
- regime
- TOP_PRESSURE / BOTTOM_PRESSURE
- UP_SURVIVAL / DOWN_SURVIVAL
- source count / disagreement
- current stage: WATCH -> CANDIDATE -> STRUCTURE_BREAK -> RECLAIM_TEST -> READY
- exact next condition

Open-position cards:
- entry mode and reason
- entry price / stop / leverage / notional / margin
- peak favorable / current PnL
- current trend survival / opposite-extremum pressure
- profit floor
- post-entry feedback state
- current exit trigger being watched

No relation-rule, family-experiment or structural-interrupt terminology remains on the Execution tab.

## Code plan

1. Keep worker orchestration, storage transport, auth, account, LIVE and Gate adapter code unchanged.
2. Replace new-entry authority inside lib/forward-relations.ts with one new pure lib/extremum-regime-engine.ts.
3. Preserve the exported ForwardState / Trade / freshQuote / advanceForward / forwardSummary / forwardEquity / reset / urgent-symbol adapter surface required by Worker, storage and LIVE.
4. Add a small optional raw-source consensus accessor only if needed by the strategy; do not alter existing MarketDataHub behavior.
5. Remove imports and runtime authority from forward-relation-v2, forward-family-experiment, forward-structural-interrupt and region-entry logic. Do not stack the new engine on top of them.
6. Keep a minimal compatibility lifecycle for already-open legacy trades; once no legacy source remains, new state persists only the new regime engine.
7. Redesign app/forward-dashboard.tsx Execution tab and strategy-specific copy; keep Overview/PAPER/LIVE/Journal/Settings capabilities intact.
8. Update tests to assert:
   - no legacy module can create a new entry;
   - trend-up never opens counter-trend SHORT without confirmed trend death;
   - trend-down mirror;
   - SWING can trade both sides;
   - impulse continuation stays active in one-way markets;
   - immediate-feedback failure exits;
   - profit protection does not auto-reverse;
   - new Trade objects satisfy existing live-parity validation;
   - fake-Gate PAPER->LIVE entry, stop, close lifecycle still passes unchanged serialized sync;
   - owner LIVE intent and credentials are untouched.
9. Run direct, live-parity, member, equity, feed/workerd, typecheck, lint, build, architecture/migration and dry-run gates.
10. Merge reviewed main only after all gates pass. Do not perform a real Gate trade or toggle LIVE during verification.
