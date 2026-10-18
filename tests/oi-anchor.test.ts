import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeOiRing, noteOiSnapshot, oiAnchor, oiSnapshotKey, type OiRing} from '../lib/oi-anchor.ts';

const T=1_792_310_000_000,min=60_000;
const rows=(v:number)=>[{symbol:'A_USDT',openInterest:v},{symbol:'B_USDT',openInterest:0}];

test('oi baseline: a snapshot every 15 minutes, anchor is the newest one 60-135 minutes old',()=>{
  let ring:OiRing=[];
  const puts:number[]=[];
  for(let m=0;m<=150;m+=0.25){
    const step=noteOiSnapshot(ring,rows(1000+m),T+m*min);ring=step.ring;if(step.put)puts.push(m);
  }
  assert.deepEqual(puts.slice(0,3),[0,15,30]);
  assert.ok(ring.length<=10,'window bounded');
  assert.equal(oiAnchor([],T),null);
  const fresh=noteOiSnapshot([],rows(5),T).ring;
  assert.equal(oiAnchor(fresh,T+59*min),null,'under an hour: no baseline');
  assert.equal(oiAnchor(fresh,T+60*min)?.oi.get('A_USDT'),5);
  assert.equal(oiAnchor(fresh,T+60*min)?.oi.has('B_USDT'),false,'zero OI not stored');
  assert.equal(oiAnchor(fresh,T+136*min),null,'too old');
  const a=oiAnchor(ring,T+150*min)!;
  assert.equal((T+150*min-a.at)/min,60,'newest snapshot at least 60 minutes old');
});

test('oi baseline survives a restart: stored snapshots merge back, stale ones are dropped',()=>{
  const stored=[{at:T,oi:{A_USDT:10}},{at:T+15*min,oi:{A_USDT:11}},{at:T-200*min,oi:{A_USDT:1}}];
  const after=mergeOiRing([],stored,T+70*min);
  assert.equal(after.ring.length,2);
  assert.deepEqual(after.drop,[oiSnapshotKey(T-200*min)]);
  assert.equal(oiAnchor(after.ring,T+70*min)?.oi.get('A_USDT'),10);
  assert.equal(oiAnchor(after.ring,T+75*min)?.oi.get('A_USDT'),11);
  assert.equal(oiSnapshotKey(T),'log:oi:000'+String(T));
});
