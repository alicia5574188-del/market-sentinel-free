import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const liveExchangeCredentials = sqliteTable("live_exchange_credentials", {
  id: integer("id").primaryKey().default(1), exchange: text("exchange").notNull().default("gate"),
  environment: text("environment").notNull().default("testnet"), ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(), cryptoVersion: integer("crypto_version").notNull().default(1), keyHint: text("key_hint").notNull(),
  gateUserId: text("gate_user_id"), ownerAccountId: text("owner_account_id"), permissionSummaryJson: text("permission_summary_json").notNull().default("{}"),
  status: text("status").notNull().default("verified"), lastVerifiedAt: integer("last_verified_at"), lastError: text("last_error"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});

export const systemSettings = sqliteTable("system_settings", {
  id: integer("id").primaryKey(), mode: text("mode").notNull().default("PAPER"), paperEquity: real("paper_equity").notNull().default(1000),
  equityVersion: integer("equity_version").notNull().default(0), portfolioRiskCap: real("portfolio_risk_cap").notNull().default(0.05), updatedAt: integer("updated_at").notNull(),
});

export const paperPlans = sqliteTable("paper_plans", {
  id: text("id").primaryKey(), symbol: text("symbol").notNull(), marketState: text("market_state").notNull(), side: text("side").notNull(),
  state: text("state").notNull(), createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
  entryTrigger: real("entry_trigger").notNull(), invalidation: real("invalidation").notNull(), target: real("target").notNull(),
  plannedRisk: real("planned_risk").notNull(), notional: real("notional").notNull(), score: real("score").notNull(), reasonJson: text("reason_json").notNull().default("[]"),
}, (table) => [index("paper_plans_symbol_time_idx").on(table.symbol, table.createdAt)]);

export const paperPositions = sqliteTable("paper_positions", {
  id: text("id").primaryKey(), symbol: text("symbol").notNull(), marketState: text("market_state").notNull(), side: text("side").notNull(), status: text("status").notNull(),
  entryAt: integer("entry_at").notNull(), entryPrice: real("entry_price").notNull(), initialStop: real("initial_stop").notNull(), currentStop: real("current_stop").notNull(),
  currentTarget: real("current_target").notNull(), targetIdentity: text("target_identity").notNull(), plannedRisk: real("planned_risk").notNull(), notional: real("notional").notNull(),
  exitAt: integer("exit_at"), exitPrice: real("exit_price"), exitReason: text("exit_reason"), realizedPnl: real("realized_pnl"),
  feesAndSlippage: real("fees_and_slippage"), mirrorVersion: integer("mirror_version").notNull().default(0),
}, (table) => [index("paper_positions_status_time_idx").on(table.status, table.entryAt)]);

export const paperEvents = sqliteTable("paper_events", {
  id: text("id").primaryKey(), symbol: text("symbol").notNull(), eventType: text("event_type").notNull(),
  observedAt: integer("observed_at").notNull(), payloadJson: text("payload_json").notNull().default("{}"),
}, (table) => [index("paper_events_time_idx").on(table.observedAt)]);
