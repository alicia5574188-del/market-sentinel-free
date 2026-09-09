-- User-authorized strategy-arena cutover: the new isolated strategy ledgers
-- must not inherit any position, trade, event, or equity from the retired PAPER system.
-- Gate credentials and every LIVE field are deliberately untouched.
DELETE FROM `paper_events`;
--> statement-breakpoint
DELETE FROM `paper_positions`;
--> statement-breakpoint
DELETE FROM `paper_plans`;
--> statement-breakpoint
UPDATE `system_settings`
SET `paper_equity` = 1000,
    `equity_version` = `equity_version` + 1,
    `updated_at` = unixepoch() * 1000
WHERE `id` = 1;
