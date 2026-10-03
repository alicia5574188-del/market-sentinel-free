import vinext from "vinext";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    define: {
      __FORWARD_BUILD_SHA__: JSON.stringify(process.env.GITHUB_SHA ?? "local-verification"),
      __STRATEGY_FINGERPRINT__: JSON.stringify(createHash("sha256").update([
        "lib/forward-relations.ts","lib/market-intelligence-engine.ts","lib/position-intelligence-engine.ts","lib/position-evidence-contract.ts",
        "lib/market-intelligence-entry-response.ts","lib/market-intelligence-environment-router.ts","lib/multi-turn-universe.ts",
        "lib/winner-policy.ts","lib/winner-risk.ts","lib/research-plan.ts","lib/market-intelligence-hypothesis-research.ts",
        "lib/market-intelligence-liquidity.ts","lib/market-intelligence-lifecycle.ts","lib/trade-realization.ts",
        "lib/shadow-inverse.ts","lib/shadow-inverse-ledger.ts","lib/shadow-baseline/manifest.json",
        "lib/unified-execution.ts","lib/unified-execution-types.ts","lib/direct-strategy.ts","lib/direct-strategy-types.ts","lib/direct-strategy-view.ts",
        "lib/event-response.ts","lib/forward-protection-checkpoint.ts",
        "lib/live-parity.ts","lib/live-session.ts","lib/live-source-policy.ts","lib/live-leverage.ts",
        "lib/shadow-baseline/forward-relations.ts","lib/shadow-baseline/market-intelligence-engine.ts","lib/shadow-baseline/winner-policy.ts"
      ].map(path=>path+"\n"+readFileSync(path,"utf8")).join("\n")).digest("hex")),
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config(config) {
          // The new PAPER-only liquidity runtime has one SQLite Durable Object.
          config.main = "./worker/index-clean.ts";
          config.compatibility_flags = [
            ...new Set([...(config.compatibility_flags ?? []), "nodejs_compat"]),
          ];

          const database = config.d1_databases?.find(
            ({ binding }) => binding === "DB",
          );
          if (database && !database.database_id) {
            database.database_id = SITE_CREATOR_PLACEHOLDER_DATABASE_ID;
          } else if (!database) {
            config.d1_databases = [
              {
                binding: "DB",
                database_name: "market-sentinel-local",
                database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
              },
            ];
          }
        },
      }),
    ],
  };
});
