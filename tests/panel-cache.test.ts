import assert from 'node:assert/strict';
import test from 'node:test';

class FakeStorage{
  map=new Map<string,string>();
  get length(){return this.map.size;}
  key(i:number){return [...this.map.keys()][i]??null;}
  getItem(k:string){return this.map.has(k)?this.map.get(k)!:null;}
  setItem(k:string,v:string){this.map.set(k,String(v));}
  removeItem(k:string){this.map.delete(k);}
}
const store=new FakeStorage();
(globalThis as {localStorage?:unknown}).localStorage=store;
const cache=await import('../lib/panel-cache.ts');
const {PANEL_KEYS}=await import('../lib/system-panels.ts');

test('a fresh app open renders the device snapshot without waiting for the network',()=>{
  const at=Date.now()-5*60_000;
  store.setItem(`${cache.PANEL_CACHE_PREFIX}owner:${PANEL_KEYS.logStatus}`,JSON.stringify({v:1,at,value:{primary:{stored:282}}}));
  const hit=cache.readPanel<{primary:{stored:number}}>('owner',PANEL_KEYS.logStatus);
  assert.equal(hit?.value.primary.stored,282);assert.equal(hit?.at,at);
  // Too old, corrupt or from the future: not shown.
  store.setItem(`${cache.PANEL_CACHE_PREFIX}owner:old`,JSON.stringify({v:1,at:Date.now()-cache.PANEL_MAX_AGE_MS-1,value:{}}));
  store.setItem(`${cache.PANEL_CACHE_PREFIX}owner:bad`,'{oops');
  store.setItem(`${cache.PANEL_CACHE_PREFIX}owner:future`,JSON.stringify({v:1,at:Date.now()+3_600_000,value:{}}));
  assert.equal(cache.readPanel('owner','old'),null);assert.equal(cache.readPanel('owner','bad'),null);assert.equal(cache.readPanel('owner','future'),null);
});

test('API status and member list never put secrets on the device',()=>{
  const full={configured:true,environment:'live',keyHint:'ab12…9f',status:'VERIFIED',lastVerifiedAt:1790000000000,lastError:'key ab12 rejected',
    apiKey:'AKEY-SHOULD-NOT-LEAK',apiSecret:'SECRET-SHOULD-NOT-LEAK'};
  cache.writePanel('owner',PANEL_KEYS.credential,full,cache.persistableCredential);
  const raw=store.getItem(`${cache.PANEL_CACHE_PREFIX}owner:${PANEL_KEYS.credential}`)!;
  assert.ok(raw);
  for(const leak of ['ab12','AKEY','SECRET','apiKey','apiSecret','rejected'])assert.doesNotMatch(raw,new RegExp(leak));
  assert.deepEqual(JSON.parse(raw).value,{configured:true,environment:'live',keyHint:null,status:'VERIFIED',lastVerifiedAt:1790000000000,lastError:null});
  // Memory (this open app) still has the full display value, e.g. the key hint.
  assert.equal(cache.readPanel<typeof full>('owner',PANEL_KEYS.credential)?.value.keyHint,'ab12…9f');
  cache.writePanel('owner',PANEL_KEYS.members,{invite:{code:'INVITE-XYZ',createdAt:1},members:[{id:'m'}]},cache.persistableMembers);
  const members=store.getItem(`${cache.PANEL_CACHE_PREFIX}owner:${PANEL_KEYS.members}`)!;
  assert.doesNotMatch(members,/INVITE-XYZ/);assert.match(members,/"members"/);
  // No persist function: memory only.
  cache.writePanel('owner','memory-only',{x:1},null);
  assert.equal(store.getItem(`${cache.PANEL_CACHE_PREFIX}owner:memory-only`),null);
});

test('scopes are separate and logout wipes memory and device copies',()=>{
  cache.writePanel('owner','k',{who:'owner'},v=>v);cache.writePanel('member-1','k',{who:'m'},v=>v);
  assert.equal(cache.readPanel<{who:string}>('member-1','k')?.value.who,'m');
  assert.equal(cache.readPanel<{who:string}>('owner','k')?.value.who,'owner');
  store.setItem('unrelated','keep');
  cache.clearPanels();
  assert.equal(cache.readPanel('owner','k'),null);assert.equal(cache.readPanel('member-1','k'),null);
  assert.ok([...store.map.keys()].every(k=>!k.startsWith(cache.PANEL_CACHE_PREFIX)));
  assert.equal(store.getItem('unrelated'),'keep');
});

test('one request per key; a prefetch and a mounting panel share it; a fresh memory value is not refetched',async()=>{
  cache.clearPanels();
  let calls=0;const fetcher=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {n:calls};};
  const [a,b]=await Promise.all([cache.loadPanel('owner','dedupe',fetcher,null),cache.loadPanel('owner','dedupe',fetcher,null)]);
  assert.equal(calls,1);assert.equal(a.value,b.value);
  cache.prefetchPanel('owner','dedupe',fetcher,null);
  assert.equal(calls,1,'fresh in memory: no request');
  cache.prefetchPanel('owner','dedupe',fetcher,null,0);
  await new Promise(r=>setTimeout(r,20));
  assert.equal(calls,2,'stale: refreshed in the background');
});

test('a failed refresh keeps the last good value; a logout mid-request drops the late answer',async()=>{
  cache.clearPanels();
  cache.writePanel('owner','keep',{ok:1},null);
  await assert.rejects(cache.loadPanel('owner','keep',async()=>{throw new Error('down');},null));
  assert.deepEqual(cache.readPanel('owner','keep')?.value,{ok:1});
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const late=cache.loadPanel('owner','late',async()=>{await gate;return {secret:'old session'};},v=>v);
  cache.clearPanels();release();
  await assert.rejects(late);
  assert.equal(cache.readPanel('owner','late'),null);
});
