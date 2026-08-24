ALTER TABLE `live_trading_control` ADD `account_equity_peak_usdt` real;--> statement-breakpoint
ALTER TABLE `live_trading_control` ADD `account_equity_last_usdt` real;--> statement-breakpoint
ALTER TABLE `live_trading_control` ADD `daily_realized_pnl_usdt` real;--> statement-breakpoint
ALTER TABLE `live_trading_control` ADD `daily_pnl_date` text;--> statement-breakpoint
ALTER TABLE `live_trading_control` ADD `account_risk_checked_at` integer;