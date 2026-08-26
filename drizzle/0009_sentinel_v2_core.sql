-- Sentinel V2 strategy reset.
-- Old strategy/simulation history is intentionally removed because it was
-- generated under materially different decision rules. Live exchange orders,
-- live credentials and live protection/audit tables are deliberately preserved.
DELETE FROM alert_events;
DELETE FROM symbol_lifecycle;
DELETE FROM strategy_memory;
DELETE FROM regime_state;
DELETE FROM scan_runs;
DELETE FROM trade_cases;

CREATE TABLE `v2_market_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `observed_at` integer NOT NULL,
  `regime` text NOT NULL,
  `confidence` integer NOT NULL,
  `stability` integer NOT NULL,
  `regime_score` integer NOT NULL,
  `regime_margin` integer NOT NULL,
  `transition_risk` integer NOT NULL,
  `transition_velocity` real DEFAULT 0 NOT NULL,
  `risk_acceleration` real DEFAULT 0 NOT NULL,
  `developing_regime` text,
  `permission` text NOT NULL,
  `bias` text NOT NULL,
  `context_json` text NOT NULL,
  `created_at` integer NOT NULL
);
CREATE INDEX `v2_market_snapshots_observed_idx` ON `v2_market_snapshots` (`observed_at`);
CREATE INDEX `v2_market_snapshots_regime_idx` ON `v2_market_snapshots` (`regime`,`observed_at`);

CREATE TABLE `v2_warning_events` (
  `id` text PRIMARY KEY NOT NULL,
  `snapshot_id` text NOT NULL,
  `warning_key` text NOT NULL,
  `observed_at` integer NOT NULL,
  `type` text NOT NULL,
  `level` text NOT NULL,
  `status` text NOT NULL,
  `severity` integer NOT NULL,
  `confidence` integer NOT NULL,
  `relevance` integer NOT NULL,
  `timeframe` text NOT NULL,
  `direction` text NOT NULL,
  `title` text NOT NULL,
  `detail` text NOT NULL,
  `impact` text NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` integer NOT NULL
);
CREATE INDEX `v2_warning_events_time_idx` ON `v2_warning_events` (`observed_at`);
CREATE INDEX `v2_warning_events_type_idx` ON `v2_warning_events` (`type`,`observed_at`);

CREATE TABLE `v2_opportunities` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `observed_at` integer NOT NULL,
  `playbook` text NOT NULL,
  `side` text NOT NULL,
  `state` text NOT NULL,
  `opportunity_score` integer NOT NULL,
  `environment_fit` integer NOT NULL,
  `playbook_fit` integer NOT NULL,
  `structure_score` integer NOT NULL,
  `timing_score` integer NOT NULL,
  `confirmation_score` integer NOT NULL,
  `risk_reward` real DEFAULT 0 NOT NULL,
  `portfolio_impact` integer NOT NULL,
  `risk_multiplier` real DEFAULT 0 NOT NULL,
  `reasons_json` text DEFAULT '[]' NOT NULL,
  `waiting_json` text DEFAULT '[]' NOT NULL,
  `reject_json` text DEFAULT '[]' NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` integer NOT NULL
);
CREATE INDEX `v2_opportunities_symbol_time_idx` ON `v2_opportunities` (`symbol`,`observed_at`);
CREATE INDEX `v2_opportunities_state_time_idx` ON `v2_opportunities` (`state`,`observed_at`);
CREATE INDEX `v2_opportunities_score_idx` ON `v2_opportunities` (`opportunity_score`,`observed_at`);

CREATE TABLE `v2_trade_thesis` (
  `trade_id` text PRIMARY KEY NOT NULL,
  `playbook` text NOT NULL,
  `entry_regime` text NOT NULL,
  `current_regime` text NOT NULL,
  `entry_transition_risk` integer NOT NULL,
  `current_transition_risk` integer NOT NULL,
  `thesis_health` integer DEFAULT 100 NOT NULL,
  `entry_thesis_json` text NOT NULL,
  `current_thesis_json` text NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `v2_trade_thesis_health_idx` ON `v2_trade_thesis` (`thesis_health`,`updated_at`);
