# Extremum Regime Lab — 2026-09-26

## Scope

Research only. No production strategy, PAPER account, LIVE bridge, storage authority, risk geometry, or deployment path was changed.

The purpose was to test whether a causal system can enter/exit near actionable local peaks and troughs while avoiding the classic failure mode of repeatedly fading a one-way trend.

## Data

The isolated collector pulled completed futures candles for BTC, ETH, SOL, XRP, DOGE, ADA, LINK, and BCH.

- 5m window: 2026-09-25 00:50 UTC through 2026-09-26 01:40 UTC, 299 completed bars per symbol/source.
- 1m window: 2026-09-25 20:48 UTC through 2026-09-26 01:46 UTC, 299 completed bars per symbol/source.
- Sources successfully available in the GitHub Actions research environment: Gate, OKX, Bitget.
- Unavailable in this runner: Bybit HTTP 403, Binance HTTP 451, KuCoin HTTP 400.
- Therefore this study is a 3-source independent-venue test, not a claim that four/five simultaneous candle feeds were validated.

The modeled round-trip friction is 0.19%, matching Forward Path Relation 3.0's existing fee/slippage assumption.

## Method

1. Build median multi-venue OHLC paths while retaining Gate as the execution-price reference.
2. Create only causal peak/trough *candidates*: a recent rolling extreme must already have begun to reject before the candidate exists.
3. Label an `actionable` turn only when a future 30-minute move reaches an adaptive target before the prior extreme is invalidated. Future data is used for the label only, never as an input feature.
4. Train on the earliest 45% of time, choose the model/threshold on the next 20%, then freeze those choices and evaluate the final 35%.
5. Compare a price-structure model with a model that also receives cross-exchange confirmation features.
6. Add a trend guard selected on the validation segment only: a strong opposite existing trend changes a peak/trough from an immediate reverse-entry into an exit/protection event.
7. Separately test the 1m lane. It is not allowed to become a standalone trading authority.

## Results

### 1. Naive peak/trough reversal is not viable

The earlier handcrafted "confirm every local peak/trough and reverse" experiments remained negative after friction. This confirms that the new route cannot be a renamed version of the retired extreme/snapback logic.

The failure mode is exactly the concern raised by the owner: in a one-way trend, small local peaks/troughs are often continuation pauses, not reversals.

### 2. Actionable-turn classification is learnable, but only modestly

The 5m candidate set contained 552 causal turn candidates. Only 26.45% became actionable turns under the target-before-invalidation label, so blindly trading them is structurally bad.

A chronological holdout classifier using causal price/structure features reached test ROC-AUC 0.639. Adding venue-confirmation features produced ROC-AUC 0.643. AUC improvement is small; the useful improvement came from better high-confidence trade selection, not from a dramatic global classification gain.

### 3. Multi-source confirmation improved the frozen holdout trade subset

After selecting model type and threshold on validation and retraining only on the first 65%:

| Final 35% holdout | Price/structure only | + cross-exchange confirmation |
| --- | ---: | ---: |
| selected symbol-level trades | 17 | 12 |
| win rate | 64.7% | 75.0% |
| simple summed net return after 0.19% friction | +0.27% | +1.68% |
| profit factor | 1.08 | 2.27 |
| max sequential drawdown | 1.50% | 0.45% |

These are unlevered research-path returns, not account-return promises. Seven of the profitable long selections belonged to one broad-market event, so treating all 12 as independent would overstate the evidence.

With a simple top-2-per-timestamp concentration cap, the same frozen holdout became 6 trades, 66.7% wins, PF 1.66, +0.58% simple summed net, and 0.88% max sequential drawdown. Top-3-per-timestamp produced 7 trades, 71.4% wins, PF 2.21, and +1.07%.

### 4. The trend concern is real, and the data supports switching attack mode

Using a continuous 12-bar trend-strength definition, candidate directions were split into trend-aligned, countertrend, and swing/transition groups.

At the validation-selected stronger trend boundary (>=2.5 median-range units with path efficiency >=0.30):

- Trend-aligned pullback/restart candidates: 5 samples, 60.0% actionable.
- Countertrend peak/trough candidates: 121 samples, only 17.4% actionable.
- Swing/transition candidates: 426 samples, 28.6% actionable.

Across looser trend definitions the same qualitative pattern remained: countertrend candidates were consistently worse than trend-aligned candidates.

This supports the following state behavior:

- `SWING`: confirmed trough can open LONG; confirmed peak can open SHORT.
- `TREND_UP`: trough/restart is an attack point; a peak is normally EXIT/PROTECT only, not an automatic SHORT.
- `TREND_DOWN`: peak/restart is an attack point; a trough is normally EXIT/PROTECT only, not an automatic LONG.
- `TREND_DEATH`: only after the old trend loses structural and multi-venue support can the opposite extremum become a reverse-entry.

The validation-selected trend guard removed one final-holdout countertrend BCH short that would have lost about 0.44%. With that frozen guard, the symbol-level holdout subset was 11 trades, 81.8% wins, PF 3.40, +2.12% simple summed net, and 0.45% max sequential drawdown. The concentration caveat above still applies.

### 5. 1m should be a timing/confirmation lane, not the main brain

A standalone 1m classifier did not generalize on its middle validation segment after friction, so it should not replace the 5m structural authority.

However, as a micro-confirmation lane it showed the exact behavior we want:

- A losing LINK 5m short around 22:40 UTC had no qualifying multi-source 1m top confirmation before entry; the 1m lane would have rejected/delayed it.
- A SOL 5m short around 00:30 UTC entered roughly 8-9 minutes after the nearby 1m peak and lost about 0.45% net in the 5m prototype. Multi-source 1m confirmation appeared at 00:28; next-minute entry at 00:29 reached a 0.35% target and produced about +0.16% net after the same 0.19% friction assumption.
- A later LINK short also received an earlier 1m top confirmation and reached the same micro target.

These are spot checks, not enough evidence to give 1m independent order authority. They support using 1m to reduce confirmation delay after the 5m system has already identified a valid structural candidate.

## Decision

The route is **promising enough to continue as a shadow/research architecture**, but **not validated enough to replace production yet**.

The useful architecture is not "AI predicts every peak and trough." It is:

`5m structural extremum candidate -> regime/trend role -> multi-source confirmation -> 1m timing -> entry/exit role`

The same extremum must have different permissions depending on regime. In particular, one-way trends should remain active through trend-aligned pullback/restart attacks rather than going inactive, while opposite extrema default to profit protection until trend death is confirmed.

## Next implementation boundary

If promoted to a production candidate later, keep the current market-data, account, risk, storage, and LIVE layers unchanged. Replace only the strategy decision core with an isolated `ExtremumRegime` authority after a longer shadow sample proves:

1. chronological positive net after current friction,
2. stable behavior in explicit one-way trend windows,
3. no dependence on one broad correlated event,
4. 1m confirmation improves timing without becoming a second independent strategy,
5. multi-source divergence remains useful when four or more sources are actually available in the runtime environment.

PR #510 stays draft/research-only and must not be merged as a production strategy release from this experiment alone.
