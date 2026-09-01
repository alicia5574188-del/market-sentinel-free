# Project agent instructions

Before starting work, read `.codex/goal-to-done/GOAL.md`, `STATUS.md`, and `DECISIONS.md` when present.
Before any UI, navigation, PWA, account, notification, order, live-control, or product-surface refactor, also read `docs/RESONANCE_MUST_KEEP_FEATURES.md` and preserve every applicable Must-Keep capability.
Before restoring any historical feature, compare it with current `main` and classify it as **keep-current**, **supplement/adapt**, **reimplement**, or **retire**. Must-Keep protects capabilities and safety outcomes, not old components, old page locations, or duplicate buttons.

- Work toward the stated outcome end to end and verify the result.
- Preserve unrelated user changes.
- Update `STATUS.md` after verified milestones and before stopping.
- Ask the user only for authentication, required permissions, irreversible actions, or a materially ambiguous choice.
- Never store credentials or secrets in project documentation.
- Do not treat a redesign as complete if Must-Keep regression tests fail or if required capabilities become unreachable.
- Do not restore UI features by adding unnecessary polling or by making the foreground page a Gate market-data producer again.
- Do not duplicate destructive controls merely to mimic an older UI; prefer one clear execution point plus navigation to it.
- Do not create a second authority, data source, risk path, or live-control implementation when the current architecture already owns that responsibility.
