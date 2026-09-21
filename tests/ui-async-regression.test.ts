/* eslint-disable @typescript-eslint/no-explicit-any -- deterministic component lifecycle harness, no browser or real requests */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import * as operator from "../lib/operator-ui.ts";
import * as records from "../lib/record-view.ts";
import * as curve from "../lib/equity-curve.ts";
import * as cache from "../lib/equity-cache.ts";

// Execute the actual TSX callbacks with controlled hook lifetimes. No mutation
// endpoint, authenticated browser, exchange request or strategy is involved.
function component(file:string,request:typeof operator.operatorRequest=operator.operatorRequest){
  let effects:(()=>void|(()=>void))[]=[],cleanups:(()=>void)[]=[];
  const jsx=(type:any,props:any,key?:string)=>({type,props,key});
  const react={useEffect:(fn:()=>void|(()=>void))=>effects.push(fn),useMemo:(fn:()=>unknown)=>fn(),
    useRef:(value:unknown)=>({current:value}),useState:(value:any)=>[typeof value==="function"?value():value,()=>{}],
    useSyncExternalStore:(_subscribe:unknown,snapshot:()=>unknown)=>snapshot()};
  const imports:Record<string,unknown>={react,"react/jsx-runtime":{jsx,jsxs:jsx},
    "../lib/operator-ui.ts":{...operator,operatorRequest:request},"../lib/record-view.ts":records,
    "../lib/equity-curve.ts":curve,"../lib/equity-cache.ts":cache,"./equity-curve.css":{},
    "./record-controls.tsx":{ArchivePagination:()=>null}};
  const compiledModule={exports:{} as any};
  const compiled=ts.transpileModule(readFileSync(new URL(`../app/${file}`,import.meta.url),"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
  }).outputText;
  runInNewContext(compiled,{module:compiledModule,exports:compiledModule.exports,require:(name:string)=>{
    if(!(name in imports))throw new Error(`Unexpected component import ${name}`);return imports[name];
  },window:{scrollTo(){}},setInterval:()=>1,clearInterval(){}});
  return {render:(props:any)=>{let tree=compiledModule.exports.default(props);
    if(typeof tree.type==="function")tree=tree.type(tree.props);return tree;},
    wrapper:(props:any)=>compiledModule.exports.default(props),
    mount:()=>{cleanups=effects.map(fn=>fn()).filter((fn):fn is ()=>void=>typeof fn==="function");effects=[];},
    unmount:()=>{for(const cleanup of cleanups)cleanup();cleanups=[];}};
}
function nodes(tree:any,predicate:(node:any)=>boolean):any[]{
  if(!tree||typeof tree!=="object")return [];
  if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,predicate));
  return [...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];
}
const owner={configured:true,authenticated:true,username:"owner",role:"owner" as const};
const live={requestedEnabled:true,operational:true,equity:1000,positions:{},entries:{},auditEvents:[],entrySkips:{}};
const runtime={live,liveMode:{requestedEnabled:true,operational:true},evidence:{}};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test("late LIVE mutation success after tab/account unmount cannot replace the new account runtime",async()=>{
  let release!:(result:unknown)=>void,calls=0,liveUpdates=0,refreshes=0;
  const request:any=(path:string)=>path==="/api/live/mode"
    ?(calls++,new Promise(resolve=>{release=resolve;})):Promise.resolve({credential:{configured:true}});
  const ui=component("live-console.tsx",request);
  const tree=ui.render({auth:owner,runtime,onLive:()=>liveUpdates++,onSession(){},onRefresh:()=>refreshes++});ui.mount();
  nodes(tree,node=>node.props?.role==="switch")[0].props.onClick();
  assert.equal(calls,1);ui.unmount();release({live:{...live,requestedEnabled:false}});await flush();
  assert.equal(liveUpdates,0);assert.equal(refreshes,0);assert.equal(calls,1);
});
test("late unauthorized response from the previous account cannot log out the next account",async()=>{
  let reject!:(error:Error)=>void,sessions=0;
  const request:any=(path:string)=>path==="/api/live/mode"
    ?new Promise((_resolve,fail)=>{reject=fail;}):Promise.resolve({credential:{configured:true}});
  const ui=component("live-console.tsx",request);
  const tree=ui.render({auth:owner,runtime,onLive(){},onSession:()=>sessions++,onRefresh(){}});ui.mount();
  nodes(tree,node=>node.props?.role==="switch")[0].props.onClick();ui.unmount();
  reject(new operator.OperatorRequestError("Previous session expired",401));await flush();assert.equal(sessions,0);
});
test("a current mounted LIVE action still publishes its confirmed result exactly once",async()=>{
  let calls=0,liveUpdates=0,refreshes=0;
  const request:any=(path:string)=>{if(path==="/api/live/mode"){calls++;return Promise.resolve({live:{...live,requestedEnabled:false}});}
    return Promise.resolve({credential:{configured:true}});};
  const ui=component("live-console.tsx",request);
  const tree=ui.render({auth:owner,runtime,onLive:()=>liveUpdates++,onSession(){},onRefresh:()=>refreshes++});ui.mount();
  nodes(tree,node=>node.props?.role==="switch")[0].props.onClick();await flush();ui.unmount();
  assert.equal(calls,1);assert.equal(liveUpdates,1);assert.equal(refreshes,1);
});
test("account identity changes remount private LIVE state even under a retained parent",()=>{
  const ui=component("live-console.tsx");
  const props={runtime,onLive(){},onSession(){},onRefresh(){}};
  const keys=[owner,{...owner,authenticated:false},{...owner,role:"member",memberId:"m1",username:"a"},
    {...owner,role:"member",memberId:"m2",username:"b"}].map(auth=>ui.wrapper({...props,auth}).key);
  assert.equal(new Set(keys).size,4);
});
test("a valid persistent curve beyond function argument limits renders without a stack overflow",()=>{
  const startedAt=1_700_000_000_000,points=Array.from({length:160_000},(_,i)=>({
    at:startedAt+(i+1)*300_000,equity:i%2?1001:999,kind:"observed" as const,policy:"p",homogeneous:false,
  }));
  assert.ok(JSON.stringify(points.map(p=>[p.at,p.equity,p.policy,p.homogeneous,false])).length<8_000_000);
  const ui=component("equity-curve.tsx"),data={startedAt,initialEquity:1000,updatedAt:points.at(-1)!.at,
    lastCycleAt:points.at(-1)!.at,policyVersion:"p",exitPolicyVersion:"e",storage:{persistedAt:points.at(-1)!.at}};
  const tree=ui.render({data,healthy:false,fixture:{points,complete:true}});
  assert.equal(tree.props["data-equity-version"],curve.EQUITY_CURVE_VERSION);
});
