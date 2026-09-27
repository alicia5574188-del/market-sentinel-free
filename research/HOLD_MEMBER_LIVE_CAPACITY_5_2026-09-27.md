# HOLD — Member LIVE Capacity Expansion (5 seats)

Status: **SEALED / DO NOT MERGE / DO NOT DEPLOY**
Date: 2026-09-27
Branch: `scale/member-live-capacity-5-20260927`
Draft PR: **#528**
Production remains on main; this branch is intentionally not merged.

## Why this exists

The owner wants to increase concurrent member LIVE capacity without reducing current program stability or execution quality.

This candidate keeps all execution-critical behavior unchanged:
- member LIVE execution cadence remains 10 seconds while trading;
- Gate reconciliation, source close handling, proportional copy sizing, leverage, stop protection, unknown-order recovery and OFF semantics are unchanged;
- primary LIVE and Market Intelligence strategy are unchanged;
- member execution stays isolated per MemberExecutor / Gate account.

The capacity gain comes only from non-critical resource reductions:
- member foreground runtime polling: 60 seconds instead of 10 seconds;
- member history polling: 60 seconds instead of 10 seconds;
- unchanged member usage reporting: immediate on change, otherwise at most one 15-minute heartbeat;
- hidden/background browser tabs still do not poll runtime.

## Verified capacity result

The current conservative 31-day SQLite Durable Object row-write model certifies **5 concurrently enabled/managed member LIVE accounts**, excluding the primary owner.

- 5-seat model: **23,520,072 rows / 31 days**
- internal row-write safety line: **25,000,000 rows / month** (50% of current 50M included Paid-plan row writes)
- 6-seat model crosses the current 50% safety line and is intentionally rejected by CI.

CI explicitly checks:
- 5 seats remain under the row-write safety line;
- 6 seats remain over the line until a later lossless optimization improves the model;
- member execution cadence remains 10 seconds despite slower UI polling;
- primary LIVE, member parity, isolation, build, typecheck and lint stay green.

## Important billing caveat

This branch is **not approved for merge yet** because Durable Object requests are a separate metered dimension.

Current conservative request model:
- 5 active members: about **4,553,280 DO requests / 31 days**.
- This exceeds the current Paid-plan included request allowance.
- That is a possible small billing overage, not a stability failure.

The owner previously preferred no extra monthly Cloudflare charges. Therefore this candidate stays sealed until one of the following is explicitly chosen:
1. accept the possible small request overage and merge 5 seats; or
2. redesign request architecture losslessly so additional seats do not materially increase paid request usage, then re-run capacity certification.

## Resume procedure

When the owner asks to resume, do **not** redesign from scratch.

1. Open Draft PR #528 and branch `scale/member-live-capacity-5-20260927`.
2. Rebase/compare against current `main`; preserve newer strategy/LIVE/storage changes.
3. Re-run full LIVE parity, member isolation, resource, build/typecheck/lint tests.
4. Re-check current Cloudflare pricing/resource assumptions before merging.
5. If the owner still requires fixed-cost operation, solve DO request scaling without reducing 10-second member execution quality.
6. Only then raise `MEMBER_ACTIVE_LIMIT` and merge/deploy.

## Retrieval phrase

Use this exact phrase in a future ChatGPT conversation:

**“@量化项目 调出会员5席位扩容封存方案，按 PR #528 / 分支 scale/member-live-capacity-5-20260927 继续，不重新设计。”**

That phrase should be treated as a request to resume this sealed candidate, not to rebuild the plan from memory.
