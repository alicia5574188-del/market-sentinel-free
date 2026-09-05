import { fetchBenchmarkMomentum, type GlobalRiskContext } from "./gate-client.ts";

export type MacroEvent = {
  title: string;
  time: number;
  source: "BLS" | "Federal Reserve";
  importance: "high" | "medium";
};

export type GlobalRiskPacket = GlobalRiskContext & {
  observedAt: number;
  nextEvents: MacroEvent[];
  calendarEvents?: MacroEvent[];
  options: {
    btcDvol: number | null;
    ethDvol: number | null;
    percentile30d: number | null;
  };
  sources: {
    gateBenchmarks: "live" | "unavailable";
    deribitDvol: "live" | "unavailable";
    blsCalendar: "live" | "unavailable";
    fomcCalendar: "official-static";
    etfFlow: "not-configured";
  };
};

const FOMC_EVENTS: MacroEvent[] = [
  { title: "FOMC 利率决议与发布会", time: Date.parse("2026-09-16T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2026-10-28T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2026-12-09T19:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-01-27T19:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-03-17T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-04-28T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-06-09T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-07-28T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-09-15T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-10-27T18:00:00Z"), source: "Federal Reserve", importance: "high" },
  { title: "FOMC 利率决议与发布会", time: Date.parse("2027-12-08T19:00:00Z"), source: "Federal Reserve", importance: "high" },
];

function unfoldIcs(text: string) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function easternOffsetHours(year: number, month: number, day: number) {
  const midday = new Date(Date.UTC(year, month - 1, day, 12));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" });
  const zone = formatter.formatToParts(midday).find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
  const match = zone.match(/GMT([+-]\d+)/);
  return match ? -Number(match[1]) : 5;
}

function parseIcsTime(value: string) {
  const match = value.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00", zulu] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offset = zulu ? 0 : easternOffsetHours(year, month, day);
  return Date.UTC(year, month - 1, day, hour + offset, minute, second);
}

export function parseBlsCalendar(text: string): MacroEvent[] {
  const blocks = unfoldIcs(text).split("BEGIN:VEVENT").slice(1);
  const highImpact = /Consumer Price Index|Employment Situation|Producer Price Index|Job Openings and Labor Turnover/i;
  return blocks.flatMap((block): MacroEvent[] => {
    const summary = block.match(/\nSUMMARY(?:;[^:]*)?:(.+)/)?.[1]?.trim();
    const rawTime = block.match(/\nDTSTART(?:;[^:]*)?:(\d{8}T\d{4,6}Z?)/)?.[1];
    const time = rawTime ? parseIcsTime(rawTime) : null;
    if (!summary || time == null || !highImpact.test(summary)) return [];
    return [{ title: summary.replace(/\\,/g, ","), time, source: "BLS", importance: highImpact.test(summary) ? "high" : "medium" }];
  }).sort((a, b) => a.time - b.time);
}

async function fetchBlsEvents(signal: AbortSignal) {
  const response = await fetch("https://www.bls.gov/schedule/news_release/bls.ics", { signal, headers: { Accept: "text/calendar" } });
  if (!response.ok) throw new Error(`BLS calendar returned ${response.status}`);
  return parseBlsCalendar(await response.text());
}

function percentile(values: number[], current: number) {
  if (!values.length) return null;
  return values.filter((value) => value <= current).length / values.length;
}

async function fetchDvol(currency: "BTC" | "ETH", now: number, signal: AbortSignal) {
  const start = now - 30 * 24 * 60 * 60 * 1000;
  const params = new URLSearchParams({ currency, start_timestamp: String(start), end_timestamp: String(now), resolution: "3600" });
  const response = await fetch(`https://www.deribit.com/api/v2/public/get_volatility_index_data?${params}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Deribit DVOL returned ${response.status}`);
  const payload = await response.json() as { result?: { data?: unknown[][] } };
  const closes = (payload.result?.data ?? []).map((row) => Number(row[4])).filter(Number.isFinite);
  const current = closes.at(-1) ?? null;
  return { current, values: closes };
}

function eventRisk(events: MacroEvent[], now: number) {
  const next = events.find((event) => event.time >= now - 15 * 60_000);
  if (!next) return { risk: 0, label: null as string | null };
  const hours = (next.time - now) / 3_600_000;
  const risk = hours <= 0.25 ? 1 : hours <= 1.5 ? 0.9 : hours <= 6 ? 0.7 : hours <= 24 ? 0.35 : 0;
  return { risk, label: risk > 0 ? next.title : null };
}

let cachedContext: GlobalRiskPacket | null = null;
let cachedAt = 0;
let pendingContext: Promise<GlobalRiskPacket> | null = null;

async function refreshGlobalRiskContext(now: number): Promise<GlobalRiskPacket> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const [benchmarkResult, dvolResult, blsResult] = await Promise.allSettled([
      fetchBenchmarkMomentum(),
      Promise.all([fetchDvol("BTC", now, controller.signal), fetchDvol("ETH", now, controller.signal)]),
      fetchBlsEvents(controller.signal),
    ]);
    const benchmarkMomentum = benchmarkResult.status === "fulfilled" ? benchmarkResult.value : null;
    const [btcDvol, ethDvol] = dvolResult.status === "fulfilled" ? dvolResult.value : [{ current: null, values: [] }, { current: null, values: [] }];
    const combinedCurrent = [btcDvol.current, ethDvol.current].filter((value): value is number => value != null);
    const currentDvol = combinedCurrent.length ? combinedCurrent.reduce((sum, value) => sum + value, 0) / combinedCurrent.length : null;
    const combinedHistory = [...btcDvol.values, ...ethDvol.values];
    const ivPercentile = currentDvol == null ? null : percentile(combinedHistory, currentDvol);
    const blsEvents = blsResult.status === "fulfilled" ? blsResult.value : [];
    const nextEvents = [...blsEvents, ...FOMC_EVENTS].filter((event) => event.time >= now - 15 * 60_000).sort((a, b) => a.time - b.time).slice(0, 12);
    const macro = eventRisk(nextEvents, now);
    return {
      observedAt: now,
      benchmarkMomentum,
      optionsIvPercentile: ivPercentile,
      macroEventRisk: macro.risk,
      macroEventLabel: macro.label,
      etfFlowScore: null,
      nextEvents,
      calendarEvents: [...blsEvents, ...FOMC_EVENTS].filter((event) => Math.abs(event.time - now) <= 15 * 24 * 3_600_000),
      options: { btcDvol: btcDvol.current, ethDvol: ethDvol.current, percentile30d: ivPercentile },
      sources: {
        gateBenchmarks: benchmarkResult.status === "fulfilled" ? "live" : "unavailable",
        deribitDvol: dvolResult.status === "fulfilled" ? "live" : "unavailable",
        blsCalendar: blsResult.status === "fulfilled" ? "live" : "unavailable",
        fomcCalendar: "official-static",
        etfFlow: "not-configured",
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getGlobalRiskContext(now = Date.now()): Promise<GlobalRiskPacket> {
  if (cachedContext && now - cachedAt < 5 * 60_000 && now >= cachedAt) {
    const macro = eventRisk(cachedContext.nextEvents, now);
    return { ...cachedContext, observedAt: now, macroEventRisk: macro.risk, macroEventLabel: macro.label };
  }
  if (!pendingContext) {
    pendingContext = refreshGlobalRiskContext(now).then((context) => {
      cachedContext = context;
      cachedAt = now;
      return context;
    }).finally(() => { pendingContext = null; });
  }
  return pendingContext;
}
