from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} occurrences, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new))


# Remove the old fixed-USDT UI fragment left behind by the first migration.
replace_exact(
    "app/page.tsx",
    '<b>{settings?.dailyPauseUsdt ?? 30}U / {settings?.maxDrawdownUsdt ?? 100}U</b></div>',
    "",
)

# Update legacy assertions so they validate the new equity-scaled policy rather
# than the removed fixed-10U / fixed-30U / fixed-100U assumptions.
replace_exact(
    "tests/live-trading.test.ts",
    "  assert.ok(plan.expectedNetTp2Usdt > 153 && plan.expectedNetTp2Usdt < 154);",
    "  assert.ok(plan.expectedNetTp2Usdt > 199 && plan.expectedNetTp2Usdt < 200);",
)
replace_exact(
    "tests/live-trading.test.ts",
    "  assert.ok(plan.worstCaseNetTp2Usdt > 147 && plan.worstCaseNetTp2Usdt < 149);",
    "  assert.ok(plan.worstCaseNetTp2Usdt > 192 && plan.worstCaseNetTp2Usdt < 193);",
)
replace_exact(
    "tests/live-trading.test.ts",
    "    accountEquityUsdt: 980,",
    "    accountEquityUsdt: 970,",
)
replace_exact(
    "tests/live-trading.test.ts",
    '  }) ?? "", /日内暂停线/);',
    '  }) ?? "", /3% 暂停线/);',
)
replace_exact(
    "tests/live-trading.test.ts",
    "    accountEquityUsdt: 900.01,",
    "    accountEquityUsdt: 970.01,",
)
replace_exact(
    "tests/live-trading-ui.test.mjs",
    '  assert.match(page, /Gate 当日已实现亏损或实盘权益回撤触线后/);',
    '  assert.match(page, /当日参考权益 3%.*峰值回撤.*10%/);',
)

# This is a one-shot finalizer. Remove the migration machinery from the branch
# before the verified commit is pushed so GitHub Actions cannot retrigger itself.
for transient in [
    Path("scripts/apply-equity-risk-policy.py"),
    Path(".github/workflows/equity-risk-policy-finalize.yml"),
]:
    if transient.exists():
        transient.unlink()
