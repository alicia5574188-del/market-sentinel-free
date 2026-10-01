import test from 'node:test';
import assert from 'node:assert/strict';
import {observeLiveAccount} from '../lib/live-account-view.ts';
import type {GateLiveSnapshot} from '../lib/gate-live.ts';
const snapshot=(total='100',floating='5',at=1000):GateLiveSnapshot=>({
  account:{user:'owner',total,available:'80',unrealised_pnl:floating,position_margin:'20',
    history:{pnl:'30',fee:'-2',fund:'-1'}},
  positions:[{contract:'REAL_USDT',size:'2',margin:'20',unrealised_pnl:floating}],orders:[],priceOrders:[],checkedAt:at});
test('real account includes native floating once; deposits change equity but cannot invent trading profits',()=>{
  const first=observeLiveAccount(snapshot(),500);
  assert.equal(first.equity,105);assert.equal(first.floating,5);assert.equal(first.tradingPnl,0);
  const next=snapshot('150','3',2000);next.account.history!.pnl='34';next.account.history!.fee='-3';
  const mark=observeLiveAccount(next,500,JSON.parse(JSON.stringify(first)));
  assert.equal(mark.equity,153);assert.equal(mark.capitalChange,48);assert.equal(mark.tradingPnl,1);
  assert.equal(mark.startedAt,1000);assert.equal(mark.initialEquity,105);assert.equal(mark.positionCount,1);
});
test('missing or unsupported account data stays unknown; missing native cash flows never uses capital change as PnL',()=>{
  const input=snapshot();delete input.account.history!.fee;
  const first=observeLiveAccount(input,500);assert.equal(first.tradingPnl,null);
  input.account.total='200';const next=observeLiveAccount(input,500,first);
  assert.equal(next.capitalChange,100);assert.equal(next.tradingPnl,null);
  delete input.account.total;assert.throws(()=>observeLiveAccount(input,500),/余额缺失/);
  input.account.total='200';input.account.margin_mode=1;assert.throws(()=>observeLiveAccount(input,500),/统一保证金/);
});
test('account and enable-session changes reset only the display observation anchor',()=>{
  const first=observeLiveAccount(snapshot(),500);
  const newSession=observeLiveAccount(snapshot('120','-1',2000),600,first);
  assert.equal(newSession.initialEquity,119);assert.equal(newSession.startedAt,2000);
  const other=snapshot('80','2',3000);other.account.user='member';
  const newAccount=observeLiveAccount(other,500,first);
  assert.equal(newAccount.initialEquity,82);assert.equal(newAccount.capitalChange,0);
  assert.equal(first.initialEquity,105);
});
test('observed drawdown follows actual marked equity including negative equity',()=>{
  const first=observeLiveAccount(snapshot(),500);
  const next=observeLiveAccount(snapshot('100','-10',2000),500,first);
  assert.equal(next.peak,105);assert.equal(next.maxDrawdown,15/105);
  assert.equal(observeLiveAccount(snapshot('0','-2',3000),500,next).equity,-2);
});
