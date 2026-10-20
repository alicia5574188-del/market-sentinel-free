import test from "node:test";
import assert from "node:assert/strict";

class Mem{m=new Map<string,string>();get length(){return this.m.size;}key(i:number){return [...this.m.keys()][i]??null;}
  getItem(k:string){return this.m.get(k)??null;}setItem(k:string,v:string){this.m.set(k,String(v));}removeItem(k:string){this.m.delete(k);}clear(){this.m.clear();}}
const store=new Mem();(globalThis as unknown as {localStorage:Mem}).localStorage=store;
const calls:string[]=[];(globalThis as unknown as {fetch:(u:string)=>Promise<Response>}).fetch=async(u:string)=>{calls.push(u);return new Response("{}");};
const {persistableHome,saveHome,readHome,startHomeEarly,takeHomeEarly,HOME_SHOW_MAX_AGE_MS}=await import("../lib/owner-home.ts");
const {clearPanels}=await import("../lib/panel-cache.ts");

test("device copy of the owner home drops live audit text, skip reasons, live history and error text",()=>{
  const v=persistableHome({lastError:"x",forward:{positions:[1]},live:{requestedEnabled:false,positions:{},auditEvents:[{reason:"r"}],entrySkips:{a:1},history:[1],turnover:{t:1},lastError:"gate said"}}) as Record<string,unknown>;
  assert.equal(v.lastError,undefined);assert.deepEqual(v.forward,{positions:[1]});
  assert.deepEqual(v.live,{requestedEnabled:false,positions:{},auditEvents:[],entrySkips:{},history:[],lastError:null});
  assert.equal(persistableHome(null),null);
});

test("home snapshot: shown only while recent, wiped with every panel snapshot on logout",()=>{
  const now=Date.now();saveHome({forward:{startedAt:1}},now-1000);
  assert.deepEqual(readHome(now)?.value,{forward:{startedAt:1}});
  assert.equal(readHome(now+HOME_SHOW_MAX_AGE_MS+5000),null);
  clearPanels();assert.equal(readHome(now),null);
  assert.equal([...store.m.keys()].some(k=>k.includes("owner-home")),false);
});

test("early home read starts only on a device last used by the owner, and is taken once while fresh",async()=>{
  calls.length=0;store.removeItem("sentinel-panel-identity-v1");
  startHomeEarly();assert.equal(calls.length,0);assert.equal(takeHomeEarly(),null);
  store.setItem("sentinel-panel-identity-v1","member:m1");startHomeEarly();assert.equal(calls.length,0);
  store.setItem("sentinel-panel-identity-v1","owner:owner");const t=Date.now();startHomeEarly(t);
  assert.deepEqual(calls,["/api/home"]);
  assert.ok(takeHomeEarly(t+100));assert.equal(takeHomeEarly(t+200),null);
  startHomeEarly(t);assert.equal(takeHomeEarly(t+6000),null);
});
