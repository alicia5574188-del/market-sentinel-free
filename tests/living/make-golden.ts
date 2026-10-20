/** Regenerates tests/fixtures/living/golden-a38882f4.json. Run ONLY on a38882f4 (the pre-living code): the file pins its output. */
import {writeFileSync} from "node:fs";
import {runForward} from "./forward-sim.ts";
import {bj} from "./fixture.ts";
import {GOLDEN_WINDOWS} from "./golden-windows.ts";
const out=GOLDEN_WINDOWS.map(w=>{
  const r=runForward({from:bj(w.from),to:bj(w.to),stepMs:w.stepMs,digestEvery:10});
  const s=r.state;
  return {...w,final:r.final,digests:r.digests,positions:s.positions.length,history:s.history.length,unopened:(s.unopenedTrades??[]).length,
    trades:[...s.history,...s.positions].map(t=>[t.id,t.symbol,t.side,t.openedAt,t.entryPrice,t.exitReason,t.netPnl])};
});
writeFileSync(new URL("../fixtures/living/golden-a38882f4.json",import.meta.url),JSON.stringify({commit:"a38882f4",generatedAt:"2026-10-20",windows:out},null,1));
for(const w of out)console.log(w.name,w.positions,w.history,w.unopened,w.final.slice(0,16),w.trades.map(t=>`${t[1]}:${t[5]}`).join(" "));
