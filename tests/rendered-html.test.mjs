import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

test("renders production Market Sentinel Human Trader Engine 3.0 metadata", async () => {
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
      headers: {
        accept: "text/html",
        "oai-authenticated-user-email": "owner@example.com",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Market Sentinel｜Human Trader Engine 3\.0<\/title>/i);
  assert.match(html, /三位独立交易员、环境识别、Risk Governor、模拟与 Gate 实盘统一工作台/);
  assert.doesNotMatch(html, /name=["']codex-preview["']/i);
});
