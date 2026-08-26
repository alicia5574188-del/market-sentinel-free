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

test("missing version metadata never pauses live entry", () => {
  assert.equal(workerVersionChanged("version-a", undefined), false);
  assert.equal(workerVersionChanged(undefined, "  "), false);
});

test("deployment preserves Auto Live intent and requires one clean recovery cycle", () => {
  const worker = readFileSync(fileURLToPath(new URL("../worker/index.ts", import.meta.url)), "utf8");
  const engine = readFileSync(fileURLToPath(new URL("../lib/live-trading-engine.ts", import.meta.url)), "utf8");
  assert.match(worker, /CF_VERSION_METADATA\?\.id/);
  assert.match(worker, /get<string>\("workerVersionId"\)/);
  assert.match(worker, /workerVersionChanged\(previousVersionId, versionId\)/);
  assert.match(worker, /snapshot\.control\.entryEnabled && snapshot\.control\.state === "armed"/);
  assert.match(worker, /pauseAutomaticEntryForRecovery/);
  assert.match(worker, /worker_deployment_recovery_pause/);
  assert.match(worker, /schedule\(1_000\)/);
  assert.doesNotMatch(worker, /setAutomaticEntry\(false, "system-worker-deployment"\)/);
  assert.match(worker, /put\("workerVersionId", versionId\)/);
  assert.match(engine, /export async function pauseAutomaticEntryForRecovery/);
  assert.match(engine, /Auto Live 保持开启/);
  assert.match(engine, /recoveringFromTransientPause/);
  assert.match(engine, /!recoveringFromTransientPause/);
});
