import vinext from "vinext";
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
          // HTE 3.1 Clean uses fresh simulation scanner/position Durable Object
          // namespaces. The live Gate coordinator remains the existing audited
          // implementation and is deliberately not recreated here.
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
