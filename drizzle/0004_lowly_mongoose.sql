CREATE TABLE `user_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_accounts_email_unique` ON `user_accounts` (`email`);--> statement-breakpoint
CREATE INDEX `user_accounts_status_idx` ON `user_accounts` (`status`);--> statement-breakpoint
CREATE INDEX `user_accounts_last_seen_idx` ON `user_accounts` (`last_seen_at`);--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `account_id` text;--> statement-breakpoint
CREATE INDEX `push_subscriptions_account_idx` ON `push_subscriptions` (`account_id`,`disabled_at`);