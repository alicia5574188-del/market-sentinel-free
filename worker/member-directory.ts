/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { MEMBERS_VERSION, MEMBER_LIMIT, MEMBER_ACTIVE_LIMIT, digestMember, randomHex, validMemberId, equalSecret, parseLoginKey, encryptMemberText, decryptMemberText } from "../lib/member-auth.ts";
import type { CloudflareEnv } from "./index-clean.ts";
import type { ForwardState, Trade, forwardSummary } from "../lib/forward-relations.ts";
export type MemberUsage={notional:number|null;fills:number;through:number|null;reportedAt:number;partial:boolean;error:boolean};
export type MemberRecord={id:string;label:string;createdAt:number;activatedAt:number|null;lastLoginAt:number|null;keyHash:string;keyVersion:number;usage:MemberUsage|null;revokedAt?:number|null};
export type MemberFeed={version:string;at:number;healthy:boolean;error:string|null;state:ForwardState|null;
  view:ReturnType<typeof forwardSummary>|null;metadata:Record<string,unknown>;ticks:Record<string,number>;evidence:Record<string,unknown>;
  ownerAccountHash:string|null;sourceStatus:{state:string;lastSuccessAt:number|null;stale:boolean};};
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{"Cache-Control":"no-store"}});
const publicRecord=(m:MemberRecord)=>({id:m.id,label:m.label,createdAt:m.createdAt,activatedAt:m.activatedAt,lastLoginAt:m.lastLoginAt,usage:m.usage,revokedAt:m.revokedAt??null});

/** Separate namespace: registration/aggregation has no primary trade authority.
 * /feed is one bounded shared read, independent of the number of friends.
 * No alarm runs here and no primary write is possible from this class.
 */
export class MemberDirectory extends DurableObject<CloudflareEnv> {
  private feedCache:MemberFeed|null=null;
  private feedWork:Promise<MemberFeed>|null=null;
  private feedAttempt=0;
  private failures=new Map<string,{n:number;reset:number}>();
  private async readMember(id:string) { return this.ctx.storage.get<MemberRecord>(`member:${id}`); }
  private async feed(viewOnly=false) {
    const now=Date.now();
    if(this.feedCache&&now-this.feedCache.at<(viewOnly?10000:2500))return this.feedCache;
    if(this.feedWork)return this.feedWork;
    if(now-this.feedAttempt<2000)throw new Error("共享行情读取等待重试");
    this.feedAttempt=now;
    this.feedWork=(async()=>{
      const r=await this.env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/member-feed",{signal:AbortSignal.timeout(4000)});
      if(!r.ok)throw new Error("共享策略源暂不可用，主交易循环不会等待会员");
      const f=await r.json<MemberFeed>();
      if(f.version!==MEMBERS_VERSION||!Number.isFinite(f.at)||f.at>Date.now()+1000||Date.now()-f.at>8000)throw new Error("共享信号快照无效");
      this.feedCache=f;return f;
    })();
    try{return await this.feedWork;}finally{this.feedWork=null;}
  }
  async fetch(request:Request) {
    const url=new URL(request.url),p=url.pathname,now=Date.now(),root=this.env.OWNER_ACCESS_TOKEN;
    if(!root||root.length<16)return json({error:"登录密钥服务未配置"},503);
    try {
      if(p==="/health")return json({version:MEMBERS_VERSION,configured:true,memberLimit:MEMBER_LIMIT,activeLimit:MEMBER_ACTIVE_LIMIT});
      if(p==="/issue"&&request.method==="POST") {
        const b=await request.json<{label?:unknown;requestId?:unknown}>();
        if(typeof b.requestId!=="string"||!/^[-a-zA-Z0-9_]{16,80}$/.test(b.requestId))return json({error:"请求标识无效"},400);
        const label=typeof b.label==="string"?b.label.trim().slice(0,60):"";
        const key=`MS-${randomHex(32)}`,id=`m_${randomHex(16)}`,keyHash=await digestMember(key);
        const sealed=await encryptMemberText(key,root,`current-key:${id}`);
        const result=await this.ctx.storage.transaction(async tx=>{
          const issueKey=`issue:${b.requestId}`,prior=await tx.get<string>(issueKey);
          if(prior) {
            const existing=await tx.get<MemberRecord>(`member:${prior}`);
            if(existing)return {id:prior,repeated:true};
            await tx.delete(issueKey);
          }
          const total=(await tx.get<number>("member-count"))??0;
          if(total>=MEMBER_LIMIT)throw new Error(`首批登录账户容量${MEMBER_LIMIT}位已满；不会影响已有用户，请先评估资源后扩容`);
          const row:MemberRecord={id,label:label||`朋友${String(total+1).padStart(2,"0")}`,createdAt:now,activatedAt:null,lastLoginAt:null,keyHash,keyVersion:1,usage:null,revokedAt:null};
          await tx.put({[`member:${id}`]:row,[`key:${keyHash}`]:id,[`issue:${b.requestId}`]:id,"member-count":total+1,"current-key":{id,sealed}});
          return {id,repeated:false};
        });
        const current=await this.ctx.storage.get<{id:string;sealed:Awaited<ReturnType<typeof encryptMemberText>>}>("current-key");
        const display=current?.id===result.id?await decryptMemberText(current.sealed,root,`current-key:${current.id}`):null;
        return json({ok:true,...result,loginKey:display,oldKeysRemainValid:true,member:publicRecord((await this.readMember(result.id))!)});
      }
      if(p==="/overview") {
        const rows=await this.ctx.storage.list<MemberRecord>({prefix:"member:",limit:MEMBER_LIMIT});
        const current=await this.ctx.storage.get<{id:string;sealed:Awaited<ReturnType<typeof encryptMemberText>>}>("current-key");
        return json({version:MEMBERS_VERSION,members:[...rows.values()].map(publicRecord).sort((a,b)=>b.createdAt-a.createdAt),
          current:current?{id:current.id,loginKey:await decryptMemberText(current.sealed,root,`current-key:${current.id}`)}:null,
          memberLimit:MEMBER_LIMIT,activeLimit:MEMBER_ACTIVE_LIMIT,activeCount:(await this.ctx.storage.get<string[]>("execution-seats"))?.length??0});
      }
      if(p==="/admin-identity") {
        const id=url.searchParams.get("id");if(!validMemberId(id))return json({error:"账户无效"},400);
        const m=await this.readMember(id);return m?json({id:m.id,version:m.keyVersion,label:m.label,createdAt:m.createdAt,revokedAt:m.revokedAt??null}):json({error:"账户不存在"},404);
      }
      if(p==="/begin-delete"&&request.method==="POST") {
        const id=url.searchParams.get("id");if(!validMemberId(id))return json({error:"账户无效"},400);
        const value=await this.ctx.storage.transaction(async tx=>{
          const row=await tx.get<MemberRecord>(`member:${id}`);if(!row)throw new Error("账户不存在");
          if(row.revokedAt)return {id,revokedAt:row.revokedAt,repeated:true};
          const current=await tx.get<{id:string}>("current-key");
          await tx.put(`member:${id}`,{...row,keyVersion:row.keyVersion+1,revokedAt:now});
          await tx.delete(`key:${row.keyHash}`);
          if(current?.id===id)await tx.delete("current-key");
          return {id,revokedAt:now,repeated:false};
        });
        return json({ok:true,...value});
      }
      if(p==="/finalize-delete"&&request.method==="POST") {
        const id=url.searchParams.get("id");if(!validMemberId(id))return json({error:"账户无效"},400);
        const claims=await this.ctx.storage.list<string>({prefix:"gate:"}),issues=await this.ctx.storage.list<string>({prefix:"issue:"});
        const claimKeys=[...claims].filter(([,owner])=>owner===id).map(([key])=>key);
        const issueKeys=[...issues].filter(([,owner])=>owner===id).map(([key])=>key);
        await this.ctx.storage.transaction(async tx=>{
          const row=await tx.get<MemberRecord>(`member:${id}`);if(!row)throw new Error("账户不存在");
          if(!row.revokedAt)throw new Error("账户尚未进入安全删除状态");
          const current=await tx.get<{id:string}>("current-key"),seats=await tx.get<string[]>("execution-seats")??[];
          const total=(await tx.get<number>("member-count"))??0;
          const keys=[`member:${id}`,`key:${row.keyHash}`,...claimKeys,...issueKeys];
          if(current?.id===id)keys.push("current-key");
          await tx.delete(keys);
          const nextSeats=seats.filter(v=>v!==id);if(nextSeats.length!==seats.length)await tx.put("execution-seats",nextSeats);
          await tx.put("member-count",Math.max(0,total-1));
        });
        return json({ok:true,id,deleted:true});
      }
      if(p==="/login"&&request.method==="POST") {
        const b=await request.json<{key?:unknown;bucket?:string}>(),bucket=b.bucket??"unknown";
        if(!/^[a-f0-9]{64}$/.test(bucket))return json({error:"请求无效"},400);
        const rate=this.failures.get(bucket);if(rate&&rate.reset>now&&rate.n>=20)return json({error:"尝试过于频繁，请稍后再试"},429);
        const key=parseLoginKey(b.key),hash=await digestMember(key??"invalid");
        const id=key?await this.ctx.storage.get<string>(`key:${hash}`):null,m=id?await this.readMember(id):null;
        if(!m||m.revokedAt||!equalSecret(hash,m.keyHash)) {
          this.failures.set(bucket,{n:rate&&rate.reset>now?rate.n+1:1,reset:rate?.reset&&rate.reset>now?rate.reset:now+15*60000});
          if(this.failures.size>500)this.failures.delete(this.failures.keys().next().value!);
          return json({error:"登录密钥无效"},401);
        }
        this.failures.delete(bucket);
        await this.ctx.storage.transaction(async tx=>{
          const saved=await tx.get<MemberRecord>(`member:${m.id}`);if(!saved||saved.keyVersion!==m.keyVersion)throw new Error("登录资格发生变化");
          if(!saved.activatedAt||now-(saved.lastLoginAt??0)>60000)await tx.put(`member:${m.id}`,{...saved,activatedAt:saved.activatedAt??now,lastLoginAt:now});
        });
        return json({id:m.id,version:m.keyVersion,label:m.label,createdAt:m.createdAt});
      }
      const id=url.searchParams.get("id");if(!validMemberId(id))return json({error:"账户无效"},400);
      const m=await this.readMember(id);if(!m)return json({error:"账户不存在"},401);
      if(p==="/identity")return m.revokedAt?json({error:"账户已删除或正在删除"},401):json({id:m.id,version:m.keyVersion,label:m.label,createdAt:m.createdAt});
      if(p==="/feed")return json(await this.feed(url.searchParams.get("view")==="1"));
      if(p==="/source-close"&&request.method==="POST") {
        // Every lookup is bounded and only uses already-closed primary records.
        // Members can never submit a replacement source or change a close.
        const b=await request.json<{id:string;openedAt:number}>();
        if(!/^ft-[a-zA-Z0-9_-]{1,100}$/.test(b.id)||!Number.isFinite(b.openedAt)||b.openedAt<1||b.openedAt>now)return json({error:"源单标识无效"},400);
        const cached=await this.ctx.storage.get<Trade>(`close:${b.id}`);if(cached)return json({trade:cached});
        const cursor=await this.ctx.storage.get<string>(`lookup:${b.id}`);
        const res=await this.env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/member-closed?id=${encodeURIComponent(b.id)}&openedAt=${b.openedAt}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
        const value=await res.json<{trade:Trade|null;nextCursor?:string|null}>();
        if(value.trade?.id===b.id&&value.trade.status==="CLOSED")await this.ctx.storage.put(`close:${b.id}`,value.trade);
        else if(value.nextCursor)await this.ctx.storage.put(`lookup:${b.id}`,value.nextCursor);
        return json(value,res.status);
      }
      if(p==="/seat"&&request.method==="POST") {
        const b=await request.json<{enabled:boolean}>();
        if(typeof b.enabled!=="boolean")return json({error:"参数无效"},400);
        if(m.revokedAt&&b.enabled)return json({error:"账户正在删除，不能重新开启实盘席位"},409);
        await this.ctx.storage.transaction(async tx=>{
          const seats=await tx.get<string[]>("execution-seats")??[];
          if(b.enabled&&!seats.includes(id)&&seats.length>=MEMBER_ACTIVE_LIMIT)throw new Error(`会员实盘安全容量为${MEMBER_ACTIVE_LIMIT}个并行账户，已有账户和主账户不受影响`);
          const next=b.enabled?[...new Set([...seats,id])]:seats.filter(v=>v!==id);
          if(JSON.stringify(next)!==JSON.stringify(seats))await tx.put("execution-seats",next);
        });return json({ok:true});
      }
      if(p==="/claim-account"&&request.method==="POST") {
        const b=await request.json<{accountHash:string}>();if(!/^[a-f0-9]{64}$/.test(b.accountHash))return json({error:"账户标识无效"},400);
        if(m.revokedAt)return json({error:"账户正在删除，不能绑定新的Gate账户"},409);
        const feed=await this.feed();
        if(!feed.ownerAccountHash)throw new Error("主账户身份尚未完成隔离核对，请稍后保存API");
        if(b.accountHash===feed.ownerAccountHash)throw new Error("不能将主账户的Gate账户绑定给会员");
        await this.ctx.storage.transaction(async tx=>{
          const claimed=await tx.get<string>(`gate:${b.accountHash}`);
          if(claimed&&claimed!==id)throw new Error("同一个Gate账户不能由多个会员重复管理，请使用独立账户");
          await tx.put(`gate:${b.accountHash}`,id);
        });return json({ok:true});
      }
      if(p==="/usage"&&request.method==="POST") {
        const b=await request.json<MemberUsage>();
        if(b.notional!==null&&(!Number.isFinite(b.notional)||b.notional<0))return json({error:"成交额无效"},400);
        if(!Number.isSafeInteger(b.fills)||b.fills<0||!Number.isFinite(b.reportedAt)||b.reportedAt<=0||b.reportedAt>now+1000
          ||(b.through!==null&&(!Number.isFinite(b.through)||b.through<=0||b.through>now+1000))||typeof b.partial!=="boolean"||typeof b.error!=="boolean")return json({error:"统计参数无效"},400);
        await this.ctx.storage.transaction(async tx=>{
          const row=await tx.get<MemberRecord>(`member:${id}`);if(row&&b.reportedAt>(row.usage?.reportedAt??0))await tx.put(`member:${id}`,{...row,usage:{notional:b.notional,fills:b.fills,through:b.through,reportedAt:b.reportedAt,partial:b.partial,error:b.error}});
        });return json({ok:true});
      }
      return json({error:"操作不可用"},404);
    }catch(error){return json({error:error instanceof Error?error.message:"会员服务暂不可用"},409);}
  }
}