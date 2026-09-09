#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

command -v timeout || {
  echo "build-verified.sh requires GNU timeout." >&2
  exit 69
}

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

echo "Running bounded vinext build..."
project_root="$(cd "${SITES_PROJECT_ROOT}" && pwd -P)"
git_root="$(git -C "${project_root}" rev-parse --show-toplevel 2>/dev/null || true)"
git_root="$(cd "${git_root:-/}" && pwd -P)"
if [[ "${project_root}" != "${git_root}" ]] ||
  ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"market-sentinel-free"' "${project_root}/package.json" ||
  [[ ! -f "${project_root}/wrangler.jsonc" ]]; then
  echo "Refusing to clean an unverified project path." >&2
  exit 70
fi

dist_dir="${project_root}/dist"
if [[ "$(dirname "${dist_dir}")" != "${project_root}" ]] || [[ "$(basename "${dist_dir}")" != "dist" ]]; then
  echo "Refusing to clean an unexpected build directory." >&2
  exit 70
fi
rm -rf -- "${dist_dir}"
timeout \
  --signal=TERM \
  --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" \
  "${SITES_BUILD_TIMEOUT:-3m}" \
  "${vinext}" build
