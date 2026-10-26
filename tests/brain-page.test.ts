/** 大脑 page: reverse hold only. Positions (price % and U) and the last closes. Research boards are gone.
 * gateWords / dur / phaseCn stay as plain-text helpers (the page no longer renders them). */
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
test("brain page: reverse hold, live off, open positions with price % and U, recent closes; no research boards",async()=>{
  const r=await render(),html=r.now;
  const at=(id:string)=>html.indexOf(`data-testid="${id}"`);
  for(const id of ["owner-living-research","brain-scheme","execution-status","execution-positions","brain-recent"])
    assert.ok(at(id)>=0,id);
  assert.ok(at("brain-scheme")<at("execution-status")&&at("execution-status")<at("execution-positions")&&at("execution-positions")<at("brain-recent"),"order");
  assert.match(html,/反向持仓/);assert.match(html,/历史不再下载/);assert.match(html,/只跑模拟，不下单/);
  assert.match(html,/价格 \+/);assert.match(html,/SOL/);assert.match(html,/\+3\.41/);
  assert.doesNotMatch(html,/旧系统|开关 10|现在最看好|data-testid="brain-ranked"|data-testid="brain-gates"|data-testid="brain-families"|data-testid="brain-legacy"|data-testid="brain-backfill"/);
  assert.doesNotMatch(html,/NaN|undefined/);
  assert.match(r.later,/反向持仓/);assert.match(r.empty,/读取中/);
  assert.equal(r.gateWords("未来 6 小时处在赚钱期的概率 41%（要 ≥58%）【数据一般】"),"概率没到门槛 58%，只记录");
  assert.equal(r.gateWords("预测：未来 6 小时在赚钱期的概率 71%（赚钱期第 3 小时）【数据一般】；证据 ×0.61 → 风险 0.31%"),"概率过了门槛 58%；证据 ×0.61 → 风险 0.31%");
  assert.equal(r.gateWords("分配器不允许（只记录）— 未来 6 小时处在赚钱期的概率 41%（要 ≥58%）【数据少】"),"概率没到门槛 58%，只记录");
  assert.deepEqual([r.dur(5),r.dur(56),r.dur(48),r.phaseCn("GOOD"),r.phaseCn("BAD"),r.phaseCn(null)],["5 小时","2 天 8 小时","2 天","赚钱期","亏钱期","还看不清"]);
});
