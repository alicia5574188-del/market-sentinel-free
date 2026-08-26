import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, before, after) {
  const source = await readFile(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one match, found ${count}`);
  await writeFile(path, source.replace(before, after));
}

await replaceOnce(
  "worker/index.ts",
  `  getLiveTradingSnapshot,\n  liveAlarmDelayMs,`,
  `  getLiveTradingSnapshot,\n  liveAlarmDelayMs,\n  pauseAutomaticEntryForRecovery,`,
);

await replaceOnce(
  "worker/index.ts",
  `    const snapshot = await getLiveTradingSnapshot();\n    if (snapshot.control.entryEnabled && snapshot.control.state === "armed") {\n      await setAutomaticEntry(false, "system-worker-deployment");\n    }\n    await this.ctx.storage.put("workerVersionId", versionId);`,
  `    const snapshot = await getLiveTradingSnapshot();\n    if (snapshot.control.entryEnabled && snapshot.control.state === "armed") {\n      // A deployment is a safety boundary, but it must not erase the owner's\n      // 24/7 Auto Live intent. Mark one recovery cycle instead: reconcile all\n      // Gate positions/orders and account risk first, skip new entry for that\n      // clean cycle, then resume automatically on the following alarm.\n      await pauseAutomaticEntryForRecovery(\n        \`Worker 已更新到新版本 \${versionId.slice(0, 8)}，正在执行部署后安全对账\`,\n        "worker_deployment_recovery_pause",\n      );\n      await this.schedule(1_000);\n    }\n    await this.ctx.storage.put("workerVersionId", versionId);`,
);

await replaceOnce(
  "lib/live-trading-engine.ts",
  `export async function setAutomaticEntry(enabled: boolean, actorAccountId: string) {`,
  `/**\n * Preserve the owner's Auto Live intent while temporarily blocking new entry.\n * The existing reconcile path treats an armed control with lastError as a\n * recovery cycle: current positions and exchange protection are reconciled, no\n * new candidate is submitted, and a clean cycle clears lastError so the next\n * alarm resumes entries automatically.\n */\nexport async function pauseAutomaticEntryForRecovery(reason: string, eventType = "automatic_entry_recovery_pause") {\n  const control = await getLiveControl();\n  if (!control.entryEnabled || control.state !== "armed") return getLiveTradingSnapshot();\n  const pauseReason = \`自动实盘安全复核：\${reason}\`.slice(0, 500);\n  const changed = control.lastError !== pauseReason;\n  await patchLiveControl({ lastError: pauseReason });\n  if (changed) {\n    await addLiveAudit({\n      eventType,\n      severity: "warning",\n      message: \`\${pauseReason}；Auto Live 保持开启，本轮禁止新开仓，完成一轮干净对账后自动恢复\`,\n    });\n  }\n  return getLiveTradingSnapshot();\n}\n\nexport async function setAutomaticEntry(enabled: boolean, actorAccountId: string) {`,
);

const deploymentTest = `import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nimport test from "node:test";\nimport { fileURLToPath } from "node:url";\nimport { workerVersionChanged } from "../lib/live-deployment-safety.ts";\n\ntest("same Worker version does not look like a deployment", () => {\n  assert.equal(workerVersionChanged("version-a", "version-a"), false);\n});\n\ntest("new Worker version is treated as a deployment boundary", () => {\n  assert.equal(workerVersionChanged("version-a", "version-b"), true);\n  assert.equal(workerVersionChanged(null, "version-first"), true);\n});\n\ntest("missing version metadata never pauses live entry", () => {\n  assert.equal(workerVersionChanged("version-a", undefined), false);\n  assert.equal(workerVersionChanged(undefined, "  "), false);\n});\n\ntest("deployment preserves Auto Live intent and requires one clean recovery cycle", () => {\n  const worker = readFileSync(fileURLToPath(new URL("../worker/index.ts", import.meta.url)), "utf8");\n  const engine = readFileSync(fileURLToPath(new URL("../lib/live-trading-engine.ts", import.meta.url)), "utf8");\n  assert.match(worker, /CF_VERSION_METADATA\\?\\.id/);\n  assert.match(worker, /get<string>\\("workerVersionId"\\)/);\n  assert.match(worker, /workerVersionChanged\\(previousVersionId, versionId\\)/);\n  assert.match(worker, /snapshot\\.control\\.entryEnabled && snapshot\\.control\\.state === "armed"/);\n  assert.match(worker, /pauseAutomaticEntryForRecovery/);\n  assert.match(worker, /worker_deployment_recovery_pause/);\n  assert.match(worker, /schedule\\(1_000\\)/);\n  assert.doesNotMatch(worker, /setAutomaticEntry\\(false, "system-worker-deployment"\\)/);\n  assert.match(worker, /put\\("workerVersionId", versionId\\)/);\n  assert.match(engine, /export async function pauseAutomaticEntryForRecovery/);\n  assert.match(engine, /Auto Live 保持开启/);\n  assert.match(engine, /recoveringFromTransientPause/);\n  assert.match(engine, /!recoveringFromTransientPause/);\n});\n`;
await writeFile("tests/live-deployment-safety.test.ts", deploymentTest);

console.log("deployment Auto Live continuity patch applied");
