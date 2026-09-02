ALTER TABLE `hte31_shadow_samples` ADD `sample_kind` text DEFAULT 'near_ready' NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `playbook_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `max_holding_minutes` integer DEFAULT 240 NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `confidence` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `setup_score` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `evidence_score` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `thesis` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `terminal_at` integer;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `terminal_price` real;
--> statement-breakpoint
ALTER TABLE `hte31_shadow_samples` ADD `terminal_reason` text;
--> statement-breakpoint
CREATE INDEX `hte31_shadow_kind_status_idx` ON `hte31_shadow_samples` (`sample_kind`,`status`,`entry_at`);
