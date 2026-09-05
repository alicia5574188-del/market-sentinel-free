// Read-only operational acceptance. Uses the existing CI credential; never a
// runtime token, D1 counter write, owner session, or trading action.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BASE = "https://market-sentinel-free.alicia5574188.workers.dev";
const API = "https://api.cloudflare.com/client/v4";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), ...options });
  if (!response.ok) throw new Error(`运行验收读取失败：HTTP ${response.status}`);
  const data = await response.json();
  if (data.errors?.length) throw new Error(`运行验收 API 错误：${data.errors.map((e) => e.message).join("; ")}`);
  return data;
}

export function healthy(data, now = Date.now()) {
  const { scanner, position } = data.schedulers ?? {};
  return data.ok === true && data.schedulerError == null
    && [scanner, position].every((s) => s && !s.lastError && !s.circuitOpen
      && ["live", "starting"].includes(s.state)
      && Number.isFinite(s.lastSuccessAt) && now - s.lastSuccessAt < (s === position ? 360_000 : 180_000))
    && Number.isFinite(position.nextRunAt) && position.nextRunAt > now - 5_000 && position.nextRunAt < now + 90_000;
}

async function checkHealth() {
  const first = await json(`${BASE}/__health`);
  if (!healthy(first)) {
    console.error(JSON.stringify({ check: "scheduler_health", ok: false, schedulerError: first.schedulerError, schedulers: first.schedulers }));
    throw new Error("后台健康检查未通过");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await pause(35_000);
    const next = await json(`${BASE}/__health`);
    if (!healthy(next)) {
      console.error(JSON.stringify({ check: "scheduler_health", ok: false, schedulerError: next.schedulerError, schedulers: next.schedulers }));
      throw new Error("后台健康检查未通过");
    }
    // The idle position heartbeat is deliberately only persisted every five
    // minutes. Its alarm still moves each minute; do not create false outages
    // or increase storage writes merely to satisfy the acceptance probe.
    if (next.schedulers.scanner.lastSuccessAt > first.schedulers.scanner.lastSuccessAt
      && next.schedulers.position.nextRunAt > first.schedulers.position.nextRunAt) {
      console.log(JSON.stringify({ check: "scheduler_progress", ok: true,
        before: first.schedulers, after: next.schedulers }));
      return;
    }
  }
  throw new Error("后台时间戳没有持续推进，不能按健康验收");
}

export function summarizeUsage(groups) {
  if (!Array.isArray(groups) || groups.length === 0 || groups.length >= 10_000) throw new Error("D1 用量缺失或被截断，不能当作零用量");
  return groups.reduce((total, group) => {
    for (const key of ["rowsRead", "rowsWritten"]) {
      const value = group?.sum?.[key];
      if (!Number.isFinite(value) || value < 0) throw new Error("D1 用量字段无效");
      total[key] += value;
    }
    return total;
  }, { rowsRead: 0, rowsWritten: 0 });
}

async function checkD1() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("D1 用量验收缺少现有 Cloudflare 凭据");
  // Wrangler resolves accessible accounts through its supported authentication
  // API. Do not print whoami output, account identity, permissions, or tokens.
  const identity = JSON.parse(execFileSync("npx", ["wrangler", "whoami", "--json"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }));
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? (identity.accounts?.length === 1 ? identity.accounts[0].id : null);
  if (!account) throw new Error("Cloudflare 账户不唯一，D1 用量验收不能猜测账户");
  const now = new Date();
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const rolling = new Date(now.getTime() - 86_400_000); rolling.setUTCMinutes(0, 0, 0);
  const reports = {};
  for (const [window, start] of [["utcDay", day], ["rolling24hRoundedOut", rolling]]) {
    const data = await json(`${API}/graphql`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) {
        viewer { accounts(filter: { accountTag: $accountTag }) {
          d1AnalyticsAdaptiveGroups(limit: 10000, filter: $filter) {
            sum { rowsRead rowsWritten } dimensions { datetimeHour }
          }
        } }
      }`, variables: { accountTag: account, filter: { AND: [{ datetimeHour_geq: start.toISOString(), datetimeHour_leq: now.toISOString() }] } } }),
    });
    reports[window] = summarizeUsage(data.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups);
  }
  console.log(JSON.stringify({ check: "account_d1_usage", measuredAt: now.toISOString(), reports,
    safeThresholds: { rowsRead: 3_250_000, rowsWritten: 65_000 },
    note: "账户全部数据库；UTC 当日与向外取整的最近24小时，分析数据可能延迟；不是未来用量保证" }));
  if (Object.values(reports).some((r) => r.rowsRead >= 3_250_000 || r.rowsWritten >= 65_000)) {
    throw new Error("D1 账户用量已达到安全预警线，需要检查消耗来源");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "health") await checkHealth();
    else if (process.argv[2] === "d1") await checkD1();
    else throw new Error("必须指定 health 或 d1");
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
