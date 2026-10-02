import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedLiveBasis,FIXED_ALLOCATION_EQUITY,FIXED_ALLOCATION_POLICY} from '../lib/fixed-allocation.ts';
test('fixed reference is1000 and capital anchor survives profits, losses and serialized restart',()=>{
  assert.equal(FIXED_ALLOCATION_EQUITY,1000);
  const basis=fixedLiveBasis(undefined,280,'native-owner',1790832000000);
  assert.equal(basis.version,FIXED_ALLOCATION_POLICY);
  for(const equity of [310,900,150])assert.deepEqual(fixedLiveBasis(JSON.parse(JSON.stringify(basis)),equity,'native-owner',1790832001000),basis);
  assert.equal(basis.liveEquity/FIXED_ALLOCATION_EQUITY,.28);
});
test('independent accounts retain separate anchors and invalid/corrupt identity is rejected',()=>{
  const owner=fixedLiveBasis(undefined,280,'owner',1790832000000),member=fixedLiveBasis(undefined,100,'member',1790832000000);
  assert.equal(member.liveEquity,100);assert.equal(owner.liveEquity,280);
  assert.throws(()=>fixedLiveBasis(owner,900,'another-account',1790832001000),/不一致/);
  for(const equity of [NaN,Infinity,0,-1])assert.throws(()=>fixedLiveBasis(undefined,equity,'owner',1790832000000));
  assert.throws(()=>fixedLiveBasis({...owner,liveEquity:NaN},280,'owner',1790832001000));
  assert.throws(()=>fixedLiveBasis({...owner,establishedAt:Infinity},280,'owner',1790832001000));
});
