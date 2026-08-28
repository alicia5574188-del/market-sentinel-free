-- Human Trader Engine 3.0 fresh-start reset.
--
-- The prior Strategy 2.0 / P1-P12 simulation, learning and observability data is
-- intentionally discarded because those rows were produced by a materially
-- different entry authority. System configuration and the real Gate execution
-- chain are preserved.
--
-- If a real Gate order is active at migration time, its linked trade case and
-- lifecycle row are retained temporarily so Order Lifecycle can keep managing
-- that real position safely. Those retained rows are excluded from the new HTE
-- simulation account and learning by code-level S2|HT isolation.

DELETE FROM alert_events;
DELETE FROM strategy_memory;
DELETE FROM regime_state;
DELETE FROM scan_runs;

DELETE FROM v2_warning_events;
DELETE FROM v2_opportunities;
DELETE FROM v2_market_snapshots;
DELETE FROM v2_trade_thesis
WHERE trade_id NOT IN (
  SELECT trade_case_id FROM live_orders
  WHERE state IN ('submitting','open','protected','closing')
);

DELETE FROM symbol_lifecycle
WHERE active_trade_id IS NULL
   OR active_trade_id NOT IN (
     SELECT trade_case_id FROM live_orders
     WHERE state IN ('submitting','open','protected','closing')
   );

DELETE FROM trade_cases
WHERE id NOT IN (
  SELECT trade_case_id FROM live_orders
  WHERE state IN ('submitting','open','protected','closing')
);
