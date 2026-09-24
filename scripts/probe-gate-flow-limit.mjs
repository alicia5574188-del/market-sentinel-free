const BASE = "https://api.gateio.ws/api/v4/futures/usdt/contract_stats";
const from = Math.floor(Date.UTC(2026, 7, 1) / 1000);
for (const interval of ["5m", "15m", "30m", "1h"]) {
  for (const limit of [100, 500, 1000, 2000]) {
    const url = new URL(BASE);
    url.searchParams.set("contract", "BTC_USDT");
    url.searchParams.set("from", String(from));
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await response.text();
    let rows=[]; try { const parsed=JSON.parse(body); if(Array.isArray(parsed)) rows=parsed; } catch {}
    console.log(JSON.stringify({ interval, limit, status: response.status, count: rows.length,
      first: rows[0]?.time ?? null, last: rows.at(-1)?.time ?? null,
      spanHours: rows.length ? (rows.at(-1).time - rows[0].time) / 3600 : 0,
      error: response.ok ? null : body.slice(0,300) }));
  }
}
