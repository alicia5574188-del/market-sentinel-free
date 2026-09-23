# Private Gate reads and immediate source dispatch

The owner reports repeated six-round account timeouts and asks LIVE to respond
alongside PAPER. This scoped repair preserves the one persisted PAPER authority,
source identity, entry/exit policy, actual-account risk and manual LIVE intent.
No reset, real-money verification trade, credential change or external executor.

## Reproduced defects

- The old GET hedge hit the same host after two seconds. It raced HTTP headers;
  a 503, malformed response or stalled body could win before usable backup data.
- Snapshot Promise.all could fail while other signed reads were still active.
- The critical two-second alarm awaited the entire private reconciliation. Gate
  latency delayed fresh books/PAPER as well as copying. The optional candle lane
  could commit a source after that pass, with no direct notification.
- Desired sources were captured before the private snapshot await, missing a
  newly committed source until a later pass. lastSyncAt used the pre-read time.

## Changes

GET hedges use Gate's documented futures alternate after350ms or immediately on
network/5xx/invalid-JSON failure. They race complete successful JSON within the
same six-second deadline and abort losing transports. Definitive4xx (including
permissions/rate limits) remain errors, not hidden failovers. Production hosts
are fixed api.gateio.ws and fx-api.gateio.ws; testnet stays testnet; redirects are
rejected. POST/PUT/DELETE remain single-submit, including body-read timeouts.
All four fresh account/position/order/protective-order reads must complete; no
stale account cache or cross-exchange account data can authorize execution.

Official endpoint authority, checked2026-09-23:
https://www.gate.com/docs/developers/apiv4/en/#access-url

The existing alarm now launches a single background reconciler. Successful
financial source lifecycle commits notify it directly; events during a running
pass coalesce into one immediate serialized follow-up. Routine alarms join and
cannot manufacture an endless retry loop. Owner ON/OFF serialization, the final
before-send fence, durable reservations, tag reconciliation for unknown writes,
native protection and all size/price/risk gates remain unchanged. Desired sources
are selected after the account read. No additional alarms or periodic storage
writes; source notifications can add bounded lifecycle-driven reconciliation.
Original financial/protection write caps still govern concurrent writers.

Only alarm, advanceForwardNow and syncLiveOnce frozen bodies are updated under
this explicit request after actual-Worker semantic tests. Pure strategy, storage,
auth, owner switch, source mapping and member isolation baselines remain frozen.
Members inherit private read transport; their existing isolated polling cadence
and execution namespace are unchanged.

Public health adds aggregate liveExecution timing/counters and private transport
recovery counts, without credentials, order details or private financial amounts.
It distinguishes a running read from a completed fresh account confirmation.

## Verification and limits

Regression tests cover stalled bodies,5xx, malformed JSON, credential/rate-limit
errors, testnet isolation, write ambiguity, current-source-after-read, serialized
event follow-up, nonblocking alarms, and dispatch only after durable source commit.
Existing LIVE parity, owner OFF, stop protection, storage budget and membership
tests remain release gates. Post-deployment checks use public health only.

This removes reproduced transport/scheduling delays; it does not promise Gate
availability, identical PAPER/Gate prices, simultaneous fills or profitability.
If both authentic Gate routes fail, new exposure still requires fresh account
confirmation; unchanged native exchange stops protect previously covered holdings.
