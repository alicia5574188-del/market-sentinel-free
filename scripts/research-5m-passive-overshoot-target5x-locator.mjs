import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const sourcePath=new URL('./research-5m-passive-overshoot-fade-target5x.mjs',import.meta.url);
let source=readFileSync(sourcePath,'utf8');
const oldFractions="const fractions=[.02,.025,.03,.04,.05]";
const newFractions="const fractions=[.005,.0075,.01,.0125,.015,.02]";
if(!source.includes(oldFractions))throw new Error('fraction patch marker missing');
source=source.replace(oldFractions,newFractions)
  .replace("5m-passive-overshoot-fade-target5x-v2","5m-passive-overshoot-fade-target5x-locator-v3")
  .replace("Only notional fractions are reduced from 10/20/30% to 2/2.5/3/4/5%","Only notional fractions are reduced to 0.5/0.75/1/1.25/1.5/2% to locate the genuine 5x turnover band");
const patched='/tmp/research-passive-target5x-locator-patched.mjs';
writeFileSync(patched,source);
const run=spawnSync(process.execPath,['--max-old-space-size=6144',patched],{env:{...process.env,RESEARCH_OUTPUT:process.env.RESEARCH_OUTPUT??'/tmp/passive-overshoot-target5x-locator.json'},stdio:'inherit',maxBuffer:1024*1024*20});
if(run.status!==0)throw new Error(`locator replay failed status=${run.status}`);
