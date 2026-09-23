import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("owner PAPER reset remains isolated, confirmed and unavailable to members",()=>{
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
  const control=readFileSync(new URL("../app/paper-account-reset.tsx",import.meta.url),"utf8");
  assert.match(worker,/sameOriginMutation\(request\)/);
  assert.match(worker,/ownerAuthenticated\(request, env\)/);
  assert.match(worker,/RESET_PAPER/);
  assert.match(worker,/runtime\.live\.requestedEnabled \|\| this\.runtime\.live\.operational/);
  assert.match(worker,/prepareForwardReset\(previous,closed,next,now\)/);
  assert.match(worker,/initialMultiTurnForward\(now\)/);
  assert.match(control,/auth\.username==="owner"/);
  assert.match(control,/!auth\.memberId/);
  assert.match(control,/auth\.role!=="member"/);
  assert.match(control,/\/api\/paper\/reset/);
  assert.match(control,/confirm:"RESET_PAPER"/);
  assert.match(control,/operatorRequest<ResetResult>/);
  assert.doesNotMatch(control,/setInterval|setTimeout|retry/i);
  assert.match(page,/PaperAccountReset/);
});
