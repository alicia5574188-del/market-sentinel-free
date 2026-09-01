# Project agent instructions

Before starting work, read `.codex/goal-to-done/GOAL.md`, `STATUS.md`, and `DECISIONS.md` when present.
Before any UI, navigation, PWA, account, notification, order, live-control, or product-surface refactor, also read `docs/RESONANCE_MUST_KEEP_FEATURES.md` and preserve every applicable Must-Keep capability.

- Work toward the stated outcome end to end and verify the result.
- Preserve unrelated user changes.
- Update `STATUS.md` after verified milestones and before stopping.
- Ask the user only for authentication, required permissions, irreversible actions, or a materially ambiguous choice.
- Never store credentials or secrets in project documentation.
- Do not treat a redesign as complete if Must-Keep regression tests fail or if required controls become unreachable.
- Do not restore UI features by adding unnecessary polling or by making the foreground page a Gate market-data producer again.
