/** Local-only, synthetic-secret smoke test of the compiled Worker and actual
 * SQLite MemberDirectory. No MarketStream read, Gate request or funded user.
 */
import {spawn} from 'node:child_process';
import {mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import assert from'node:assert/strict';
const root='synthetic-local-member-smoke-secret-not-production',dir=await mkdtemp(join(tmpdir(),'member-local-'));
const port=18000+(process.pid%10000),base=`http://127.0.0.1:${port}`;
// The archived local workerd binary supports May 2026. This override is ONLY
// for the disposable emulator; production keeps its original compatibility date.
const process_=spawn('./node_modules/.bin/wrangler',['dev','--local','--compatibility-date','2026-05-22','--config','dist/server/wrangler.json','--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--persist-to',dir,'--var',`OWNER_ACCESS_TOKEN:${root}`],{env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
let logs='';process_.stdout.on('data',b=>logs+=b);process_.stderr.on('data',b=>logs+=b);
const call=async(path,cookie='',body)=>{
 let last;
 for(let attempt=0;attempt<2;attempt++){
  try{
   const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json',Connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});
   // Drain every local HTTP body, including status-only denial assertions, so
   // the smoke test cannot exhaust its own keep-alive connection pool.
   return new Response(await response.arrayBuffer(),{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch(error){last=error;if(attempt===0)await new Promise(r=>setTimeout(r,150));}
 }
 throw new Error(`Local member smoke request failed: ${path}`,{cause:last});
};
try{
 let ready=false;for(let i=0;i<40;i++){if(process_.exitCode!==null)throw Error('Local Worker exited');try{const r=await call('/api/auth/session');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'Local Worker ready');
 let r=await call('/api/auth/login','',{username:'owner',password:root});assert.equal(r.status,200);const owner=r.headers.getSetCookie().find(x=>x.startsWith('ms_owner_session=')).split(';')[0];
 const register=async(username,requestId)=>{const admin=await(await call('/api/members/admin',owner)).json();
   const body={inviteCode:admin.invite.code,username,password:'synthetic-password-'+username,requestId};
   const r=await call('/api/members/register','',body);assert.equal(r.status,200,await r.clone().text());return{id:(await r.json()).memberId,body};};
 const a=await register('local_user_a','local-user-A-idempotent'),b=await register('local_user_b','local-user-B-idempotent');assert.notEqual(a.id,b.id);
 r=await call('/api/members/login','',{username:a.body.username,password:a.body.password});assert.equal(r.status,200,await r.clone().text());const member=r.headers.getSetCookie().find(x=>x.startsWith('ms_member_session=')).split(';')[0];assert.equal((await r.json()).memberId,a.id);
 assert.equal((await call('/api/members/admin',member)).status,403);assert.equal((await call('/api/runtime')).status,401);
 assert.equal((await call('/api/members/issue',member,{requestId:'retired-member-key'})).status,410);
 assert.equal((await call('/api/members/invite/rotate',member,{})).status,403);
 assert.equal((await(await call('/api/auth/session',member)).json()).memberId,a.id);
 const credentials=await call('/api/live/credentials',member);assert.equal(credentials.status,200);assert.equal((await credentials.json()).credential.configured,false);
 const actualMember=await call('/api/live/status',member);assert.equal(actualMember.status,200);assert.equal((await actualMember.json()).live.requestedEnabled,false);
 const again=await call('/api/members/register','',a.body);assert.equal(again.status,200);assert.equal((await again.json()).memberId,a.id);
 const wrong=await call('/api/members/register','',{...a.body,password:'wrong-synthetic-password'});assert.equal(wrong.status,409);assert.equal(wrong.headers.has('set-cookie'),false);
 const admin=await(await call('/api/members/admin',owner)).json();assert.equal(admin.members.length,2);assert.ok(admin.members.some(m=>m.id===b.id));assert.notEqual(admin.invite.code,b.body.inviteCode);
 console.log(JSON.stringify({compiledWorker:true,sqliteDirectory:true,sqliteMemberExecutor:true,usernamePasswordLogin:true,singleUseInvites:true,passwordRequiredOnRetry:true,memberCannotInvite:true,guestBlocked:true,realGateRequests:0,primaryReads:0,syntheticLocalOnly:true}));
}catch(e){console.error(logs.replaceAll(root,'[synthetic-redacted]'));throw e;}finally{process_.kill('SIGTERM');await new Promise(r=>setTimeout(r,400));if(process_.exitCode===null)process_.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
