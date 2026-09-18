# Authorized source timing update — 2026-09-18

The protection timing change documented in `research/TIMELY_PROTECTION.md` is an explicit exception to the original UI-only pure-source byte freeze below. Members still consume the identical source including its full exit policy; the member executor, primary execution methods, keys, seats and owner switches are unchanged. The new source→primary and source→member early-exit integration tests are mandatory.

# Permanent isolated member access contract — 2026-09-18

## Scope and invariants

This is an access/distribution change, NOT a strategy upgrade. The current owner requires preservation of stable operation. `lib/forward-relations.ts`, `lib/forward-evidence.ts`, original Gate signing/quantity/close engine, owner authentication/vault and original dark stylesheet remain byte-identical. Ten critical original MarketStream method bodies (including main alarm, syncLive, setLiveMode, forward advance and checkpoint) are protected by a TypeScript-AST SHA256 test. The primary constructor's default path is unchanged; only a member-execution-only subclass skips it. Original current-source parity contract applies independently to every member, but the primary alone may issue memberships.

## Login keys and privacy

- An owner-issued key is256random bits and immediately binds one random immutable memberID. Issuance is an atomic idempotent transaction; old keys remain valid even before first login. Generating B does not invalidate A, reset an account or mutate any switch.
- Key hashes are stored; only the latest owner-display key is additionally AES-GCM sealed. A forgotten older key cannot be retrieved from its hash; keep the delivered copy securely. Per-person replacement/revocation is outside this first issuance feature, never pretend “next key” revokes one.
- Member sessions use a distinct signed HttpOnly/Secure/SameSite cookie and HMAC domain, expiring after30days; the key remains valid for later login. Key itself is not stored in cookie/browser storage. Server verified identity selects the tenant namespace; client role/memberID cannot redirect a request. Owner login clears member cookie, member login clears owner cookie, switching/logout clears private UI snapshot and in-flight epochs.
- Only owner endpoints issue/list. Members cannot invoke primary credentials, source reset, another binding, member list, key creation or any owner capability. Guest program APIs reject401. Health remains sanitized operational metadata, not an account key or numeric LIVE ledger.
- Friends are explicitly told that the inviter sees their program-derived actual traded notional and reporting time. Primary does not receive memberAPI/balance/PnL/private holdings through the membership UI. Membership is bearer-key access, NOT proof of the natural person or protection against voluntary key sharing.

## Execution and persistent isolation

- `MemberDirectory` owns registration/keys/aggregate usage and coalesces READ-only source projections. `MemberExecutor` owns each member's KV, encrypted GateAPI, intent/activation, orders, journal, history and turnover. Primary D1 and its credentialid1 are never used by member code. Per-member HKDF input binds to immutable memberID, not login key; credential blobs cannot be swapped between members or primary.
- Members inherit exact verified LIVE reconciliation methods, not a rewritten second strategy. The shared current PAPER source produces every tradeID and full immutable rule geometry. Copies freeze proportional marked equity sizing, preserve requested source leverage, contract-specific downward decimal quantization, stops, source lifecycle and true execution differences.
- New member LIVE starts OFF. Only their authenticated same-origin action enables their account. OFF→ON establishes their own fence; no old-source catch-up. Login, refresh, new-key issuance, deployment and background recovery never enable. Existing exposure survives OFF/restart and closes against authoritative original source. Source disappearance alone is not a close. Missing hot history is retrieved through a bounded immutable-archive cursor.
- Previously submitted or ambiguous requests keep the same durable source reservation; no retry to fabricate a second order. Member checkpoints atomically store journals before publishing submissions, lossless compressed and digest-checked; corruption refuses overwrite/reset. Member API failure never enters another executor or blocks primary's loop.
- Each member needs an independent Gate USDT account, not shared credentials/account with primary or another member. SaveAPI checks account identity and refuses existing unmanaged positions/orders. Cannot claim a member account before primary account identity is available for isolation. No transfer/withdrawal API exists. API replacement/deletion requires OFF and drained exposure.
- The primary is not hard-real-time isolated from all account-wide platform resource usage: cached readonly reads still cost work. No claimed identical Gate execution price, fees, funding, minimum sizes or results across separate accounts.

## Capacity and background work

- First rollout admits20login accounts and at most2members with enabled/managed execution, excluding primary. Limits are visible in UI; expansion requires resource review, not silent infinite admission. OFF with outstanding managed exposure retains a seat until reconciliation completes. A full capacity check never evicts already-active accounts.
- No member exists: no directory alarm, no member alarm, no Gate calls and no additional main-source reads. Key issuance itself starts no actor/trading loop.
- Active member alarms are10seconds, with rearm-before-await and isolated serialized work. Aligned alarms share the directory's2.5second single-flight source cache. UI can reuse up to10second projection; no duplicate market scans or learning. Source reads are bounded, never called or awaited from primary alarm. There are no per-tick memberD1writes. Per-user accounts have their own existing8000local daily write guard; this is not an account-wide platform meter or quota guarantee.
- Additional usage should be measured when real members are onboarded. The two-executor rollout is a conservative functional limit, not a benchmark proving unlimited requests/day. Deployment may reload a Worker but must preserve every durable source/intent/position and unchanged market cadence.

## Volume attribution

Use the existing confirmed-fill API, actual price/size/value/multiplier and durable ID dedup. Member start is account issuance time. Own account UI may show full personalGate turnover; admin summary uses only exact program tags persisted by THIS member before its own submission. Manual or another program's matching prefix is not sufficient. Original tags survive checkpoint restart. Amount+through+partial/error is the only shared numeric usage projection. No PAPER order value, planned quantity or invented zero replaces unverified fills. Report aggregation failures do not affect protection or owner intent.

## Tests and release

34initial dedicated tests exercise real exported Worker/MemberDirectory/MemberExecutor with only injected FakeGate, plus all existing438direct and17architecture/migration checks. Fake-network access is forbidden. Tests cover A/B-before-activation, key idempotence/hashing/encryption, role/cookie/tenant injection, owner operation while memberdirectory fails, defaultOFF/noD1/noPAPERinit, source coalescing, source copy sizing per equity, protection/close, restart/ambiguous-state baseline, corrupt storage and actual program-tag attribution. Main10method bodies are hashed against01b3093b9807dd3395d40271b7957e68662d53e9.

Compiled-workerd smoke uses disposable local SQLite and synthetic roots/keys only; its May2026 test-compatible date is an emulator accommodation and never changes production's Aug2026 compatibility. Actual component tests exercise primary/member all6tabs at320/393/768/1440 and login/issue-next/logout; API data fixtures are synthetic, not real-money tests.

Main production gates keep original health/advancing/state/LIVE intent and exactbuild checks. Old anonymous program-read expectations are replaced with REQUIRED rejection, not bypassed; only sanitized health remains anonymous. Additive v8migrations create new namespaces, no primary/table deletion or rollback. Before/after production receipt must be public-only, avoid issuing synthetic members in the real registry, and explicitly distinguish no-key-issued launch from funded-friend execution validation.
