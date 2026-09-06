-- Prepare the new PAPER-only schema without touching the one preserved Gate credential row.
CREATE TABLE IF NOT EXISTS `live_exchange_credentials` (
  `id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
  `exchange` text DEFAULT 'gate' NOT NULL,
  `environment` text DEFAULT 'testnet' NOT NULL,
  `ciphertext` text NOT NULL,
  `iv` text NOT NULL,
  `crypto_version` integer DEFAULT 1 NOT NULL,
  `key_hint` text NOT NULL,
  `gate_user_id` text,
  `owner_account_id` text,
  `permission_summary_json` text DEFAULT '{}' NOT NULL,
  `status` text DEFAULT 'verified' NOT NULL,
  `last_verified_at` integer,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_settings` (
  `id` integer PRIMARY KEY CHECK (`id` = 1),
  `mode` text NOT NULL DEFAULT 'PAPER' CHECK (`mode` = 'PAPER'),
  `paper_equity` real NOT NULL DEFAULT 1000 CHECK (`paper_equity` > 0),
  `equity_version` integer NOT NULL DEFAULT 0,
  `portfolio_risk_cap` real NOT NULL DEFAULT 0.05 CHECK (`portfolio_risk_cap` <= 0.05),
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `system_settings` (`id`,`mode`,`paper_equity`,`portfolio_risk_cap`,`updated_at`) VALUES (1,'PAPER',1000,0.05,unixepoch()*1000);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `paper_plans` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `market_state` text NOT NULL CHECK (`market_state` IN ('BREAKOUT','REVERSAL','RANGE')),
  `side` text NOT NULL CHECK (`side` IN ('LONG','SHORT')),
  `state` text NOT NULL CHECK (`state` IN ('PREPARED','TRIGGERED','CANCELLED')),
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `entry_trigger` real NOT NULL,
  `invalidation` real NOT NULL,
  `target` real NOT NULL,
  `planned_risk` real NOT NULL,
  `notional` real NOT NULL,
  `score` real NOT NULL,
  `reason_json` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `paper_plans_symbol_time_idx` ON `paper_plans` (`symbol`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `paper_positions` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `market_state` text NOT NULL CHECK (`market_state` IN ('BREAKOUT','REVERSAL','RANGE')),
  `side` text NOT NULL CHECK (`side` IN ('LONG','SHORT')),
  `status` text NOT NULL CHECK (`status` IN ('OPEN','CLOSED')),
  `entry_at` integer NOT NULL,
  `entry_price` real NOT NULL,
  `initial_stop` real NOT NULL,
  `current_stop` real NOT NULL,
  `current_target` real NOT NULL,
  `target_identity` text NOT NULL,
  `planned_risk` real NOT NULL,
  `notional` real NOT NULL,
  `exit_at` integer,
  `exit_price` real,
  `exit_reason` text,
  `realized_pnl` real,
  `fees_and_slippage` real,
  `mirror_version` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `paper_positions_status_time_idx` ON `paper_positions` (`status`,`entry_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `paper_events` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `event_type` text NOT NULL,
  `observed_at` integer NOT NULL,
  `payload_json` text NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `paper_events_time_idx` ON `paper_events` (`observed_at`);
--> statement-breakpoint
-- Temporary hand-off written only by the separately deployed, read-only old-Worker preflight.
-- The final Worker has no route that can create these rows; 0033 removes the table.
CREATE TABLE IF NOT EXISTS `cutover_preflight` (
  `id` text PRIMARY KEY NOT NULL,
  `checked_at` integer NOT NULL,
  `credential_fingerprint` text NOT NULL,
  `worker_sha` text NOT NULL,
  `account_ok` integer NOT NULL,
  `positions` integer NOT NULL,
  `orders` integer NOT NULL,
  `conditional_orders` integer NOT NULL
);
