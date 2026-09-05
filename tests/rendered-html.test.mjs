import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

test("renders production Resonance metadata", async () => {
  const cloudflareRuntimeHook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") {
        return {
          shortCircuit: true,
          url: "data:text/javascript,export class DurableObject%7Bconstructor(ctx%2Cenv)%7Bthis.ctx%3Dctx%3Bthis.env%3Denv%7D%7D",
        };
      }
      return nextResolve(specifier, context);
    },
  });
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href).finally(() => cloudflareRuntimeHook.deregister());

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", "oai-authenticated-user-email": "owner@example.com" },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>共振量化｜短线交易台<\/title>/i);
  assert.match(html, /历史方向交易模拟：历史走势预测、当前决定、持仓保护与交易结果/);
  const version = (await readFile(new URL("../lib/direct-market-types.ts", import.meta.url), "utf8")).match(/DIRECT_MARKET_BRAIN_VERSION = "([^"]+)"/)[1];
  assert.ok(html.includes(`data-release="${version}"`));
  assert.doesNotMatch(html, /name=["']codex-preview["']/i);
});
