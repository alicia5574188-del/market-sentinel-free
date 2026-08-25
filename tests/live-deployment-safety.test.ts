import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { workerVersionChanged } from "../lib/live-deployment-safety.ts";

test("same Worker version does not look like a deployment", () => {
  assert.equal(workerVersionChanged("version-a", "version-a"), false);
});

test("new Worker version is treated as a deployment boundary", () => {
  assert.equal(workerVersionChanged("version-a", "version-b"), true);
  assert.equal(workerVersionChanged(null, "version-first"), true);
});

test("missing version metadata never disarms live entry", () => {
  assert.equal(workerVersionChanged("version-a", undefined), false);
  assert.equal(workerVersionChanged(undefined, "  "), false);
});

test("live coordinator persists the seen version and disarms only new entry on deployment", () => {
  const source = readFileSync(fileURLToPath(new URL("../worker/index.ts", import.meta.url)), "utf8");
  assert.match(source, /CF_VERSION_METADATA\?\.id/);
  assert.match(source, /get<string>\("workerVersionId"\)/);
  assert.match(source, /workerVersionChanged\(previousVersionId, versionId\)/);
  assert.match(source, /snapshot\.control\.entryEnabled && snapshot\.control\.state === "armed"/);
  assert.match(source, /setAutomaticEntry\(false, "system-worker-deployment"\)/);
  assert.match(source, /put\("workerVersionId", versionId\)/);
});
