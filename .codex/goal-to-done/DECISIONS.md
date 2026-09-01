# Decisions

Record only consequential decisions using this format:

## YYYY-MM-DD — Decision

- Choice:
- Reason:
- Evidence:
- Revisit when:

## 2026-08-30 — Enlarge paper positions before rejecting signals

- Choice: Size HTE 3.1 paper orders around 4% equity risk, constrain actual planned loss to 3–5%, and target fee-adjusted TP2 net profit of 5–20%. Preserve READY-entry frequency by enlarging simulated notional and adjusting TP2 R before rejecting a setup.
- Reason: The previous 1%/3x/25%-margin combination produced sub-dollar gains; the user explicitly rejected solving this by filtering more entries from an already low-frequency system.
- Evidence: `lib/hte31-repository.ts` currently caps base risk near 10U, leverage at 3x, and margin at 25% equity. The user specified 30–50U acceptable loss and 50–200U profit for 1,000U paper capital.
- Revisit when: New paper samples show whether the adjusted setup remains positive after fees and time exits.

## 2026-08-30 — Cap adaptive paper leverage at 50x

- Choice: Permit HTE 3.1 simulated sizing to use up to 50x for tight-stop, liquid markets, subject to a liquidation-buffer check and full UI disclosure.
- Reason: Tight structural stops require larger notional to put 30–50U at risk; leverage should express stop-defined risk rather than conceal it.
- Evidence: Current HTE leverage is only 1–3x and is omitted from closed-order summaries.
- Revisit when: Paper slippage modeling or contract-specific Gate limits are added.

## 2026-08-30 — Keep live enabled per explicit authorization, isolate paper sizing

- Choice: Preserve the current Gate live-enabled intent; do not automatically apply the new paper leverage/risk formula to real orders in this change.
- Reason: The user explicitly authorized live to remain on and states the futures account is unfunded, while real sizing changes still require independent verification.
- Evidence: User instruction on 2026-08-30; project live controls are owner-controlled and fail-closed.
- Revisit when: The user funds the futures account or explicitly requests real sizing parity.

## 2026-08-30 — Expand analysis, not execution latency

- Choice: Keep 5m tactical execution for HT1-HT3, expose 15m/1h/4h separately, and add HT4 Exhaustion plus HT5 Higher-Timeframe Swing as independent paper traders.
- Reason: Recent trades often had short-term favorable excursion while the larger subsequent move ran the other way; averaging timeframes into one scalar hid that conflict.
- Evidence: Four new paper trades all showed initial profit; two reached TP1, while two later hit valid structural stops and continued adverse.
- Revisit when: Counterfactual and post-exit samples are large enough to compare original direction, direct opposite, and confirmed reversal paths by trader/regime.

## 2026-08-30 — Fix measurement before tuning setup thresholds

- Choice: Make paper 1R include round-trip fees, classify TP1-protected breakevens as scratches rather than failure losses, and prevent a newly moved TP1 stop from using pre-trigger intrabar history.
- Reason: Otherwise loss R is overstated, protected trades contaminate loss streaks, and impossible same-candle ordering can create false breakeven exits.
- Evidence: BTC planned -39.10U realized -48.64U and HYPE planned -39.87U realized -45.29U were explained by fees outside the old risk budget.
- Revisit when: Real exchange slippage modeling or finer event/tick data is introduced.

## 2026-09-01 — Preserve capabilities and repair stale UI smoke contracts

- Choice: Keep the PR #99 operator capabilities and update three stale smoke assertions to validate behavior: preserved reset history, absence of document/window touch traps, and one trading page tree plus the isolated operator drawer.
- Reason: The failed assertions encoded obsolete copy and DOM shape, and one over-broad rule treated the Emergency Stop button's local gesture suppression as a page-wide scroll trap.
- Evidence: GitHub Actions run `33460289588` failed only tests 35, 68, and 96; the production build, 189 strategy/risk tests, 100 UI safety tests, Wrangler dry-run, ESLint, and TypeScript all pass after the compatibility repair.
- Revisit when: The reset behavior, mobile navigation model, or root operator-control mounting architecture changes.

## 2026-09-01 — Restore the five-tab contract without deleting learning

- Choice: Use exactly `机会 / 雷达 / 订单 / 实盘 / 设置` in the fixed bottom navigation and place the former standalone Learning sections under `订单`.
- Reason: The original product contract requires those five discoverable destinations, while learning and per-trade review remain Must-Keep capabilities and should not be discarded merely to meet the navigation count.
- Evidence: The production page previously exposed `首页 / 市场 / 交易 / 学习 / 实盘` and hid Settings behind a header button; focused and full UI tests now enforce the restored fixed tab set while continuing to assert every learning surface.
- Revisit when: User research supports a different information architecture and the fixed five-tab contract is explicitly changed.

## 2026-09-01 — Adapt existing HTE31 plans into complete pre-trade cards

- Choice: Render full pre-trade evidence and risk detail from the existing dashboard `entryPlan`, `reasons`, and `blockers`, using native expandable cards and no new API or state producer.
- Reason: The backend already persisted the required trigger checks, levels, support, counter-evidence, and exit rules; the UI type and compact card were the only missing layer.
- Evidence: `getHte31Dashboard()` already returns parsed entry plans. The updated page displays direction, trigger/gates, entry zone, stop, TP1/TP2, evidence, missing conditions, and invalidation while the polling and exchange boundaries remain unchanged.
- Revisit when: The HTE31 entry-plan schema changes or operators require additional execution economics on pre-trade cards.

## 2026-09-01 — Keep the HTE31 observer independent of account persistence

- Choice: Authenticate the high-frequency `/api/hte31` read path with a trusted read-only viewer identity, while retaining durable `requireApiAccount()` checks for account-scoped and mutation APIs.
- Reason: The core dashboard does not need to read or update `user_accounts` on every 15-second refresh. Making that auxiliary persistence lookup a prerequisite allows a transient account-store failure to surface as a full dashboard 503 instead of local degradation.
- Evidence: The production iPhone reported `/api/hte31 请求失败 (503)` while its last successful snapshot remained visible; route audit showed `requireApiAccount()` ran before all scanner/dashboard `allSettled` and catch-based degradation handling. PR #100 CI run `33470798900` passed strategy/risk/migration, production build/UI safety, and Wrangler dry-run after removing that hard dependency only from the observer path.
- Revisit when: HTE31 snapshot responses need durable account identifiers or account-specific authorization beyond owner/member display role.
