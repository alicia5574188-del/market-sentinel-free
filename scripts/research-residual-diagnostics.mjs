import { readFileSync, writeFileSync } from "node:fs";

const sourcePath = "scripts/research-residual-microcells.mjs";
const tempPath = "scripts/.research-residual-diagnostics.generated.mjs";
const source = readFileSync(sourcePath, "utf8");
const needle = "qualifiedCells, portfolios: Object.fromEntries";
if (!source.includes(needle)) throw new Error("Residual report marker changed");
const patched = source.replace(needle, "qualifiedCells, cellAudit, portfolios: Object.fromEntries");
writeFileSync(tempPath, patched);
process.env.RESIDUAL_OUTPUT = process.env.RESIDUAL_DIAGNOSTIC_OUTPUT ?? "/tmp/residual-diagnostics.json";
await import(`./.research-residual-diagnostics.generated.mjs?ts=${Date.now()}`);
