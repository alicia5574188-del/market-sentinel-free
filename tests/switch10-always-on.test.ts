/** Switch 10 (dynAllocator, predictor gate) is always on: no toggle in the config path, stored "off" is read as on, nothing else changes. */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {LivingEngine,LIVING_KEYS} from "../lib/living/engine.ts";
import {defaultLivingConfig,normalizeLivingConfig,effectiveLiving,LIVING_ITEMS,SWITCH10_FIXED} from "../lib/living/config.ts";

const restoreWith=(items:Record<string,boolean>,at=1_000)=>{
  const e=new LivingEngine(at),cfg=defaultLivingConfig(at);
  e.restore(new Map([[LIVING_KEYS.config,{...cfg,items:{...cfg.items,...items}}]]),at);return e;
};
test("production flag is on; the item and its key stay (log fields / status keep working)",()=>{
  assert.equal(SWITCH10_FIXED.on,true);assert.equal(LIVING_ITEMS[9],"dynAllocator");
});
test("an old stored 'off' for switch 10 is read as on (other switches keep their stored value)",()=>{
  const c=normalizeLivingConfig({...defaultLivingConfig(5),items:{...defaultLivingConfig(5).items,dynAllocator:false,htfTrend:false}},5);
  assert.equal(c.items.dynAllocator,true);assert.equal(c.items.htfTrend,false);
  assert.equal(effectiveLiving(c,5).items.dynAllocator,true);
  const e=restoreWith({dynAllocator:false});
  const st=e.status(1_000,{positions:[],history:[],opportunities:[]}) as {items:{key:string;on:boolean}[]};
  assert.equal(st.items.find(i=>i.key==="dynAllocator")!.on,true);
  assert.equal(e.effective(1_000).items.dynAllocator,true);
});
test("setConfig cannot turn switch 10 off; other items still toggle; mode change keeps it on",()=>{
  const e=restoreWith({});
  const c=e.setConfig({items:{dynAllocator:false,htfTrend:false} as never},2_000);
  assert.equal(c.items.dynAllocator,true);assert.equal(c.items.htfTrend,false);
  assert.equal(e.setConfig({mode:"compute-only"},3_000).items.dynAllocator,true);
});
test("API refuses to toggle switch 10; page has no toggle and no prop for it; no research-storage clearing in the toggle path",()=>{
  const w=readFileSync("worker/index-clean.ts","utf8"),m=w.slice(w.indexOf('path === "/living-mode"'),w.indexOf('path === "/forward-log-status"'));
  assert.match(m,/开关 10 已固定开启/);
  assert.doesNotMatch(m,/dynamic\.|DELETE|\.clear\(|reset/i,"the config endpoint only writes the living config key");
  const ui=readFileSync("app/dynamic-panel.tsx","utf8"),lp=readFileSync("app/living-panel.tsx","utf8");
  assert.doesNotMatch(ui,/关掉开关 10|打开开关 10|onToggle/);assert.doesNotMatch(lp,/setItem\("dynAllocator"/);
  const e=readFileSync("lib/living/engine.ts","utf8"),sc=e.slice(e.indexOf("setConfig(next"),e.indexOf("/** Recent gaps"));
  assert.doesNotMatch(sc,/dynamic|backfill|predict|shadow/i,"engine.setConfig touches only the living config");
});
