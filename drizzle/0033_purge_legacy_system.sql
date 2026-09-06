-- User-authorized destructive cutover: remove every legacy strategy/history/product table.
-- live_exchange_credentials is deliberately absent and therefore remains byte-for-byte intact.
DROP TABLE IF EXISTS `alert_events`;
--> statement-breakpoint
DROP TABLE IF EXISTS `trade_cases`;
--> statement-breakpoint
DROP TABLE IF EXISTS `symbol_lifecycle`;
--> statement-breakpoint
DROP TABLE IF EXISTS `strategy_memory`;
--> statement-breakpoint
DROP TABLE IF EXISTS `scan_runs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `app_settings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `live_trading_control`;
--> statement-breakpoint
DROP TABLE IF EXISTS `live_orders`;
--> statement-breakpoint
DROP TABLE IF EXISTS `live_audit_events`;
--> statement-breakpoint
DROP TABLE IF EXISTS `push_subscriptions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `regime_state`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_trades`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_simulation_epochs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_paper_reset_state`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_evaluations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_learning`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_trade_charts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_post_exit_observations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_trigger_buckets`;
--> statement-breakpoint
DROP TABLE IF EXISTS `hte31_shadow_samples`;
--> statement-breakpoint
DROP TABLE IF EXISTS `v2_market_snapshots`;
--> statement-breakpoint
DROP TABLE IF EXISTS `v2_warning_events`;
--> statement-breakpoint
DROP TABLE IF EXISTS `v2_opportunities`;
--> statement-breakpoint
DROP TABLE IF EXISTS `v2_trade_thesis`;
--> statement-breakpoint
DROP TABLE IF EXISTS `scalp_risk_days`;
--> statement-breakpoint
DROP TABLE IF EXISTS `__new_app_settings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `user_accounts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `cutover_preflight`;
