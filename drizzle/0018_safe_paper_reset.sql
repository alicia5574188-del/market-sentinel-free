CREATE TABLE `hte31_paper_reset_state` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`requested_capital_usdt` real NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `hte31_paper_reset_state` (`id`, `status`, `requested_capital_usdt`, `requested_at`, `completed_at`, `updated_at`)
VALUES ('singleton', 'pending', COALESCE((SELECT `trial_capital_usdt` FROM `app_settings` WHERE `id` = 1), 1000), unixepoch('now') * 1000, NULL, unixepoch('now') * 1000);
