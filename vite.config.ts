import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
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
          // Production is intentionally rooted at the V2 wrapper. The wrapper
          // re-exports the full Worker but also gives MarketScanner a fresh DO
          // class export/namespace so legacy scanner runtime state cannot pin
          // the resumable phase machine behind a poisoned old instance.
          config.main = "./worker/index-v2.ts";
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
