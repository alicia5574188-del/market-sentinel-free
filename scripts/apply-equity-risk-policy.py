from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} occurrences, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new))


# The previous migration regex left the old fixed-USDT display fragment behind
# after the new equity-scaled settings rows. Remove that fragment exactly once.
replace_exact(
    "app/page.tsx",
    '<b>{settings?.dailyPauseUsdt ?? 30}U / {settings?.maxDrawdownUsdt ?? 100}U</b></div>',
    "",
)

# This is a one-shot finalizer. Remove the migration machinery from the branch
# before the verified commit is pushed so GitHub Actions cannot retrigger itself.
for transient in [
    Path("scripts/apply-equity-risk-policy.py"),
    Path(".github/workflows/equity-risk-policy-finalize.yml"),
]:
    if transient.exists():
        transient.unlink()
