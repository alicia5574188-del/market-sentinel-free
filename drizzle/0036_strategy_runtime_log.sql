CREATE TABLE IF NOT EXISTS strategy_runtime_log (
  id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  version TEXT NOT NULL,
  scanned_markets INTEGER NOT NULL,
  stable_markets INTEGER NOT NULL,
  realtime_markets INTEGER NOT NULL,
  regime_counts_json TEXT NOT NULL DEFAULT '{}',
  strategy_metrics_json TEXT NOT NULL DEFAULT '[]',
  shadow_open INTEGER NOT NULL,
  shadow_resolved INTEGER NOT NULL,
  active_strategies INTEGER NOT NULL,
  portfolio_open INTEGER NOT NULL,
  portfolio_equity REAL NOT NULL,
  portfolio_resolved INTEGER NOT NULL,
  portfolio_net_pnl REAL NOT NULL,
  strategy_candle_error TEXT,
  authority_state TEXT NOT NULL,
  live_requested INTEGER NOT NULL DEFAULT 0,
  live_operational INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS strategy_runtime_log_time_idx
  ON strategy_runtime_log(observed_at);
