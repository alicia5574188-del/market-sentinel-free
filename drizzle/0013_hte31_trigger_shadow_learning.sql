CREATE TABLE `hte31_trigger_buckets` (
  `bucket_start` integer PRIMARY KEY NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hte31_trigger_bucket_updated_idx` ON `hte31_trigger_buckets` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `hte31_shadow_samples` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `trader_id` text NOT NULL,
  `setup_id` text NOT NULL,
  `side` text NOT NULL,
  `asset_regime` text NOT NULL,
  `missing_key` text NOT NULL,
  `missing_label` text NOT NULL,
  `entry_at` integer NOT NULL,
  `entry_price` real NOT NULL,
  `stop_price` real NOT NULL,
  `take_profit_2_price` real NOT NULL,
  `risk_per_unit` real NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `max_price_seen` real NOT NULL,
  `min_price_seen` real NOT NULL,
  `last_price` real NOT NULL,
  `last_observed_at` integer NOT NULL,
  `observations_json` text DEFAULT '[]' NOT NULL,
  `final_at` integer,
  `final_price` real,
  `result_r` real,
  `mfe_r` real,
  `mae_r` real,
  `outcome` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hte31_shadow_status_time_idx` ON `hte31_shadow_samples` (`status`,`entry_at`);
--> statement-breakpoint
CREATE INDEX `hte31_shadow_symbol_status_idx` ON `hte31_shadow_samples` (`symbol`,`status`);
--> statement-breakpoint
CREATE INDEX `hte31_shadow_trader_status_idx` ON `hte31_shadow_samples` (`trader_id`,`status`);
