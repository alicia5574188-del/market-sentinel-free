const BASE = "https://api.gateio.ws/api/v4/futures/usdt";
const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "SUI_USDT", "PEPE_USDT"];
const probes = [
  { label: "2025-09", from: Math.floor(Date.UTC(2025, 8, 1) / 1000) },
  { label: "2026-01", from: Math.floor(Date.UTC(2026, 0, 1) / 1000) },
  { label: "2026-06", from: Math.floor(Date.UTC(2026, 5, 1) / 1000) },
  { label: "2026-08", from: Math.floor(Date.UTC(2026, 7, 1) / 1000) },
];

async function get(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, url: url.toString(), body: text.slice(0, 500) };
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: true, status: response.status, url: url.toString(), data };
}

const report = { generatedAt: new Date().toISOString(), contractStats: [], funding: [] };
for (const symbol of symbols) {
  for (const probe of probes) {
    const result = await get("/contract_stats", { contract: symbol, from: probe.from, interval: "5m", limit: 100 });
    const rows = result.ok && Array.isArray(result.data) ? result.data : [];
    report.contractStats.push({ symbol, label: probe.label, from: probe.from, ok: result.ok, status: result.status,
      count: rows.length, firstTime: rows[0]?.time ?? null, lastTime: rows.at(-1)?.time ?? null,
      first: rows[0] ? { open_interest: rows[0].open_interest, open_interest_usd: rows[0].open_interest_usd,
        long_taker_size: rows[0].long_taker_size, short_taker_size: rows[0].short_taker_size,
        long_liq_usd: rows[0].long_liq_usd_new ?? rows[0].long_liq_usd,
        short_liq_usd: rows[0].short_liq_usd_new ?? rows[0].short_liq_usd,
        lsr_taker: rows[0].lsr_taker, top_lsr_size: rows[0].top_lsr_size } : null,
      error: result.ok ? null : result.body });
  }
  const funding = await get("/funding_rate", { contract: symbol,
    from: Math.floor(Date.UTC(2025, 8, 1) / 1000), to: Math.floor(Date.UTC(2026, 8, 1) / 1000), limit: 1000 });
  const frows = funding.ok && Array.isArray(funding.data) ? funding.data : [];
  report.funding.push({ symbol, ok: funding.ok, status: funding.status, count: frows.length,
    firstTime: frows[0]?.t ?? null, lastTime: frows.at(-1)?.t ?? null,
    firstRate: frows[0]?.r ?? null, lastRate: frows.at(-1)?.r ?? null, error: funding.ok ? null : funding.body });
}
console.log("GATE_FLOW_HISTORY_PROBE=" + JSON.stringify(report, null, 2));
