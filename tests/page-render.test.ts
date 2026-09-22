import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {createRequire} from "node:module";

test("real React renders login, recovering dashboard and restored account without mounting LIVE eagerly",async()=>{
  const built=await build({stdin:{resolveDir:process.cwd(),sourcefile:"page-smoke.tsx",contents:`
    import {createElement as h} from 'react';
    import {renderToStaticMarkup as render} from 'react-dom/server';
    import Home from './app/page.tsx';
    import Dashboard from './app/forward-dashboard.tsx';
    import LiveConsole from './app/live-console.tsx';
    import {initialMultiTurnForward,forwardSummary} from './lib/forward-relations.ts';
    const auth={configured:true,authenticated:true,username:'owner',role:'owner'};
    const props={healthy:false,feedAt:null,error:'账户恢复测试',liveEnabled:false,
      livePanel:h(()=>{throw new Error('LIVE mounted before first visit')})};
    const state=initialMultiTurnForward(1790050000000);
    export const surfaces=[render(h(Home)),render(h(Dashboard,{...props,data:null})),
      render(h(Dashboard,{...props,data:forwardSummary(state,{},1790050001000)})),
      render(h(LiveConsole,{auth,runtime:null,onSession(){},onLive(){},onRefresh(){}}))];
  `},bundle:true,write:false,format:"cjs",platform:"node",jsx:"automatic",loader:{".css":"empty"},logLevel:"silent"});
  const module_={exports:{} as {surfaces?:string[]}};
  const evaluate=new Function("require","module","exports",built.outputFiles[0].text);
  evaluate(createRequire(import.meta.url),module_,module_.exports);
  const surfaces=module_.exports.surfaces!;
  assert.equal(surfaces.length,4);
  assert.ok(surfaces.every(html=>html.length>500));
  assert.match(surfaces[0],/登录/);
  assert.match(surfaces[1],/账户恢复测试/);
  assert.match(surfaces[2],/主导航/);
  assert.match(surfaces[3],/实盘账户/);
});
