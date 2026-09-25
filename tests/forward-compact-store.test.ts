import test from "node:test";
import assert from "node:assert/strict";
import { initialForward, type ForwardState } from "../lib/forward-relations.ts";
import { FORWARD_STORAGE, FORWARD_COMPACT_BYTES, FORWARD_STORAGE_STATE_VERSION, prepareForwardWrite, readForwardStore } from "../lib/forward-store.ts";
import { MAX_STATE_BYTES } from "../lib/storage-codec.ts";

const T=1_790_100_000_000,HEAD=`${FORWARD_STORAGE}head`;
class Memory {
  data=new Map<string,unknown>();reads:string[]=[];
  async get<V>(key:string){this.reads.push(key);return structuredClone(this.data.get(key)) as V|undefined;}
  async put(entries:Record<string,unknown>){for(const[k,v]of Object.entries(entries))this.data.set(k,structuredClone(v));}
}
function fixture(){const s=initialForward(T);s.storage.persistedAt=T;s.latestReason="无损保护、财务与规则记录 🛡️";return s;}
function largeFixture(){
  const s=fixture() as ForwardState&{futureOpaqueEvidence:string};
  // Deterministic high-entropy future extension, not a real user record. It
  // forces multi-chunk gzip without relying on repetitive compressible text.
  let seed=72193;const words:string[]=[];
  for(let i=0;i<60_000;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;words.push((seed>>>0).toString(16).padStart(8,"0"));}
  s.futureOpaqueEvidence=words.join("");return s;
}
test("sample-pack storage keeps a 2MB+ verbose learning state lossless without deleting evidence",async()=>{
  const s=fixture(),at=T-60_000;
  s.relationEngine.samples=Array.from({length:2200},(_,i)=>({
    symbol:`PACK${String(i).padStart(4,"0")}_USDT`,at,response:.0123456789012345,up:.0187654321098765,down:.0065432109876543,
    x:[.123456789012345,.234567890123456,.345678901234567,.456789012345678,.567890123456789,.678901234567891,.789012345678912,.890123456789123],
    env:{breadth:.612345678901234,dispersion:.223456789012345,expansion:.334567890123456},
    cp:{5:.001234567890123,10:.002345678901234,15:.003456789012345,20:.004567890123456,30:.006789012345678,45:.009012345678901,60:.0123456789012345},
    upAt:{5:.002,10:.003,15:.004,20:.005,30:.008,45:.012,60:.0187654321098765},
    downAt:{5:.001,10:.0015,15:.002,20:.0025,30:.003,45:.004,60:.0065432109876543},
    relativeAt:{15:0,30:0,45:0,60:0},pathEfficiency:.712345678901234,reversals:2,
  }));
  const verboseBytes=new TextEncoder().encode(JSON.stringify(s)).length;
  assert.ok(verboseBytes>MAX_STATE_BYTES,`verbose fixture should exceed 2MB, got ${verboseBytes}`);
  const write=await prepareForwardWrite(null,s,T,{compact:true});
  assert.ok(write.compression.rawBytes<MAX_STATE_BYTES,`packed raw state should fit, got ${write.compression.rawBytes}`);
  assert.ok(write.compression.rawBytes<verboseBytes*.82,"sample packing should materially reduce raw JSON");
  const head=write.entries[HEAD] as {version:string};assert.equal(head.version,FORWARD_STORAGE_STATE_VERSION);
  const db=new Memory();await db.put(write.entries);const restored=await readForwardStore(db,T+1);
  assert.equal(restored.relationEngine.samples.length,2200);
  assert.deepEqual(restored.relationEngine.samples[0],s.relationEngine.samples[0]);
  assert.deepEqual(restored.relationEngine.samples.at(-1),s.relationEngine.samples.at(-1));
  assert.equal(restored.balance,s.balance);assert.equal(restored.positions.length,s.positions.length);
});

test("compact forward full commit preserves all bytes while reducing a small record by one key",async()=>{
  const s=fixture(),old=await prepareForwardWrite(null,s,T),compact=await prepareForwardWrite(null,s,T,{compact:true});
  assert.equal(compact.writes,old.writes-1);assert.equal(compact.compression.inlineHead,true);
  assert.equal(compact.compression.chunks,0);assert.equal(compact.compression.storedBytes,old.compression.storedBytes);
  const h=compact.entries[HEAD] as {inline:Uint8Array};assert.ok(h.inline instanceof Uint8Array);
  assert.ok(h.inline.byteLength<=FORWARD_COMPACT_BYTES);
  assert.equal(Object.keys(compact.entries).some(k=>k.includes("chunk:")),false);
  assert.deepEqual(Object.entries(compact.entries).filter(([k])=>k.includes("archive:")),
    Object.entries(old.entries).filter(([k])=>k.includes("archive:")));
  const db=new Memory();await db.put(compact.entries);assert.deepEqual(await readForwardStore(db,T+1),s);
  assert.equal(db.reads.some(k=>k.includes("chunk:")),false);
});
test("legacy 80 KiB chunk encoding remains default and readable before compact migration",async()=>{
  const s=fixture(),old=await prepareForwardWrite(null,s,T),db=new Memory();await db.put(old.entries);
  assert.ok(Object.keys(old.entries).some(k=>k.includes("chunk:")));
  assert.equal((old.entries[HEAD] as {inline?:unknown}).inline,undefined);
  assert.deepEqual(await readForwardStore(db,T+1),s);
  const compact=await prepareForwardWrite(s,s,T+2,{compact:true});await db.put(compact.entries);
  // The old chunk key is not deleted or read. A new compact head selects its
  // own authenticated bytes even when obsolete legacy chunks remain present.
  db.data.set(`${FORWARD_STORAGE}chunk:0`,new Uint8Array([0,1,2]));
  assert.deepEqual(await readForwardStore(db,T+3),s);
});
test("compact reader can losslessly rewrite legacy format before rolling back the old reader",async()=>{
  const s=fixture(),db=new Memory();await db.put((await prepareForwardWrite(null,s,T,{compact:true})).entries);
  const recovered=await readForwardStore(db,T+1),legacy=await prepareForwardWrite(recovered,recovered,T+2);
  await db.put(legacy.entries);assert.ok((db.data.get(HEAD) as {count:number}).count>=1);
  assert.equal((db.data.get(HEAD) as {inline?:unknown}).inline,undefined);
  assert.deepEqual(await readForwardStore(db,T+3),s);
});
test("compact multi-chunk layout uses <=112 KiB chunks, fewer records, and retains future fields",async()=>{
  const s=largeFixture(),old=await prepareForwardWrite(null,s,T),compact=await prepareForwardWrite(null,s,T,{compact:true});
  assert.equal(compact.compression.inlineHead,true);assert.ok(compact.compression.storedBytes>FORWARD_COMPACT_BYTES);
  assert.ok(compact.compression.chunks<old.compression.chunks);assert.ok(compact.writes<old.writes);
  for(const[k,v]of Object.entries(compact.entries))if(k.includes("chunk:"))assert.ok((v as Uint8Array).byteLength<=FORWARD_COMPACT_BYTES);
  const db=new Memory();await db.put(compact.entries);assert.deepEqual(await readForwardStore(db,T+1),s);
});
test("compact inline tampering, truncation, oversize and encoding mismatch fail without reset",async()=>{
  const s=fixture(),write=await prepareForwardWrite(null,s,T,{compact:true});
  const original=write.entries[HEAD] as {inline:Uint8Array;count:number;length:number;rawLength:number};
  const flipped=original.inline.slice();flipped[Math.floor(flipped.length/2)]^=1;
  for(const head of [{...original,inline:flipped},{...original,inline:original.inline.slice(1)},
    {...original,inline:new Uint8Array(FORWARD_COMPACT_BYTES+1)},
    {...original,inline:undefined},{...original,count:1},{...original,rawLength:original.rawLength+1}]){
    const db=new Memory();await db.put({...write.entries,[HEAD]:head});
    await assert.rejects(()=>readForwardStore(db,T+1));
    assert.deepEqual(db.data.get(HEAD),head);
  }
});
test("missing compact chunk fails; rollback from inline never masks an incomplete replacement",async()=>{
  const s=largeFixture(),db=new Memory(),write=await prepareForwardWrite(null,s,T,{compact:true});
  await db.put(write.entries);db.data.delete(`${FORWARD_STORAGE}chunk:0`);
  await assert.rejects(()=>readForwardStore(db,T+1),/分片缺失/);
});
