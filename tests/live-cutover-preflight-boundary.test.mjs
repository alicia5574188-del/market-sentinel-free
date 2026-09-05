import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../app/api/live/preflight/route.ts", import.meta.url);
const helperUrl = new URL("../lib/live-cutover-preflight.ts", import.meta.url);
const summaryUrl = new URL("../lib/live-cutover-summary.ts", import.meta.url);
const authUrl = new URL("../lib/cutover-preflight-auth.ts", import.meta.url);
const workerUrl = new URL("../worker/index.ts", import.meta.url);

test("Gate cutover preflight is owner-authenticated, GET-only, and never writes D1", async () => {
  const [route, helper, summary, auth, worker] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(helperUrl, "utf8"),
    readFile(summaryUrl, "utf8"),
    readFile(authUrl, "utf8"),
    readFile(workerUrl, "utf8"),
  ]);

  assert.match(route, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/);
  assert.match(route, /requireApiViewer/);
  assert.match(route, /role !== "owner"/);
  assert.match(route, /cutoverPreflightTokenMatches/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(auth, /CUTOVER_PREFLIGHT_TOKEN_MIN_BYTES = 32/);
  assert.match(auth, /accessCodeMatches\(submitted, configured\)/);
  assert.match(worker, /url\.pathname === "\/api\/live\/preflight"[\s\S]*request\.method === "GET"[\s\S]*cutoverPreflightTokenMatches/);

  assert.match(summary, /client\.positions\(true\)/);
  assert.match(summary, /client\.openOrders\(\)/);
  assert.match(summary, /client\.priceOrders\("open"\)/);
  assert.doesNotMatch(`${helper}\n${summary}`, /client\.(?:createOrder|cancelOrder|cancelAllOrders|createPriceOrder|cancelPriceOrder|cancelAllPriceOrders|setIsolatedLeverage)\s*\(/);
  assert.doesNotMatch(helper, /getDb\(\)\.(?:insert|update|delete)\s*\(/);
});

test("cutover preflight CI is branch-scoped, migration-free, and verifies twice after one deploy", async () => {
  const workflow = await readFile(new URL("../.github/workflows/sentinel-v2-ci.yml", import.meta.url), "utf8");
  const deployStart = workflow.indexOf("  deploy:");
  const start = workflow.indexOf("  cutover_preflight:");
  const end = workflow.indexOf("\n  operations:", start);
  assert.ok(deployStart >= 0 && start > deployStart && end > start);
  const deploy = workflow.slice(deployStart, start);
  const job = workflow.slice(start, end);

  assert.match(job, /github\.event_name == 'pull_request'/);
  assert.match(job, /github\.head_ref == 'cutover\/preflight-ci'/);
  assert.match(job, /head\.repo\.full_name == github\.repository/);
  assert.match(job, /needs: verify/);
  for (const productionJob of [deploy, job]) {
    assert.match(productionJob, /concurrency:\n\s+group: market-sentinel-production\n\s+cancel-in-progress: false/);
  }
  assert.match(job, /timeout-minutes: 25/);
  assert.doesNotMatch(job.match(/timeout-minutes: 25[\s\S]*?steps:/)?.[0] ?? "", /CLOUDFLARE_API_TOKEN/);
  assert.match(job, /git fetch --no-tags origin main/);
  assert.match(job, /EVENT_BASE_SHA[\s\S]*github\.event\.pull_request\.base\.sha/);
  assert.match(job, /\[\[ "\$EVENT_BASE_SHA" == "\$origin_main" \]\]/);
  assert.match(job, /git merge-base --is-ancestor "\$origin_main" HEAD/);
  assert.match(job, /git diff --quiet "\$origin_main"\.\.\.HEAD --[\s\S]*wrangler\.jsonc drizzle drizzle\.config\.ts db vite\.config\.ts/);
  assert.match(job, /PREFLIGHT_BODY_DEADLINE=\$\(\( \$\(date \+%s\) \+ 900 \)\)/);
  assert.match(job, /timeout "\$\{remaining\}s" npm ci[\s\S]*timeout "\$\{remaining\}s" npm run build[\s\S]*timeout "\$\{remaining\}s" npx wrangler deploy --dry-run/);
  assert.ok(job.indexOf("npm run build") < job.indexOf("deploy --dry-run"));
  assert.ok(job.indexOf("deploy --dry-run") < job.indexOf("openssl rand -hex 32"));
  assert.ok(job.indexOf("openssl rand -hex 32") < job.indexOf("deployments status --name market-sentinel-free --json"));
  assert.ok(job.indexOf("deployments status --name market-sentinel-free --json") < job.indexOf("--secrets-file"));
  assert.match(job, /\(\.versions \| length\) == 1[\s\S]*\.versions\[0\]\.percentage == 100/);
  assert.match(job, /BASELINE_VERSION_ID=\$baseline_version_id/);
  assert.ok(job.indexOf("--secrets-file") < job.indexOf("validate_preflight /tmp/cutover-preflight-first.json"));
  assert.equal((job.match(/validate_preflight \/tmp\/cutover-preflight-(?:first|second)\.json/g) ?? []).length, 2);
  assert.match(job, /sleep 5/);
  assert.match(job, /\.counts\.positions == 0/);
  assert.match(job, /\.counts\.openOrders == 0/);
  assert.match(job, /\.counts\.priceOrders == 0/);
  assert.match(job, /Upload safe preflight summary/);
  assert.doesNotMatch(job, /wrangler secret put/);
  assert.doesNotMatch(job, /d1 migrations apply/);
  assert.match(job, /Always attempt token revocation and baseline rollback[\s\S]*if: always\(\)[\s\S]*Always verify Cloudflare cleanup state[\s\S]*if: always\(\)[\s\S]*Always verify bearer bypass is inactive[\s\S]*if: always\(\)/);
  const cleanup = job.slice(job.indexOf("Always attempt token revocation and baseline rollback"));
  assert.ok(cleanup.indexOf("secret delete CUTOVER_PREFLIGHT_TOKEN") < cleanup.indexOf('rollback "$BASELINE_VERSION_ID"'));
  assert.match(cleanup, /secret_delete_rc="\$\?"[\s\S]*rollback_rc="\$\?"/);
  assert.match(cleanup, /secret list --name market-sentinel-free --format json[\s\S]*CUTOVER_PREFLIGHT_TOKEN[\s\S]*deployments status[\s\S]*percentage == 100[\s\S]*version_id == \$baseline/);
  assert.match(cleanup, /Authorization: Bearer \$CUTOVER_PREFLIGHT_TOKEN[\s\S]*\[\[ "\$code" == "401" \]\]/);
  assert.doesNotMatch(cleanup, /git switch|npm ci|npm run build|d1 migrations apply/);
  const bearerVerification = cleanup.slice(cleanup.indexOf("Always verify bearer bypass is inactive"));
  assert.doesNotMatch(bearerVerification, /CLOUDFLARE_API_TOKEN/);
});

test("Gate client methods used by cutover preflight are signed GET requests", async () => {
  const client = await readFile(new URL("../lib/gate-private.ts", import.meta.url), "utf8");
  assert.match(client, /positions\(holding = true\)[\s\S]*?this\.request<GatePosition\[\]>\("GET"/);
  assert.match(client, /openOrders\(contract\?: string\)[\s\S]*?this\.request<GateFuturesOrder\[\]>\("GET"/);
  assert.match(client, /priceOrders\(status:[\s\S]*?this\.request<GatePriceOrder\[\]>\("GET"/);
});
