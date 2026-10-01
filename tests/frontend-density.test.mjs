import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";
import * as liveEquity from '../lib/live-equity.ts';
import * as equityGeometry from '../lib/equity-curve.ts';
import {EquityHistoryCache,EQUITY_CACHE_VERSION} from '../lib/equity-cache.ts';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
// Load the real pure accounting helper, not a favorable mocked PnL formula.
const realizationModule={exports:{}};
const realizationSource=ts.transpileModule(read("lib/trade-realization.ts"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
runInNewContext(`(function(require,module,exports){${realizationSource}\n})`,{})(name=>{throw new Error(`pure accounting imported ${name}`);},realizationModule,realizationModule.exports);
const paidModule={exports:{}};
const paidSource=ts.transpileModule(read("lib/paid-fee-view.ts"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
runInNewContext(`(function(require,module,exports){${paidSource}\n})`,{})(name=>{throw new Error(`pure view imported ${name}`);},paidModule,paidModule.exports);
// Render the real presentation modules; network/cache boundaries are inert fixtures.
function render(path,props,extra={},component="default"){
  const source=ts.transpileModule(read(path),{fileName:path,compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX
  }}).outputText;
  const imports={
    react:React,"react/jsx-runtime":jsxRuntime,
    "../lib/trade-realization.ts":realizationModule.exports,
    "../lib/paid-fee-view.ts":paidModule.exports,
    "../lib/research-snapshot.ts":{collectReviewSnapshot(){throw new Error("render must not export");}},
    "../lib/beijing-time.ts":{BEIJING_TIME_ZONE:"Asia/Shanghai",beijingDayKey:()=>"2026-09-30"},
    "../lib/equity-cache.ts":{EquityHistoryCache:class{cancel(){}}},
    "../lib/record-view.ts":{recordWindows:rows=>({recent:rows.slice(0,10),archive:rows.slice(10)}),archivePage:rows=>({items:rows,page:0,pages:1})},
    "./record-controls.tsx":{ArchivePagination:()=>null},
    "./equity-curve.tsx":{default:()=>jsxRuntime.jsx("div",{"data-testid":"curve-fixture"})},
    "./live-equity-curve.tsx":{default:props=>jsxRuntime.jsx('div',{'data-testid':'live-curve-fixture','data-session':props.sessionAt})},
    "./market-intelligence-execution.tsx":{default:()=>null},
    ...extra
  };
  const fixtureModule={exports:{}};
  runInNewContext(`(function(require,module,exports){${source}\n})`,{}, {filename:path})(name=>{
    if(name.endsWith(".css"))return {};
    assert.ok(Object.hasOwn(imports,name),`unexpected runtime dependency: ${name}`);
    return imports[name];
  },fixtureModule,fixtureModule.exports);
  return renderToStaticMarkup(React.createElement(fixtureModule.exports[component],props));
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

test("paper floating display deducts paid entry fees only and leaves future exit fees out",()=>{
  const data={...account(),floating:123.45,positions:[{
    id:"open-long",status:"OPEN",symbol:"WLD_USDT",side:"LONG",entryPrice:100,lastPrice:101,quantity:1,notional:100,entryFee:.07,
    leverage:10,margin:10,plannedRisk:1,openedAt:1790760000000,closedAt:null,exitPrice:null,netPnl:null,stopPrice:98,
    favorable:.01,adverse:0,profitFloorRate:0,expectedHoldMinutes:30,entryContext:null,holdScore:80
  }]};
  const html=render("app/forward-dashboard.tsx",dashboardProps(data));
  assert.match(html,/<small>浮动盈亏<\/small><strong>\+0\.93 U<\/strong>/);
  assert.doesNotMatch(html,/<small>浮动盈亏<\/small><strong>\+123\.45 U<\/strong>/);
});

test("missing account stays unknown and operational errors remain visible",()=>{
  const html=render("app/forward-dashboard.tsx",{...dashboardProps(null),healthy:false,error:"fixture storage unavailable"});
  const equity=html.match(/<section[^>]*data-testid="overview-equity-first"[\s\S]*?<\/section>/)?.[0];
  assert.ok(equity);assert.match(equity,/<strong>—<\/strong>/);assert.doesNotMatch(equity,/0\.00/);
  assert.match(html,/role="alert"/);assert.match(html,/fixture storage unavailable/);
});

test('LIVE ON uses exchange equity and floating while preserving the separate original PAPER curve',()=>{
  const data={...account(),equity:9876.54,netPnl:8876.54};
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(data),cacheScope:'member:curve-owner',liveEnabled:true,
    liveOverview:{equity:101.23,available:80,positionCount:1,accountMark:{initialEquity:110,tradingPnl:-8.77,
      capitalChange:-8.77,floating:-3.21,margin:20,positionCount:1,startedAt:1790760000000,maxDrawdown:.08},copied:1,eligible:3,missing:2}},
    {'./equity-curve.tsx':{default:props=>{
      assert.strictEqual(props.data,data);assert.equal(props.cacheScope,'member:curve-owner');assert.ok(props.cache);
      return jsxRuntime.jsx('div',{'data-testid':'curve-fixture',children:'PAPER_CURVE_9876.54'});
    }}});
  assert.match(html,/101\.23/);assert.match(html,/-3\.21 U/);assert.match(html,/-8\.77/);
  const equity=html.match(/<section[^>]*data-testid="overview-equity-first"[\s\S]*?<\/section>/)?.[0];
  assert.doesNotMatch(equity,/9,876\.54|8,876\.54|PAPER_CURVE/);
  assert.match(html,/data-testid="paper-equity-curve"[\s\S]*模拟净值[\s\S]*PAPER_CURVE_9876\.54/);
  assert.equal(html.split('data-testid="curve-fixture"').length-1,1);
  assert.match(html,/未跟上 2/);assert.match(html,/含出入金/);
});
test('LIVE ON without account confirmation does not substitute simulated equity or zero PnL',()=>{
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(account()),liveEnabled:true});
  const equity=html.match(/<section[^>]*data-testid="overview-equity-first"[\s\S]*?<\/section>/)?.[0];
  assert.match(equity,/<strong>—<\/strong>/);assert.doesNotMatch(equity,/922\.82|-77\.18|\+0\.00/);
  assert.match(html,/paper-equity-curve/);assert.match(html,/curve-fixture/);
});
test('LIVE ON simulated page keeps the native order panel without either overview curve',()=>{
  const data=account();
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(data),liveEnabled:true,livePanel:'REAL_ORDER_PANEL'},
    {react:{...React,useState:value=>React.useState(value==='overview'?'paper':value)},
      './equity-curve.tsx':{default:props=>{assert.strictEqual(props.data,data);return jsxRuntime.jsx('div',{'data-testid':'curve-fixture'});}}});
  assert.match(html,/paper-live-mirror/);assert.match(html,/REAL_ORDER_PANEL/);
  assert.doesNotMatch(html,/paper-equity-curve|模拟净值|curve-fixture|live-equity-curve/);
  assert.doesNotMatch(html,/模拟权益|暂无已平仓记录|当前没有模拟持仓|shadow-inverse-comparison/);
});
test('overview passes actual LIVE session and account observations to its separate curve',()=>{
  const mark={sessionAt:123,accountUser:'gate-fixture'},head={sessionAt:123,lastEquity:456};
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(account()),liveEnabled:true,cacheScope:'member:private',
    liveOverview:{equity:456,accountMark:mark,equityCurve:head,sessionAt:123}},
    {'./live-equity-curve.tsx':{default:props=>{
      assert.strictEqual(props.head,head);assert.strictEqual(props.mark,mark);assert.equal(props.sessionAt,123);
      assert.equal(props.cacheScope,'member:private');assert.equal(props.enabled,true);
      return jsxRuntime.jsx('div',{'data-testid':'live-curve-fixture'});
    }}});
  assert.equal(html.split('data-testid="curve-fixture"').length-1,1);
  assert.equal(html.split('data-testid="live-curve-fixture"').length-1,1);
});
test('real LIVE curve hides old-session data while awaiting the new baseline and uses native scoped history',()=>{
  const T=1790760000000,head={version:liveEquity.LIVE_EQUITY_VERSION,sessionAt:T,accountUser:'gate-test',startedAt:T,
    initialEquity:100,lastAt:T+300000,lastEquity:93};
  const props={head,mark:null,enabled:true,sessionAt:T,cacheScope:'member:one',now:T+300000};
  const extra={'../lib/live-equity.ts':liveEquity,'./equity-curve.tsx':{default:p=>{
    assert.equal(p.data.equity,93);assert.equal(p.data.initialEquity,100);assert.equal(p.label,'实盘账户净值');
    assert.equal(p.cacheScope,`live:member:one:${T}:gate-test`);assert.equal(p.healthy,false);
    return jsxRuntime.jsx('div',{'data-testid':'native-curve'});
  }}};
  assert.match(render('app/live-equity-curve.tsx',props,extra),/native-curve/);
  const pending=render('app/live-equity-curve.tsx',{...props,sessionAt:T+1},extra);
  assert.match(pending,/等待本次开启后的实盘净值记录/);assert.doesNotMatch(pending,/native-curve/);
});
test('both real chart variants share ranges, sliding controls and exact saved native values',()=>{
  const T=1790760000000,data={startedAt:T,initialEquity:100,equity:93,updatedAt:T+300000,storage:{persistedAt:T+300000}};
  const points=[{at:T+300000,equity:93,kind:'observed',policy:'native',homogeneous:true}];
  for(const label of ['模拟账户净值','实盘账户净值']){
    const html=render('app/equity-curve.tsx',{data,healthy:false,label,fixture:{points,complete:true},cache:new EquityHistoryCache()},
      {'../lib/equity-curve.ts':equityGeometry,'../lib/equity-cache.ts':{EquityHistoryCache,EQUITY_CACHE_VERSION}});
    assert.match(html,new RegExp(label));assert.match(html,/93\.00/);assert.match(html,/-7\.00 U/);
    for(const control of ['24小时','7天','全部','较早','较新','最新'])assert.ok(html.includes(control));
    assert.match(html,/class="eq-curve"/);assert.match(html,/aria-label="净值曲线，可左右滑动或使用方向键"/);
  }
});

test("partial realizations are not counted as floating and entry fees are allocated only once",()=>{
  const t={id:"partial",status:"OPEN",symbol:"WLD_USDT",side:"LONG",entryPrice:100,lastPrice:110,quantity:6,contracts:6,
    notional:600,entryFee:.7,leverage:10,margin:60,plannedRisk:6,openedAt:1790760000000,closedAt:null,exitPrice:null,
    netPnl:null,stopPrice:103,favorable:.1,adverse:0,profitFloorRate:.03,expectedHoldMinutes:180,entryContext:null,holdScore:80,
    realization:{version:"partial-realization-v1",initialQuantity:10,initialContracts:10,initialNotional:1000,initialMargin:100,
      initialRisk:10,initialEntryFee:.7,gross:32,fees:.3024,funding:0,sequence:1,
      fills:[{sequence:1,at:1790760300000,quoteAt:1790760300000,price:108,contracts:4,quantity:4,gross:32,fee:.3024,funding:0,reason:"fixture"}]}};
  const accounting=realizationModule.exports;
  assert.ok(Math.abs(accounting.remainingOpenNetPnl(t)-59.118)<1e-10);
  assert.ok(Math.abs(accounting.realizedNetPnl(t)-31.4176)<1e-10);
  assert.ok(Math.abs(accounting.remainingOpenNetPnl(t)+accounting.realizedNetPnl(t)-90.5356)<1e-10);
  const html=render("app/forward-dashboard.tsx",dashboardProps({...account(),floating:123.45,positions:[t]}));
  assert.match(html,/<small>浮动盈亏<\/small><strong>\+59\.58 U<\/strong>/);
  assert.doesNotMatch(html,/<small>浮动盈亏<\/small><strong>\+90\.54 U<\/strong>/);
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
test('LIVE open and archived cards keep six primary fields and fold execution attribution',()=>{
  const number=value=>typeof value==='number'?value.toFixed(2):'—';
  for(const status of ['OPEN','CLOSED']){
    const position={id:'fixture',symbol:'LONGSYMBOL_USDT',side:'SHORT',status,entryPrice:100.01,exitPrice:99,
      entryAt:1790760000000,exitAt:1790761200000,notional:1000,margin:100,leverage:10,exchangeSize:10,realizedPnl:9,
      parity:{sourceEntryPrice:100,sourceId:'fixture',sourceRole:'INVERSE_PAPER'},exitReason:'SOURCE_CLOSED'};
    const html=render('app/live-console.tsx',{position,runtime:null,now:1790761200000},
      {'../lib/operator-ui.ts':{numberText:number,signedText:number,operatorTime:()=> '2026/10/01 17:21:23',contractText:number,
        holdingTime:()=> '20分钟',livePositionMark:()=>({pnl:1,margin:100,price:99}),operatorRequest(){throw new Error('network forbidden');}}},'LivePositionCard');
    const primary=html.slice(0,html.indexOf('<details'));
    assert.equal((primary.match(/<dt>/g)??[]).length,6);
    assert.match(primary,/入场对比/);assert.match(primary,/更优/);assert.match(primary,/进场时间/);assert.match(primary,/出场时间/);
    assert.doesNotMatch(primary,/源信号参考 ↔ 实盘|名义金额|合约数量|SOURCE_CLOSED/);
    assert.match(html,/<details class="fr-details"><summary>详情<\/summary>/);assert.doesNotMatch(html,/<details[^>]* open/);
    assert.match(html,/SOURCE_CLOSED/);assert.match(html,/源信号参考 ↔ 实盘/);
  }
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

test("waiting and holding views use the frozen order area, not a newer conflicting map",()=>{
  const frozen={version:"winner-preservation-v1",researchVersion:"research-plan-v1",intent:"TREND",initialStop:99,
    origin:{lower:100,upper:104,center:102},target:null},current={...frozen,origin:{lower:200,upper:204,center:202}};
  const data={...account(),opportunities:[{id:"same",symbol:"SUI_USDT",side:"LONG",eligible:true,score:88,tradePlan:"WINNER_TREND",winnerPlan:current}],
    entryValidation:{records:[{id:"same",candidateId:"same",symbol:"SUI_USDT",side:"LONG",status:"WAITING",phase:"ARMED",stableThesis:true,
      frozenOpportunity:{tradePlan:"WINNER_TREND",winnerPlan:frozen}}]}};
  const html=render("app/market-intelligence-execution.tsx",{data,now:1790761200000,liveEnabled:false});
  assert.match(html,/本单参考区 100–104/);assert.doesNotMatch(html,/本单参考区 200–204/);
});

test("order cards expose exact-price shadow/inverse nets before expanding, without an unfilled close charge",()=>{
  const t={id:"iv-source",status:"OPEN",symbol:"AAVE_USDT",side:"LONG",entryPrice:100,lastPrice:102,quantity:2,contracts:2,
    notional:200,entryFee:.14,leverage:10,margin:20,plannedRisk:2,openedAt:1790760000000,closedAt:null,
    stopPrice:98,expectedHoldMinutes:40,favorable:.02,adverse:0,entryContext:null,
    inverseCopy:{sourceId:"source",sourceSide:"SHORT",sourceEntryPrice:100,fills:[{sequence:0,kind:"OPEN",quantity:2,contracts:2,
      sourcePrice:100,price:100,sourceFee:.14,fee:.14,sourceGross:0,gross:0,sourceFunding:0,funding:0,spreadDrag:0,
      sourceAt:1790760000000,appliedAt:1790760000000,sourceQuoteAt:1790760000000,quoteAt:1790760000000}]}};
  const source={id:"source",status:"OPEN",symbol:"AAVE_USDT",side:"SHORT",entryPrice:100,lastPrice:102,lastQuoteAt:1790761200000};
  const pair=paidModule.exports.pairedPaidView(t,undefined,1790761200000,source);
  const html=render("app/forward-dashboard.tsx",{trade:t,now:1790761200000,paid:pair},{},"TradeCard");
  const summary=html.match(/<summary>[\s\S]*?<\/summary>/)?.[0];assert.ok(summary);
  assert.match(summary,/原策略影子 · 空/);assert.match(summary,/反向模拟 · 多/);
  assert.match(summary,/净额 -4\.14 U/);assert.match(summary,/净额 \+3\.86 U/);
  assert.match(summary,/已扣手续费 0\.1400 U/);assert.doesNotMatch(summary,/平仓 [0-9]|已减仓 [0-9]/);
  assert.match(summary,/毛盈亏镜像校验 0\.000000 U/);assert.doesNotMatch(summary,/报价毛额差/);
});
test("comparison shows exact-mirror paid-fee nets and overview fee never adds estimates",()=>{
  const data=account();data.fees=3.25;
  data.shadowInverse={sourceNet:-999,inverseNet:888,sourceFees:1.25,inverseFees:1.25,pairedOpened:7,pairedClosed:2,legacyOpen:0,
    initialEquity:1000,cutoverAt:1790760000000,sourceEquity:998,inverseEquity:1001,theoreticalSamePriceEquity:1001,curve:[],realizedSpreadDrag:0,
    paidCost:{source:{netPnl:-5},inverse:{netPnl:2.5},rows:[],stalePairs:0,
      reconciliation:{grossMirrorResidual:0,paidFees:2.5,netSum:-2.5},estimatedExitFees:{source:66,inverse:66}}};
  const html=render("app/forward-dashboard.tsx",dashboardProps(data));
  assert.match(html,/原策略影子净额/);assert.match(html,/-5\.00 U/);assert.match(html,/\+2\.50 U/);
  assert.doesNotMatch(html,/-999\.00|\+888\.00|报价毛额差|资金费占位/);
  assert.match(html,/<small>模拟已扣手续费<\/small><b>3\.25 U<\/b>/);
  assert.match(html,/同价镜像对照曲线/);assert.match(html,/毛盈亏镜像校验 0\.000000 U/);
});
