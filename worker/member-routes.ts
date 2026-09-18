/** Public HTTP authorization boundary. New roles cannot fall through to the
 * primary owner endpoints. Tenant identity comes ONLY from a verified cookie.
 */
import type { CloudflareEnv } from "./index-clean.ts";
import { verifyOwnerSession, sameOriginMutation, clearOwnerSessionCookie } from "../lib/owner-auth.ts";
import { MEMBERS_VERSION, verifyMemberSession, issueMemberSession, memberCookie, clearMemberCookie, digestMember } from "../lib/member-auth.ts";
type Identity={id:string;version:number;label:string;createdAt:number};
const json=(v:unknown,status=200,headers?:HeadersInit)=>Response.json(v,{status,headers:{"Cache-Control":"no-store",...headers}});
const cachedIdentity=new Map<string,{value:Identity;at:number}>();
const rates=new Map<string,{count:number;at:number}>();
async function smallJson(request:Request) {
  if(Number(request.headers.get("content-length")??0)>2048)throw new Error("请求过大");
  const text=await request.text();if(text.length>2048)throw new Error("请求过大");
  return JSON.parse(text) as Record<string,unknown>;
}
function rate(id:string) {const now=Date.now(),r=rates.get(id);if(r&&now-r.at<60000){r.count++;return r.count<=90;}
  rates.set(id,{count:1,at:now});if(rates.size>200)rates.delete(rates.keys().next().value!);return true;}
async function identity(request:Request,env:CloudflareEnv):Promise<Identity|null> {
  const session=await verifyMemberSession(request,env.OWNER_ACCESS_TOKEN);if(!session||!env.MEMBERS)return null;
  const key=`${session.id}:${session.version}`,old=cachedIdentity.get(key);
  if(old&&Date.now()-old.at<30000)return old.value;
  const r=await env.MEMBERS.getByName("directory").fetch(`https://members/identity?id=${session.id}`);
  if(!r.ok)return null;const v=await r.json<Identity>();if(v.id!==session.id||v.version!==session.version)return null;
  cachedIdentity.set(key,{value:v,at:Date.now()});if(cachedIdentity.size>100)cachedIdentity.delete(cachedIdentity.keys().next().value!);
  return v;
}
export async function memberRoutes(request:Request,env:CloudflareEnv):Promise<Response|null> {
  const u=new URL(request.url),path=u.pathname;if(!path.startsWith("/api/"))return null;
  const owner=!!env.OWNER_ACCESS_TOKEN&&await verifyOwnerSession(request,env.OWNER_ACCESS_TOKEN);
  try {
    if(path==="/api/members/admin"||path==="/api/members/issue") {
      if(!owner)return json({error:"仅主账户可以发放登录密钥或查看会员成交额"},403);
      if(!env.MEMBERS)return json({error:"会员服务未部署"},503);
      if(path.endsWith("/admin")&&request.method==="GET")return env.MEMBERS.getByName("directory").fetch("https://members/overview");
      if(path.endsWith("/issue")&&request.method==="POST") {
        if(!sameOriginMutation(request))return json({error:"请求来源验证失败"},403);
        const b=await smallJson(request);
        return env.MEMBERS.getByName("directory").fetch("https://members/issue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:b.label,requestId:b.requestId})});
      }
      return json({error:"不支持此操作"},405);
    }
    if(path==="/api/members/login"&&request.method==="POST") {
      if(!sameOriginMutation(request))return json({error:"请求来源验证失败"},403);
      if(!env.MEMBERS||!env.MEMBER_EXECUTION||!env.OWNER_ACCESS_TOKEN)return json({error:"会员服务未部署"},503);
      const b=await smallJson(request),ip=request.headers.get("CF-Connecting-IP")??"unknown";
      const r=await env.MEMBERS.getByName("directory").fetch("https://members/login",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({key:b.key,bucket:await digestMember(`login:${ip}`)})});
      if(!r.ok)return r;
      const m=await r.json<Identity>();const cookie=memberCookie(await issueMemberSession(env.OWNER_ACCESS_TOKEN,m.id,m.version));
      const headers=new Headers({"Cache-Control":"no-store"});headers.append("Set-Cookie",cookie);headers.append("Set-Cookie",clearOwnerSessionCookie());
      return Response.json({configured:true,authenticated:true,role:"member",username:m.label,memberId:m.id,version:MEMBERS_VERSION},{headers});
    }
    // Master requests keep their original route and never depend on the new
    // directory's availability (except the explicit invitations page).
    if(owner)return null;
    if(path==="/api/auth/login")return null;
    const m=await identity(request,env);
    if(path==="/api/auth/session")return m?json({configured:true,authenticated:true,role:"member",username:m.label,memberId:m.id})
      :json({configured:!!env.OWNER_ACCESS_TOKEN,authenticated:false,username:"owner",role:"guest"});
    if(path==="/api/auth/logout"&&request.method==="POST") {
      if(!sameOriginMutation(request))return json({error:"请求来源验证失败"},403);
      const headers=new Headers({"Cache-Control":"no-store"});headers.append("Set-Cookie",clearMemberCookie());headers.append("Set-Cookie",clearOwnerSessionCookie());
      return Response.json({ok:true,authenticated:false},{headers});
    }
    if(!m)return json({error:"请使用主账户或个人登录密钥登录"},401);
    if(!env.MEMBER_EXECUTION)return json({error:"会员执行服务尚未部署"},503);
    if(!rate(m.id))return json({error:"请求过于频繁，请稍后刷新"},429);
    if(path==="/api/forward/equity"&&request.method==="GET")return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/forward-equity${u.search}`);
    const internal=new Headers({"x-verified-member":m.id,"x-member-created-at":String(m.createdAt),"x-member-label":encodeURIComponent(m.label)});
    const actor=env.MEMBER_EXECUTION.getByName(`member:${m.id}`);
    const get=(p:string)=>actor.fetch(`https://member-execution${p}`,{headers:internal});
    if(path==="/api/runtime"&&request.method==="GET")return get("/status");
    if(path==="/api/live/status"&&request.method==="GET")return get("/live-status");
    if(path==="/api/live/history"&&request.method==="GET")return get("/live-history");
    if(path==="/api/live/source"&&request.method==="GET")return get(`/source?id=${encodeURIComponent(u.searchParams.get("id")??"")}`);
    if(path==="/api/live/credentials"&&request.method==="GET")return get("/credential-status");
    if((path==="/api/live/mode"&&request.method==="POST")||(path==="/api/live/credentials"&&["PUT","DELETE"].includes(request.method))) {
      if(!sameOriginMutation(request))return json({error:"请求来源验证失败"},403);
      const b=await smallJson(request);internal.set("Content-Type","application/json");
      const body=path.endsWith("/mode")?{enabled:b.enabled}:request.method==="PUT"?{apiKey:b.apiKey,apiSecret:b.apiSecret,environment:"live"}:{};
      return actor.fetch(`https://member-execution${path.endsWith("/mode")?"/live-mode":"/credentials"}`,{method:request.method,headers:internal,body:JSON.stringify(body)});
    }
    if(path==="/api/forward/export"&&request.method==="GET") {
      const r=await get("/status");if(!r.ok)return r;const s=await r.json<{forward:unknown}>();
      return json({exportedAt:Date.now(),forward:s.forward,scope:"共享模拟策略；不包含主账户或其他会员的实盘数据"});
    }
    if(path==="/api/forward/archive"&&request.method==="GET")return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/forward-archive${u.search}`);
    return json({error:"会员不能修改共享模拟账户、发放密钥或读取其他人的账户"},403);
  }catch {return json({error:"登录或会员服务暂不可用；不会切换为主账户"},503);}
}