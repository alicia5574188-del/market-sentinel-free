from pathlib import Path
import hashlib

def patch(path, before, after, edits):
    p = Path(path)
    old = p.read_bytes()
    assert hashlib.sha256(old).hexdigest() == before, f"Base mismatch: {path}"
    lines = old.decode("utf-8").splitlines(keepends=True)
    for start, end, text in reversed(edits):
        lines[start:end] = [text]
    result = "".join(lines).encode("utf-8")
    assert hashlib.sha256(result).hexdigest() == after, f"Target mismatch: {path}"
    p.write_bytes(result)
    print("verified", path, after)

patch('.codex/goal-to-done/DECISIONS.md', 'a918c7825766d7f6ee32c6e0a448eca92ceda6f0d4ae7954aae69aec9d18b203', '691f9a5450c276c564adc3a22ced942b2abcaccb93858c726b72d65ac78d1155', [
(0, 0, r'''# Forward implementation decision — 2026-09-16

- User's latest request replaces historical-profit research with real-feed forward operation and a major default UI rebuild. Generate condition/response rules within a bounded grammar; do not promise unconstrained algorithm invention or month doubling.
- Keep the core version identifier unchanged because old constructor cutover uses it as a migration trigger. Version the new module separately and expose exact build SHA; do not reset legacy accounts during a presentation release.
- New rules run a separate 1000U PAPER ledger and are physically absent from canonicalLivePortfolio. Owner intent, credentials and existing stops are preserved. Old regimes get allowNewEntries=false.
- Market measurements mature only from post-start future bars and are not shadow trades. Entry/exit costs, rule revisions, missing data and all genuine simulated transactions persist atomically and are archived for later audits.
- Maintain Top30 five-minute learning paths independent of rotating real-time book slots; prioritize open-position books. Persist in 80KiB digest-verified chunks plus immutable per-cycle archives using the existing non-alarm write reserve, no new D1 table or data purge.
- Default UI is real-data-only. Empty/unready states show missing evidence, not fake opportunities. Existing owner/LIVE controls remain accessible in legacy management with no automatic login prompt.
- Existing GitHub scheduled path deploys only when online buildSha differs from main; exact same-build jobs skip redeployment.

'''),
])

patch('.codex/goal-to-done/GOAL.md', '72127694d79527452b0ffac24133672f65ccbe9d3e06c4c2524d20f1d9c695e7', 'fc1814c14f82fe7be61b686b0025212088b15c501818e514889e4698a35c41ce', [
(0, 0, r'''# Active release — forward market-relation generation / 2026-09-16

The user explicitly authorizes direct implementation, major UI replacement and main deployment using the already working path. No further historical-profit search is a prerequisite. Run real market data through a PAPER-only generated-rule system and retain forward evidence for later optimization. Net monthly doubling is a goal, not a release claim. Earlier fixed-authority/turnover goals below are historical, not current requirements.

- Stop all old frozen-regime new entries; preserve old account history, open-position protection, credentials and exact owner LIVE intent.
- Create a separate 1,000U forward experiment, collect only post-start condition/response pairs, generate bounded conditions/directions/exit logic with immutable versions, and execute only with fresh validated quotes and integer lots.
- No historical losing-strategy replay or resurrection, no shadow promotion, no autonomous Gate orders, no arbitrary self-modifying code.
- Make process, uncertainty, cost assumptions, rule changes and realized/unrealized results visible in a new five-tab mobile UI.
- Functional causality, accounting, serialization, stale/duplicate protection, browser layout and release checks precede main merge. Historical return metrics are not invented.

'''),
])

patch('.codex/goal-to-done/STATUS.md', '88e2dbfdaafb6fda315b2ae18289daf50fe26469ad786e349d4759733b48ff1e', 'c5d780c4f296e5e2500fbee63c5315a4ec24b945dc87e8c162ee690f517c7174', [
(0, 0, r'''# Release candidate — forward relation engine / 2026-09-16

Implementation and mobile/desktop UI are complete in PR #293. New module reads the existing real market feed, stores only new forward response measurements, generates auditable bounded rules and controls a separate PAPER ledger. Old frozen regimes are retired from new entry. No new rule can reach the existing Gate LIVE order source.

Local tests passed (292 direct tests including 24 forward tests, 17 architecture/migration tests, typecheck, lint, build and Cloudflare dry-run). Browser component checks passed at 320/393/1440 pixels across all five tabs, without JS errors, horizontal overflow or dialogs. Reviewed main deployment and advancing-production checks remain until their CI records are attached to the PR. No historical profitability result is claimed. Never interpret this candidate heading as deployment completion.

'''),
])

patch('.github/workflows/sentinel-v2-ci.yml', 'abbcacdf00f801fb96fec9710f0e8f0ef0b63668638c2de5936b1d5758ae05f3', 'b8bbf74b79068f7e70e174de1126e1e7f75c0b0bbc125fde114e4f83478d6a31', [
(9, 11, r'''    # Connector-authored main merges may not emit push. The read-only
    # deployment-plan skips already deployed commits; no repeated redeploy.
'''),
(982, 982, r'''  deployment-plan:
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')
    runs-on: ubuntu-latest
    timeout-minutes: 2
    outputs:
      required: ${{ steps.plan.outputs.required }}
    steps:
      - id: plan
        name: Skip an already deployed exact main commit
        shell: bash
        run: |
          set -euo pipefail
          body="$(curl -sS --max-time 15 "$WORKER_BASE_URL/__health" || true)"
          deployed="$(jq -r '.runtime.buildSha // empty' <<<"$body" 2>/dev/null || true)"
          if [[ "$deployed" == "$GITHUB_SHA" ]]; then
            echo "required=false" >> "$GITHUB_OUTPUT"
            echo "Exact main commit already deployed; skipping redundant rebuild/redeploy."
          else
            echo "required=true" >> "$GITHUB_OUTPUT"
          fi

'''),
(983, 985, r'''    if: always() && needs.deployment-plan.outputs.required == 'true' && github.ref == 'refs/heads/main' && (needs.verify.result == 'success' || github.event_name == 'schedule')
    needs: [verify, deployment-plan]
'''),
(1001, 1001, r'''      - name: Require the current main head and retain owner intent
        working-directory: release
        run: |
          set -euo pipefail
          current="$(git ls-remote origin refs/heads/main | cut -f1)"
          [[ "$current" == "$GITHUB_SHA" ]]
          curl -fsS --retry 2 --max-time 20 "$WORKER_BASE_URL/__health" > "$RUNNER_TEMP/owner-intent-before.json"
          jq -e '(.runtime.liveMode.requestedEnabled | type) == "boolean"' "$RUNNER_TEMP/owner-intent-before.json" >/dev/null
'''),
(1048, 1049, r'''              .runtime.strategyArena.shadowCount == 0 and .runtime.strategyArena.activeCount == 0 and
              .runtime.legacyRetired == true and
              .runtime.forward.version == "forward-relations-v1.0" and
              .runtime.forward.liveEligible == false and
              .runtime.forward.storage.persistedAt > 0 and
              .runtime.forward.storage.error == null and
'''),
(1130, 1131, r'''          grep -Fq '哨兵 · 关系引擎' "$RUNNER_TEMP/main-page.html"
          jq -e --arg sha "$GITHUB_SHA" '.runtime.buildSha == $sha' "$RUNNER_TEMP/main-health.json" >/dev/null
          before="$(jq -r '.runtime.liveMode.requestedEnabled' "$RUNNER_TEMP/owner-intent-before.json")"
          after="$(jq -r '.runtime.liveMode.requestedEnabled' "$RUNNER_TEMP/main-health.json")"
          [[ "$before" == "$after" ]]
          curl -fsS --retry 2 --max-time 20 "$WORKER_BASE_URL/api/forward/export" > "$RUNNER_TEMP/forward-export.json"
          jq -e '.forward.liveEligible == false and .forward.storage.error == null and .forward.storage.persistedAt > 0' "$RUNNER_TEMP/forward-export.json" >/dev/null
          curl -fsS --retry 2 --max-time 20 "$WORKER_BASE_URL/api/forward/archive" > "$RUNNER_TEMP/forward-archive.json"
          jq -e '.immutable == true and (.items | length) > 0' "$RUNNER_TEMP/forward-archive.json" >/dev/null
          echo "Forward PAPER is persisted; exact main build and unchanged owner LIVE intent verified."
'''),
(1212, 1213, r'''            .runtime.strategyArena.shadowCount == 0 and .runtime.strategyArena.activeCount == 0 and
              .runtime.legacyRetired == true and
              .runtime.forward.version == "forward-relations-v1.0" and
              .runtime.forward.liveEligible == false and
              .runtime.forward.storage.persistedAt > 0 and
              .runtime.forward.storage.error == null and
'''),
(1280, 1281, r'''          grep -Fq '哨兵 · 关系引擎' "$RUNNER_TEMP/monitor-page.html"
'''),
])

patch('AGENTS.md', '11094b9098bef11408c72104152809fc4a3b33f7dafcd85b6766333a55b15e93', 'a5ffb338b5d5778656c43dbe359bc9c941939d99bae1ccc6d2147e0e7de26242', [
(1, 1, r'''
Current authority addition (2026-09-16): `lib/forward-relations.ts` is the user-authorized real-feed PAPER-only generated-rule engine. Old frozen regime strategies have no new-entry authority. Their records, existing protective lifecycle and canonical LIVE source remain intact. Do not wire generated rules to LIVE. Preserve forward state and archives through deployments; never seed historical outcomes or reset on corruption. User requested direct main deployment after functional verification, not another profitability backtest. Read the newest sections before historical decisions.
'''),
])

patch('README.md', '271f0321801e370304c4265e63e551df15e3759eed9e9e2a43ad3952e0156b7c', '5d07ed50c0ae8fa94209b9a7ac4c6f99ceecb5407cd8a2d0ca42ceec886da19c', [
(0, 0, r'''# 哨兵 · 关系引擎 — 真实行情前向实验

当前版本：`forward-relations-v1.0`。**真实 Gate USDT 永续行情 + 独立 1,000 USDT PAPER 账户**。这是功能上线，不是已经证明盈利或月复利翻倍。新规则绝不进入 Gate 私有下单路径。

## 当前运行方式

- 使用现有单一 `MarketStream` 数据源，保留最多30个流动性标的5分钟路径；旧K线仅计算启动特征。只记录部署启动之后的条件与随后真正发生的15/60/180分钟反应，不导入历史收益或交易。
- 按时间去重、同币同期限不重叠测量；反应区间断口作废。市场测量不是影子订单，不设连胜晋级。
- 每15分钟按已完成的新反应生成有限、可审计的规则语法：至多两个特征条件，方向由条件反应估计，期限从15/60/180分钟选择，生成止损、保护启动、回吐边界和反应期限退出。量化阈值来自较早样本；较晚时间组作检查，重叠端点隔离。多重筛选仍有偏差，绝不称盲测或胜率。
- 规则有不可变版本与父版本、生成/修订/休眠/再识别理由。已开仓冻结原始风险边界，新证据不能扩大它；反应回吐或连续两个完成K线的相反新证据可退出。
- PAPER使用当时新鲜、顺序核对完成的买卖价与合约整数张数；不以旧K线补单，不伪造最高点退出。开平仓费用各7bp、额外滑点各2.5bp，加实际价差；每日2bp不利资金费用占位。这不是账户真实费率和资金费结算，不能称交易所真实成交。
- 初始实验预算：单笔风险1.5%，总10%，同向6.5%，总名义额4倍；按当前净值计算。不是最佳杠杆结论，也不保证回撤。月复利翻倍仅是待检验目标。

## 页面与数据

新版默认五页：**总览 / 规则 / 交易 / 演变 / 系统**。启动时明确显示数据积累，不预置规则、图表或成功订单。旧账户与所有者管理由“系统”页进入；原凭据、LIVE开关选择、历史和已有仓位保护不改。旧五行情系统不再新开仓，旧账户不是新实验成绩的一部分。

学习状态、账户和去重信息使用校验分片原子持久化。规则与成交必须保存成功才发布；失败不自动清空本金。全部新样本、规则版本、成交和账户路径另外写入不可变归档，供后续分析和受测的软件优化。页面展示滚动记录，完整内容分页读取：

- `/api/runtime` 的 `forward`：当前前向账户、规则、观测进度、状态及成本。
- `/api/forward/export`：当前账户和滚动样本快照。
- `/api/forward/archive?cursor=...`：每页25个不可变归档包，使用返回的 `nextCursor` 继续，null表示结束。
- `/__health`：核心运行状态、新模块持久化状态和精确发布 `buildSha`。

每日净值是定时采样点，`exactBoundary=false`，不冒充精确午夜结算。累计净值以当前可观察退出报价计浮动盈亏和退出成本；陈旧持仓估值明确标记并阻止新增风险。仅有已见盘口保护，不声称复现交易所标记价格强平或真实排队成交。

## 验证与部署

```bash
npm run test:direct
npm run test:forward
npm test
npm run typecheck
npm run lint
npx wrangler deploy --dry-run --config dist/server/wrangler.json
git diff --check
```

发布仅通过已验证的 GitHub `main` → Cloudflare 路径。调度先比对线上 `buildSha`，相同提交不反复部署；发布后核验页面、新模块持久化和所有者LIVE选择未变。不要求额外插件或登录弹窗。生成器没有任意代码执行权限，扩展表达能力需要新的代码审查和功能测试。

---

# 历史版本说明（退役新开仓，不是当前主系统）

'''),
])

patch('app/layout.tsx', 'd4f82ca07b916094a727d89c2e740577f312a1e0b9bda38a99bcacbaa4ed863c', '1413487a991bc09ddb97eb4d80ebe873add25bd627367e595285babc54009db1', [
(2, 2, r'''import "./forward-dashboard.css";
'''),
(6, 9, r'''  title: "哨兵 · 关系引擎 | 前向实验",
  description: "真实行情驱动的关系观测、规则生成、模拟交易与可审计演变；新规则仅模拟",
  applicationName: "哨兵关系引擎",
'''),
(12, 13, r'''export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#f3f4f0" };
'''),
])

patch('app/page.tsx', '3d80af4d046ab149c0cfdc429ab61edd9032d8b5271084a2c52b57d54c6d5cec', 'dfdaf4cab1bb7615b6e775cc05a0632f48c461df85540985a9cefc2bdf90e9c1', [
(5, 5, r'''import ForwardDashboard from "./forward-dashboard.tsx";
import type { forwardSummary } from "../lib/forward-relations.ts";
'''),
(142, 142, r'''  forward?: ReturnType<typeof forwardSummary>;
  legacyRetired?: boolean;
'''),
(231, 231, r'''  const [legacyConsole, setLegacyConsole] = useState(false);
'''),
(434, 434, r'''  if (!legacyConsole) return <ForwardDashboard data={runtime?.forward?.startedAt ? runtime.forward : null}
    healthy={backendOperational} feedAt={runtime?.lastSuccessAt ?? null}
    error={runtime?.forward?.storage?.error ?? error} onLegacy={() => { setLegacyConsole(true); setTab("history"); window.scrollTo(0,0); }} />;

'''),
(435, 435, r'''    <button className="fr-return" onClick={() => { setLegacyConsole(false); window.scrollTo(0,0); }}>← 返回关系引擎 · 本页是退役账户与原有实盘管理，旧策略已停止新开仓</button>
'''),
])

patch('lib/regime-portfolio.ts', '7ef23502be29b7c90e19aeabbf956ab949587c86561f637890074782e8fab11a', 'd463c8a026f60969c894b81caccbf5836b13a7f52c5a1fd79714d0ac44703aa9', [
(444, 445, r'''  quotes: Record<string, ArenaQuote>; contracts: Record<string, RegimeContractMeta>; now: number; allowNewEntries?: boolean }) {
'''),
(450, 450, r'''  if (input.allowNewEntries === false) {
    state.lastEvaluatedHour = synchronized.context.at;
    state.routeChecks = [];
    return state;
  }
'''),
])

patch('package.json', '245015b110f07e76fbb1b5ee7db3b69d59efbcfb2254af853bab7b66eeefe45b', 'be5ebfeff3c391283317d8b6f4fcb7f7a8b61e83763825d5e92ee6b1088b86e7', [
(17, 18, r'''    "test:direct": "node --experimental-strip-types --test tests/extreme-sequence-mirror.test.ts tests/adaptive-policy.test.ts tests/liquidity-core.test.ts tests/market-radar.test.ts tests/market-regime.test.ts tests/all-regime-engine.test.ts tests/previous-all-regime-engine.test.ts tests/arena-live.test.ts tests/dual-paper.test.ts tests/regime-portfolio.test.ts tests/rejection-audit.test.ts tests/reaction-lab.test.ts tests/outcome-research.test.ts tests/strategy-arena.test.ts tests/previous-strategy-arena.test.ts tests/strategy-coverage.test.ts tests/paper-cycle.test.ts tests/gate-market.test.ts tests/runtime-health.test.ts tests/runtime-faults.test.ts tests/credential-vault.test.ts tests/owner-auth.test.ts tests/gate-live.test.ts tests/position-metrics.test.ts tests/forward-relations.test.ts",
'''),
(22, 22, r'''    "test:forward": "node --experimental-strip-types --test tests/forward-relations.test.ts",
'''),
(29, 30, r'''  "displayName": "Forward Market Relation Engine"
'''),
])

patch('public/manifest.webmanifest', '1c87615632069f6b97ac708fd19ea18757f4f6110ced86d2d17b2122b2f4ddce', 'e749d1c15639736103a6ddb82a4d95ba8a84665b3d6984cdb88091d014f68452', [
(1, 3, r'''  "name": "哨兵关系引擎",
  "short_name": "关系引擎",
'''),
(5, 7, r'''  "background_color": "#f3f4f0",
  "theme_color": "#f3f4f0",
'''),
])

patch('tests/architecture.test.mjs', 'c35bde985f5525d2a8d21a0c03d3d0de45a1de0f1b3bc89eb0ee495c3a89c43a', 'dc55e91ed566323834c3bcce798216596c6a0a2fe125fa79b9e3b28074724aeb', [
(81, 82, r'''  assert.match(layout, /哨兵 · 关系引擎/);
'''),
(341, 342, r'''  assert.equal((workflow.match(/grep -Fq '哨兵 · 关系引擎'/g) ?? []).length, 2);
  assert.match(workflow, /deployment-plan/);
  assert.match(workflow, /runtime\.forward\.liveEligible == false/);
  assert.match(workflow, /runtime\.legacyRetired == true/);
'''),
])

patch('vite.config.ts', '6944c5bddc56a760364916b1a71420d1a28192b92ac7ce3c25e01ec4c57f79d5', '01f9a4d2a5c4930e335fb22938fe0b6e4ce3a2efd3e898452842682d60b88ac6', [
(18, 18, r'''    define: {
      __FORWARD_BUILD_SHA__: JSON.stringify(process.env.GITHUB_SHA ?? "local-verification"),
    },
'''),
])

patch('worker/index-clean.ts', '6b3559a894ae6dff2197b70ba8a04aca166835bb56fe8d8efbf10c7ae84802a3', 'beb1bddee85071d5718a5706760df1365ca0529b918b48671c353daf3d8d5f01', [
(31, 31, r'''import { advanceForward, forwardSummary, forwardWatchSymbols, FORWARD_VERSION, type ForwardState } from "../lib/forward-relations.ts";
import { readForwardStore, prepareForwardWrite, FORWARD_STORAGE } from "../lib/forward-store.ts";
declare const __FORWARD_BUILD_SHA__: string;
const FORWARD_BUILD_SHA = typeof __FORWARD_BUILD_SHA__ === "string" ? __FORWARD_BUILD_SHA__ : "local-verification";
'''),
(439, 439, r'''  private forwardState: ForwardState | null = null;
  private forwardError: string | null = null;
  private forwardBusy = false;
  private forwardLastAttemptAt = 0;
'''),
(520, 520, r'''      try { this.forwardState = await readForwardStore(ctx.storage, Date.now()); }
      catch (error) { this.forwardError = safeError(error); }
'''),
(623, 624, r'''      // Five-minute learning paths are independent of the small realtime book pool.
      // Keep a Top30 path when its symbol leaves a realtime slot.
      if (!this.runtime.liquidUniverse.includes(symbol)) {
        delete this.runtime.strategyCandleFailures[symbol]; delete this.strategyCandles[symbol];
      }
'''),
(663, 663, r'''      ...(this.forwardState?.positions.map((position) => position.symbol) ?? []),
'''),
(664, 665, r'''    const forwardWatched = this.forwardState ? forwardWatchSymbols(this.forwardState, now) : [];
    const locked = [...new Set([...protectedLocked, ...forwardWatched, ...researchUniverse])];
'''),
(740, 740, r'''        entryReady: row.entryReady === true,
'''),
(766, 767, r'''      hourly: this.regimeHourly, quotes: this.regimeQuotes(now), contracts: this.regimeContracts(), now, allowNewEntries: false });
  }

  private forwardView(now = Date.now()) {
    return this.forwardState ? { ...forwardSummary(this.forwardState, this.regimeQuotes(now), now),
      storage: { ...this.forwardState.storage, error: this.forwardError } }
      : { version: FORWARD_VERSION, mode: "RECOVERY_REQUIRED", liveEligible: false, storage: { error: this.forwardError } };
  }

  private async advanceForwardNow(now: number) {
    if (this.forwardBusy || now - this.forwardLastAttemptAt < 10_000) return;
    this.forwardLastAttemptAt = now;
    this.forwardBusy = true;
    try {
      if (!this.forwardState) this.forwardState = await readForwardStore(this.ctx.storage, now);
      const previous = this.forwardState;
      const next = advanceForward({ state: previous, now, paths: this.strategyCandles,
        quotes: this.regimeQuotes(now), contracts: this.regimeContracts() });
      if (next.changed || !previous.storage.persistedAt) {
        next.state.storage = { persistedAt: now, error: null };
        const prepared = await prepareForwardWrite(previous.storage.persistedAt ? previous : null, next.state, now);
        // All extra persistence consumes the existing non-alarm write reserve.
        if (this.runtime.nonAlarmWrites + prepared.writes + 64 > NON_ALARM_WRITE_CAP) throw new Error("前向写入预算不足；保留原账户，不提交未持久化订单");
        await this.ctx.storage.transaction(async transaction => { await transaction.put(prepared.entries); });
        this.runtime.nonAlarmWrites += prepared.writes;
      }
      // A PAPER fill/rule update becomes visible only after its atomic commit.
      this.forwardState = next.state;
      this.forwardError = null;
    } catch (error) { this.forwardError = safeError(error); }
    finally { this.forwardBusy = false; }
'''),
(1955, 1955, r'''      ...(this.forwardState?.positions.map((position) => position.symbol) ?? []),
'''),
(1975, 1975, r'''      ...(this.forwardState?.positions.map((position) => position.symbol) ?? []),
'''),
(2305, 2305, r'''      // Generated rules have PAPER-only authority. No path enters canonicalLivePortfolio.
      await this.advanceForwardNow(Date.now());
'''),
(2319, 2319, r'''      await this.advanceForwardNow(Date.now());
'''),
(2412, 2412, r'''    if (path === "/forward-export" && request.method === "GET") {
      await this.ensureAlarm();
      return json({ exportedAt: Date.now(), forward: this.forwardView(),
        measurements: this.forwardState?.samples ?? [],
        archiveEndpoint: "/api/forward/archive", completeness: "当前快照与滚动样本；完整不可变记录按archive接口分页读取" });
    }
    if (path === "/forward-archive" && request.method === "GET") {
      const prefix = `${FORWARD_STORAGE}archive:`;
      const cursor = url.searchParams.get("cursor");
      if (cursor && (!cursor.startsWith(prefix) || cursor.length > 150)) return json({ error: "invalid cursor" }, 400);
      const rows = await this.ctx.storage.list({ prefix, limit: 26, ...(cursor ? { startAfter: cursor } : {}) });
      const entries = [...rows.entries()]; const hasMore = entries.length > 25;
      const page = entries.slice(0, 25);
      return json({ items: page.map(([key, value]) => ({ key, value })), nextCursor: hasMore ? page.at(-1)?.[0] ?? null : null,
        immutable: true, generatedAt: Date.now() });
    }
'''),
(2432, 2432, r'''        buildSha: FORWARD_BUILD_SHA,
        forward: this.forwardView(),
        legacyRetired: true,
'''),
(2447, 2448, r'''          activeCount: 0,
'''),
(2553, 2553, r'''        buildSha: FORWARD_BUILD_SHA,
        forward: this.forwardView(), legacyRetired: true,
'''),
(2826, 2826, r'''    if (url.pathname === "/api/forward/export" && request.method === "GET") return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/forward-export");
    if (url.pathname === "/api/forward/archive" && request.method === "GET") return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/forward-archive${url.search}`);
'''),
])
