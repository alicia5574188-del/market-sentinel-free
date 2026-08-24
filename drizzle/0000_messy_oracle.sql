CREATE TABLE `alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`symbol` text NOT NULL,
	`state` text NOT NULL,
	`side` text NOT NULL,
	`confidence` integer NOT NULL,
	`directional_score` real NOT NULL,
	`posterior_long` real,
	`data_quality` real NOT NULL,
	`regime` text NOT NULL,
	`observed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`entry_price` real,
	`entry_low` real,
	`entry_high` real,
	`invalidation_price` real,
	`trigger` text NOT NULL,
	`thesis` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`counter_evidence_json` text DEFAULT '[]' NOT NULL,
	`metrics_json` text DEFAULT '[]' NOT NULL,
	`source_snapshot_json` text DEFAULT '{}' NOT NULL,
	`outcome_state` text DEFAULT 'open' NOT NULL,
	`outcome_at` integer,
	`exit_price` real,
	`max_price_seen` real,
	`min_price_seen` real,
	`gross_move_pct` real,
	`estimated_cost_pct` real,
	`net_move_pct` real,
	`mfe_pct` real,
	`mae_pct` real,
	`brier_score` real,
	`notified` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_events_fingerprint_unique` ON `alert_events` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `alert_events_symbol_time_idx` ON `alert_events` (`symbol`,`observed_at`);--> statement-breakpoint
CREATE INDEX `alert_events_state_time_idx` ON `alert_events` (`state`,`observed_at`);--> statement-breakpoint
CREATE INDEX `alert_events_outcome_idx` ON `alert_events` (`outcome_state`,`observed_at`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`alert_style` text DEFAULT 'balanced' NOT NULL,
	`universe_limit` integer DEFAULT 30 NOT NULL,
	`deep_scan_limit` integer DEFAULT 8 NOT NULL,
	`min_confidence` integer DEFAULT 72 NOT NULL,
	`core_symbols_json` text DEFAULT '["BTC_USDT","ETH_USDT","SOL_USDT","HYPE_USDT"]' NOT NULL,
	`round_trip_cost_bps` real DEFAULT 8 NOT NULL,
	`trial_capital_usdt` real DEFAULT 100 NOT NULL,
	`max_risk_per_alert_usdt` real DEFAULT 1.25 NOT NULL,
	`daily_pause_usdt` real DEFAULT 3 NOT NULL,
	`max_drawdown_usdt` real DEFAULT 10 NOT NULL,
	`scan_enabled` integer DEFAULT true NOT NULL,
	`push_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_success_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_active_idx` ON `push_subscriptions` (`disabled_at`);--> statement-breakpoint
CREATE TABLE `regime_state` (
	`symbol` text PRIMARY KEY NOT NULL,
	`posterior_long` real DEFAULT 0.5 NOT NULL,
	`regime` text DEFAULT 'unknown' NOT NULL,
	`last_score` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL,
	`universe_size` integer DEFAULT 0 NOT NULL,
	`deep_scanned` integer DEFAULT 0 NOT NULL,
	`confirmed_count` integer DEFAULT 0 NOT NULL,
	`pre_alert_count` integer DEFAULT 0 NOT NULL,
	`average_data_quality` real,
	`duration_ms` integer,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scan_runs_started_idx` ON `scan_runs` (`started_at`);