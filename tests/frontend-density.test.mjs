import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";
import * as inverseFee from '../lib/inverse-fee.ts';
import * as panelCache from '../lib/panel-cache.ts';
import * as systemPanels from '../lib/system-panels.ts';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
// Load the real pure accounting helper, not a favorable mocked PnL formula.
const realizationModule={exports:{}};
const realizationSource=ts.transpileModule(read("lib/trade-realization.ts"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
runInNewContext(`(function(require,module,exports){${realizationSource}\n})`,{})(name=>{throw new Error(`pure accounting imported ${name}`);},realizationModule,realizationModule.exports);
const paidModule={exports:{}};
const paidSource=ts.transpileModule(read("lib/paid-fee-view.ts"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
runInNewContext(`(function(require,module,exports){${paidSource}\n})`,{})(name=>{
  if(name==='./inverse-fee.ts')return inverseFee;
  throw new Error(`pure view imported ${name}`);
},paidModule,paidModule.exports);
// The real paper-account selector (which book the page shows and its floating P&L).
const paperAccountModule={exports:{}};
const paperAccountSource=ts.transpileModule(read("lib/paper-account-view.ts"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
runInNewContext(`(function(require,module,exports){${paperAccountSource}\n})`,{Set,Number})(name=>{
  if(name==='./paid-fee-view.ts')return paidModule.exports;
  throw new Error(`paper account view imported ${name}`);
},paperAccountModule,paperAccountModule.exports);
// The shared order card is a pure presentation module; load the real one, not a fixture.
const orderCardModule={exports:{}};
const orderCardSource=ts.transpileModule(read("app/order-card.tsx"),{fileName:"app/order-card.tsx",compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
runInNewContext(`(function(require,module,exports){${orderCardSource}\n})`,{})(name=>{
  if(name.endsWith(".css"))return {};
  if(name==="react/jsx-runtime")return jsxRuntime;
  throw new Error(`order card imported ${name}`);
},orderCardModule,orderCardModule.exports);
// Living-trade order-card text (pure, no imports).
const livingViewModule={exports:{}};
runInNewContext(`(function(require,module,exports){${ts.transpileModule(read("lib/living-trade-view.ts"),{fileName:"lib/living-trade-view.ts",compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText}\n})`,{Math,Number})(name=>{
  throw new Error(`living trade view imported ${name}`);
},livingViewModule,livingViewModule.exports);
// The real freshness stamp (pure presentation).
const panelStampModule={exports:{}};
const panelStampSource=ts.transpileModule(read("app/panel-stamp.tsx"),{fileName:"app/panel-stamp.tsx",compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
runInNewContext(`(function(require,module,exports){${panelStampSource}\n})`,{Intl,Date})(name=>{
  if(name.endsWith(".css"))return {};
  if(name==="react/jsx-runtime")return jsxRuntime;
  if(name==="../lib/beijing-time.ts")return {BEIJING_TIME_ZONE:"Asia/Shanghai"};
  throw new Error(`panel stamp imported ${name}`);
},panelStampModule,panelStampModule.exports);
// Render the real presentation modules; network/cache boundaries are inert fixtures.
function render(path,props,extra={},component="default"){
  const source=ts.transpileModule(read(path),{fileName:path,compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX
  }}).outputText;
  const imports={
    react:{...React,useState(initial){return React.useState(initial==="execution"?"paper":initial);}},"react/jsx-runtime":jsxRuntime,
    "../lib/trade-realization.ts":realizationModule.exports,
    "../lib/paid-fee-view.ts":paidModule.exports,
    "../lib/paper-account-view.ts":paperAccountModule.exports,
    "../lib/research-snapshot.ts":{collectReviewSnapshot(){throw new Error("render must not export");}},
    "../lib/beijing-time.ts":{BEIJING_TIME_ZONE:"Asia/Shanghai",beijingDayKey:()=>"2026-09-30"},
    "../lib/equity-browser-purge.ts":{purgeEquityBrowserCache(){}},
    "../lib/visible-poll.ts":{pageHidden:()=>false,visibleInterval:()=>()=>{}},
    "../lib/record-view.ts":{recordWindows:rows=>({recent:rows.slice(0,10),archive:rows.slice(10)}),archivePage:rows=>({items:rows,page:0,pages:1})},
    "./record-controls.tsx":{ArchivePagination:()=>null},
    "./order-card.tsx":orderCardModule.exports,
    "../lib/living-trade-view.ts":livingViewModule.exports,
    "./panel-stamp.tsx":panelStampModule.exports,
    "../lib/panel-cache.ts":panelCache,
    "../lib/system-panels.ts":systemPanels,
    "./market-intelligence-execution.tsx":{default:()=>null},
    "./living-panel.tsx":{default:()=>jsxRuntime.jsx("div",{"data-testid":"brain-fixture"})},
    "./run-log-status.tsx":{default:()=>jsxRuntime.jsx("div",{"data-testid":"run-log-status-fixture"})},
    "./nts-panel.tsx":{default:()=>jsxRuntime.jsx("div",{"data-testid":"nts-fixture"})},
    ...extra
  };
  const fixtureModule={exports:{}};
  runInNewContext(`(function(require,module,exports){${source}\n})`,{window:{scrollY:0,scrollTo(){}}}, {filename:path})(name=>{
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
  assert.ok(html.indexOf("922.82")<html.indexOf('data-testid="forward-orders"'));
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

test("dead reverse desk does not hide living-layer positions: paper page shows the account and its real floating",()=>{
  const pos=(id,symbol,side,entry,last,qty,fee)=>({id,status:"OPEN",symbol,side,entryPrice:entry,lastPrice:last,quantity:qty,notional:entry*qty,entryFee:fee,
    leverage:10,margin:entry*qty/10,plannedRisk:1,openedAt:1790760000000,closedAt:null,exitPrice:null,netPnl:null,stopPrice:null,
    favorable:0,adverse:0,profitFloorRate:0,expectedHoldMinutes:30,entryContext:null,holdScore:80});
  const data={...account(),equity:1014.2,netPnl:14.2,positions:[pos("o","ONDO_USDT","LONG",1,.9995,2000,.33),pos("z","ZRO_USDT","SHORT",2,2.004,600,1.86)],
    forwardDesk:{stance:"REVERSE",book:"reverse-v1",equity:1000,initialEquity:1000,netPnl:0,maxDrawdown:0,fees:0,floating:0,stale:false,openCount:0,resolved:0,wins:0,
      open:[],recent:[],curve:[],study:{},research:{}}};
  const html=render("app/forward-dashboard.tsx",dashboardProps(data));
  assert.match(html,/模拟账户权益/);assert.doesNotMatch(html,/反向权益/);
  assert.match(html,/<strong>1,014\.20<\/strong>/);
  // ONDO 2000*(−0.0005)−0.33 = −1.33 ; ZRO −600*0.004−1.86 = −4.26 → −5.59
  assert.match(html,/<small>浮动盈亏<\/small><strong>-5\.59 U<\/strong>/);
  assert.match(html,/<small>当前持仓<\/small><strong>2 笔<\/strong>/);
});

test("living-layer order says its own playbook as the open reason, not the attached TREND winner plan",()=>{
  const ctx=(living)=>({winnerPlan:{intent:"TREND"},mode:"CONTINUATION",reserve:false,environment:null,...(living?{living}:{})});
  const pos=(id,symbol,c)=>({id,status:"OPEN",symbol,side:"LONG",entryPrice:1,lastPrice:1,quantity:100,notional:100,entryFee:.07,
    leverage:10,margin:10,plannedRisk:1,openedAt:1790760000000,closedAt:null,exitPrice:null,netPnl:null,stopPrice:.99,
    favorable:0,adverse:0,profitFloorRate:0,expectedHoldMinutes:30,entryContext:c,holdScore:80});
  const data={...account(),positions:[pos("a","ONDO_USDT",ctx({v:"living-v2",k:"F",pb:"fast"})),pos("b","ARB_USDT",ctx({v:"living-v2",k:"N",pb:"follow"}))]};
  const html=render("app/forward-dashboard.tsx",dashboardProps(data));
  assert.match(html,/做多，集体异动快速跟进/);assert.match(html,/做多，顺着真资金（回调跟进）/);
  assert.doesNotMatch(html,/做这个币自己的趋势/);
  const legacy=render("app/forward-dashboard.tsx",dashboardProps({...account(),positions:[pos("c","SOL_USDT",ctx(null))]}));
  assert.match(legacy,/做这个币自己的趋势/);
});
test("living-layer order: 详细依据 shows the brain's intent, evidence, layers, sizing and exit plan, not the old system's fields",()=>{
  // 2026-10-21 screenshot: squeeze-fade short opened at 06:33 with stage TRANSITION stamped by the shared entry context.
  const living={v:"living-v2",k:"N",pb:"squeeze-fade",th:null,ep:null,ev:"normal",mult:3,sc:.62,t:null,n:null,per:null,rk:1,inv:2.0748,ref:2.06,hold:60,
    why:"逼空衰竭反做：逼空衰竭：1小时涨 +3.95% 靠空头回补（持仓量 -0.25%），19 分钟没新高，回补停了 → 反做；位置到了且确认",
    in:"SQUEEZE_UP/EXHAUSTION",mk:"MIXED",nar:"大盘分歧，没有一边占优｜逼空衰竭",evd:"15分钟价格 +0.40%，持仓量 -0.25%（1小时 -0.80%），资金费 0.010%，主动买卖 -0.12，成交量 1.8倍"};
  const ctx={winnerPlan:{intent:"TREND"},mode:"CONTINUATION",reserve:false,environment:"TRANSITION",stageNote:{liveStage:"TRANSITION",priorStage:"TREND",stageAgeMin:82},
    sizeMultiple:3,strategyVersion:"market-intelligence-v1",entryScore:68,postEntryState:"PENDING",reason:living.why,living};
  const t={id:"lv-1",status:"OPEN",symbol:"ZRO_USDT",side:"SHORT",entryPrice:2.06,lastPrice:2.032,quantity:883,notional:1818.98,entryFee:1.27,
    leverage:10,margin:181.9,plannedRisk:16.5,openedAt:1792535596000,closedAt:null,exitPrice:null,netPnl:null,stopPrice:2.0748,liquidationPrice:2.2525,
    favorable:.0262,adverse:.0005,profitFloorRate:0,expectedHoldMinutes:60,entryContext:ctx,holdScore:50};
  const html=render("app/forward-dashboard.tsx",dashboardProps({...account(),positions:[t]}));
  assert.match(html,/做空，逼空衰竭反做；这个币空头被逼平（力竭）；市场分歧。/);
  assert.match(html,/开仓时市场意图/);
  for(const k of ["资金意图","市场判断","证据数字","三层确认","仓位","止损","强平","出场计划","计划持有","不适用"])assert.match(html,new RegExp(`<b>${k}</b>`),k);
  assert.match(html,/0\.55% 作风险基数 × 3\.00 倍（5 倍 × 证据档「普通」0\.6）/);
  assert.match(html,/离开仓价 0\.72%（价格涨跌，不是收益率）/);
  assert.match(html,/1\.5 倍（90 分钟）/);
  assert.doesNotMatch(html,/<b>持仓评分<\/b>|入场评分 68|开仓时盘面是过渡|只有同步爆发或趋势才会真正开仓|不使用 5% 和 10% 那两条|同步爆发和趋势都是 5 倍|<b>开仓走势<\/b>/);
  assert.doesNotMatch(html,/<small>开仓盘面<\/small>|>过渡</);
});
test("living exit reasons read in plain Chinese on the order card (no raw codes)",()=>{
  const {exitShort,exitPlain}=orderCardModule.exports;
  assert.equal(exitShort("LIVING_FAST_EXHAUST"),"异动力竭");assert.equal(exitShort("LIVING_STOP"),"止损");
  assert.equal(exitShort("LIVING_FALLBACK_TIMEOUT"),"兜底到时间");assert.match(exitPlain("LIVING_FALLBACK_TIMEOUT"),/大脑暂停/);
});

test("missing account stays unknown and operational errors remain visible",()=>{
  const html=render("app/forward-dashboard.tsx",{...dashboardProps(null),healthy:false,error:"fixture storage unavailable"});
  const equity=html.match(/<section[^>]*data-testid="overview-equity-first"[\s\S]*?<\/section>/)?.[0];
  assert.ok(equity);assert.match(equity,/<strong>—<\/strong>/);assert.doesNotMatch(equity,/0\.00/);
  assert.match(html,/role="alert"/);assert.match(html,/fixture storage unavailable/);
});

test('LIVE ON keeps the simulation page on the paper account',()=>{
  const data={...account(),equity:9876.54,netPnl:8876.54};
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(data),cacheScope:'member:curve-owner',liveEnabled:true,
    liveOverview:{equity:101.23,available:80,positionCount:1,accountMark:{initialEquity:110,tradingPnl:-8.77,
      capitalChange:-8.77,floating:-3.21,margin:20,positionCount:1,startedAt:1790760000000,maxDrawdown:.08},copied:1,eligible:3,missing:2}});
  assert.match(html,/9,876\.54/);assert.match(html,/\+8,876\.54/);
  assert.doesNotMatch(html,/101\.23|-3\.21 U|未跟上 2|含出入金|实盘账户权益/);
});
test('LIVE ON without a live account still shows the paper equity',()=>{
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(account()),liveEnabled:true});
  const equity=html.match(/<section[^>]*data-testid="overview-equity-first"[\s\S]*?<\/section>/)?.[0];
  assert.match(equity,/922\.82/);assert.match(equity,/-77\.18/);
  assert.doesNotMatch(html,/实盘账户权益/);
});
test('LIVE ON simulated page keeps the paper account and does not mount the live order panel',()=>{
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(account()),liveEnabled:true,livePanel:'REAL_ORDER_PANEL'},
    {react:{...React,useState:value=>React.useState(value==='execution'?'paper':value)}});
  assert.match(html,/overview-equity-first/);
  assert.doesNotMatch(html,/REAL_ORDER_PANEL|shadow-inverse-comparison/);
});
test('the simulation page has no equity curve section, only the numbers, stats and orders',()=>{
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(account()),liveEnabled:true,livePanel:'REAL_ORDER_PANEL',cacheScope:'member:private',
    liveOverview:{equity:456,accountMark:{sessionAt:123,accountUser:'gate-fixture'}}});
  assert.doesNotMatch(html,/paper-equity-curve|forward-equity-curve|模拟净值|账户曲线|eq-module|<svg|REAL_ORDER_PANEL/);
  for(const id of ['overview-equity-first','forward-orders','forward-history'])assert.match(html,new RegExp(`data-testid="${id}"`));
  assert.match(html,/class="fr-stats"/);
  assert.ok(html.indexOf('class="fr-stats"')<html.indexOf('data-testid="forward-orders"'));
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
test('LIVE open and archived cards show a one-glance summary, key numbers on tap, and fold execution attribution',()=>{
  const number=value=>typeof value==='number'?value.toFixed(2):'—';
  for(const status of ['OPEN','CLOSED']){
    const position={id:'fixture',symbol:'LONGSYMBOL_USDT',side:'SHORT',status,entryPrice:100.01,exitPrice:99,
      entryAt:1790760000000,exitAt:1790761200000,notional:1000,margin:100,leverage:10,exchangeSize:10,realizedPnl:9,
      parity:{sourceEntryPrice:100,sourceId:'fixture',sourceRole:'INVERSE_PAPER'},exitReason:'SOURCE_CLOSED'};
    const html=render('app/live-console.tsx',{position,runtime:null,now:1790761200000},
      {'../lib/operator-ui.ts':{numberText:number,signedText:number,operatorTime:()=> '2026/10/01 17:21:23',contractText:number,
        holdingTime:()=> '20分钟',livePositionMark:()=>({pnl:1,margin:100,price:99}),operatorRequest(){throw new Error('network forbidden');}}},'LivePositionCard');
    assert.match(html,/^<details class="oc-card is-live">/);assert.doesNotMatch(html,/<details[^>]* open/);
    const summary=html.match(/<summary>[\s\S]*?<\/summary>/)?.[0];assert.ok(summary);
    assert.match(summary,/LONGSYMBOL/);assert.match(summary,/实盘/);assert.match(summary,/空/);assert.match(summary,/10×/);
    assert.match(summary,status==='OPEN'?/持仓中 · 20分钟/:/已平仓 · 20分钟/);assert.doesNotMatch(summary,/SOURCE_CLOSED/);
    assert.doesNotMatch(summary,/<dt>|源信号参考|名义金额|合约数量/);
    const body=html.slice(html.indexOf('</summary>'),html.indexOf('<details class="oc-more">'));
    const facts=(body.match(/<dt>/g)??[]).length;assert.ok(facts>=6&&facts<=10,`key facts stay compact: ${facts}`);
    assert.match(body,/入场比模拟/);assert.match(body,/更优/);assert.match(body,/开仓时间/);assert.match(body,/平仓时间/);
    assert.doesNotMatch(body,/源信号参考 ↔ 实盘|合约数量/);
    assert.match(html,/<details class="oc-more"><summary>执行明细<\/summary>/);
    const fold=html.slice(html.indexOf('<details class="oc-more">'));
    assert.match(fold,/源信号参考 ↔ 实盘/);assert.match(fold,/合约数量/);
    if(status==='CLOSED')assert.match(fold,/SOURCE_CLOSED/);
  }
});

test('PAPER cards keep the first glance to symbol, side, result and one status line; research prose is folded',()=>{
  const t={id:"p1",status:"CLOSED",symbol:"PONS_USDT",side:"SHORT",entryPrice:.2966,exitPrice:.2892,lastPrice:.2892,quantity:11220,notional:3327.85,
    entryFee:2.33,exitFee:2.34,leverage:10,margin:332.79,plannedRisk:40,openedAt:1790752298000,closedAt:1790761200000,netPnl:78.36,grossPnl:83.03,
    stopPrice:.3002,expectedHoldMinutes:261,favorable:.0425,adverse:.001,profitFloorRate:.0252,exitReason:"WINNER_STRUCTURE_EXIT",
    winnerManagement:{reason:"价格触及此前已经建立的有效保护位置"},
    entryContext:{strategyVersion:"market-intelligence-v1",mode:"RELATIVE",reason:"PONS 做空 · 独立趋势：持续相对优势成立",entryScore:90,clusterId:"corr:PONS_USDT",
      postEntryState:"CONFIRMED",environment:"TRANSITION",winnerPlan:{intent:"TREND"},stageNote:{liveStage:"TREND",priorStage:"TRANSITION",stageAgeMin:0},
      coinPath:{label:"前面近8小时已经压成下跌。"},entryRead:{withTrend:true,move30:.0202}}};
  const html=render("app/forward-dashboard.tsx",{trade:t,now:1790761200000},{},"TradeCard");
  const summary=html.match(/<summary>[\s\S]*?<\/summary>/)?.[0];assert.ok(summary);
  assert.match(summary,/PONS/);assert.match(summary,/空/);assert.match(summary,/\+78\.36 U/);assert.match(summary,/碰到保护位 · 2小时28分/);
  assert.doesNotMatch(summary,/这笔做的是|开仓时盘面|入场评分|同组|最高浮盈|有效结构保护/);
  const body=html.slice(html.indexOf('</summary>'),html.indexOf('<details class="oc-more">'));
  for(const label of["开仓价","平仓价","开仓时间","平仓时间","最高浮盈","最大浮亏","锁住的利润","手续费"])assert.match(body,new RegExp(label));
  assert.match(body,/为什么开<\/span>顺着大盘方向做空，做这个币自己的趋势；开仓时盘面是趋势。/);
  assert.match(body,/为什么平<\/span>价格回到开仓后设好的保护位，按计划平仓。/);
  assert.doesNotMatch(body,/额外出场|开仓走势|入场依据|持仓计划/);
  const fold=html.slice(html.indexOf('<details class="oc-more">'));
  assert.match(fold,/<summary>详细依据<\/summary>/);
  for(const text of["额外出场","开仓走势","入场依据","持仓计划","有效结构保护","入场评分 90","同组 PONS","已经走出成本"])assert.match(fold,new RegExp(text));
});

test("reference card, equity chart and static manuals are removed, not hidden; controls stay",()=>{
  const dashboard=read("app/forward-dashboard.tsx"),live=read("app/live-console.tsx");
  assert.doesNotMatch(dashboard+live,/equityReference|eq-reference|实盘开启参考|依据与限制|eq-hint|EquityCurve/);
  assert.doesNotMatch(dashboard,/latestReason|当前系统边界|fr-hero-tags/);
  assert.doesNotMatch(live,/复制规则与边界|只有添加或更换API时需要填写/);
  assert.match(live,/confirmEnable&&!enabled/);assert.match(live,/disabled=\{!canEnable\}/);assert.match(live,/confirmDelete&&/);
  assert.match(read("app/paper-account-reset.tsx"),/该操作不能撤销/);
});

test("inverse cards show only their own exact-price net and paid fees without an unfilled close charge",()=>{
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
  assert.doesNotMatch(summary,/原策略影子|影子空单|-4\.14|paired-order-costs/);
  assert.match(summary,/\+3\.86 U/);
  assert.match(summary,/已扣手续费 0\.1400 U/);assert.doesNotMatch(summary,/平仓 [0-9]|已减仓 [0-9]/);
  assert.doesNotMatch(summary,/毛盈亏镜像校验|报价毛额差/);
});
test('LIVE OFF hides cached native statistics while preserving PAPER history',()=>{
  const html=render('app/forward-dashboard.tsx',{...dashboardProps(account()),liveOverview:{equity:4321.09,available:6543.21,positionCount:99}});
  assert.match(html,/overview-equity-first/);assert.doesNotMatch(html,/4,321\.09|6,543\.21|99 笔/);
});
test('the order tab is the forward book, and live orders stay on the live page',()=>{
  const data=account();
  const states=[],refs=[],buttons=[];let cursor=0,refCursor=0;
  const hooks={...React,useState(initial){const i=cursor++;if(!(i in states))states[i]=initial==="execution"?"paper":typeof initial==='function'?initial():initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
    useRef(initial){const i=refCursor++;return refs[i]??(refs[i]={current:initial});},useEffect(){},useLayoutEffect(){}};
  const capture=fn=>(type,props,...rest)=>{if(type==='button')buttons.push(props);return fn(type,props,...rest);};
  const draw=()=>{cursor=0;refCursor=0;buttons.length=0;return render('app/forward-dashboard.tsx',{...dashboardProps(data),liveEnabled:true,livePanel:'NATIVE_ORDER_PANEL',liveOverview:{equity:321.09,positionCount:1}},
    {react:hooks,'react/jsx-runtime':{...jsxRuntime,jsx:capture(jsxRuntime.jsx),jsxs:capture(jsxRuntime.jsxs)}});};
  let html=draw();
  assert.match(html,/922\.82/);
  assert.doesNotMatch(html,/321\.09|NATIVE_ORDER_PANEL|影子|影子订单|shadow-orders-panel/);
  buttons.find(b=>Array.isArray(b.children)&&b.children[1]?.props?.children==='实盘').onClick();html=draw();
  assert.match(html,/NATIVE_ORDER_PANEL/);
  assert.doesNotMatch(html,/shadow-orders-panel/);
});

test("run-log panel shows storage progress, last export and the latest export time in Beijing time",()=>{
  const H=3_600_000,now=Date.UTC(2026,9,19,4,0,0);
  const base={now,lastExportRows:1100,classes:[],hot:{rawBytes:1.2*1048576,budgetBytes:4*1048576,usedPct:30}};
  const records={key:"records",label:"订单记录（含价格路径）",kind:"count",stored:1200,cap:1200,usedPct:100,sinceBase:842,pendingPct:70.2,ratePerHour:4.6,deadline:now+235*H,overdue:false};
  const html=render("app/run-log-status.tsx",{status:{...base,lastExportAt:now-26*H,primary:records,binding:records,classes:[records],
    deadline:now+235*H,hoursLeft:235,safeAt:now+188*H,overdue:false}},{},"RunLogStatusView");
  assert.match(html,/导出后新增 842 \/ 1,200 条 · 70%/);
  assert.match(html,/现在共存 1,200 条/);
  assert.match(html,/is-warn/);
  assert.match(html,/role="progressbar"/);
  assert.match(html,/上次导出.*10月18日 10:00/);
  assert.match(html,/最晚导出.*10月29日 07:00 · 还剩约 9 天 19 小时/);
  assert.match(html,/建议导出.*10月27日 08:00 前/);
  assert.match(html,/按最近每小时约 4\.6 条估算/);
  assert.match(html,/账户热存储 1\.2 \/ 4\.0 MB/);
  const first=render("app/run-log-status.tsx",{status:{...base,lastExportAt:null,lastExportRows:null,primary:{...records,stored:1200,usedPct:100,sinceBase:1200,pendingPct:100,overdue:true,deadline:now},
    binding:{...records,overdue:true,deadline:now},deadline:now,hoursLeft:0,safeAt:now,overdue:true}},{},"RunLogStatusView");
  assert.match(first,/还没有导出记录/);
  assert.match(first,/已存 1,200 \/ 1,200 条 · 100%/);
  assert.doesNotMatch(first,/现在共存/);
  assert.match(first,/现在就导出/);
  assert.match(first,/is-bad/);
  const idle=render("app/run-log-status.tsx",{status:{...base,lastExportAt:now-H,primary:{...records,ratePerHour:0,deadline:null},binding:null,deadline:null,hoursLeft:null,safeAt:null,overdue:false}},{},"RunLogStatusView");
  assert.match(idle,/暂时不用导出/);
  assert.doesNotMatch(idle,/建议导出/);
});

test("run-log panel no longer shows the long-term archive; the 1200-record deadline stays",()=>{
  const H=3_600_000,now=Date.UTC(2026,9,19,4,0,0);
  const records={key:"records",label:"订单记录（含价格路径）",kind:"count",stored:1200,cap:1200,usedPct:100,sinceBase:842,pendingPct:70.2,ratePerHour:4.6,deadline:now+235*H,overdue:false};
  const archive={healthy:true,error:null,loaded:true,backfillDone:true,pending:3,lastOkAt:now-2*60_000,pendingExport:1240,segmentSize:500,
    stats:{records:5230,bytes:61*1048576,firstOpenedAt:Date.UTC(2026,7,1,0,0),lastOpenedAt:now-25*H},lastExport:{at:now-3*24*H,mode:"since",rows:500}};
  const status={now,lastExportRows:1100,classes:[records],hot:null,lastExportAt:now-26*H,primary:records,binding:records,deadline:now+235*H,hoursLeft:235,safeAt:now+188*H,overdue:false};
  const ok=render("app/run-log-status.tsx",{status:{...status,archive}},{},"RunLogStatusView");
  assert.doesNotMatch(ok,/长期归档|不限条数|不用赶了/);
  assert.match(ok,/最晚导出.*10月29日 07:00 · 还剩约 9 天 19 小时/);
  assert.match(ok,/建议导出/);
  const failing=render("app/run-log-status.tsx",{status:{...status,archive:{...archive,healthy:false,error:"D1_ERROR: overloaded"}}},{},"RunLogStatusView");
  assert.match(failing,/最晚导出.*还剩约 9 天 19 小时/);
  assert.doesNotMatch(failing,/出错，没在存|长期归档/);
});

test("order card shows a clear 爆仓 tag and plain reason for a liquidated position (paper and live share the card)",()=>{
  const base={symbol:"DOGE_USDT",side:"LONG",leverage:20,pnl:-71.2,rate:-.05,held:"12分钟",facts:[{label:"强平价（逐仓）",value:"0.2412",tone:-1}]};
  const html=render("app/order-card.tsx",{...base,liquidated:true,state:"爆仓",out:"价格越过逐仓强平价，止损没来得及成交，按爆仓平掉，这笔保证金全部亏掉。"},{},"OrderCard");
  assert.match(html,/class="oc-liq"[^>]*>爆仓</);
  assert.match(html,/oc-card is-liquidated/);
  assert.match(html,/爆仓 · 12分钟/);
  assert.match(html,/强平价（逐仓）/);
  const live=render("app/order-card.tsx",{...base,live:true,liquidated:true,state:"爆仓"},{},"OrderCard");
  assert.match(live,/实盘<\/i>.*爆仓<\/i>/s);
  const normal=render("app/order-card.tsx",{...base,state:"止损"},{},"OrderCard");
  assert.doesNotMatch(normal,/oc-liq|is-liquidated/);
});

test("System panels render cached details first instead of a loading state",()=>{
  const scope="fixture-owner";
  const number=value=>typeof value==="number"?value.toFixed(2):"—";
  const operatorUi={numberText:number,signedText:number,operatorTime:()=>"—",contractText:number,
    operatorRequest(){throw new Error("render must not issue requests");},isTransientLiveReadError:()=>false,OperatorRequestError:class extends Error{}};
  // No cache at all: the only case that may show loading.
  panelCache.clearPanels();
  assert.match(render("app/run-log-status.tsx",{refreshKey:0,scope}),/正在读取存储进度/);
  const status={primary:{key:"orders",label:"订单记录",kind:"count",cap:1200,stored:282,sinceBase:27,pendingPct:2,usedPct:23},binding:null,
    classes:[],lastExportAt:1790760000000,lastExportRows:255,deadline:null,overdue:false,hoursLeft:null,safeAt:null,now:1790761200000};
  panelCache.writePanel(scope,systemPanels.PANEL_KEYS.logStatus,status,null,1790761200000);
  const html=render("app/run-log-status.tsx",{refreshKey:0,scope});
  assert.doesNotMatch(html,/正在读取存储进度/);
  assert.match(html,/存储进度/);assert.match(html,/导出后新增 27/);
  assert.match(html,/data-testid="panel-stamp"/);assert.match(html,/更新于 \d\d:\d\d:\d\d/);
  // Gate API status from cache, no 读取中.
  panelCache.writePanel("owner",systemPanels.PANEL_KEYS.credential,{configured:true,environment:"live",keyHint:null,status:"OK",lastVerifiedAt:1,lastError:null},null);
  const live=render("app/live-console.tsx",{view:"system",auth:{authenticated:true,username:"owner",role:"owner"},
    runtime:{live:{positions:{},entries:{},history:[],requestedEnabled:false,lastSyncAt:1790761200000},liveMode:{requestedEnabled:false}},
    onSession(){throw new Error("unexpected session mutation");},onLive(){throw new Error("unexpected live mutation");},onRefresh(){}},
    {"../lib/operator-ui.ts":operatorUi});
  assert.match(live,/API状态[\s\S]*已保存/);assert.doesNotMatch(live,/<b>读取中<\/b><\/div><small class="pc-stamp/);
  // Member list from cache (device copy carries no invite code).
  panelCache.writePanel("owner",systemPanels.PANEL_KEYS.members,panelCache.persistableMembers({version:"v",authVersion:"a",invite:{code:"SECRET-INVITE",createdAt:1},
    memberLimit:5,activeLimit:3,activeCount:1,members:[{id:"m1",label:"m1",username:"alice",authVersion:"a",createdAt:1,activatedAt:1,followBlockedAt:null,revokedAt:null,usage:null}]}),null);
  const members=render("app/member-access.tsx",{auth:{authenticated:true,username:"owner",role:"owner"}},{"../lib/operator-ui.ts":operatorUi},"MemberAccess");
  assert.match(members,/alice/);assert.match(members,/1 位/);assert.doesNotMatch(members,/SECRET-INVITE/);
  panelCache.clearPanels();
  assert.match(render("app/run-log-status.tsx",{refreshKey:0,scope}),/正在读取存储进度/,"logout wipes the cache");
});

test("home 「交易系统运行情况」区块：真实组件渲染所有要求的项目，原有模拟/实盘/系统标签不变",()=>{
  const nts={ready:true,enabled:true,state:"空仓待命",now:1790761200000,symbols:["BTC_USDT","ETH_USDT"],
    evals:{BTC_USDT:{at:1790761200000,action:"NO_TRADE",side:null,reason:"core 0.05 在中性带 ±0.2 内",core:0.05,score:0.06,plan:null,vetoes:0,zones:[{lo:79000,hi:79200,score:90,kind:"支撑",tfs:["4h"]},{lo:81000,hi:81200,score:88,kind:"压力",tfs:["1h"]}]},ETH_USDT:{at:1790761200000,action:"NO_TRADE",side:null,reason:"没有候选区满足触发条件",core:null,score:null,plan:null,vetoes:1,zones:[]}},
    position:null,today:{trades:0,wins:0,pnl:0,r:0,pct:0},month:{trades:2,wins:1,pnl:3.5,r:0.2,pct:0.0035},recent:[{at:1790761200000,sym:"BTC_USDT",kind:"不做",text:"core 0.05 在中性带内"}],
    lastExit:{sym:"BTC_USDT",side:"LONG",at:1790750000000,reason:"保本出场",netPnl:0.4,r:0.01,holdMin:90},breaker:{state:"OK",allowEntry:true,reason:"月度 +0.35%",monthPct:0.0035,dayR:0},
    data:{quoteOk:true,health:{BTC_USDT:{ok:true,notes:[]},ETH_USDT:{ok:true,notes:[]}}},log:{appended:3,pending:0,lastFlushAt:1790761000000,error:null},resetState:{phase:"done",doneAt:1790700000000,error:null}};
  const html=render("app/nts-panel.tsx",{nts});
  for(const t of ["交易系统运行情况","系统开关","市场偏向分","只记录，不参与开仓","订单块","当前计划","持仓","今日","本月","最近一次出场","当日停开","数据 / 行情","最近决策","下载运行日志","老挝"])assert.ok(html.includes(t),`缺少 ${t}`);
  assert.ok(!html.includes("实盘开关"),"面板不含实盘开关");
  for(const t of ["订单块系统","不补仓","等待订单块回踩","市场结构与订单块","胜率","运行中"])assert.ok(html.includes(t),`缺少 ${t}`);
  const held=render("app/nts-panel.tsx",{nts:{...nts,state:"持仓中",prices:{BTC_USDT:80500,ETH_USDT:3000},position:{sym:"BTC_USDT",side:"LONG",openedAt:1790760000000,avg:80000,price:80400,added:false,stage:"未补仓",target:82000,stop:79200,breakeven:null,floatingR:0.3,floatingPct:0.01,floatingNet:8.04,mfeR:0.4,maeR:-0.1}}});
  for(const t of ["做多","80000.0","79200.0","82000.0","+0.50%","距 1.49%","距 1.99%","+8.04 U","价格波动"])assert.ok(held.includes(t),`持仓卡缺少 ${t}`);
  assert.ok(!/ROE|收益率\s*\d/.test(held),"不显示 ROE");
  assert.equal(render("app/nts-panel.tsx",{nts:null}),"","无数据时不渲染");
  const dash=render("app/forward-dashboard.tsx",{...dashboardProps(account()),ntsView:nts});
  for(const t of ["模拟","实盘","系统"])assert.ok(dash.includes(t),`标签 ${t} 保持`);
});
