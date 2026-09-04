ALTER TABLE `hte31_paper_reset_state` ADD `active_brain_version` text;
--> statement-breakpoint
ALTER TABLE `hte31_paper_reset_state` ADD `target_brain_version` text;
--> statement-breakpoint
INSERT INTO `hte31_paper_reset_state` (`id`, `status`, `reset_mode`, `active_brain_version`, `target_brain_version`, `requested_capital_usdt`, `requested_at`, `completed_at`, `updated_at`)
VALUES (
  'singleton',
  'pending',
  'force_archive',
  'direct-market-brain-v1',
  'direct-market-brain-v2-core-three',
  COALESCE((SELECT `trial_capital_usdt` FROM `app_settings` WHERE `id` = 1), 1000),
  unixepoch('now') * 1000,
  NULL,
  unixepoch('now') * 1000
)
ON CONFLICT(`id`) DO UPDATE SET
  `status` = 'pending',
  `reset_mode` = 'force_archive',
  `active_brain_version` = COALESCE(`active_brain_version`, 'direct-market-brain-v1'),
  `target_brain_version` = excluded.`target_brain_version`,
  `requested_capital_usdt` = excluded.`requested_capital_usdt`,
  `requested_at` = excluded.`requested_at`,
  `completed_at` = NULL,
  `updated_at` = excluded.`updated_at`;
