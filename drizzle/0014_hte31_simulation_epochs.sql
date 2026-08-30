CREATE TABLE `hte31_simulation_epochs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`starting_capital_usdt` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hte31_simulation_epochs_started_idx` ON `hte31_simulation_epochs` (`started_at`);
