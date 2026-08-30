import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { appSettings } from "../db/schema";
import { publicRiskPolicy } from "./risk-policy.ts";

export type AppSettings = typeof appSettings.$inferSelect;

const DEFAULT_SETTINGS: typeof appSettings.$inferInsert = {
  id: 1,
  alertStyle: "balanced",
  universeLimit: 30,
  deepScanLimit: 8,
  minConfidence: 72,
  coreSymbolsJson: '["BTC_USDT","ETH_USDT","SOL_USDT","HYPE_USDT"]',
  roundTripCostBps: 8,
  trialCapitalUsdt: 1000,
  maxRiskPerAlertUsdt: 10,
  dailyPauseUsdt: 30,
  maxDrawdownUsdt: 100,
  scanEnabled: true,
  pushEnabled: false,
  updatedAt: Date.now(),
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function getSettings(): Promise<AppSettings> {
  const db = getDb();
  const [existing] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (existing) return existing;
  await db.insert(appSettings).values(DEFAULT_SETTINGS).onConflictDoNothing();
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (!settings) throw new Error("Unable to initialize settings");
  return settings;
}

export async function updateSettings(patch: Partial<Pick<AppSettings,
  "alertStyle" | "universeLimit" | "deepScanLimit" | "minConfidence" | "roundTripCostBps" |
  "trialCapitalUsdt" | "scanEnabled" | "pushEnabled"
>> & { coreSymbols?: string[] }) {
  const db = getDb();
  await getSettings();
  const values: Partial<typeof appSettings.$inferInsert> = { updatedAt: Date.now() };
  if (patch.alertStyle && ["early", "balanced", "confirmed"].includes(patch.alertStyle)) values.alertStyle = patch.alertStyle;
  if (Number.isFinite(patch.universeLimit)) values.universeLimit = Math.round(Math.min(50, Math.max(4, patch.universeLimit!)));
  if (Number.isFinite(patch.deepScanLimit)) values.deepScanLimit = Math.round(Math.min(12, Math.max(2, patch.deepScanLimit!)));
  if (Number.isFinite(patch.minConfidence)) values.minConfidence = Math.round(Math.min(90, Math.max(55, patch.minConfidence!)));
  if (Number.isFinite(patch.roundTripCostBps)) values.roundTripCostBps = Math.min(100, Math.max(0, patch.roundTripCostBps!));
  if (Number.isFinite(patch.trialCapitalUsdt)) values.trialCapitalUsdt = Math.min(1_000_000, Math.max(10, patch.trialCapitalUsdt!));
  if (typeof patch.scanEnabled === "boolean") values.scanEnabled = patch.scanEnabled;
  if (typeof patch.pushEnabled === "boolean") values.pushEnabled = patch.pushEnabled;
  if (patch.coreSymbols) values.coreSymbolsJson = JSON.stringify(patch.coreSymbols.filter((symbol) => /^[A-Z0-9]{2,18}_USDT$/.test(symbol)).slice(0, 20));
  await db.update(appSettings).set(values).where(eq(appSettings.id, 1));
  return getSettings();
}

export function publicSettings(settings: AppSettings) {
  const current: Partial<AppSettings> = { ...settings };
  delete current.maxRiskPerAlertUsdt;
  delete current.dailyPauseUsdt;
  delete current.maxDrawdownUsdt;
  return { ...current, coreSymbols: parseJson<string[]>(settings.coreSymbolsJson, []), riskPolicy: publicRiskPolicy() };
}
