# Integrated storage, Shock and entry repair — 2026-09-25

## Verified baseline

- Production and GitHub main: `779becb4abed22e3a5d7b2bbda401295d36f649e`.
- The uploaded snapshot contains 76 closed trades: +16.011588U gross,
  22.902742U fees, 0.045061U funding allowance and -6.936215U net.
- Excluding three Structural Interrupt trades: 73 trades, +20.001388U gross,
  21.389989U fees and -1.433560U net.
- The three Shock shorts lost 5.502655U net. SUI and XLM were already 1.39% and
  1.78% outside their boundaries; LINK was later assigned a separate market
  event even though all three detections share the same side and 30-second bin.
- Current production's packed raw checkpoint is 2,070,903 bytes. The existing
  2MiB failure is temporarily absent only because active samples fell from 2099
  to 2036; account/history/event growth can cross it again.

## Design

1. Store account/current strategy without mature samples in a compact account
   generation. Store mature samples in stable one-hour, bounded-row shards. A manifest records
   layout version, sample count, page ids/counts/raw/stored lengths and SHA-256,
   plus its own digest bound into the account head.
2. Read legacy single-package checkpoints and migrate on the next normal atomic
   commit. New writes compare stable page contents and write only affected pages.
   Missing, reordered, corrupt or mismatched pages fail closed without resetting
   account or learning.
3. A Structural Interrupt pre-alert can veto the opposite ordinary direction.
   Reverse permission is separate. A just-crossed path needs sustained realtime
   continuation; a path already beyond its chase envelope enters WAIT_RETEST and
   needs a bounded pullback followed by a new extreme. Speed alone is never a
   reverse-entry proof.
4. Same-side tracks in one rolling shock window inherit one event id. Candidate
   ranking combines outer-region quality, boundary distance, remaining space,
   continuation/restart quality, BBO liquidity and market breadth. The first
   candidate is normal; a second needs explicit independent restart quality.
5. Non-Shock Reserve and marginal entries wait 12–24 seconds for monotonic fresh
   BBO evidence. Re-entry into the region, invalidation or directional engulfing
   cancels the attempt. Strong mature relations can still execute immediately.
6. Closed PAPER trades update bounded per-family predicted-versus-realized cost
   calibration once. Calibration cannot lower the 19bp modeled round trip and is
   used only for validation routing and diagnostics.
7. PAPER trade creation remains in the same transaction as the authoritative
   checkpoint. Only after that succeeds does the existing serialized LIVE worker
   wake; source id, side, stop, exit plan and shock event id stay identical.

## Release gate

No deployment unless causal snapshot counterfactuals improve net/cost behavior
without deleting normal Forward opportunities, the SUI +17U winner remains
admissible, the three failed Shock entries are prevented or delayed, storage
passes 2200 mature samples + 240 history + 160 events + rules/regions/positions,
and every existing Forward/LIVE/Gate/build/type/lint/architecture gate passes.
