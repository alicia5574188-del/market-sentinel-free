import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {clearEquityBrowserCache,purgeEquityBrowserCache,EQUITY_CACHE_PREFIX} from "../lib/equity-browser-purge.ts";
class Memory {
  data=new Map<string,string>();get length(){return this.data.size;}key(i:number){return [...this.data.keys()][i]??null;}
  getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,v);}removeItem(k:string){this.data.delete(k);}
}
const read=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("old saved curves are deleted from both storages and every other key stays",()=>{
  const local=new Memory(),tab=new Memory();
  local.setItem(`${EQUITY_CACHE_PREFIX}owner:1789556791436:1000`,"x".repeat(50_000));
  local.setItem(`${EQUITY_CACHE_PREFIX}live%3Aowner%3A1%3Au:1:100`,"{}");
  local.setItem("sentinel-ui-font-scale-v1","92");local.setItem("sentinel-panel-v1:owner:brain-status","{}");local.setItem("sentinel-identity","owner");
  tab.setItem(`${EQUITY_CACHE_PREFIX}member-x:1:1000`,"{}");tab.setItem("other-tab-key","1");
  const g=globalThis as {window?:unknown},before=g.window;
  g.window={localStorage:local,sessionStorage:tab};
  try{purgeEquityBrowserCache();}finally{if(before===undefined)delete g.window;else g.window=before;}
  assert.deepEqual([...local.data.keys()].sort(),["sentinel-identity","sentinel-panel-v1:owner:brain-status","sentinel-ui-font-scale-v1"]);
  assert.deepEqual([...tab.data.keys()],["other-tab-key"]);
});
test("blocked or missing storage never throws",()=>{
  const bad={get length():number{throw new Error("SecurityError");},key:()=>null,removeItem:()=>{throw new Error("x");}};
  assert.doesNotThrow(()=>clearEquityBrowserCache(bad as unknown as Storage));assert.doesNotThrow(()=>clearEquityBrowserCache(null));
  const g=globalThis as {window?:unknown},before=g.window;
  g.window={get localStorage(){throw new Error("blocked");},get sessionStorage(){throw new Error("blocked");}};
  try{assert.doesNotThrow(()=>purgeEquityBrowserCache());}finally{if(before===undefined)delete g.window;else g.window=before;}
  assert.doesNotThrow(()=>purgeEquityBrowserCache());
});
test("the page has no equity chart and never asks for curve history; the server API stays",()=>{
  for(const gone of ["app/equity-curve.tsx","app/live-equity-curve.tsx","app/equity-curve.css","lib/equity-cache.ts"])
    assert.equal(existsSync(new URL(`../${gone}`,import.meta.url)),false,gone);
  const dashboard=read("app/forward-dashboard.tsx");
  assert.match(dashboard,/useEffect\(\(\)=>\{purgeEquityBrowserCache\(\);\},\[\]\)/);
  for(const file of ["app/forward-dashboard.tsx","app/page.tsx","app/live-console.tsx","app/pages.css"]){
    const s=read(file);
    assert.doesNotMatch(s,/\/api\/(?:forward|paper|live)\/equity|forward-equity|EquityHistoryCache|paper-equity-curve|forward-equity-curve|eq-module|模拟净值/,file);
  }
  const worker=read("worker/index-clean.ts");assert.match(worker,/EQUITY_CURVE_VERSION/);
  assert.ok(existsSync(new URL("../lib/equity-reader.ts",import.meta.url)));assert.ok(existsSync(new URL("../lib/live-equity.ts",import.meta.url)));
});
