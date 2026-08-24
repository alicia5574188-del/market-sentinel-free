PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`alert_style` text DEFAULT 'balanced' NOT NULL,
	`universe_limit` integer DEFAULT 30 NOT NULL,
	`deep_scan_limit` integer DEFAULT 8 NOT NULL,
	`min_confidence` integer DEFAULT 72 NOT NULL,
	`core_symbols_json` text DEFAULT '["BTC_USDT","ETH_USDT","SOL_USDT","HYPE_USDT"]' NOT NULL,
	`round_trip_cost_bps` real DEFAULT 8 NOT NULL,
	`trial_capital_usdt` real DEFAULT 1000 NOT NULL,
	`max_risk_per_alert_usdt` real DEFAULT 10 NOT NULL,
	`daily_pause_usdt` real DEFAULT 30 NOT NULL,
	`max_drawdown_usdt` real DEFAULT 100 NOT NULL,
	`scan_enabled` integer DEFAULT true NOT NULL,
	`push_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_app_settings`("id", "alert_style", "universe_limit", "deep_scan_limit", "min_confidence", "core_symbols_json", "round_trip_cost_bps", "trial_capital_usdt", "max_risk_per_alert_usdt", "daily_pause_usdt", "max_drawdown_usdt", "scan_enabled", "push_enabled", "updated_at") SELECT "id", "alert_style", "universe_limit", "deep_scan_limit", "min_confidence", "core_symbols_json", "round_trip_cost_bps", "trial_capital_usdt", "max_risk_per_alert_usdt", "daily_pause_usdt", "max_drawdown_usdt", "scan_enabled", "push_enabled", "updated_at" FROM `app_settings`;--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `contract_type` text DEFAULT 'USDT_PERPETUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `margin_mode` text DEFAULT 'isolated' NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `leverage` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `leverage_reason` text DEFAULT '旧模型未记录自适应杠杆' NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `margin_usdt` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `contract_notional_usdt` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `quantity` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `estimated_liquidation_price` real;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `simulation_model` text DEFAULT 'contract_v2' NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `account_balance_before_usdt` real DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `account_balance_after_usdt` real;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `unrealized_net_pct` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `unrealized_gross_usdt` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `unrealized_net_usdt` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `gross_pnl_usdt` real;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `estimated_cost_usdt` real;--> statement-breakpoint
ALTER TABLE `trade_cases` ADD `net_pnl_usdt` real;--> statement-breakpoint
UPDATE `app_settings`
SET `trial_capital_usdt` = 1000,
	`max_risk_per_alert_usdt` = 10,
	`daily_pause_usdt` = 30,
	`max_drawdown_usdt` = 100,
	`updated_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE `id` = 1 AND `trial_capital_usdt` <= 100;--> statement-breakpoint
UPDATE `trade_cases`
SET `leverage` = MIN(
	CASE WHEN `data_quality` < 0.80 OR `confidence` < 75 THEN 3 ELSE 8 END,
	CASE
		WHEN `planned_risk_pct` >= 3 THEN 2
		WHEN `planned_risk_pct` >= 1.8 THEN 3
		WHEN `planned_risk_pct` >= 1 THEN 5
		ELSE 6
	END
),
`leverage_reason` = '历史订单按1000U合约模型保守重算：缺少当时24h成交额，杠杆仅按入场波动代理、数据质量和可信度限制',
`simulation_model` = 'contract_v2_recalculated';--> statement-breakpoint
UPDATE `trade_cases`
SET `contract_notional_usdt` = MIN(
	10.0 / MAX(`planned_risk_pct` / 100.0, 0.0001),
	200.0 * `leverage`
),
`suggested_notional_usdt` = MIN(
	10.0 / MAX(`planned_risk_pct` / 100.0, 0.0001),
	200.0 * `leverage`
);--> statement-breakpoint
UPDATE `trade_cases`
SET `margin_usdt` = `contract_notional_usdt` / MAX(`leverage`, 1),
	`quantity` = `contract_notional_usdt` / MAX(`entry_price`, 0.00000001),
	`risk_budget_usdt` = `contract_notional_usdt` * `planned_risk_pct` / 100.0,
	`estimated_liquidation_price` = CASE
		WHEN `side` = 'LONG' THEN `entry_price` * (1.0 - 0.92 / MAX(`leverage`, 1))
		ELSE `entry_price` * (1.0 + 0.92 / MAX(`leverage`, 1))
	END,
	`unrealized_net_pct` = `unrealized_gross_pct` - COALESCE((SELECT `round_trip_cost_bps` / 100.0 FROM `app_settings` WHERE `id` = 1), 0.08),
	`unrealized_gross_usdt` = CASE WHEN `status` = 'holding' THEN `contract_notional_usdt` * `unrealized_gross_pct` / 100.0 ELSE 0 END,
	`unrealized_net_usdt` = CASE WHEN `status` = 'holding' THEN `contract_notional_usdt` * (`unrealized_gross_pct` - COALESCE((SELECT `round_trip_cost_bps` / 100.0 FROM `app_settings` WHERE `id` = 1), 0.08)) / 100.0 ELSE 0 END,
	`gross_pnl_usdt` = CASE WHEN `status` = 'closed' THEN `contract_notional_usdt` * COALESCE(`gross_move_pct`, 0) / 100.0 ELSE NULL END,
	`estimated_cost_usdt` = CASE WHEN `status` = 'closed' THEN `contract_notional_usdt` * COALESCE(`estimated_cost_pct`, 0) / 100.0 ELSE NULL END,
	`net_pnl_usdt` = CASE WHEN `status` = 'closed' THEN `contract_notional_usdt` * COALESCE(`net_move_pct`, 0) / 100.0 ELSE NULL END;--> statement-breakpoint
UPDATE `trade_cases` AS `current_trade`
SET `account_balance_before_usdt` = 1000 + COALESCE((
	SELECT SUM(`prior_trade`.`net_pnl_usdt`)
	FROM `trade_cases` AS `prior_trade`
	WHERE `prior_trade`.`status` = 'closed'
		AND `prior_trade`.`exit_at` IS NOT NULL
		AND (`prior_trade`.`exit_at` < COALESCE(`current_trade`.`exit_at`, `current_trade`.`entry_at`)
			OR (`prior_trade`.`exit_at` = COALESCE(`current_trade`.`exit_at`, `current_trade`.`entry_at`) AND `prior_trade`.`id` < `current_trade`.`id`))
), 0);--> statement-breakpoint
UPDATE `trade_cases`
SET `account_balance_after_usdt` = `account_balance_before_usdt` + COALESCE(`net_pnl_usdt`, 0)
WHERE `status` = 'closed';
