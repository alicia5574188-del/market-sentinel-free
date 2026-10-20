import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {createRequire} from "node:module";
import {memberForwardView,liveSourceIds,runtimeRefreshMs,MEMBER_IDLE_MS,RUNTIME_ACTIVE_MS} from "../lib/member-view.ts";

const trade=(id:string,status="OPEN")=>({id,symbol:"BTC_USDT",side:"LONG",status,entryPrice:100,lastPrice:101,exitPrice:status==="OPEN"?null:102,netPnl:1,notional:50,
  openedAt:1,closedAt:status==="OPEN"?null:2,margin:5,entryContext:{secret:"research"},positionIntelligence:{decision:"HOLD"}});

test("member forward view keeps health plus only the sources of the member's own live orders",()=>{
  const view={startedAt:10,mode:"LIVE",updatedAt:20,lastCycleAt:19,storage:{error:null,persistedAt:19},events:[1,2],marketIntelligence:{x:1},
    positions:[trade("a"),trade("b")],history:[trade("c","CLOSED"),trade("d","CLOSED")]};
  const state={positions:[],history:[trade("e","CLOSED")]};// e: hidden from the page summary by a PAPER reset
  const v=memberForwardView(view,state,["a","c","e","zzz"])!;
  assert.deepEqual(v.positions.map(t=>t.id),["a"]);assert.deepEqual(v.history.map(t=>t.id),["c","e"]);
  assert.equal("events" in v,false);assert.equal("marketIntelligence" in v,false);
  assert.equal("entryContext" in v.positions[0]!,false);assert.equal(v.storage.persistedAt,19);assert.equal(v.lastCycleAt,19);
  assert.equal(memberForwardView(null,state,["a"]),null);
});
test("live source ids cover open, pending and recently closed orders",()=>{
  assert.deepEqual([...liveSourceIds({positions:{a:{id:"a"},b:null},entries:{p:{planId:"p"}},history:[{id:"h"}]})].sort(),["a","b","h","p"]);
  assert.equal(liveSourceIds(undefined).size,0);
});
test("refresh cadence: owner always 10s; member 10s while copying or holding, 30s when idle",()=>{
  assert.equal(runtimeRefreshMs("owner",null),RUNTIME_ACTIVE_MS);assert.equal(runtimeRefreshMs(undefined,{live:{requestedEnabled:false}}),RUNTIME_ACTIVE_MS);
  assert.equal(runtimeRefreshMs("member",null),RUNTIME_ACTIVE_MS);
  assert.equal(runtimeRefreshMs("member",{liveMode:{requestedEnabled:false},live:{requestedEnabled:false,positions:{},entries:{}}}),MEMBER_IDLE_MS);
  assert.equal(runtimeRefreshMs("member",{live:{requestedEnabled:true}}),RUNTIME_ACTIVE_MS);
  assert.equal(runtimeRefreshMs("member",{live:{positions:{a:{status:"OPEN"}}}}),RUNTIME_ACTIVE_MS);
  assert.equal(runtimeRefreshMs("member",{live:{positions:{a:{status:"CLOSED"}},entries:{p:{status:"SUBMITTED"}}}}),RUNTIME_ACTIVE_MS);
  assert.equal(runtimeRefreshMs("member",{live:{positions:{a:{status:"CLOSED"}},entries:{p:{status:"FILLED"}}}}),MEMBER_IDLE_MS);
});

async function surfaces(){
  const built=await build({stdin:{resolveDir:process.cwd(),sourcefile:"member-slim.tsx",contents:`
    import {createElement as h} from 'react';
    import {renderToStaticMarkup as render} from 'react-dom/server';
    import MemberDashboard from './app/member-dashboard.tsx';
    import Dashboard from './app/forward-dashboard.tsx';
    import LiveConsole from './app/live-console.tsx';
    import {initialMultiTurnForward,forwardSummary} from './lib/forward-relations.ts';
    const member={configured:true,authenticated:true,username:'alice',role:'member',memberId:'m_${"a".repeat(32)}'};
    const owner={configured:true,authenticated:true,username:'owner',role:'owner'};
    const live={requestedEnabled:true,operational:true,equity:120,available:80,positions:{},entries:{},history:[],lastSyncAt:1790050000000};
    const runtime={generatedAt:1790050000000,lastSuccessAt:1790050000000,state:'LIVE',stale:false,authorityReady:true,live,liveMode:{requestedEnabled:true,operational:true},evidence:{},
      forward:{startedAt:1,mode:'LIVE',positions:[],history:[],storage:{error:null,persistedAt:1},memberProjection:true}};
    const panels=(auth)=>({livePanel:h(LiveConsole,{view:'trade',auth,runtime,onSession(){},onLive(){},onRefresh(){}}),
      liveSystemPanel:h(LiveConsole,{view:'system',auth,runtime,onSession(){},onLive(){},onRefresh(){}})});
    const base={memberName:'alice',healthy:true,statusLabel:'后台运行中',feedAt:1790050000000,error:null,liveEnabled:true,liveOperational:true,livePositions:0};
    const state=initialMultiTurnForward(1790050000000);
    export const out={
      execution:render(h(MemberDashboard,{...base,...panels(member)})),
      system:render(h(MemberDashboard,{...base,...panels(member),initialTab:'settings'})),
      owner:render(h(Dashboard,{data:forwardSummary(state,{},1790050001000),healthy:true,feedAt:null,error:null,liveEnabled:false,...panels(owner)})),
      ownerBrain:render(h(Dashboard,{data:forwardSummary(state,{},1790050001000),healthy:true,feedAt:null,error:null,liveEnabled:false,...panels(owner),brainAuth:owner})),
    };
  `},bundle:true,write:false,format:"cjs",platform:"node",jsx:"automatic",loader:{".css":"empty"},logLevel:"silent"});
  const module_={exports:{} as {out?:Record<string,string>}};
  new Function("require","module","exports",built.outputFiles[0]!.text)(createRequire(import.meta.url),module_,module_.exports);
  return module_.exports.out!;
}
const navLabels=(html:string)=>[...html.matchAll(/<nav class="fr-nav[^"]*">(.*?)<\/nav>/g)].flatMap(m=>[...m[1]!.matchAll(/<b>([^<]+)<\/b>/g)].map(x=>x[1]));

test("member render shows only 执行 and 系统 with the member's own live account; nothing research, PAPER or run-log",async()=>{
  const {execution,system}=await surfaces();
  for(const html of [execution,system]){
    assert.deepEqual(navLabels(html),["执行","系统"]);
    for(const banned of ["模拟账户权益","运行日志","导出运行日志","邀请码","会员管理","市场状态","策略版本","重置模拟"])assert.doesNotMatch(html,new RegExp(banned),banned);
  }
  assert.match(execution,/data-testid="member-execution"/);assert.match(execution,/实盘账户权益/);assert.match(execution,/实盘交易开关/);
  assert.doesNotMatch(execution,/data-testid="member-system"/);
  assert.match(system,/data-testid="member-account"/);assert.match(system,/Gate API/);assert.match(system,/模拟 → 实盘跟单/);assert.match(system,/退出登录/);
  assert.match(system,/alice/);
});
test("owner render keeps the original four tabs and owner panels",async()=>{
  const {owner,ownerBrain}=await surfaces();
  assert.deepEqual(navLabels(owner),["执行","模拟","实盘","系统"]);
  assert.deepEqual(navLabels(ownerBrain),["大脑","模拟","实盘","系统"],"owner home is the market brain; 执行 is gone");
  assert.match(ownerBrain,/data-testid="owner-living-research"/);assert.match(ownerBrain,/data-testid="execution-status"/);assert.doesNotMatch(ownerBrain,/market-command-summary/);assert.match(owner,/market-intelligence-v1/);assert.doesNotMatch(owner,/member-dashboard/);
});
