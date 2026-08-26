CREATE TABLE IF NOT EXISTS `v2_market_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `observed_at` integer NOT NULL,
  `regime` text NOT NULL,
  `confidence` integer NOT NULL,
  `stability` integer NOT NULL,
  `transition_risk` integer NOT NULL,
  `risk_velocity` real NOT NULL,
  `risk_acceleration` real NOT NULL,
  `permission` text NOT NULL,
  `direction_bias` text NOT NULL,
  `developing_regime` text,
  `regime_margin` real NOT NULL,
  `context_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `v2_market_snapshots_symbol_time_idx` ON `v2_market_snapshots` (`symbol`,`observed_at` DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `v2_warning_events` (
  `id` text PRIMARY KEY NOT NULL,
  `snapshot_id` text NOT NULL,
  `symbol` text NOT NULL,
  `observed_at` integer NOT NULL,
  `warning_type` text NOT NULL,
  `status` text NOT NULL,
  `severity` real NOT NULL,
  `confidence` real NOT NULL,
  `relevance` real NOT NULL,
  `warning_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `v2_warning_events_symbol_time_idx` ON `v2_warning_events` (`symbol`,`observed_at` DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `v2_opportunity_decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `snapshot_id` text NOT NULL,
  `symbol` text NOT NULL,
  `observed_at` integer NOT NULL,
  `playbook_id` text NOT NULL,
  `decision_state` text NOT NULL,
  `side` text NOT NULL,
  `score` real NOT NULL,
  `confidence` real NOT NULL,
  `environment_fit` real NOT NULL,
  `structure_score` real NOT NULL,
  `timing_score` real NOT NULL,
  `confirmation_score` real NOT NULL,
  `risk_reward_score` real NOT NULL,
  `opportunity_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `v2_opportunity_decisions_symbol_time_idx` ON `v2_opportunity_decisions` (`symbol`,`observed_at` DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `v2_system_meta` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint

-- Sentinel V2 starts with a clean strategy-learning history. Exchange credentials,
-- live control, live orders and live audit events are intentionally preserved.
DELETE FROM `strategy_memory`;
--> statement-breakpoint
DELETE FROM `alert_events`;
--> statement-breakpoint
DELETE FROM `regime_state`;
--> statement-breakpoint
DELETE FROM `symbol_lifecycle`
WHERE `active_trade_id` IS NULL
   OR `active_trade_id` NOT IN (
     SELECT `trade_case_id` FROM `live_orders`
     WHERE `state` IN ('submitting','open','protected','closing')
   );
--> statement-breakpoint
DELETE FROM `trade_cases`
WHERE `id` NOT IN (
  SELECT `trade_case_id` FROM `live_orders`
  WHERE `state` IN ('submitting','open','protected','closing')
);
--> statement-breakpoint
INSERT OR REPLACE INTO `v2_system_meta` (`key`,`value`,`updated_at`)
VALUES ('strategy_generation','sentinel-growth-v2',strftime('%s','now') * 1000);
