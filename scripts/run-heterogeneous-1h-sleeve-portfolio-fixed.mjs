import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = 'scripts/research-heterogeneous-1h-sleeve-portfolio.mjs';
const source = readFileSync(sourcePath, 'utf8');
const needle = '&from=${from}&to=${to}`);';
const replacement = '&interval=1h&from=${from}&to=${to}`);';
if (!source.includes(needle)) {
  throw new Error('Expected Gate candlestick request shape not found; refusing to alter research logic implicitly.');
}
const patched = source.replace(needle, replacement);
if (patched === source) throw new Error('1h candle adapter made no change');
const out = '/tmp/research-heterogeneous-1h-sleeve-portfolio-fixed.mjs';
writeFileSync(out, patched);
await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
