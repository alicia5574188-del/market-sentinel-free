CREATE TABLE `strategy_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`bayes_alpha` real DEFAULT 1 NOT NULL,
	`bayes_beta` real DEFAULT 1 NOT NULL,
	`average_net_pct` real DEFAULT 0 NOT NULL,
	`average_mfe_pct` real DEFAULT 0 NOT NULL,
	`average_mae_pct` real DEFAULT 0 NOT NULL,
	`gross_profit_sum_pct` real DEFAULT 0 NOT NULL,
	`gross_loss_sum_pct` real DEFAULT 0 NOT NULL,
	`target_exits` integer DEFAULT 0 NOT NULL,
	`stop_exits` integer DEFAULT 0 NOT NULL,
	`reversal_exits` integer DEFAULT 0 NOT NULL,
	`timeout_exits` integer DEFAULT 0 NOT NULL,
	`regime_breakdown_json` text DEFAULT '{}' NOT NULL,
	`last_lesson_json` text DEFAULT '{}' NOT NULL,
	`last_applied_trade_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `strategy_memory_symbol_side_idx` ON `strategy_memory` (`symbol`,`side`);--> statement-breakpoint
CREATE TABLE `symbol_lifecycle` (
	`symbol` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`side` text NOT NULL,
	`active_trade_id` text,
	`cooldown_until` integer,
	`last_transition_at` integer NOT NULL,
	`last_observed_at` integer NOT NULL,
	`decision_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trade_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`active_key` text,
	`symbol` text NOT NULL,
	`status` text DEFAULT 'holding' NOT NULL,
	`side` text NOT NULL,
	`confidence` integer NOT NULL,
	`posterior_long` real,
	`data_quality` real NOT NULL,
	`regime` text NOT NULL,
	`entry_directional_score` real NOT NULL,
	`entry_at` integer NOT NULL,
	`entry_price` real NOT NULL,
	`entry_low` real NOT NULL,
	`entry_high` real NOT NULL,
	`entry_trigger` text NOT NULL,
	`entry_thesis` text NOT NULL,
	`entry_checks_json` text DEFAULT '[]' NOT NULL,
	`exit_rules_json` text DEFAULT '[]' NOT NULL,
	`entry_evidence_json` text DEFAULT '[]' NOT NULL,
	`entry_counter_evidence_json` text DEFAULT '[]' NOT NULL,
	`entry_metrics_json` text DEFAULT '[]' NOT NULL,
	`entry_snapshot_json` text DEFAULT '{}' NOT NULL,
	`initial_stop_price` real NOT NULL,
	`current_stop_price` real NOT NULL,
	`take_profit_1_price` real NOT NULL,
	`take_profit_2_price` real NOT NULL,
	`target_1_hit_at` integer,
	`max_holding_minutes` integer NOT NULL,
	`planned_risk_pct` real NOT NULL,
	`risk_reward` real NOT NULL,
	`risk_budget_usdt` real NOT NULL,
	`suggested_notional_usdt` real NOT NULL,
	`last_price` real NOT NULL,
	`last_evaluated_at` integer NOT NULL,
	`max_price_seen` real NOT NULL,
	`min_price_seen` real NOT NULL,
	`adverse_flow_count` integer DEFAULT 0 NOT NULL,
	`unrealized_gross_pct` real DEFAULT 0 NOT NULL,
	`progress_r` real DEFAULT 0 NOT NULL,
	`exit_at` integer,
	`exit_price` real,
	`exit_code` text,
	`exit_reason` text,
	`exit_evidence_json` text DEFAULT '[]' NOT NULL,
	`exit_metrics_json` text DEFAULT '[]' NOT NULL,
	`gross_move_pct` real,
	`estimated_cost_pct` real,
	`net_move_pct` real,
	`mfe_pct` real,
	`mae_pct` real,
	`hold_minutes` real,
	`lesson_json` text DEFAULT '{}' NOT NULL,
	`learning_applied` integer DEFAULT false NOT NULL,
	`entry_notified` integer DEFAULT false NOT NULL,
	`target_1_notified` integer DEFAULT false NOT NULL,
	`exit_notified` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trade_cases_active_key_unique` ON `trade_cases` (`active_key`);--> statement-breakpoint
CREATE INDEX `trade_cases_symbol_entry_idx` ON `trade_cases` (`symbol`,`entry_at`);--> statement-breakpoint
CREATE INDEX `trade_cases_status_entry_idx` ON `trade_cases` (`status`,`entry_at`);--> statement-breakpoint
CREATE INDEX `trade_cases_exit_idx` ON `trade_cases` (`exit_at`);--> statement-breakpoint
ALTER TABLE `alert_events` ADD `trade_id` text;--> statement-breakpoint
WITH `ranked_confirmations` AS (
	SELECT *, ROW_NUMBER() OVER (PARTITION BY `symbol` ORDER BY `observed_at` DESC, `id` DESC) AS `symbol_rank`
	FROM `alert_events`
	WHERE `state` = 'confirmed'
		AND `outcome_state` = 'open'
		AND `side` IN ('LONG', 'SHORT')
		AND `entry_price` IS NOT NULL
		AND `entry_price` > 0
		AND `invalidation_price` IS NOT NULL
),
`legacy_seed` AS (
	SELECT *, ABS(`entry_price` - `invalidation_price`) AS `risk_per_unit`
	FROM `ranked_confirmations`
	WHERE `symbol_rank` = 1 AND ABS(`entry_price` - `invalidation_price`) > 0
)
INSERT INTO `trade_cases` (
	`id`, `active_key`, `symbol`, `status`, `side`, `confidence`, `posterior_long`, `data_quality`, `regime`,
	`entry_directional_score`, `entry_at`, `entry_price`, `entry_low`, `entry_high`, `entry_trigger`, `entry_thesis`,
	`entry_checks_json`, `exit_rules_json`, `entry_evidence_json`, `entry_counter_evidence_json`, `entry_metrics_json`, `entry_snapshot_json`,
	`initial_stop_price`, `current_stop_price`, `take_profit_1_price`, `take_profit_2_price`, `max_holding_minutes`,
	`planned_risk_pct`, `risk_reward`, `risk_budget_usdt`, `suggested_notional_usdt`, `last_price`, `last_evaluated_at`,
	`max_price_seen`, `min_price_seen`, `entry_notified`
)
SELECT
	'legacy:' || `id`, `symbol`, `symbol`, 'holding', `side`, `confidence`, `posterior_long`, `data_quality`, `regime`,
	`directional_score`, `observed_at`, `entry_price`, COALESCE(`entry_low`, `entry_price`), COALESCE(`entry_high`, `entry_price`),
	`trigger`, `thesis`,
	json_array(
		json_object('key', 'legacy-confirmed', 'label', '旧版确认状态', 'passed', json('true'), 'required', json('true'), 'detail', '该记录在升级前已经确认，现完整迁移为系统跟踪持仓'),
		json_object('key', 'data-quality', 'label', '数据质量', 'passed', json('true'), 'required', json('true'), 'detail', printf('入场时数据质量 %.0f/100', `data_quality` * 100)),
		json_object('key', 'directional-score', 'label', '方向评分', 'passed', json('true'), 'required', json('true'), 'detail', printf('入场方向评分 %.3f', `directional_score`)),
		json_object('key', 'risk-boundary', 'label', '结构止损', 'passed', json('true'), 'required', json('true'), 'detail', printf('升级前已保存失效价 %.8f', `invalidation_price`))
	),
	json_array(
		json_object('code', 'stop_loss', 'label', '结构止损', 'condition', printf('价格触及 %.8f，立即平仓', `invalidation_price`)),
		json_object('code', 'breakeven', 'label', '第一目标保护', 'condition', printf('到达 %.8f（1R）后，止损移动到入场价 %.8f', CASE WHEN `side` = 'LONG' THEN `entry_price` + `risk_per_unit` ELSE `entry_price` - `risk_per_unit` END, `entry_price`)),
		json_object('code', 'take_profit', 'label', '第二目标止盈', 'condition', printf('到达 %.8f（2R），完成平仓', CASE WHEN `side` = 'LONG' THEN `entry_price` + 2 * `risk_per_unit` ELSE `entry_price` - 2 * `risk_per_unit` END)),
		json_object('code', 'structure_reversal', 'label', '结构反转', 'condition', '多源方向分反向达到 0.24 且至少 3 类证据确认，平仓'),
		json_object('code', 'flow_reversal', 'label', '资金流反转', 'condition', 'Spot CVD 与至少一个独立结构源连续 2 轮反向，平仓'),
		json_object('code', 'macro_risk', 'label', '事件风险退出', 'condition', '宏观事件风险达到 85/100，平仓'),
		json_object('code', 'timeout', 'label', '时间止损', 'condition', '迁移后首次复核若已超过 120 分钟，按实时价格完成平仓')
	),
	`evidence_json`, `counter_evidence_json`, `metrics_json`, `source_snapshot_json`,
	`invalidation_price`, `invalidation_price`,
	CASE WHEN `side` = 'LONG' THEN `entry_price` + `risk_per_unit` ELSE `entry_price` - `risk_per_unit` END,
	CASE WHEN `side` = 'LONG' THEN `entry_price` + 2 * `risk_per_unit` ELSE `entry_price` - 2 * `risk_per_unit` END,
	120, `risk_per_unit` / `entry_price` * 100, 2,
	MIN(1.25, 100 * `risk_per_unit` / `entry_price`),
	MIN(100, 1.25 / (`risk_per_unit` / `entry_price`)),
	`entry_price`, `observed_at`, COALESCE(`max_price_seen`, `entry_price`), COALESCE(`min_price_seen`, `entry_price`), `notified`
FROM `legacy_seed`
WHERE true
ON CONFLICT (`active_key`) DO NOTHING;--> statement-breakpoint
UPDATE `alert_events`
SET `trade_id` = 'legacy:' || `id`
WHERE 'legacy:' || `id` IN (SELECT `id` FROM `trade_cases`);--> statement-breakpoint
INSERT INTO `symbol_lifecycle` (`symbol`, `state`, `side`, `active_trade_id`, `cooldown_until`, `last_transition_at`, `last_observed_at`, `decision_json`)
SELECT `symbol`, 'holding', `side`, `id`, NULL, `entry_at`, `last_evaluated_at`, json_object('migration', 'legacy confirmed alert converted to holding trade', 'tradeId', `id`)
FROM `trade_cases`
WHERE `id` LIKE 'legacy:%'
ON CONFLICT (`symbol`) DO UPDATE SET
	`state` = 'holding',
	`side` = excluded.`side`,
	`active_trade_id` = excluded.`active_trade_id`,
	`cooldown_until` = NULL,
	`last_transition_at` = excluded.`last_transition_at`,
	`last_observed_at` = excluded.`last_observed_at`,
	`decision_json` = excluded.`decision_json`;
