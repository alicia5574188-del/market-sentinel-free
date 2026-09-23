import test from "node:test";
import assert from "node:assert/strict";
import {LIVE_READ_TIMEOUT_ESCALATE_AFTER,isTransientLiveReadErrorText,liveReadTimeoutDecision} from "../lib/live-read-resilience.ts";

test("one or two Gate read timeouts stay transient; the third consecutive timeout escalates",()=>{
  const one=liveReadTimeoutDecision(0),two=liveReadTimeoutDecision(one.streak),three=liveReadTimeoutDecision(two.streak);
  assert.equal(LIVE_READ_TIMEOUT_ESCALATE_AFTER,3);
  assert.deepEqual([one.streak,one.escalated],[1,false]);
  assert.deepEqual([two.streak,two.escalated],[2,false]);
  assert.equal(three.streak,3);assert.equal(three.escalated,true);
  assert.match(three.message??"",/连续3轮超时/);
  assert.match(three.message??"",/暂停新增复制/);
  assert.match(three.message??"",/Owner开关保持不变/);
});

test("only raw/transient read-timeout text is suppressible in the LIVE page",()=>{
  assert.equal(isTransientLiveReadErrorText("The operation was aborted due to timeout"),true);
  assert.equal(isTransientLiveReadErrorText("Gate只读核对超时：/futures/usdt/accounts；本轮不执行新增实盘动作"),false);
  assert.equal(isTransientLiveReadErrorText("Gate账户核对连续3轮超时；已暂停新增复制"),false);
  assert.equal(isTransientLiveReadErrorText("结构止损更新结果暂不明确"),false);
});
