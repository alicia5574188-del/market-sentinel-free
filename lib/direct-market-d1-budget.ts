export const CLOUDFLARE_D1_FREE_DAILY_ROWS_WRITTEN = 100_000;

// Keep the whole account below the 75% warning level observed by the owner.
// The deploy gate verifies account-wide usage; the runtime meter protects this
// application's own contribution without storing a Cloudflare API token.
export const DIRECT_MARKET_ACCOUNT_SAFE_ROWS_WRITTEN = 65_000;
export const DIRECT_MARKET_APP_HARD_ROWS_WRITTEN = 30_000;
export const DIRECT_MARKET_NEW_ORDER_ADMISSION_ROWS = 22_000;

export const DIRECT_MARKET_MAX_OPEN_POSITIONS = 3;
export const DIRECT_MARKET_POSITION_CHECKPOINT_MS = 60_000;
export const DIRECT_MARKET_MAX_NEW_ORDERS_PER_UTC_DAY = 120;
export const DIRECT_MARKET_RESERVED_ROWS_PER_NEW_ORDER = 100;

const DAY_MS = 24 * 60 * 60_000;

export function indexAdjustedRows(logicalRows: number, indexEntriesPerRow: number) {
  return logicalRows * (1 + indexEntriesPerRow);
}

/**
 * Conservative proof of why the deployed logical-row budget can exhaust D1.
 * Evaluation rows touch the table, text primary-key index and three explicit
 * indexes. Diagnostic rows touch the table, primary-key index and one explicit
 * index. Holding updates receive no index discount in this upper bound.
 */
export function legacyHte31IndexAdjustedDailyUpperBound() {
  const evaluationLogicalRows = 18_720;
  const diagnosticLogicalRows = 1_440;
  const positionCheckpointLogicalRows = 7_200;
  const evaluationPhysicalRows = indexAdjustedRows(evaluationLogicalRows, 4);
  const diagnosticPhysicalRows = indexAdjustedRows(diagnosticLogicalRows, 2);
  const positionCheckpointPhysicalRows = positionCheckpointLogicalRows;
  return {
    evaluationLogicalRows,
    diagnosticLogicalRows,
    positionCheckpointLogicalRows,
    evaluationPhysicalRows,
    diagnosticPhysicalRows,
    positionCheckpointPhysicalRows,
    physicalRowsUpperBound:
      evaluationPhysicalRows + diagnosticPhysicalRows + positionCheckpointPhysicalRows,
  };
}

/**
 * The fifteen-coin scans persist only bounded Durable Object snapshots. D1 is
 * reserved for positions and real lifecycle evidence. A 2x checkpoint factor
 * deliberately covers table/index/accounting uncertainty until production D1
 * query metadata confirms a lower observed value.
 */
export function directMarketIndexAdjustedDailyBudget() {
  const scannerRows = 0;
  const evaluationRows = 0;
  const diagnosticRows = 0;
  const positionCheckpointLogicalRows =
    (DAY_MS / DIRECT_MARKET_POSITION_CHECKPOINT_MS) * DIRECT_MARKET_MAX_OPEN_POSITIONS;
  const positionCheckpointPhysicalRows = positionCheckpointLogicalRows * 2;
  const admittedTradeLifecycleRows =
    DIRECT_MARKET_MAX_NEW_ORDERS_PER_UTC_DAY * DIRECT_MARKET_RESERVED_ROWS_PER_NEW_ORDER;
  const mandatoryReserveRows =
    DIRECT_MARKET_APP_HARD_ROWS_WRITTEN
    - positionCheckpointPhysicalRows
    - admittedTradeLifecycleRows;
  return {
    scannerRows,
    evaluationRows,
    diagnosticRows,
    positionCheckpointLogicalRows,
    positionCheckpointPhysicalRows,
    admittedTradeLifecycleRows,
    mandatoryReserveRows,
    plannedPhysicalRows:
      positionCheckpointPhysicalRows + admittedTradeLifecycleRows + mandatoryReserveRows,
    appHardLimit: DIRECT_MARKET_APP_HARD_ROWS_WRITTEN,
    accountSafeLimit: DIRECT_MARKET_ACCOUNT_SAFE_ROWS_WRITTEN,
    freeDailyLimit: CLOUDFLARE_D1_FREE_DAILY_ROWS_WRITTEN,
    freeLimitHeadroom: CLOUDFLARE_D1_FREE_DAILY_ROWS_WRITTEN - DIRECT_MARKET_APP_HARD_ROWS_WRITTEN,
  };
}

export type DirectMarketD1Admission = {
  allowed: boolean;
  projectedRows: number;
  reason: "within_budget" | "daily_order_cap" | "new_order_reserve" | "hard_limit";
};

export function directMarketD1Admission(input: {
  estimatedPhysicalRowsToday: number;
  committedMandatoryRows: number;
  newOrdersToday: number;
  nextTradeReserveRows?: number;
}): DirectMarketD1Admission {
  const reserve = input.nextTradeReserveRows ?? DIRECT_MARKET_RESERVED_ROWS_PER_NEW_ORDER;
  const projectedRows = input.estimatedPhysicalRowsToday + input.committedMandatoryRows + reserve;
  if (input.estimatedPhysicalRowsToday >= DIRECT_MARKET_APP_HARD_ROWS_WRITTEN) {
    return { allowed: false, projectedRows, reason: "hard_limit" };
  }
  if (input.newOrdersToday >= DIRECT_MARKET_MAX_NEW_ORDERS_PER_UTC_DAY) {
    return { allowed: false, projectedRows, reason: "daily_order_cap" };
  }
  if (projectedRows > DIRECT_MARKET_NEW_ORDER_ADMISSION_ROWS) {
    return { allowed: false, projectedRows, reason: "new_order_reserve" };
  }
  return { allowed: true, projectedRows, reason: "within_budget" };
}

