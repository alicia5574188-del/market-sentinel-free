# Dependency security audit — 2026-09-21

Scope: the deployed architecture at `ed418e9` and this repair candidate. Inspect the locked dependency tree, application imports, Vinext/Cloudflare request handlers, and the newly built Worker and SSR bundles. Preserve trading decisions, execution order, account state and LIVE intent.

## Repaired runtime dependency

`react`, `react-dom`, and `react-server-dom-webpack` are pinned from 19.2.6 to **19.2.8**. This is the smallest matching patch triplet that addresses [React's Server Functions denial-of-service advisory GHSA-wx67-qw84-cm4g](https://github.com/react/react/security/advisories/GHSA-wx67-qw84-cm4g). Matching versions preserve React's server/client version contract.

Although RSC is in `devDependencies`, it is bundled into production. `worker/index-clean.ts` delegates page requests to `vinext/server/app-router-entry`; Vinext's progressive multipart POST handler calls `decodeAction`. No application `use server` functions were found, but that alone does not justify treating the decoder as development-only. No exploit was sent to the production service.

Verification:

- Installed package files in an isolated dependency directory all report 19.2.8; the former shared dependency installation was not modified.
- The RSC plugin's actual framework-package discovery selects the explicitly installed `react-server-dom-webpack` package. The plugin also contains an older vendored fallback, so package metadata alone would have been insufficient evidence.
- The generated Worker bundle includes `react-server-dom-webpack/cjs/react-server-dom-webpack-server.edge.production.js` from the repaired installation; SSR includes its corresponding client. The built React/DOM versions are 19.2.8. The patched `decodeAction` implementation selects the final action key before decoding, replacing repeated per-key action decoding.
- The lockfile changes only the three package entries and matching root dependency specifications. npm also reconciles pre-existing stale root name/version/Node-engine metadata with `package.json`; no transitive package versions change.

## Remaining scanner findings and reachability

Full `npm audit` changes from **24 affected packages** (1 critical, 16 high, 6 moderate, 1 low) to **23** (1 critical, 15 high, 6 moderate, 1 low). These are affected-package counts, including dependency propagation, not 23 independently demonstrated production exploits. The remaining advisories are **not fixed** by this release.

| Remaining packages | Inspected exposure in this deployment | Disposition |
| --- | --- | --- |
| `next`, `sharp` | Next's server is not the Worker entry point. Next imports in application source are types; Vinext supplies the routing/runtime. Next's Windows filesystem and AVIF optimizer RCE prerequisites are absent. `sharp` is pulled by Next and local Miniflare; no Sharp parser occurs in the generated Worker/SSR bundles. | Not reachable through the inspected production request path. Remain vulnerable if used by a different host or feature. |
| `vinext`, `image-size` | Vinext itself is the production framework. Its `image-size` calls are in the build-time static image-import loader and metadata generator and read repository files. Generated metadata responses serve embedded bytes. The actual `/_vinext/image` branch **is reachable**, but this entry point validates the URL and returns a 302; it does not invoke `image-size`, Sharp, or an image decoder. No `image-size` parser occurs in the generated Worker/SSR bundles. | The image-parser advisories have no identified remote request-to-parser path here; malicious repository image assets could still affect a future build. No framework major migration or unsupported override applied. |
| `fflate` | Dependency path: Vinext → `@vercel/og` → `@shuding/opentype.js` → `fflate`. This app has no `next/og`, `ImageResponse`, dynamic image metadata, or font-upload endpoint. No fflate/OG implementation is present in the built Worker/SSR bundles. Additionally, the installed OpenType source imports `inflateSync`, whereas this advisory concerns ZIP64 `unzipSync`. | No identified production path to the affected function. Keep as an unresolved dependency advisory; revisit if image/font generation is introduced. |
| `@babel/core`, `baseline-browser-mapping`, `brace-expansion`, `browserslist`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `vite` | Build, CSS, lint, schema, and development-server dependency paths. Application/Worker code does not import these parsers. Vite advisories require Windows development-server behavior, outside the deployed Workers runtime. | Development/build exposure remains; not a demonstrated deployed trading/API vulnerability. |
| `@cloudflare/vite-plugin`, `miniflare`, `wrangler`, `ws`, `undici`, `drizzle-kit`, `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, `esbuild` | Local emulation, deployment, database migration and build toolchain. Production market requests use the Worker runtime's fetch API, not the installed Miniflare Undici client; production does not run these Node development servers. | Development/tooling advisories remain. No blanket `audit --force`, Drizzle downgrade, or broad Cloudflare/Vinext upgrade is included. |

The two critical Next advisory conditions are documented by the maintainer: [Windows filesystem RCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) and [AVIF Image Optimization API RCE](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4). The local call-path and generated-bundle review, rather than package severity alone, supports the deployment-specific reachability assessment above.

## Limits and follow-up

This is a source/configuration/bundle reachability assessment, not a penetration-test certification. It does not prove the absence of unknown vulnerabilities, future configuration changes, malicious build inputs, or bugs in third-party code. No production stress or financial test was performed. Application regression tests and build results are recorded by the parent release audit.

Keep the residual dependency backlog explicit. Toolchain updates require their own compatibility build and deployment checks; do not present the 23 remaining scanner findings as resolved, nor change trading logic to address them. If adding image generation, image upload, Server Functions, a Windows/Node host, or public development servers, repeat this reachability assessment before exposing the new path.
