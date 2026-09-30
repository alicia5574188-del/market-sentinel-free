import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
// Render the real presentation modules; network/cache boundaries are inert fixtures.
function render(path,props,extra={}){
  const source=ts.transpileModule(read(path),{fileName:path,compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX
  }}).outputText;
  const imports={
    react:React,"react/jsx-runtime":jsxRuntime,
    "../lib/beijing-time.ts":{BEIJING_TIME_ZONE:"Asia/Shanghai",beijingDayKey:()=>"2026-09-30"},
    "../lib/equity-cache.ts":{EquityHistoryCache:class{cancel(){}}},
    "../lib/record-view.ts":{recordWindows:rows=>({recent:rows.slice(0,10),archive:rows.slice(10)}),archivePage:rows=>({items:rows,page:0,pages:1})},
    "./record-controls.tsx":{ArchivePagination:()=>null},
    "./equity-curve.tsx":{default:()=>jsxRuntime.jsx("div",{"data-testid":"curve-fixture"})},
    "./market-intelligence-execution.tsx":{default:()=>null},
    ...extra
  };
  const module={exports:{}};
  runInNewContext(`(function(require,module,exports){${source}\n})`,{}, {filename:path})(name=>{
    if(name.endsWith(".css"))return {};
    assert.ok(Object.hasOwn(imports,name),`unexpected runtime dependency: ${name}`);
    return imports[name];
  },module,module.exports);
  return renderToStaticMarkup(React.createElement(module.exports.default,props));
}
const account=()=>({startedAt:1790670000000,updatedAt:1790761200000,initialEquity:1000,equity:922.82,
  netPnl:-77.18,maxDrawdown:.141,floating:3.2,turnover:800,fees:4,resolved:5,
  positions:[],opportunities:[],history:[],events:[],storage:{error:null},engineVersion:"market-intelligence-v1"});
const dashboardProps=data=>({data,healthy:true,statusLabel:"后台运行中",feedAt:1790761200000,error:null,liveEnabled:false,livePanel:null});

test("overview renders account equity before any statistics or research",()=>{
  const data=account();Object.defineProperty(data,"latestReason",{get(){throw new Error("overview must not read narrative prose");}});
  const html=render("app/forward-dashboard.tsx",dashboardProps(data));
  assert.match(html,/<section[^>]*data-testid="overview-equity-first"/);
  assert.ok(html.indexOf("overview-equity-first")<html.indexOf('class="fr-stats"'));
  assert.ok(html.indexOf("922.82")<html.indexOf("curve-fixture"));
  assert.match(html,/-77\.18/);assert.match(html,/14\.10%/);
  assert.doesNotMatch(html,/系统正在正常运行|独立交易假设|MARKET STATE|实盘开启参考/);
});

test("missing account stays unknown and operational errors remain visible",()=>{
  const html=render("app/forward-dashboard.tsx",{...dashboardProps(null),healthy:false,error:"fixture storage unavailable"});
  const equity=html.match(/<section[^>]*data-testid="overview-equity-first"[\s\S]*?<\/section>/)?.[0];
  assert.ok(equity);assert.match(equity,/<strong>—<\/strong>/);assert.doesNotMatch(equity,/0\.00/);
  assert.match(html,/role="alert"/);assert.match(html,/fixture storage unavailable/);
});

test("execution retains actionable waiting and position reasons without repeated philosophy",()=>{
  const data={...account(),marketIntelligence:{updatedAt:1790761200000,narrative:{major:{bias:"BULLISH"},short:{bias:"BULLISH"},plan:"NEVER_RENDER_PHILOSOPHY"},
    liquidity:{market:{ready:true,testingShare:.3},symbols:{}}},
    environmentRouter:{phase:"TRANSITIONAL",currentEnvironment:"TRANSITION",outlook:{transitionPressure:.5,horizonMinutes:45}},
    opportunities:[{id:"observed",symbol:"BTC_USDT",side:"LONG",eligible:true,score:80,tradePlan:"LIQUIDITY_MIGRATION"}],
    entryValidation:{records:[{id:"waiting",candidateId:"frozen",symbol:"ETH_USDT",side:"LONG",status:"WAITING",phase:"RETEST_WAIT",frozenOpportunity:{tradePlan:"LIQUIDITY_MIGRATION"}}]},
    positions:[{id:"held",symbol:"SUI_USDT",side:"SHORT",entryContext:{tradePlan:"FAMILY_TURN"},positionIntelligence:{decision:"REVIEW",concerns:["fixture position concern"]}}]};
  const html=render("app/market-intelligence-execution.tsx",{data,now:1790761200000,liveEnabled:false});
  for(const text of ["正在发生","接下来可能","BTC / USDT","ETH / USDT","等回调重启","SUI / USDT","重点复核","fixture position concern"])assert.ok(html.includes(text),text);
  assert.equal(html.split("ETH / USDT").length-1,1);
  assert.doesNotMatch(html,/NEVER_RENDER_PHILOSOPHY|一个板块只回答|每笔持仓只显示|这次页面精简/);
});

test("live account remains equity-first and rendering cannot enable trading",()=>{
  const number=value=>typeof value==="number"?value.toFixed(2):"—";
  const html=render("app/live-console.tsx",{auth:{authenticated:true,username:"owner",role:"owner"},
    runtime:{live:{equity:123.45,available:100,positions:{},entries:{},history:[],requestedEnabled:false},liveMode:{requestedEnabled:false}},
    onSession(){throw new Error("unexpected session mutation");},onLive(){throw new Error("unexpected live mutation");},onRefresh(){}},
    {"../lib/operator-ui.ts":{numberText:number,signedText:number,operatorTime:()=>"—",contractText:number,
      operatorRequest(){throw new Error("render must not issue requests");},isTransientLiveReadError:()=>false}});
  assert.ok(html.indexOf("live-equity-first")<html.indexOf("live-control"));
  assert.match(html,/123\.45/);assert.match(html,/aria-checked="false"/);
});

test("reference card and static manuals are removed, not hidden; cache and controls stay",()=>{
  const chart=read("app/equity-curve.tsx"),dashboard=read("app/forward-dashboard.tsx"),live=read("app/live-console.tsx");
  assert.doesNotMatch(chart,/equityReference|eq-reference|实盘开启参考|依据与限制|eq-hint/);
  assert.match(chart,/store\.configure\(context,cacheScope\)/);assert.match(chart,/history\.cacheNotice/);
  assert.match(chart,/继续加载/);assert.match(chart,/onPointerDown=\{pick\}/);
  assert.doesNotMatch(dashboard,/latestReason|当前系统边界|fr-hero-tags/);
  assert.doesNotMatch(live,/复制规则与边界|只有添加或更换API时需要填写/);
  assert.match(live,/confirmEnable&&!enabled/);assert.match(live,/disabled=\{!canEnable\}/);assert.match(live,/confirmDelete&&/);
  assert.match(read("app/paper-account-reset.tsx"),/该操作不能撤销/);
});
