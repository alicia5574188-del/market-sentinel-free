import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {OperatorRequestError,operatorRequest} from "../lib/operator-ui.ts";

test("owner PAPER reset remains isolated, confirmed and unavailable to members",()=>{
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
  const control=readFileSync(new URL("../app/paper-account-reset.tsx",import.meta.url),"utf8");
  const cache=readFileSync(new URL("../lib/equity-cache.ts",import.meta.url),"utf8");
  const ownerAction=worker.slice(worker.indexOf("async function ownerPaperAction"),worker.indexOf("const worker ="));
  const resetMethod=worker.slice(worker.indexOf("private async resetPaperAccount"),worker.indexOf("private async clearPaperHistory"));
  assert.match(ownerAction,/sameOriginMutation\(request\)/);
  assert.match(ownerAction,/ownerAuthenticated\(request, env\)/);
  assert.match(ownerAction,/RESET_PAPER/);
  assert.match(resetMethod,/runtime\.live\.requestedEnabled\|\|this\.runtime\.live\.operational/);
  assert.match(resetMethod,/resetForwardAccountPreservingLearning\(previous,now\)/);
  assert.match(worker,/prepareForwardReset\(previous,closed,next,now\)/);
  assert.doesNotMatch(resetMethod,/行情不新鲜/);
  assert.match(resetMethod,/for\(const\[key,value\]of Object\.entries\(prepared\.archiveEntries\)\)await transaction\.put\(key,value\)/);
  assert.match(resetMethod,/prepared\.accountEntries/);
  assert.match(resetMethod,/模拟账户重置失败（\$\{stage\}）/);
  assert.doesNotMatch(resetMethod,/initialForward\(now\)/);
  assert.match(control,/学习样本和关系状态已保留/);
  assert.match(control,/市场学习样本会保留/);
  assert.match(control,/try\{onReset\(\);\}catch/);
  assert.match(control,/auth\.username==="owner"/);
  assert.match(control,/!auth\.memberId/);
  assert.match(control,/auth\.role!=="member"/);
  assert.match(control,/\/api\/paper\/reset/);
  assert.match(control,/confirm:"RESET_PAPER"/);
  assert.match(control,/operatorRequest<ResetResult>/);
  assert.match(control,/submitting\.current/);
  assert.doesNotMatch(control,/setInterval|setTimeout|retry/i);
  assert.match(page,/PaperAccountReset/);
  assert.match(cache,/context\.startedAt/);
  assert.match(cache,/if\(this\.key!==key\)/);
});


test("PAPER reset Safari DOMException is Chinese and never replayed",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new DOMException("The string did not match the expected pattern.","SyntaxError");};
  try{
    await assert.rejects(()=>operatorRequest("/api/paper/reset","POST",{confirm:"RESET_PAPER"}),
      e=>e instanceof OperatorRequestError&&e.status===0&&/未收到服务器确认/.test(e.message));
    assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
