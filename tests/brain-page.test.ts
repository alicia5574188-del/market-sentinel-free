/** 大脑 page (dynamic-v1.4): the one scheme on top — summary, ranked playbooks, gate decisions, pool trades, families — and the old
 * read-outs folded under 旧系统/只记录. Rendered from the fixture the screenshots use (tests/fixtures/brain-status.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {createRequire} from "node:module";

type Out={now:string;later:string;empty:string;gateWords:(w:string)=>string;dur:(h:number)=>string;phaseCn:(l:string|null)=>string};
async function render():Promise<Out>{
  const built=await build({stdin:{resolveDir:process.cwd(),sourcefile:"brain-page.tsx",contents:`
    import {createElement as h} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {BrainBody} from './app/living-panel.tsx';
    import {gateWords,dur,phaseCn} from './app/dynamic-panel.tsx';
    import {build} from './tests/fixtures/brain-status.ts';
    const page=(later)=>{const fx=build(later);return renderToStaticMarkup(h(BrainBody,{s:fx.s,data:fx.data,now:fx.now,liveEnabled:false,healthy:true,systemStatus:'正常',feedAt:fx.now,floating:1,
      busy:false,error:null,stamp:{at:fx.now,refreshing:false,failed:false},setMode(){},setItem(){}}));};
    export const out={now:page(false),later:page(true),gateWords,dur,phaseCn,
      empty:renderToStaticMarkup(h(BrainBody,{s:null,busy:false,error:null,stamp:{at:null,refreshing:false,failed:false},setMode(){},setItem(){}}))};
  `},bundle:true,write:false,format:"cjs",platform:"node",jsx:"automatic",loader:{".css":"empty"},logLevel:"silent"});
  const m={exports:{} as {out?:Out}};
  new Function("require","module","exports",built.outputFiles[0]!.text)(createRequire(import.meta.url),m,m.exports);
  return m.exports.out!;
}
test("brain page: the scheme first (switch 10, pool x/8, today, live score, hit rate, backfill), ranked playbooks, gates, pool trades, families; old system folded",async()=>{
  const r=await render(),html=r.now;
  const at=(id:string)=>html.indexOf(`data-testid="${id}"`);
  for(const id of ["owner-living-research","brain-scheme","brain-live-score","brain-backfill","execution-status","brain-ranked","brain-ranked-low","execution-positions","brain-gates","brain-pool-trades","brain-families","brain-legacy","brain-market"])
    assert.ok(at(id)>=0,id);
  assert.ok(at("brain-scheme")<at("brain-ranked")&&at("brain-ranked")<at("brain-gates")&&at("brain-gates")<at("brain-families"),"order");
  assert.ok(at("brain-legacy")<at("brain-market"),"the old market read is inside the 旧系统/只记录 fold");
  assert.match(html,/开关 10 开/);assert.match(html,/按预测开模拟单/);assert.match(html,/3\/8/);assert.match(html,/4 \/ 3/);assert.match(html,/\+3\.25%/);
  assert.match(html,/0\/157<\/b> 条序列/);assert.match(html,/不用 Gate/);assert.match(html,/现在最看好/);assert.match(html,/现在不看好/);
  assert.match(html,/全市场突然爆发/);assert.match(html,/日线突破做多/);assert.match(html,/旧系统 \/ 只记录/);
  assert.match(html,/发出开单/);assert.match(html,/不允许（只记录）/);assert.match(html,/暂停（预测被打脸）/);
  assert.doesNotMatch(html,/NaN|undefined/);
  assert.doesNotMatch(html,/关掉开关 ?10|打开开关 ?10/,"switch 10 has no toggle button any more");assert.doesNotMatch(r.later,/关掉开关 ?10|打开开关 ?10/);
  assert.match(r.later,/\+0\.21%\/笔/);assert.match(r.later,/-0\.09%\/笔/);assert.match(r.later,/看好时跟着来的交易比不看好时好/);assert.match(r.later,/61%/);
  assert.match(r.empty,/读取中/);
  assert.equal(r.gateWords("未来 6 小时处在赚钱期的概率 41%（要 ≥58%）【数据一般】"),"概率没到门槛 58%，只记录");
  assert.equal(r.gateWords("预测：未来 6 小时在赚钱期的概率 71%（赚钱期第 3 小时）【数据一般】；证据 ×0.61 → 风险 0.31%"),"概率过了门槛 58%；证据 ×0.61 → 风险 0.31%");
  assert.equal(r.gateWords("分配器不允许（只记录）— 未来 6 小时处在赚钱期的概率 41%（要 ≥58%）【数据少】"),"概率没到门槛 58%，只记录");
  assert.deepEqual([r.dur(5),r.dur(56),r.dur(48),r.phaseCn("GOOD"),r.phaseCn("BAD"),r.phaseCn(null)],["5 小时","2 天 8 小时","2 天","赚钱期","亏钱期","还看不清"]);
});
