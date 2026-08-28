CREATE TABLE `hte31_trades` (
  `id` text PRIMARY KEY NOT NULL,
  `active_key` text,
  `symbol` text NOT NULL,
  `status` text DEFAULT 'holding' NOT NULL,
  `trader_id` text NOT NULL,
  `setup_id` text NOT NULL,
  `side` text NOT NULL,
  `asset_regime` text NOT NULL,
  `confidence` integer NOT NULL,
  `entry_at` integer NOT NULL,
  `entry_price` real NOT NULL,
  `initial_stop_price` real NOT NULL,
  `current_stop_price` real NOT NULL,
  `take_profit_1_price` real NOT NULL,
  `take_profit_2_price` real NOT NULL,
  `target_1_hit_at` integer,
  `max_holding_minutes` integer NOT NULL,
  `risk_reward` real NOT NULL,
  `risk_budget_usdt` real NOT NULL,
  `notional_usdt` real NOT NULL,
  `margin_usdt` real NOT NULL,
  `quantity` real NOT NULL,
  `leverage` integer NOT NULL,
  `entry_trigger` text NOT NULL,
  `entry_thesis` text NOT NULL,
  `entry_checks_json` text DEFAULT '[]' NOT NULL,
  `entry_metrics_json` text DEFAULT '[]' NOT NULL,
  `last_price` real NOT NULL,
  `last_evaluated_at` integer NOT NULL,
  `max_price_seen` real NOT NULL,
  `min_price_seen` real NOT NULL,
  `unrealized_net_pct` real DEFAULT 0 NOT NULL,
  `unrealized_net_usdt` real DEFAULT 0 NOT NULL,
  `progress_r` real DEFAULT 0 NOT NULL,
  `exit_at` integer,
  `exit_price` real,
  `exit_code` text,
  `exit_reason` text,
  `gross_move_pct` real,
  `net_move_pct` real,
  `gross_pnl_usdt` real,
  `cost_usdt` real,
  `net_pnl_usdt` real,
  `mfe_pct` real,
  `mae_pct` real,
  `hold_minutes` real,
  `post_exit_status` text DEFAULT 'pending' NOT NULL,
  `post_exit_mfe_pct` real,
  `post_exit_mae_pct` real,
  `exit_capture_pct` real,
  `exit_efficiency` real,
  `stop_recovery` integer,
  `post_exit_label` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hte31_trades_active_key_unique` ON `hte31_trades` (`active_key`);
--> statement-breakpoint
CREATE INDEX `hte31_trades_status_time_idx` ON `hte31_trades` (`status`,`entry_at`);
--> statement-breakpoint
CREATE INDEX `hte31_trades_trader_exit_idx` ON `hte31_trades` (`trader_id`,`exit_at`);
--> statement-breakpoint
CREATE INDEX `hte31_trades_symbol_time_idx` ON `hte31_trades` (`symbol`,`entry_at`);
--> statement-breakpoint
CREATE TABLE `hte31_evaluations` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `observed_at` integer NOT NULL,
  `trader_id` text NOT NULL,
  `setup_id` text NOT NULL,
  `state` text NOT NULL,
  `side` text NOT NULL,
  `confidence` integer NOT NULL,
  `setup_score` real NOT NULL,
  `evidence_score` real NOT NULL,
  `asset_regime` text NOT NULL,
  `thesis` text NOT NULL,
  `reasons_json` text DEFAULT '[]' NOT NULL,
  `blockers_json` text DEFAULT '[]' NOT NULL,
  `entry_plan_json` text DEFAULT 'null' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hte31_eval_time_idx` ON `hte31_evaluations` (`observed_at`);
--> statement-breakpoint
CREATE INDEX `hte31_eval_symbol_time_idx` ON `hte31_evaluations` (`symbol`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `hte31_eval_trader_time_idx` ON `hte31_evaluations` (`trader_id`,`observed_at`);
--> statement-breakpoint
CREATE TABLE `hte31_learning` (
  `id` text PRIMARY KEY NOT NULL,
  `trader_id` text NOT NULL,
  `asset_regime` text NOT NULL,
  `side` text NOT NULL,
  `sample_count` integer DEFAULT 0 NOT NULL,
  `wins` integer DEFAULT 0 NOT NULL,
  `losses` integer DEFAULT 0 NOT NULL,
  `expectancy_r` real DEFAULT 0 NOT NULL,
  `gross_profit_r` real DEFAULT 0 NOT NULL,
  `gross_loss_r` real DEFAULT 0 NOT NULL,
  `average_mfe_r` real DEFAULT 0 NOT NULL,
  `average_mae_r` real DEFAULT 0 NOT NULL,
  `average_exit_efficiency` real DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hte31_learning_trader_idx` ON `hte31_learning` (`trader_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `hte31_trade_charts` (
  `trade_id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `entry_candles_json` text DEFAULT '[]' NOT NULL,
  `holding_candles_json` text DEFAULT '[]' NOT NULL,
  `post_exit_candles_json` text DEFAULT '[]' NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hte31_post_exit_observations` (
  `trade_id` text NOT NULL,
  `horizon_minutes` integer NOT NULL,
  `due_at` integer NOT NULL,
  `observed_at` integer,
  `status` text DEFAULT 'pending' NOT NULL,
  `price` real,
  `favorable_pct` real,
  `adverse_pct` real,
  `favorable_r` real,
  `adverse_r` real,
  `candles_json` text DEFAULT '[]' NOT NULL,
  PRIMARY KEY (`trade_id`,`horizon_minutes`)
);
--> statement-breakpoint
CREATE INDEX `hte31_post_exit_due_idx` ON `hte31_post_exit_observations` (`status`,`due_at`);
--> statement-breakpoint
UPDATE `live_trading_control`
SET `entry_enabled` = 0,
    `state` = CASE WHEN `state` = 'emergency_stopped' THEN `state` ELSE 'disabled' END,
    `activation_epoch` = `activation_epoch` + 1,
    `updated_at` = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE `id` = 1;
