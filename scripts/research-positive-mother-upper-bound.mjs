import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SIGNAL=process.env.RESEARCH_SIGNAL_DATASET??'/tmp/gate-history-44m-from5m-1h.json';
const EXEC=process.env.RESEARCH_EXECUTION_DATASET??'/tmp/gate-history-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/positive-mother-upper-bound.json';
const REPORT_SOURCE='research-results/regime-system-portfolios-2026-09-14.json';
const SOURCE=new URL('./research-regime-system-portfolios.mjs',import.meta.url);
const EXPECTED_SIGNAL='185bd97b968f96373bef6a174c8258d8ad5606a0d1ed824eaa2cc1ace1efa053';
const EXPECTED_EXEC='9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522';
const signal=JSON.parse(readFileSync(SIGNAL,'utf8')),exec=JSON.parse(readFileSync(EXEC,'utf8'));
if(signal.sha256!==EXPECTED_SIGNAL||exec.sha256!==EXPECTED_EXEC)throw new Error('dataset hash mismatch');
const frozen=JSON.parse(readFileSync(REPORT_SOURCE,'utf8'));
const robust=frozen.crossPeriodAudit.filter(x=>x.allPeriodsPositive===true&&x.stressDiscovery.netPnl>0&&x.stressValidation.netPnl>0&&x.stressRecent.netPnl>0);
const robustIds=robust.map(x=>x.id);
if(robustIds.length!==29)throw new Error(`expected 29 robust configs, got ${robustIds.length}`);
const tacticFamilies=[...new Set(robust.map(x=>`${x.system}|${x.tactic}`))];

const original=readFileSync(SOURCE,'utf8');
const marker='const serializableSystems = systems.map((system) => {';
if(!original.includes(marker))throw new Error('injection marker missing');
const injection=String.raw`
if (process.env.RESEARCH_UPPER_BOUND_OUTPUT && process.env.RESEARCH_UPPER_BOUND_IDS) {
  const ids = JSON.parse(process.env.RESEARCH_UPPER_BOUND_IDS);
  const chosen = activeConfigs.filter((c) => ids.includes(c.id));
  if (chosen.length !== ids.length) throw new Error('upper-bound config id mismatch');
  const dayMs = 86_400_000;
  const periods = { discovery:[fromMs,discoveryEnd], validation:[discoveryEnd,validationEnd], evaluation:[validationEnd,toMs], full:[fromMs,toMs] };
  const turnover = (account,start,end) => {
    const grouped = new Map();
    for (const t of account.trades) {
      const f = t.notional / Math.max(t.equityAtOpen, 1e-12); const d = t.side === 'LONG' ? 1 : -1;
      for (const [time,delta] of [[t.openedAt,d*f],[t.closedAt,-d*f]]) if (time >= start && time < end) {
        const k = time + '|' + t.symbol; grouped.set(k,(grouped.get(k) ?? 0) + delta);
      }
    }
    return [...grouped.values()].reduce((s,x)=>s+Math.abs(x),0) / ((end-start)/dayMs);
  };
  const summarize = (friction,slippage) => {
    const trades = chosen.flatMap((c)=>rawTrades(c,toMs,friction,slippage)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength||a.strategyId.localeCompare(b.strategyId));
    const account = portfolio(trades,configById);
    return { endEquity:account.endEquity, maxDrawdown:account.maxDrawdown,
      periods:Object.fromEntries(Object.entries(periods).map(([k,[a,b]])=>[k,{...compactMetrics(metrics(account,a,b)),turnoverPerDay:turnover(account,a,b)}])) };
  };
  const base=summarize(FRICTION,ENTRY_SLIPPAGE),stress=summarize(STRESS_FRICTION,ENTRY_SLIPPAGE),adverse=summarize(FRICTION,ENTRY_SLIPPAGE*2);
  writeFileSync(process.env.RESEARCH_UPPER_BOUND_OUTPUT,JSON.stringify({ ids,chosen:chosen.map(c=>({id:c.id,system:c.system,tactic:c.tactic})),base,stress,adverse },null,2));
}
`;
const patched=original.replace(marker,`${injection}\n${marker}`);
const patchedPath='/tmp/research-regime-system-portfolios-upper-bound.mjs';
writeFileSync(patchedPath,patched);
const childOutput='/tmp/upper-bound-inner.json';
const baseReport='/tmp/upper-bound-base-report.json';
const run=spawnSync(process.execPath,[patchedPath],{env:{...process.env,RESEARCH_SIGNAL_DATASET:SIGNAL,RESEARCH_EXECUTION_DATASET:EXEC,RESEARCH_OUTPUT:baseReport,RESEARCH_UPPER_BOUND_OUTPUT:childOutput,RESEARCH_UPPER_BOUND_IDS:JSON.stringify(robustIds)},stdio:'inherit',maxBuffer:1024*1024*100});
if(run.status!==0)throw new Error(`source replay failed ${run.status}`);
const inner=JSON.parse(readFileSync(childOutput,'utf8'));
const nativeTurnover=inner.stress.periods.full.turnoverPerDay;
const output={research:'all-robust-positive-mothers-hindsight-upper-bound-v1',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',decision:nativeTurnover>=5&&inner.stress.periods.full.netPnl>0?'UPPER_BOUND_REACHES_5X_NATIVE':'UPPER_BOUND_BELOW_5X_NATIVE',purpose:'optimistic ceiling test only: all 29 variants already known to be positive across discovery/validation/evaluation and stress are run together. Because evaluation knowledge is used to define the set, this cannot authorize a strategy; it can only rule the route out if even this ceiling is insufficient.',data:{signalSha256:signal.sha256,executionSha256:exec.sha256,months:exec.months,symbols:exec.symbols},robustConfigCount:robustIds.length,tacticFamilyCount:tacticFamilies.length,tacticFamilies,protocol:{selection:'hindsight upper bound using all-period-positive + all-period-stress-positive audit entries',execution:'exact original regime research rawTrades/portfolio logic, exact 5m path, same global risk constraints',costs:{base:0.0014,stress:0.0022,adverseEntryExtra:0.00025},turnover:'accepted trade entry+exit signed equity fractions netted by symbol+timestamp'},...inner,nativeStressTurnoverPerDay:nativeTurnover,gapTo5x:5-nativeTurnover,interpretation:nativeTurnover<5?'Even the deliberately optimistic all-known-winners pool does not natively supply 5x/day; causal selection can only be weaker or equal. Do not pursue parameter-neighbor proliferation as the missing turnover engine.':'This optimistic ceiling can exceed 5x; next stage must remove hindsight and select distinct tactics using discovery+validation only before evaluation.'};
writeFileSync(OUTPUT,JSON.stringify(output,null,2)+'\n');
console.log('POSITIVE_MOTHER_UPPER='+JSON.stringify({decision:output.decision,robustConfigCount:output.robustConfigCount,tacticFamilyCount:output.tacticFamilyCount,nativeStressTurnoverPerDay:output.nativeStressTurnoverPerDay,gapTo5x:output.gapTo5x,stress:output.stress.periods}));
