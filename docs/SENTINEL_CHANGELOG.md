# Sentinel Production Change Ledger

This is the durable production-history ledger for Market Sentinel. It exists so future development does not depend on chat history, memory, or screenshots.

Rules:

- Record **material production changes only**: strategy behavior, Regime logic, learning, risk, execution, order lifecycle, data architecture, stability, migrations, deployment/safety boundaries, or major observability that affects how the system is understood.
- Include what changed, what deliberately did **not** change, verification, and the production commit/version when known.
- Never rewrite old entries to make the history look cleaner. Append corrections as new entries.
- `docs/CURRENT_SYSTEM_STATE.md` describes the current truth; this file explains how that truth evolved.

---

## 2026-08-28 — Learning Arena added as read-only observability

Production merge commit: `6c3fe62c0fe9e4507c8d734212f6cd74c0e6fc23`  
Cloudflare Version ID: `76cc7a12-3881-4ac9-9e44-2b9e7c9f40af`

### Changed

- Added Strategy 2.0 Learning Arena.
- Added rolling all/20/50/100 result views, forward-vs-pre-forward evidence, rolling expectancy/profit-factor trend, exit-pattern diagnostics, Playbook diagnostics, and Regime × Playbook × side heatmap.
- Added a cached research-only API for the Arena.

### Deliberately unchanged

- No new trading authority.
- No risk increase.
- No strategy auto-promotion.
- No Execution Engine or Order Lifecycle authority transfer.

### Verification

- Strategy/risk suite passed.
- Production build/UI safety suite passed.
- Cloudflare production deployment succeeded.

---

## 2026-08-28 — Persistent-loss containment and data-degradation reduction

Production merge commit: `a1c7ef5baf59c4f612f5f4c35e3df9ab6cd976bf`  
Cloudflare Version ID: `9efe620a-c09e-4d56-98a7-334f64350447`

### Problem

- Strategy 2.0 had accumulated a materially weak completed sample and continued to generate losing simulated trades.
- `/api/market` and `/api/v2` could degrade together under Worker/Gate/D1 pressure.
- Client-side retries alone could not control server-side fan-out or repeated heavy learning reads.

### Changed

- Added a cached Strategy 2.0 execution governor using completed `contract_v2` results and recent performance.
- Added `DEFENSIVE` behavior when aggregate/recent performance is weak.
- Exploration intents are observation-only at the order-creation boundary.
- Partial-risk intents are fail-closed until V2 fractional risk multipliers are consumed end-to-end by contract sizing.
- Defensive execution only permits already-validated high-conviction cells with sufficient sample support and positive learned expectancy.
- Bounded deep-scan target concurrency to 2.
- Added partial-source isolation to `/api/v2` and cached/bounded heavy interactive learning/counterfactual reads.
- Added a short last-known-good fallback for `/api/market`, explicitly marked degraded/stale.

### Deliberately unchanged

- Existing positions continue normal lifecycle.
- No forced close was introduced.
- No leverage increase.
- No Gate mutation-path changes.
- No hard-risk relaxation.

### Verification

- Strategy/risk/migration tests passed.
- Production build/UI tests passed.
- Merged `main` CI passed.
- Cloudflare production deployment succeeded.

---

## 2026-08-28 — PWA/Worker black-screen recovery hardening

### Problem

- A previous 1102 recovery path could reuse dynamic root HTML across deployments and leave iOS with an old HTML/new asset mismatch, producing a black screen.
- Startup data modules could still create a burst of requests before the client stability layer fully controlled them.

### Changed

- Dynamic root HTML stopped being used as an unsafe stale fallback.
- Recovery now uses a dedicated reconnect shell instead of old application HTML.
- API startup concurrency/backoff was reduced and coordinated.
- Real-time API data remains network-authoritative; stale data is never silently presented as live truth.

### Deliberately unchanged

- Strategy logic and risk authority were not changed.

---

## 2026-08-28 — Playbook usage diagnostics

### Changed

- Added read-only Playbook usage/coverage diagnostics so `11/12` learning coverage can be traced to the exact missing Playbook and its evaluation/TRADE/WATCH/REJECT/completed-sample funnel.

### Deliberately unchanged

- No Playbook threshold was loosened to force 12/12 coverage.
- No execution/risk behavior changed.

---

## 2026-08-28 — Regime candidate/stability correction

### Problem

- Candidate Regime could disappear behind a hard score threshold.
- Stability could saturate too high because classifier separation was being treated as market stability.

### Changed

- Preserved a full Regime probability view and explicit runner-up candidate.
- Candidate state no longer depends on the old hard display threshold.
- Stability incorporates transition pressure/persistence rather than only classifier separation.
- Candidate momentum / early migration pressure contributes before a formal Regime switch.

### Deliberately unchanged

- Formal Regime switching remains guarded; candidate evidence does not force premature state flips.

---

## 2026-08-27/28 — Strategy 2.0 intelligence convergence

### Changed

- Kept a single **Sentinel Strategy 2.0** product/strategy identity.
- Added current→candidate Regime migration observability.
- Added dynamic Playbook expert-weight diagnostics.
- Added shadow win-probability / Net EV / decision-confidence / model-disagreement / OOD diagnostics.
- Added persistent WATCH/REJECT counterfactual archive statistics.
- Added portfolio Regime×direction concentration proxy.
- Unified Opportunity/Radar/Orders presentation around market intelligence, decisions, portfolio risk, thesis, execution and learning.

### Deliberately unchanged

- Intelligence is shadow/explanatory only.
- `liveDecisionAuthority=false`.
- Intelligence cannot increase risk, override hard safety, or auto-promote.
- Existing Strategy 2.0, portfolio risk, Execution Engine, Order Lifecycle, Live Master Switch and Gate safety chain remain authoritative.

---

## Historical migration policy

Sentinel V2/Strategy 2.0 learning must not reuse obsolete legacy transaction/learning samples as if they were current-strategy evidence. Necessary system configuration may be retained, but old-version learning memory is not a valid basis for current strategy adaptation.
