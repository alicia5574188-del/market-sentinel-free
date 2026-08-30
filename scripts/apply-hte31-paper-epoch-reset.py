from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    source = target.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    target.write_text(source.replace(old, new, 1))


# 1) Persistent epoch ledger. Historical HTE31 rows remain untouched.
replace_once(
    "db/hte31-schema.ts",
    'export const hte31Evaluations = sqliteTable("hte31_evaluations", {',
    '''export const hte31SimulationEpochs = sqliteTable("hte31_simulation_epochs", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at").notNull(),
  startingCapitalUsdt: real("starting_capital_usdt").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("hte31_simulation_epochs_started_idx").on(table.startedAt),
]);

export const hte31Evaluations = sqliteTable("hte31_evaluations", {''',
)

# 2) Account equity uses only the current epoch's realized PnL. Learning/history stay all-time.
replace_once(
    "lib/hte31-repository.ts",
    '''  hte31PostExitObservations,
  hte31TradeCharts,
  hte31Trades,
} from "../db/hte31-schema";''',
    '''  hte31PostExitObservations,
  hte31SimulationEpochs,
  hte31TradeCharts,
  hte31Trades,
} from "../db/hte31-schema";''',
)

old_account = '''async function accountFromRows(startingCapitalUsdt: number) {
  const rows = await getDb().select().from(hte31Trades).orderBy(desc(hte31Trades.entryAt)).limit(500);
  const closed = rows.filter((row) => row.status === "closed");
  const open = rows.filter((row) => row.status === "holding");
  const realizedPnlUsdt = closed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const realizedBalanceUsdt = startingCapitalUsdt + realizedPnlUsdt;
  const equityUsdt = realizedBalanceUsdt + unrealizedPnlUsdt;
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  return {
    rows,
    closed,
    open,
    account: {
      startingCapitalUsdt,
      realizedPnlUsdt,
      unrealizedPnlUsdt,
      realizedBalanceUsdt,
      equityUsdt,
      usedMarginUsdt,
      availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt),
    },
  };
}'''

new_account = '''async function currentSimulationEpoch(startingCapitalUsdt: number) {
  const [epoch] = await getDb().select().from(hte31SimulationEpochs)
    .orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);
  return epoch ?? {
    id: "hte31-epoch:initial",
    startedAt: 0,
    startingCapitalUsdt,
    createdAt: 0,
  };
}

async function accountFromRows(startingCapitalUsdt: number) {
  const rows = await getDb().select().from(hte31Trades).orderBy(desc(hte31Trades.entryAt)).limit(500);
  const epoch = await currentSimulationEpoch(startingCapitalUsdt);
  const closed = rows.filter((row) => row.status === "closed");
  const open = rows.filter((row) => row.status === "holding");
  const epochClosed = closed.filter((row) => row.entryAt >= epoch.startedAt);
  const realizedPnlUsdt = epochClosed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const realizedBalanceUsdt = epoch.startingCapitalUsdt + realizedPnlUsdt;
  const equityUsdt = realizedBalanceUsdt + unrealizedPnlUsdt;
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  return {
    rows,
    closed,
    open,
    account: {
      startingCapitalUsdt: epoch.startingCapitalUsdt,
      epochId: epoch.id,
      epochStartedAt: epoch.startedAt,
      realizedPnlUsdt,
      unrealizedPnlUsdt,
      realizedBalanceUsdt,
      equityUsdt,
      usedMarginUsdt,
      availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt),
    },
  };
}

export async function resetHte31PaperCapital(startingCapitalUsdt: number, now = Date.now()) {
  const db = getDb();
  const open = await db.select({ id: hte31Trades.id }).from(hte31Trades)
    .where(eq(hte31Trades.status, "holding")).limit(1);
  if (open.length) throw new Error("存在模拟持仓，平仓后才能重置模拟本金");
  const capital = Math.min(1_000_000, Math.max(10, startingCapitalUsdt));
  const epoch = {
    id: `hte31-epoch:${crypto.randomUUID()}`,
    startedAt: now,
    startingCapitalUsdt: capital,
    createdAt: now,
  };
  await db.insert(hte31SimulationEpochs).values(epoch);
  return epoch;
}'''
replace_once("lib/hte31-repository.ts", old_account, new_account)

# 3) Reset current account-level loss streak with the capital epoch, while preserving each trader's all-time guard.
old_governance_head = '''export async function getHte31Governance(now = Date.now()): Promise<Hte31Governance> {
  const rows = await getDb().select().from(hte31Trades)
    .where(eq(hte31Trades.status, "closed"))
    .orderBy(desc(hte31Trades.exitAt)).limit(80);

  const traderGuards = Object.fromEntries(TRADERS.map((traderId) => {'''
new_governance_head = '''export async function getHte31Governance(now = Date.now()): Promise<Hte31Governance> {
  const rows = await getDb().select().from(hte31Trades)
    .where(eq(hte31Trades.status, "closed"))
    .orderBy(desc(hte31Trades.exitAt)).limit(80);
  const [epoch] = await getDb().select().from(hte31SimulationEpochs)
    .orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);
  const accountRows = epoch ? rows.filter((row) => row.entryAt >= epoch.startedAt) : rows;

  const traderGuards = Object.fromEntries(TRADERS.map((traderId) => {'''
replace_once("lib/hte31-repository.ts", old_governance_head, new_governance_head)
replace_once(
    "lib/hte31-repository.ts",
    '''  for (const row of rows) {
    if (isHte31FailureLoss(row)) {''',
    '''  for (const row of accountRows) {
    if (isHte31FailureLoss(row)) {''',
)

# 4) Non-destructive migration.
Path("drizzle/0014_hte31_simulation_epochs.sql").write_text(
    '''CREATE TABLE `hte31_simulation_epochs` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`started_at` integer NOT NULL,\n\t`starting_capital_usdt` real NOT NULL,\n\t`created_at` integer NOT NULL\n);\n--> statement-breakpoint\nCREATE INDEX `hte31_simulation_epochs_started_idx` ON `hte31_simulation_epochs` (`started_at`);\n'''
)

# 5) Owner-only reset endpoint with explicit confirmation.
route = Path("app/api/hte31/paper-reset/route.ts")
route.parent.mkdir(parents=True, exist_ok=True)
route.write_text(
    '''import { resetHte31PaperCapital } from "../../../../lib/hte31-repository";\nimport { getSettings } from "../../../../lib/settings-repository";\nimport { requireApiAccount } from "../../../api-auth";\n\nexport async function POST(request: Request) {\n  const auth = await requireApiAccount();\n  if ("response" in auth) return auth.response;\n  if (auth.account.role !== "owner") return Response.json({ error: "只有站点所有者可以重置模拟本金" }, { status: 403 });\n  try {\n    const origin = request.headers.get("origin");\n    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "cross-origin update rejected" }, { status: 403 });\n    const payload = await request.json() as { confirmed?: boolean };\n    if (payload.confirmed !== true) return Response.json({ error: "需要确认重置模拟本金" }, { status: 400 });\n    const settings = await getSettings();\n    const epoch = await resetHte31PaperCapital(settings.trialCapitalUsdt);\n    return Response.json({ ok: true, epoch }, { headers: { "Cache-Control": "no-store" } });\n  } catch (error) {\n    return Response.json({ error: error instanceof Error ? error.message : "模拟本金重置失败" }, { status: 400 });\n  }\n}\n'''
)

# 6) Concise Settings UI. The product does not expose implementation detail.
replace_once(
    "app/page.tsx",
    '''    startingCapitalUsdt: number;
    realizedPnlUsdt: number;''',
    '''    startingCapitalUsdt: number;
    epochId: string;
    epochStartedAt: number;
    realizedPnlUsdt: number;''',
)
replace_once(
    "app/page.tsx",
    '''  const toggleScan = () => { const enabled = !(dashboard?.settings.scanEnabled ?? true); void mutate("/api/settings", {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({scanEnabled:enabled})}, enabled?"扫描已开启。":"扫描已暂停。", false); };''',
    '''  const resetPaperCapital = () => {
    if (!dashboard) return;
    if (dashboard.openTrades.length) return setMessage("当前有模拟持仓，平仓后才能重置模拟本金。");
    if (!window.confirm(`将模拟本金重置为 ${fmtMoney(dashboard.settings.trialCapitalUsdt)}？历史订单和学习数据会保留。`)) return;
    void mutate("/api/hte31/paper-reset", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmed:true})}, "模拟本金已重置。", false);
  };
  const toggleScan = () => { const enabled = !(dashboard?.settings.scanEnabled ?? true); void mutate("/api/settings", {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({scanEnabled:enabled})}, enabled?"扫描已开启。":"扫描已暂停。", false); };''',
)
replace_once(
    "app/page.tsx",
    '''      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">UNIVERSE</span><h2>核心观察币</h2></div></div><div className="clean-panel clean-form"><label><span>币种，以逗号或空格分隔</span><input value={coreSymbolsText} onChange={(e)=>setCoreSymbolsText(e.target.value)} placeholder="BTC, ETH, SOL, HYPE"/></label><button className="primary" onClick={saveCoreSymbols}>保存核心观察币</button></div></section>''',
    '''      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">SIMULATION</span><h2>模拟资金</h2></div></div><div className="clean-panel"><div className="system-facts"><div className="system-fact"><span>本轮本金</span><b>{fmtMoney(dashboard?.account.startingCapitalUsdt)}</b></div><div className="system-fact"><span>当前权益</span><b>{fmtMoney(dashboard?.account.equityUsdt)}</b></div><div className="system-fact"><span>累计学习样本</span><b>{dashboard?.stats.sampleCount ?? 0}</b></div></div><div className="clean-actions"><button className="danger" disabled={Boolean(dashboard?.openTrades.length)} onClick={resetPaperCapital}>重置模拟本金</button></div></div></section>
      <section className="clean-section"><div className="clean-section-head"><div><span className="eyebrow">UNIVERSE</span><h2>核心观察币</h2></div></div><div className="clean-panel clean-form"><label><span>币种，以逗号或空格分隔</span><input value={coreSymbolsText} onChange={(e)=>setCoreSymbolsText(e.target.value)} placeholder="BTC, ETH, SOL, HYPE"/></label><button className="primary" onClick={saveCoreSymbols}>保存核心观察币</button></div></section>''',
)

# 7) Regression contract: reset accounting only, not learning/history.
Path("tests/hte31-paper-epoch-reset.test.mjs").write_text(
    '''import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\n\nconst repository = readFileSync(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8");\nconst schema = readFileSync(new URL("../db/hte31-schema.ts", import.meta.url), "utf8");\nconst migration = readFileSync(new URL("../drizzle/0014_hte31_simulation_epochs.sql", import.meta.url), "utf8");\nconst route = readFileSync(new URL("../app/api/hte31/paper-reset/route.ts", import.meta.url), "utf8");\nconst page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");\n\ntest("paper capital reset creates a new accounting epoch without deleting learning or history", () => {\n  assert.match(schema, /hte31SimulationEpochs/);\n  assert.match(repository, /epochClosed = closed\\.filter\\(\\(row\\) => row\\.entryAt >= epoch\\.startedAt\\)/);\n  assert.match(repository, /resetHte31PaperCapital/);\n  assert.match(repository, /where\\(eq\\(hte31Trades\\.status, "holding"\\)\\)/);\n  assert.match(repository, /learningRows = await db\\.select\\(\\)\\.from\\(hte31Learning\\)/);\n  assert.match(repository, /closedTrades: closed\\.slice/);\n  assert.doesNotMatch(migration, /DELETE FROM/i);\n  assert.doesNotMatch(route, /DELETE FROM|delete\\(hte31|db\\.delete/i);\n});\n\ntest("account-level loss streak resets with the epoch while trader guards keep all-time history", () => {\n  assert.match(repository, /const accountRows = epoch \\? rows\\.filter\\(\\(row\\) => row\\.entryAt >= epoch\\.startedAt\\) : rows/);\n  assert.match(repository, /const own = rows\\.filter\\(\\(row\\) => row\\.traderId === traderId/);\n  assert.match(repository, /for \\(const row of accountRows\\)/);\n});\n\ntest("paper capital reset is owner-confirmed and blocked while a paper position is open", () => {\n  assert.match(route, /role !== "owner"/);\n  assert.match(route, /confirmed !== true/);\n  assert.match(repository, /存在模拟持仓，平仓后才能重置模拟本金/);\n  assert.match(page, /重置模拟本金/);\n  assert.match(page, /历史订单和学习数据会保留/);\n  assert.match(page, /disabled=\\{Boolean\\(dashboard\\?\\.openTrades\\.length\\)\\}/);\n});\n\ntest("dashboard keeps cumulative samples while current account PnL is epoch scoped", () => {\n  assert.match(repository, /const closed = rows\\.filter/);\n  assert.match(repository, /const epochClosed = closed\\.filter/);\n  assert.match(repository, /sampleCount: closed\\.length/);\n  assert.match(page, /累计学习样本/);\n});\n'''
)
