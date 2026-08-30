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
