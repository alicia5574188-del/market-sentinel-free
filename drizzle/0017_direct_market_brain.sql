ALTER TABLE `hte31_trades` ADD `decision_authority` text DEFAULT 'legacy_hte31' NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_trades` ADD `brain_version` text;
--> statement-breakpoint
ALTER TABLE `hte31_trades` ADD `decision_snapshot_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_trades` ADD `independent_event_key` text;
--> statement-breakpoint
ALTER TABLE `hte31_post_exit_observations` ADD `quality_status` text DEFAULT 'PENDING' NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_post_exit_observations` ADD `coverage_pct` real;
--> statement-breakpoint
ALTER TABLE `hte31_post_exit_observations` ADD `last_error` text;
--> statement-breakpoint
ALTER TABLE `hte31_post_exit_observations` ADD `retry_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_post_exit_observations` ADD `next_retry_at` integer;
