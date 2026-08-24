ALTER TABLE `trade_cases` ADD `archived_at` integer;--> statement-breakpoint
UPDATE `trade_cases`
SET `active_key` = NULL,
	`status` = 'archived',
	`archived_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER),
	`simulation_model` = 'legacy_signal_v1',
	`leverage` = 1,
	`leverage_reason` = '旧版百分比观察记录：入场时未建立合约仓位，不补算历史杠杆',
	`margin_usdt` = 0,
	`contract_notional_usdt` = 0,
	`quantity` = 0,
	`estimated_liquidation_price` = NULL,
	`suggested_notional_usdt` = MIN(100, 1.25 / MAX(`planned_risk_pct` / 100.0, 0.0001)),
	`risk_budget_usdt` = MIN(1.25, MIN(100, 1.25 / MAX(`planned_risk_pct` / 100.0, 0.0001)) * `planned_risk_pct` / 100.0),
	`unrealized_net_pct` = 0,
	`unrealized_gross_usdt` = 0,
	`unrealized_net_usdt` = 0,
	`gross_pnl_usdt` = NULL,
	`estimated_cost_usdt` = NULL,
	`net_pnl_usdt` = NULL,
	`account_balance_before_usdt` = 1000,
	`account_balance_after_usdt` = NULL,
	`learning_applied` = false
WHERE `simulation_model` = 'contract_v2_recalculated';--> statement-breakpoint
UPDATE `symbol_lifecycle`
SET `state` = 'observing',
	`side` = 'WAIT',
	`active_trade_id` = NULL,
	`cooldown_until` = NULL,
	`last_transition_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER),
	`last_observed_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER),
	`decision_json` = json_object('migration', 'legacy observation isolated from contract account')
WHERE `symbol` IN (SELECT `symbol` FROM `trade_cases` WHERE `status` = 'archived')
	AND NOT EXISTS (
		SELECT 1 FROM `trade_cases` AS `genuine_open`
		WHERE `genuine_open`.`symbol` = `symbol_lifecycle`.`symbol`
			AND `genuine_open`.`status` = 'holding'
			AND `genuine_open`.`simulation_model` = 'contract_v2'
	);--> statement-breakpoint
DELETE FROM `strategy_memory`;--> statement-breakpoint
UPDATE `trade_cases`
SET `learning_applied` = false
WHERE `status` = 'closed' AND `simulation_model` = 'contract_v2';--> statement-breakpoint
UPDATE `trade_cases` AS `current_trade`
SET `account_balance_before_usdt` = 1000 + COALESCE((
	SELECT SUM(`prior_trade`.`net_pnl_usdt`)
	FROM `trade_cases` AS `prior_trade`
	WHERE `prior_trade`.`status` = 'closed'
		AND `prior_trade`.`simulation_model` = 'contract_v2'
		AND `prior_trade`.`exit_at` IS NOT NULL
		AND (`prior_trade`.`exit_at` < COALESCE(`current_trade`.`exit_at`, `current_trade`.`entry_at`)
			OR (`prior_trade`.`exit_at` = COALESCE(`current_trade`.`exit_at`, `current_trade`.`entry_at`) AND `prior_trade`.`id` < `current_trade`.`id`))
), 0)
WHERE `current_trade`.`simulation_model` = 'contract_v2';--> statement-breakpoint
UPDATE `trade_cases`
SET `account_balance_after_usdt` = `account_balance_before_usdt` + COALESCE(`net_pnl_usdt`, 0)
WHERE `status` = 'closed' AND `simulation_model` = 'contract_v2';
