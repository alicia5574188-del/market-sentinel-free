import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {OperatorRequestError,operatorRequest} from "../lib/operator-ui.ts";

test("owner PAPER reset remains isolated, confirmed and unavailable to members",()=>{
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  const handlers=readFileSync(new URL("../worker/http-handlers.ts",import.meta.url),"utf8");
  const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
  const control=readFileSync(new URL("../app/paper-account-reset.tsx",import.meta.url),"utf8");
  const ownerAction=handlers.slice(handlers.indexOf("async function ownerPaperAction"));
  const resetMethod=worker.slice(worker.indexOf("private async resetPaperAccount"),worker.indexOf("private async clearPaperHistory"));
  assert.match(ownerAction,/sameOriginMutation\(request\)/);
  assert.match(ownerAction,/ownerAuthenticated\(request, env\)/);
  assert.match(ownerAction,/RESET_PAPER/);
  assert.match(resetMethod,/runtime\.live\.requestedEnabled\|\|this\.runtime\.live\.operational/);
  assert.match(resetMethod,/requestFundsReset\(previous,now\)/);
  assert.match(resetMethod,/commitForwardAccount\(previous,result\.state,now\)/);
  assert.doesNotMatch(resetMethod,/freshLsrLedger|freshNewDesk|freshNeedleLedger|adoptLsrLedger|adoptNewDesk/);
  assert.doesNotMatch(resetMethod,/closeForwardForReset|emptyStrategyAccount|prepareForwardReset/);
  assert.doesNotMatch(resetMethod,/行情不新鲜/);
  assert.match(resetMethod,/模拟账户重置失败（\$\{stage\}）/);
  assert.doesNotMatch(resetMethod,/initialForward\(now\)/);
  assert.match(control,/运行日志/);
  assert.match(control,/重置已预约：等到没有持仓时自动执行（当前 \{openPaper\} 单）/);
  assert.match(control,/\/api\/paper\/reset\/cancel/);
  assert.match(control,/confirm:"CANCEL_PAPER_RESET"/);
  assert.match(handlers,/CANCEL_PAPER_RESET/);
  assert.match(worker,/"\/api\/paper\/reset\/cancel"/);
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
});

test("startup clears the strategy once and does not install an old book",()=>{
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  const method=worker.slice(worker.indexOf("private async adoptEmptyStrategy"),worker.indexOf("private async sweepRetiredPaperArchives"));
  assert.match(method,/requestedEnabled\|\|live\.operational/);
  assert.match(method,/emptyStrategyAccount\(previous,now\)/);
  assert.match(method,/STRATEGY_EPOCH/);
  assert.doesNotMatch(method,/freshDeskLedger|freshLsrLedger|freshNewDesk|applyNewDesk|applyResearchExperiment/);
  assert.doesNotMatch(method,/requestedEnabled\s*=\s*true|setLiveMode\(/);
  const advance=worker.slice(worker.indexOf("private async advanceForwardNow"),worker.indexOf("private async refreshRegimeHourly"));
  assert.match(advance,/adoptEmptyStrategy\(now\)/);
  assert.match(advance,/advanceForward\(/);
  assert.doesNotMatch(advance,/adoptDeskCleanLedger|adoptLsrLedger|adoptNewDesk|advanceShadowInverse|applyNewDesk|applyResearchExperiment/);
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
