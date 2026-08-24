CREATE TABLE `live_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`live_order_id` text,
	`symbol` text,
	`actor_account_id` text,
	`message` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `live_audit_events_created_idx` ON `live_audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `live_audit_events_order_idx` ON `live_audit_events` (`live_order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `live_exchange_credentials` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`exchange` text DEFAULT 'gate' NOT NULL,
	`environment` text DEFAULT 'testnet' NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`crypto_version` integer DEFAULT 1 NOT NULL,
	`key_hint` text NOT NULL,
	`gate_user_id` text,
	`permission_summary_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'verified' NOT NULL,
	`last_verified_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `live_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`trade_case_id` text NOT NULL,
	`client_order_text` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`state` text NOT NULL,
	`activation_epoch` integer NOT NULL,
	`entry_order_id` text,
	`take_profit_order_id` text,
	`stop_loss_order_id` text,
	`requested_contracts` text NOT NULL,
	`filled_contracts` text,
	`reference_price` real NOT NULL,
	`fill_price` real,
	`stop_loss_price` real NOT NULL,
	`take_profit_price` real NOT NULL,
	`leverage` integer NOT NULL,
	`margin_mode` text DEFAULT 'isolated' NOT NULL,
	`expected_net_tp2_usdt` real NOT NULL,
	`realized_pnl_usdt` real,
	`last_gate_status_json` text DEFAULT '{}' NOT NULL,
	`failure_code` text,
	`failure_reason` text,
	`submitted_at` integer,
	`protected_at` integer,
	`closed_at` integer,
	`last_reconciled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_orders_trade_case_id_unique` ON `live_orders` (`trade_case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `live_orders_client_order_text_unique` ON `live_orders` (`client_order_text`);--> statement-breakpoint
CREATE INDEX `live_orders_state_updated_idx` ON `live_orders` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `live_orders_symbol_state_idx` ON `live_orders` (`symbol`,`state`);--> statement-breakpoint
CREATE TABLE `live_trading_control` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`entry_enabled` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'disabled' NOT NULL,
	`activation_epoch` integer DEFAULT 0 NOT NULL,
	`enabled_at` integer,
	`disabled_at` integer,
	`emergency_at` integer,
	`emergency_reason` text,
	`last_reconciled_at` integer,
	`last_successful_reconcile_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
