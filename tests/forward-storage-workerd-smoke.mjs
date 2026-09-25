/** Local workerd/SQLite KV serialization check. Synthetic state only; no
 * MarketStream constructor, private credentials, exchange or production API.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const built=await build({stdin:{resolveDir:fileURLToPath(new URL("..",import.meta.url)),sourcefile:"compact-storage-smoke.ts",contents:`
import { initialForward, normalizeForward } from "./lib/forward-relations.ts";
import { FORWARD_STORAGE, FORWARD_COMPACT_BYTES, FORWARD_PAGED_STATE_VERSION, prepareForwardWrite, readForwardStore } from "./lib/forward-store.ts";
const T=1790100000000;
function durable(value,now){const expected=structuredClone(value);expected.storage.layout=FORWARD_PAGED_STATE_VERSION;
  expected.storage.sampleIntegrity="raw-sha256";return normalizeForward(expected,now);}
function firstDiff(a,b,path="$"){if(Object.is(a,b))return null;if(typeof a!=="object"||a===null||typeof b!=="object"||b===null)
  return path+":"+JSON.stringify(a)+"!="+JSON.stringify(b);const keys=new Set([...Object.keys(a),...Object.keys(b)]);
  for(const key of keys){const found=firstDiff(a[key],b[key],path+"."+key);if(found)return found;}return null;}
function equal(a,b,label){const difference=firstDiff(a,b);if(difference)throw new Error("lossless state mismatch "+label+" "+difference);}
export class CompactStorageCheck {
 constructor(ctx){this.ctx=ctx;}
 async fetch(){
  const storage=this.ctx.storage,s=initialForward(T);s.storage.persistedAt=T;
  s.latestReason="本地SQLite完整记录 🛡️";
  const old=await prepareForwardWrite(null,s,T),compact=await prepareForwardWrite(null,s,T,{compact:true});
  await storage.transaction(async tx=>{await tx.put(old.entries);});equal(await readForwardStore(storage,T),durable(s,T),"legacy-small");
  await storage.transaction(async tx=>{await tx.put(compact.entries);});equal(await readForwardStore(storage,T),durable(s,T),"compact-small");
  const head=await storage.get(FORWARD_STORAGE+"head");
  if(!(head.inline instanceof Uint8Array))throw new Error("typed-array encoding not preserved");
  let seed=72193;const words=[];
  for(let i=0;i<60000;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;words.push((seed>>>0).toString(16).padStart(8,"0"));}
  s.futureOpaqueEvidence=words.join("");
  const largeOld=await prepareForwardWrite(null,s,T+1),largeCompact=await prepareForwardWrite(null,s,T+1,{compact:true});
  await storage.transaction(async tx=>{await tx.put(largeCompact.entries);});equal(await readForwardStore(storage,T+1),durable(s,T+1),"compact-large");
  const largeHead=await storage.get(FORWARD_STORAGE+"head");
  if(largeHead.inline.byteLength!==FORWARD_COMPACT_BYTES)throw new Error("inline first chunk is not bounded");
  const uncommitted=structuredClone(s);uncommitted.balance+=50;uncommitted.revision++;
  const failedWrite=await prepareForwardWrite(s,uncommitted,T+10,{compact:true});
  let rolledBack=false;
  try{await storage.transaction(async tx=>{await tx.put(failedWrite.entries);throw new Error("synthetic rollback");});}
  catch(error){if(error.message!=="synthetic rollback")throw error;rolledBack=true;}
  equal(await readForwardStore(storage,T+11),durable(s,T+11),"rollback");
  for(const key of Object.keys(failedWrite.entries).filter(k=>k.includes("archive:")))
    if(await storage.get(key)!==undefined)throw new Error("uncommitted archive survived rollback");
  // Verify a full 112 KiB typed array plus object metadata using actual host
  // serialization, not JSON byte estimates or base64.
  await storage.put("synthetic-112k-boundary",{inline:new Uint8Array(FORWARD_COMPACT_BYTES),length:FORWARD_COMPACT_BYTES,
    sha256:"f".repeat(64),encoding:"gzip",rawLength:1000000,version:"forward-relations-v1.0",count:2});
  if((await storage.get("synthetic-112k-boundary")).inline.byteLength!==FORWARD_COMPACT_BYTES)throw new Error("boundary mismatch");
  let oversizeRejected=false;try{await storage.put("synthetic-oversize",{inline:new Uint8Array(129*1024)});}catch{oversizeRejected=true;}
  const recovered=await readForwardStore(storage,T+2);
  await storage.transaction(async tx=>{await tx.put((await prepareForwardWrite(recovered,recovered,T+2)).entries);});
  equal(await readForwardStore(storage,T+3),durable(s,T+3),"legacy-rewrite");
  return Response.json({localOnly:true,sqliteKV:true,realMarketStream:false,networkRequests:0,typedArrayPreserved:true,
    inline112KiBAccepted:true,emulatorEnforcesProductionValueLimit:oversizeRejected,
    small:{legacyWrites:old.writes,compactWrites:compact.writes},
    large:{storedBytes:largeCompact.compression.storedBytes,legacyWrites:largeOld.writes,compactWrites:largeCompact.writes},
    fullStateAndArchivesRoundTrip:true,atomicFinancialArchiveRollback:rolledBack,legacyRewriteRoundTrip:true});
 }
}
export default {fetch(request,env){return env.CHECK.get(env.CHECK.idFromName("synthetic-storage-only")).fetch(request);}};
`},bundle:true,write:false,format:"esm",platform:"neutral",target:"es2022"});
const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:"2026-05-22",
  durableObjects:{CHECK:{className:"CompactStorageCheck",useSQLite:true}}});
try{
  const response=await mf.dispatchFetch("http://synthetic-storage.test/check");
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();assert.equal(result.inline112KiBAccepted,true);
  assert.equal(result.atomicFinancialArchiveRollback,true);
  // Miniflare may omit the hosted 128 KiB quota enforcement. Report that
  // limitation honestly: success proves the 112 KiB binary round-trip, not
  // a measurement of production limits. Application bounds remain enforced.
  assert.equal(result.small.legacyWrites-result.small.compactWrites,1);
  assert.ok(result.large.compactWrites<result.large.legacyWrites);console.log(JSON.stringify(result));
}finally{await mf.dispose();}
