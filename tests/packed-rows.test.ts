/**
 * restart fix: shadow-trade rows are kept as packed typed columns (≈ 38 B/row instead of ≈ 110 B/row of JS arrays), the per-playbook
 * expansion scans the packed column (no 490k-entry position index). Results and what is written to D1 must stay exactly the same.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {PackedRows,type PackedRow} from "../lib/dynamic/packed.ts";
import {DynamicResearch} from "../lib/dynamic/runtime.ts";
import {POOL} from "../lib/dynamic/playbooks.ts";

let seed=5;const rnd=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;
const T0=1_780_000_000;
const mkRows=(n:number,npb:number):PackedRow[]=>Array.from({length:n},()=>{const et=T0+Math.floor(rnd()*1e6);return [Math.floor(rnd()*npb),et,et+300+Math.floor(rnd()*9000),Math.round((rnd()-.47)*80000),+(100*rnd()+1).toFixed(8),+(rnd()*1e-4).toFixed(8)] as PackedRow;});

test("packed rows are exact: same numbers back, same JSON as the plain rows (what D1 stores does not change)",()=>{
  const rows=mkRows(1000,6);rows.push([0,T0,T0+60,-123456,0.000123,12345.678901]);
  const p=PackedRows.from(rows);
  assert.equal(p.length,rows.length);assert.deepEqual(p.toRows(),rows);
  assert.equal(JSON.stringify({p:["a"],t:p.toRows()}),JSON.stringify({p:["a"],t:rows}));
  assert.ok(p.sameAs(rows));const other=rows.map(r=>[...r] as PackedRow);other[500]![4]+=1e-8;assert.ok(!p.sameAs(other));assert.ok(!p.sameAs(rows.slice(1)));
  assert.deepEqual(p.get(7),rows[7]);assert.equal(p.netAt(7),rows[7]![3]);assert.equal(p.etAt(7),rows[7]![1]);
});

test("a live source grows row by row (add/push), also from empty, without losing or reordering anything",()=>{
  const rows=mkRows(333,3),p=new PackedRows();
  rows.slice(0,100).forEach(r=>p.add(r[0],r[1],r[2],r[3],r[4],r[5]));p.push(...rows.slice(100));
  assert.deepEqual(p.toRows(),rows);assert.equal(p.n,333);
});

test("memory per row: packed columns are ≤ 40 bytes per row (a JS row array is ≈ 110)",()=>{
  const p=PackedRows.from(mkRows(100_000,6));
  const bytes=Object.values(p as unknown as Record<string,unknown>).filter((v):v is ArrayBufferView=>ArrayBuffer.isView(v)).reduce((a,v)=>a+v.byteLength,0);
  assert.ok(bytes/p.n<=40,`bytes per row ${bytes/p.n}`);
});

test("the per-playbook expansion gives exactly the trades tradesLite() has for that playbook, in the same order",()=>{
  const rt=new DynamicResearch(),ids=POOL.filter(p=>!p.external).map(p=>p.id);
  for(let i=0;i<60;i++){const pbs=[...new Set(Array.from({length:4},()=>ids[Math.floor(rnd()*ids.length)]!))],k=`u|S${i%7}_USDT|5m|${i}`;
    rt.tsrc.set(k,{k,sym:`S${i%7}_USDT`,iv:"5m",t0:i,pbs,rows:PackedRows.from(mkRows(50,pbs.length)),dirty:false});}
  // a row pointing past its source's playbook list is skipped by both
  const bad=[...rt.tsrc.values()][0]!;bad.rows.add(bad.pbs.length+3,T0,T0+60,1,1,1);
  (rt as unknown as {recount():void}).recount();
  const all=rt.tradesLite(),lite=(rt as unknown as {liteIndex():(pb:string)=>typeof all}).liteIndex();
  let seen=0;
  for(const id of ids){const want=all.filter(x=>x.pb===id),got=lite(id);assert.deepEqual(got,want,id);seen+=got.length;}
  assert.equal(seen,all.length);assert.equal(all.length,rt.tradeCount-1);
  assert.equal(rt.peakLite,Math.max(...ids.map(id=>all.filter(x=>x.pb===id).length)));
});

test("analysis result is unchanged by the packing (gates, cycles, forecasts equal the one-shot reference)",()=>{
  const mk=()=>{const rt=new DynamicResearch(),ids=POOL.filter(p=>!p.external).map(p=>p.id);seed=99;
    for(let i=0;i<40;i++){const pbs=[...new Set(Array.from({length:3},()=>ids[Math.floor(rnd()*ids.length)]!))],k=`u|S${i%5}_USDT|5m|${i}`;
      rt.tsrc.set(k,{k,sym:`S${i%5}_USDT`,iv:"5m",t0:i,pbs,rows:PackedRows.from(mkRows(60,pbs.length)),dirty:false});}
    (rt as unknown as {recount():void}).recount();rt.tradesLoaded=true;return rt;};
  const a=mk(),b=mk(),at=(T0+2_000_000)*1000;
  a.analyze(at);
  const all=b.tradesLite(),by=new Map<string,typeof all>();for(const x of all)(by.get(x.pb)??by.set(x.pb,[]).get(x.pb)!).push(x);
  b.analyze(at,pb=>by.get(pb)??[]);
  assert.deepEqual(a.cycles,b.cycles);assert.deepEqual(a.gates,b.gates);assert.deepEqual(a.forecasts,b.forecasts);
});

test("loading a stored chunk then merging a live day keeps the dedupe (playbook + entry time) and marks only the merged source dirty",()=>{
  const rt=new DynamicResearch();
  const pb=POOL.find(p=>!p.external)!.id,pb2=POOL.filter(p=>!p.external)[1]!.id;
  const src={k:"l|A_USDT|5m|1",sym:"A_USDT",iv:"5m" as const,t0:1,pbs:[pb],rows:PackedRows.from([[0,T0,T0+60,100,1,2],[0,T0+300,T0+360,-50,1,2]]),dirty:false};
  rt.tsrc.set(src.k,src);
  (rt as unknown as {mergeRows(d:typeof src,p:string[],r:PackedRow[]):void}).mergeRows(src,[pb,pb2],[[0,T0,T0+60,100,1,2],[1,T0,T0+90,7,1,2],[0,T0+600,T0+660,3,1,2]]);
  assert.equal(src.rows.n,4);assert.equal(src.dirty,true);assert.deepEqual(src.pbs,[pb,pb2]);assert.deepEqual(src.rows.get(2),[1,T0,T0+90,7,1,2]);
});
