/** Local-only, synthetic-secret smoke test of the compiled Worker and actual
 * SQLite MemberDirectory. No MarketStream read, Gate request or funded user.
 */
import {spawn} from 'node:child_process';
import {mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import assert from'node:assert/strict';
const root='synthetic-local-member-smoke-secret-not-production',dir=await mkdtemp(join(tmpdir(),'member-local-'));
const port=18787,base=`http://127.0.0.1:${port}`;
// The archived local workerd binary supports May 2026. This override is ONLY
// for the disposable emulator; production keeps its original compatibility date.
const process_=spawn('./node_modules/.bin/wrangler',['dev','--local','--compatibility-date','2026-05-22','--config','dist/server/wrangler.json','--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--persist-to',dir,'--var',`OWNER_ACCESS_TOKEN:${root}`],{env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
let logs='';process_.stdout.on('data',b=>logs+=b);process_.stderr.on('data',b=>logs+=b);
const call=(path,cookie='',body)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
try{
 let ready=false;for(let i=0;i<40;i++){if(process_.exitCode!==null)throw Error('Local Worker exited');try{const r=await call('/api/auth/session');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'Local Worker ready');
 let r=await call('/api/auth/login','',{username:'owner',password:root});assert.equal(r.status,200);const owner=r.headers.getSetCookie().find(x=>x.startsWith('ms_owner_session=')).split(';')[0];
 const issue=async(requestId)=>{const r=await call('/api/members/issue',owner,{label:'Local synthetic',requestId});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const a=await issue('local-key-A-idempotent'),b=await issue('local-key-B-idempotent');assert.notEqual(a.id,b.id);assert.notEqual(a.loginKey,b.loginKey);
 r=await call('/api/members/login','',{key:a.loginKey});assert.equal(r.status,200,await r.clone().text());const member=r.headers.getSetCookie().find(x=>x.startsWith('ms_member_session=')).split(';')[0];assert.equal((await r.json()).memberId,a.id);
 assert.equal((await call('/api/members/admin',member)).status,403);assert.equal((await call('/api/runtime')).status,401);
 assert.equal((await call('/api/members/issue',member,{requestId:'forbidden-member-invitation'})).status,403);
 assert.equal((await(await call('/api/auth/session',member)).json()).memberId,a.id);
 const credentials=await call('/api/live/credentials',member);assert.equal(credentials.status,200);assert.equal((await credentials.json()).credential.configured,false);
 const actualMember=await call('/api/live/status',member);assert.equal(actualMember.status,200);assert.equal((await actualMember.json()).live.requestedEnabled,false);
 const again=await issue('local-key-A-idempotent');assert.equal(again.id,a.id);
 const admin=await(await call('/api/members/admin',owner)).json();assert.equal(admin.members.length,2);assert.equal(admin.current.id,b.id);
 console.log(JSON.stringify({compiledWorker:true,sqliteDirectory:true,sqliteMemberExecutor:true,olderUnusedKeyWorks:true,memberCannotInvite:true,guestBlocked:true,realGateRequests:0,primaryReads:0,syntheticLocalOnly:true}));
}catch(e){console.error(logs.replaceAll(root,'[synthetic-redacted]'));throw e;}finally{process_.kill('SIGTERM');await new Promise(r=>setTimeout(r,400));if(process_.exitCode===null)process_.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
