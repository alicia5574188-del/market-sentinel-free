CREATE INDEX IF NOT EXISTS hte31_trades_event_idx ON hte31_trades(independent_event_key);
CREATE INDEX IF NOT EXISTS hte31_trades_status_exit_idx ON hte31_trades(status,exit_at);
CREATE TABLE IF NOT EXISTS scalp_risk_days (id TEXT PRIMARY KEY NOT NULL, day_base REAL NOT NULL, halted_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
INSERT INTO `hte31_paper_reset_state` (`id`, `status`, `reset_mode`, `active_brain_version`, `target_brain_version`, `requested_capital_usdt`, `requested_at`, `completed_at`, `updated_at`)
VALUES (
  'singleton', 'pending', 'force_archive',
  'direct-market-brain-v7-historical-analog',
  'direct-market-brain-v8-minute-pullback',
  COALESCE((SELECT `trial_capital_usdt` FROM `app_settings` WHERE `id` = 1), 1000),
  unixepoch('now') * 1000, NULL, unixepoch('now') * 1000
)
ON CONFLICT(`id`) DO UPDATE SET
  `status` = 'pending',
  `reset_mode` = 'force_archive',
  `target_brain_version` = excluded.`target_brain_version`,
  `requested_capital_usdt` = excluded.`requested_capital_usdt`,
  `requested_at` = excluded.`requested_at`,
  `completed_at` = NULL,
  `updated_at` = excluded.`updated_at`;
