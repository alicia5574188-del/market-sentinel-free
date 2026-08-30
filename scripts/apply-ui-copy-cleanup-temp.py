from pathlib import Path

page_path = Path("app/page.tsx")
s = page_path.read_text()

replacements = {
    'function Empty({ title, detail }: { title: string; detail: string }) {\n  return <div className="clean-empty"><strong>{title}</strong><span>{detail}</span></div>;\n}': 'function Empty({ title, detail }: { title: string; detail?: string }) {\n  return <div className="clean-empty"><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;\n}',
    'detail={chart.upstreamError ?? "Clean 账本已保存交易，等待 K 线窗口补齐。"}': 'detail={chart.upstreamError ?? "等待 K 线数据补齐。"}',
    'setMainError(error instanceof Error ? error.message : "HTE 3.1 Clean 暂不可用");': 'setMainError(error instanceof Error ? error.message : "HTE 3.1 暂不可用");',
    '`${scanner.lastError ?? "Clean Scanner 已熔断"}${scanner.retryAfter ? ` · ${fmtTime(scanner.retryAfter)} 后重试` : ""}`': '`${scanner.lastError ?? "扫描暂时停止"}${scanner.retryAfter ? ` · ${fmtTime(scanner.retryAfter)} 后重试` : ""}`',
    '`Clean Scanner 正在执行：${scanner.phase ?? "启动"}${scanner.phaseAttempt ? ` · 尝试 ${scanner.phaseAttempt}/3` : ""}`': '`扫描启动中${scanner.phase ? ` · ${scanner.phase}` : ""}`',
    '`Clean Scanner 已 ${ageSeconds} 秒没有完成新评估 · ${scanner?.lastError ?? scanner?.phase ?? "正在恢复"}`': '`扫描延迟 ${ageSeconds} 秒 · ${scanner?.lastError ?? "正在恢复"}`',
    '`Clean Scanner ${scanner?.state ?? "starting"} · 最近成功 ${snapshot?.observedAt ? fmtTime(snapshot.observedAt) : "--"} · Trade Manager ${position?.state ?? "starting"}`': '`最近更新 ${snapshot?.observedAt ? fmtTime(snapshot.observedAt) : "--"}`',
    '<small>HUMAN TRADER ENGINE 3.1 CLEAN · 5 TRADERS</small>': '<small>HTE 3.1 · 5 TRADERS</small>',
    'loading?"正在启动 HTE 3.1 Clean…":statusText': 'loading?"正在启动…":statusText',
    '<span className="eyebrow">MARKET STATE · CLEAN</span>': '<span className="eyebrow">MARKET STATE</span>',
    'dashboard?.governance.reason ?? "新账本从零启动，不继承 HTE 3.0 盈亏或学习。"': 'dashboard?.governance.reason ?? "等待风险状态"',
    '<Empty title="等待 Clean 账本" detail="首轮扫描成功后显示交易员状态。" />': '<Empty title="等待交易员状态" />',
    '<span className="eyebrow">CLEAN RADAR</span>': '<span className="eyebrow">RADAR</span>',
    '<Empty title="暂时没有新评估" detail={scanner?.phase ? `当前 Scanner 阶段：${scanner.phase}` : "Clean Scanner 成功运行后，这里只显示新系统的 HT1–HT5 判断。"}/>': '<Empty title="暂无评估" />',
    '<span className="eyebrow">SIMULATION LEDGER · CLEAN</span><h2>HTE 3.1 新账本</h2></div><small>旧 HTE 3.0 不进入这里</small>': '<span className="eyebrow">SIMULATION</span><h2>模拟账户</h2></div>',
    '<Empty title="当前没有模拟持仓" detail="只有独立交易员的完整 Setup 才会生成新订单。"/>': '<Empty title="暂无模拟持仓" />',
    '<span className="eyebrow">CLOSED · POST-EXIT OBSERVER</span><h2>已平仓 / 持续复盘</h2>': '<span className="eyebrow">CLOSED</span><h2>已平仓</h2>',
    '<Empty title="新系统还没有已平仓样本" detail="平仓后仍会观察 30m / 1h / 2h / 4h / 12h，学习进出场质量。"/>': '<Empty title="暂无已平仓交易" />',
    '<span className="eyebrow">GATE LIVE · SAFETY BOUNDARY</span><h2>实盘链独立保留</h2>': '<span className="eyebrow">GATE LIVE</span><h2>实盘</h2>',
    '<p className="clean-driver">Auto Live 保留所有者手动开关；风险锁、保护单和紧急停机仍可自动阻止新开仓。合约账户没有可用资金时不会成交。</p>': '',
    '<Empty title="没有活动实盘订单" detail="Clean 重建不会删除或改写 Gate 凭据与实盘审计记录。"/>': '<Empty title="没有活动实盘订单" />',
    '<span className="eyebrow">CLEAN RUNTIME</span>': '<span className="eyebrow">RUNTIME</span>',
    '<span>新账本样本</span>': '<span>模拟样本</span>',
    'dashboard?.settings.scanEnabled?"暂停 Clean Scanner":"开启 Clean Scanner"': 'dashboard?.settings.scanEnabled?"暂停扫描":"开启扫描"',
    '<p className="clean-driver">Clean Scanner 每轮只深扫一个币，按异常 → 核心 → 全市场轮转，优先保证 Cloudflare Free 下持续可靠运行。</p>': '',
    '<p>新账本 n={samples} · W/S/L ': '<p>样本 n={samples} · W/S/L ',
    'enabled?"Clean Scanner 已开启。":"Clean Scanner 已暂停。"': 'enabled?"扫描已开启。":"扫描已暂停。"',
    '"Gate 凭据已验证保存；HTE 3.1 新实盘仍保持锁定。"': '"Gate 凭据已验证保存。"',
    '<p className="clean-driver">这里展示 Gate 实盘链已经保存的真实账户状态。当前后端只持久化合约权益、当日已实现和对账时间；没有可靠字段时不会把“可用保证金”估算出来。</p>': '',
}

for old, new in replacements.items():
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"Expected one page match, found {count}: {old[:120]!r}")
    s = s.replace(old, new)

banned = [
    "HTE 3.0 不进入这里",
    "SIMULATION LEDGER · CLEAN",
    "HTE 3.1 新账本",
    "MARKET STATE · CLEAN",
    "CLEAN RADAR",
    "CLEAN RUNTIME",
    "Clean 重建",
    "新账本从零启动",
    "等待 Clean 账本",
    "暂停 Clean Scanner",
    "开启 Clean Scanner",
    "Clean Scanner 每轮只深扫一个币",
    "Clean Scanner 已开启",
    "Clean Scanner 已暂停",
    "HTE 3.1 新实盘仍保持锁定",
    "这里展示 Gate 实盘链已经保存的真实账户状态",
]
for phrase in banned:
    if phrase in s:
        raise SystemExit(f"Banned product copy remains: {phrase}")
page_path.write_text(s)

test_path = Path("tests/human-trader-ui.test.mjs")
t = test_path.read_text()
test_replacements = {
    'test("production UI is HTE 3.1 Clean and not a Strategy 2 overlay stack", () => {': 'test("production UI is HTE 3.1 and not a Strategy 2 overlay stack", () => {',
    'assert.match(page, /HUMAN TRADER ENGINE 3\\.1 CLEAN/);': 'assert.match(page, /HTE 3\\.1 · 5 TRADERS/);',
    '  assert.match(page, /旧 HTE 3\\.0 不进入这里/);': '  assert.doesNotMatch(page, /旧 HTE 3\\.0 不进入这里|SIMULATION LEDGER · CLEAN|HTE 3\\.1 新账本/);',
    '  assert.match(page, /30m \\/ 1h \\/ 2h \\/ 4h \\/ 12h/);': '  assert.match(page, /chart\\.observations/);',
    '  assert.match(page, /风险锁、保护单和紧急停机仍可自动阻止新开仓/);': '  assert.match(page, /按住 1\\.2 秒紧急停机/);',
}
for old, new in test_replacements.items():
    count = t.count(old)
    if count != 1:
        raise SystemExit(f"Expected one test match, found {count}: {old!r}")
    t = t.replace(old, new)

t += '''\n\ntest("product UI omits migration and implementation copy", () => {\n  for (const phrase of [\n    "HTE 3.0 不进入这里",\n    "SIMULATION LEDGER · CLEAN",\n    "HTE 3.1 新账本",\n    "MARKET STATE · CLEAN",\n    "CLEAN RADAR",\n    "CLEAN RUNTIME",\n    "Clean 重建",\n    "新账本从零启动",\n    "Clean Scanner 已开启",\n    "Clean Scanner 已暂停",\n    "HTE 3.1 新实盘仍保持锁定",\n  ]) assert.equal(page.includes(phrase), false, phrase);\n  assert.match(page, />模拟账户</);\n  assert.match(page, /title="暂无模拟持仓"/);\n  assert.match(page, />实盘</);\n});\n'''
test_path.write_text(t)
