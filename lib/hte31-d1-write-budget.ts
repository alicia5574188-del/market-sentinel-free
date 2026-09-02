export const D1_FREE_DAILY_ROWS_WRITTEN = 100_000;
export const HTE31_D1_PLANNED_DAILY_CEILING = 60_000;
export const HTE31_POSITION_CHECKPOINT_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;
const SCANNER_INTERVAL_MS = 60_000;
const STRATEGY_COUNT = 13;
const MAX_OPEN_POSITIONS = 5;

/**
 * Scheduled D1 writes under the maximum configured five-position load.
 * Lifecycle, post-exit, settings and other event-driven writes consume the
 * remaining reserve instead of competing with an unbounded quote heartbeat.
 */
export function hte31ScheduledDailyWriteBudget() {
  const scannerCycles = DAY_MS / SCANNER_INTERVAL_MS;
  const evaluationRows = scannerCycles * STRATEGY_COUNT;
  const diagnosticRows = scannerCycles;
  const positionCheckpointRows = DAY_MS / HTE31_POSITION_CHECKPOINT_MS * MAX_OPEN_POSITIONS;
  const scheduledRows = evaluationRows + diagnosticRows + positionCheckpointRows;
  return {
    dailyLimit: D1_FREE_DAILY_ROWS_WRITTEN,
    plannedCeiling: HTE31_D1_PLANNED_DAILY_CEILING,
    evaluationRows,
    diagnosticRows,
    positionCheckpointRows,
    scheduledRows,
    eventReserveRows: D1_FREE_DAILY_ROWS_WRITTEN - scheduledRows,
  };
}

export function shouldPersistHte31HoldingCheckpoint(input: {
  lastEvaluatedAt: number;
  observedAt: number;
  protectionChanged: boolean;
}) {
  return input.protectionChanged
    || input.observedAt - input.lastEvaluatedAt >= HTE31_POSITION_CHECKPOINT_MS;
}
