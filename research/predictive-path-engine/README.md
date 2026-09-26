# Multi-Source Predictive Path Engine — Research V1

Status: **offline research only**. This branch must not change PAPER/LIVE authority, account state, Gate execution, owner/member intent, storage, alarms or production deployment.

## Hard reset of strategy assumptions

This research does **not** inherit Extremum Regime, Forward Relation, Anchor/Region, Shock, fixed 5m/1m entry rules, old scores, old profit protection, or old strategy samples as trading evidence.

The only retained trading-data advantage is **multi-source market data**. Existing account/LIVE/Gate code is infrastructure, not strategy evidence.

## Objective

For each Gate USDT perpetual candidate at decision time `t`, predict the **future executable path on Gate** rather than a hand-labelled market regime.

Primary targets:

- directional outcome at 15 / 30 / 60 / 120 minutes;
- future return at each horizon for distribution/quantile models;
- LONG and SHORT MFE / MAE;
- target-before-risk first-touch probabilities;
- entry regret: how much better an entry became within the next 5 / 10 minutes;
- reversal-hazard labels;
- later, action value for ENTER NOW versus WAIT.

Multi-venue data is input evidence. Gate remains the target/execution venue for labels.

## Causality contract

Every feature value carries:

- `eventAt`: when the source event actually happened;
- `observedAt`: when this system could first have known it.

A feature is legal for a decision at `decisionAt` only when:

`eventAt <= observedAt <= decisionAt`.

No timestamp rewriting, no completed-candle backfill into an earlier decision, and no future-derived normalization.

Future labels may use only Gate bars whose **open time is at or after decisionAt**. This intentionally discards the remainder of a partially-open bar because its pre-decision high/low cannot be separated causally from its post-decision path.

If a single bar touches both target and risk boundaries, the first-touch label is `AMBIGUOUS`; the framework never invents intra-bar ordering.

## Information worlds

The model may eventually consume all useful inputs, but they remain separate feature families rather than independent votes:

1. **Price** — returns, slopes, acceleration, realized range, path efficiency, high/low geometry.
2. **Technical transforms** — EMA families, MACD, RSI, DMI/ADX, CCI, Williams %R, Stoch RSI, Bollinger, Keltner, Donchian, ATR, Supertrend, Ichimoku, VWAP/anchored VWAP, volume-profile transforms.
3. **Volume / flow** — volume, CVD, aggressive buy/sell flow, OFI, price impact per unit flow.
4. **Derivatives** — OI, OI velocity/acceleration, funding, basis, perp/spot dislocation.
5. **Liquidation** — observed liquidation flow, OI deleveraging, estimated liquidation-density/distance/cascade features. Estimated maps must remain labelled estimates.
6. **Multi-venue** — normalized returns, basis/OI/funding/flow disagreement and agreement across Gate/Bybit/OKX/KuCoin/Bitget/Binance where available.
7. **Market context** — BTC/ETH state, cross-sectional breadth/correlation, realized volatility, optional options IV/skew inputs.
8. **Microstructure** — aggregated 5s/15s/30s/1m OFI, microprice, depth imbalance, add/cancel/consume rates. This is an Entry expert input, not a high-frequency trading mandate.

## Dataset layers

### Historical backbone

Can be built immediately from causal historical data that actually exists:

- Gate futures price/volume path;
- other-venue price/volume;
- available historical OI/funding/basis;
- available liquidation evidence;
- market-context features.

### Live microstructure archive

Order-book features that lack reliable long history are collected forward-only with original timestamps. They start as shadow features and cannot obtain production authority merely because they are available.

## Model plan

The first production-capable research stack, if evidence supports it, is:

- **Tabular expert** — CatBoost/LightGBM-class model outside the Worker;
- **Temporal expert** — TCN first, larger sequence models only if incremental walk-forward value is proven;
- **Path expert** — return quantiles, MFE/MAE, first-touch and entry-regret;
- **Microstructure expert** — entry timing only;
- **Meta model** — consumes expert predictions, not dozens of raw indicator votes.

No model receives production trading authority until strict purged walk-forward evaluation shows incremental cost-after performance.

## Split policy

Random train/test split is forbidden.

Research uses purged walk-forward windows with an embargo at least as long as the longest label horizon. Samples whose future label window overlaps the next partition are purged.

## Stage 1 acceptance

This stage is complete only when:

- label definitions are deterministic and tested;
- first-touch same-bar ambiguity is fail-closed;
- feature timestamp leakage is rejected;
- LONG/SHORT MFE/MAE and entry-regret labels are symmetric;
- purged walk-forward creates no label overlap;
- the research modules import no existing strategy engine;
- no production/PAPER/LIVE file is modified.

No profitability claim is made at this stage.
