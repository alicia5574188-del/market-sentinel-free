/// <reference types="@cloudflare/workers-types" />
import type { MarketStream, CloudflareEnv, LivePosition } from "./index-clean.ts";
import type { MemberFeed } from "./member-directory.ts";
import { MEMBERS_VERSION, digestMember, memberVaultRoot, validMemberId } from "../lib/member-auth.ts";
import { encryptGateCredentials, decryptGateCredentials, gateKeyHint, normalizeGateCredentials, type EncryptedGateCredentials, type GateCredentials } from "../lib/credential-vault.ts";
import { GateLiveClient, gateMarkedEquity, buildLiveStopIntent, liveExitTag } from "../lib/gate-live.ts";
import { LIVE_PARITY_PREFIX, LIVE_PARITY_VERSION, forwardMirrorSources, type MirrorBinding } from "../lib/live-parity.ts";
import { LIVE_TURNOVER_PREFIX, validateTurnover, turnoverView, type TurnoverState, type GateConfirmedFill } from "../lib/live-turnover.ts";
import { LIVE_SESSION_VERSION, type LiveSession } from "../lib/live-session.ts";
import { forwardEquity } from "../lib/forward-relations.ts";
import { gzip, gunzip } from "../lib/storage-codec.ts";
type Identity={id:string;label:string;createdAt:number};
type Credential={encrypted:EncryptedGateCredentials;keyHint:string;user:string;accountHash:string;savedAt:number};
const CHECKPOINT="member-execution:v1:checkpoint",IDENTITY="member-execution:v1:identity",CREDENTIAL="member-execution:v1:credential",
  DELETED="member-execution:v1:deleted";
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{"Cache-Control":"no-store"}});
const errorText=(e:unknown)=>e instanceof Error?e.message:"会员执行暂不可用";

/** The exact verified MarketStream execution methods are inherited, not a
 * second strategy. Primary bootstrap, alarm, D1, credentials and source engine
 * are NEVER entered. Only this member's DO storage and encrypted API are used.
 */
export function memberExecutionClass(Base:typeof MarketStream) {
  return class MemberExecution extends Base {
    private identity:Identity|null=null;
    private credential:Credential|null=null;
    private feed:MemberFeed|null=null;
    private sourceWork:Promise<void>|null=null;
    private memberTick:Promise<void>|null=null;
    private usageAt=0;
    private bootError:string|null=null;
    private deleted=false;
    private deleting=false;
    private deletedId:string|null=null;
    private controlGeneration=0;
    private credentialBusy=false;
    private knownProgramTags=new Set<string>();
    constructor(ctx:DurableObjectState,env:CloudflareEnv) {
      super(ctx,env,true);
      ctx.blockConcurrencyWhile(async()=>{
        try {
          const deleted=await ctx.storage.get<{id:string;at:number}>(DELETED);
          if(deleted){this.deleted=true;this.deletedId=deleted.id;return;}
          this.identity=await ctx.storage.get<Identity>(IDENTITY)??null;
          if(this.identity&&!validMemberId(this.identity.id))throw new Error("会员执行账户损坏，禁止自动重置");
          const saved=await ctx.storage.get<{bytes:Uint8Array;sha:string}>(CHECKPOINT);
          if(saved) {
            if(!(saved.bytes instanceof Uint8Array)||await digestMember([...saved.bytes].join(","))!==saved.sha)throw new Error("会员执行校验失败，保留原状态");
            const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await gunzip(saved.bytes)));
            if(value.version!==MEMBERS_VERSION||!this.identity||value.id!==this.identity.id||!value.live?.positions||!value.live?.entries)throw new Error("会员执行归属不匹配");
            this.runtime.live={...this.runtime.live,...value.live,operational:false};
            this.runtime.utcDay=value.utcDay;this.runtime.nonAlarmWrites=value.nonAlarmWrites;
          }
          const intent=await ctx.storage.get<{enabled:boolean;changedAt:number;activation:LiveSession|null}>(`${LIVE_PARITY_PREFIX}owner-intent`);
          if(intent) {this.runtime.live.requestedEnabled=intent.enabled;this.runtime.live.changedAt=intent.changedAt;this.runtime.live.activation=intent.activation;}
          if(this.runtime.live.requestedEnabled&&this.runtime.live.activation?.version!==LIVE_SESSION_VERSION)throw new Error("会员开启起点缺失，禁止补开旧单");
          this.credential=await ctx.storage.get<Credential>(CREDENTIAL)??null;
          this.runtime.live.credentialConfigured=!!this.credential;
          const ids=new Set([...Object.values(this.runtime.live.entries).flatMap(e=>e?.mirrorSourceId?[e.mirrorSourceId]:[]),
            ...Object.values(this.runtime.live.positions).flatMap(p=>p?.mirrorSourceId?[p.mirrorSourceId]:[])]);
          for(const id of ids) {
            const binding=await ctx.storage.get<MirrorBinding>(`${LIVE_PARITY_PREFIX}binding:${id}`);
            if(!binding||binding.version!==LIVE_PARITY_VERSION||binding.receipt.sourceId!==id)throw new Error("会员复制映射缺失，禁止重放");
            const e=Object.values(this.runtime.live.entries).find(e=>e?.planId===id),p=Object.values(this.runtime.live.positions).find(p=>p?.id===id);
            if(e)e.parity=structuredClone(binding.receipt);if(p)p.parity=structuredClone(binding.receipt);
            const closed=await ctx.storage.get<MirrorBinding["sourceAtClose"]>(`${LIVE_PARITY_PREFIX}source-close:${id}`);
            if(closed?.status==="CLOSED")this.mirrorClosures.set(id,closed);
          }
          const closed=await ctx.storage.list<{position:LivePosition}>({prefix:`${LIVE_PARITY_PREFIX}closed:`,reverse:true,limit:40});
          this.liveHistory=[...closed.values()].map(v=>v.position);
          const key=this.runtime.live.turnoverAccountKey;
          if(key) {const t=await ctx.storage.get<TurnoverState>(`${LIVE_TURNOVER_PREFIX}${key}:summary`);if(t){this.turnoverState=validateTurnover(t);this.turnoverAccountKey=key;}}
        }catch(e){this.bootError=errorText(e);this.forwardError=this.bootError;this.runtime.live.operational=false;}
      });
    }
    // No PAPER or canonical engine is run for a friend.
    protected reconcileCanonicalMirror(now:number) { void now;return false; }
    protected liveDesiredPortfolio(now:number) {
      if(!this.forwardState)throw new Error("共享模拟源尚未读取");
      return forwardMirrorSources(this.forwardState,forwardEquity(this.forwardState,this.regimeQuotes(now),now).equity);
    }
    protected turnoverStartsAt() { return this.identity!.createdAt; }
    protected async turnoverRows(rows:GateConfirmedFill[]) {
      const out:GateConfirmedFill[]=[];
      for(const r of rows) {
        const tag=r.text??"";
        const owned=this.knownProgramTags.has(tag)||(/^t-ms-[esx]-[a-zA-Z0-9_-]{1,80}$/.test(tag)&&await this.ctx.storage.get<boolean>(`member-program-tag:${tag}`));
        if(owned)this.knownProgramTags.add(tag);
        out.push(owned?r:{...r,text:""});
      }
      return out;
    }
    protected async gateLive() {
      if(this.bootError)throw new Error(this.bootError);
      if(this.deleted||this.deleting)throw new Error("会员账户正在删除");
      if(!this.identity||!this.credential||!this.env.OWNER_ACCESS_TOKEN)throw new Error("请先在自己的账户保存Gate API");
      if(!this.liveClient) {
        const root=await memberVaultRoot(this.env.OWNER_ACCESS_TOKEN,this.identity.id);
        const client=new GateLiveClient(await decryptGateCredentials(this.credential.encrypted,root));
        if(this.deleted||this.deleting)throw new Error("会员账户正在删除");
        this.liveClient=client;
      }
      this.runtime.live.credentialConfigured=true;return this.liveClient;
    }
    protected async saveCheckpoint(now:number,force=false) {
      if(this.deleted||this.deleting)throw new Error("会员账户正在删除");
      if(!this.identity||this.bootError)throw new Error(this.bootError??"会员归属未确认");
      this.resetDailyCounters(now);
      if(!force&&now-(this.runtime.lastHeartbeatAt??0)<30000)return;
      const journal=new Map(this.liveJournal),newTags:string[]=[];
      const potential=new Set<string>();
      for(const e of Object.values(this.runtime.live.entries))if(e){potential.add(e.tag);potential.add(liveExitTag(e.planId));potential.add(buildLiveStopIntent({id:e.planId,symbol:e.symbol,side:e.side,currentStop:e.invalidation},this.runtime.tickSize[e.symbol]).tag);if(e.stopTag)potential.add(e.stopTag);}
      for(const p of Object.values(this.runtime.live.positions))if(p){potential.add(liveExitTag(p.id));potential.add(buildLiveStopIntent(p,this.runtime.tickSize[p.symbol]).tag);if(p.stopTag)potential.add(p.stopTag);}
      for(const tag of potential)if(!this.knownProgramTags.has(tag)){
        if(await this.ctx.storage.get<boolean>(`member-program-tag:${tag}`))this.knownProgramTags.add(tag);
        else {journal.set(`member-program-tag:${tag}`,true);newTags.push(tag);}
      }
      const writes=1+journal.size;
      const reservation=this.reserveNonAlarmWrites(writes);
      if(!reservation)throw new Error("会员写入预算不足，保留保护并等待核对");
      try {
        const bytes=await gzip(new TextEncoder().encode(JSON.stringify({version:MEMBERS_VERSION,id:this.identity.id,live:this.runtime.live,
          utcDay:this.runtime.utcDay,nonAlarmWrites:this.runtime.nonAlarmWrites+this.nonAlarmPendingWrites})));
        if(bytes.length>112*1024)throw new Error("会员检查点超过预算，拒绝丢弃已有仓位");
        const sha=await digestMember([...bytes].join(","));
        if(this.deleted||this.deleting)throw new Error("会员账户正在删除");
        await this.ctx.storage.transaction(async tx=>{await tx.put({[CHECKPOINT]:{bytes,sha},...Object.fromEntries(journal)});});
        for(const[k,v]of journal)if(this.liveJournal.get(k)===v)this.liveJournal.delete(k);
        for(const tag of newTags)this.knownProgramTags.add(tag);
        reservation.finish(true);this.runtime.lastHeartbeatAt=now;
      } finally {reservation.finish(false);}
    }
    private async directory(path:string,body?:unknown) {
      if(!this.env.MEMBERS||!this.identity)throw new Error("会员服务尚未就绪");
      const res=await this.env.MEMBERS.getByName("directory").fetch(`https://members${path}${path.includes("?")?"&":"?"}id=${this.identity.id}`,
        body===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const value=await res.json<Record<string,unknown>>();if(!res.ok)throw new Error(String(value.error??"会员服务等待恢复"));return value;
    }
    private async refreshSource(viewOnly=false) {
      if(this.sourceWork)return this.sourceWork;
      this.sourceWork=(async()=>{
        try {
          const f=await this.directory(viewOnly?"/feed?view=1":"/feed") as unknown as MemberFeed;
          if(f.version!==MEMBERS_VERSION||!f.state||Date.now()-f.at>(viewOnly?10000:8000))throw new Error("共享源快照过期");
          if(this.feed&&f.at<this.feed.at)return;
          this.feed=f;this.forwardState=f.state;this.runtime.evidence=f.evidence as typeof this.runtime.evidence;
          this.runtime.contractMeta=f.metadata as typeof this.runtime.contractMeta;this.runtime.tickSize=f.ticks;
          this.runtime.lastSuccessAt=f.sourceStatus.lastSuccessAt;this.runtime.state=f.sourceStatus.state as typeof this.runtime.state;
          this.forwardError=f.healthy?null:f.error??"主策略行情尚待恢复；会员停止新增风险";
          if(this.credential?.accountHash===f.ownerAccountHash)this.forwardError="此Gate账户已与主账户冲突，停止新增复制并保留原保护";
          const existing=new Set([...this.activeLivePositions().map(p=>p.id),...this.activeLiveEntries().map(e=>e.planId)]);
          for(const id of existing) {
            let close=f.state.history.find(t=>t.id===id&&t.status==="CLOSED");
            if(!close&&!f.state.positions.some(t=>t.id===id)&&!this.mirrorClosures.has(id)) {
              const binding=await this.ctx.storage.get<MirrorBinding>(`${LIVE_PARITY_PREFIX}binding:${id}`);
              if(binding)close=(await this.directory("/source-close",{id,openedAt:binding.sourceAtCopy.openedAt})).trade as typeof close;
            }
            if(close&&!this.mirrorClosures.has(id)) {
              const reservation=this.reserveNonAlarmWrites(1);
              if(!reservation)throw new Error("会员源单退出保存预算不足，保留保护并等待核对");
              try {await this.ctx.storage.put(`${LIVE_PARITY_PREFIX}source-close:${id}`,close);reservation.finish(true);}
              finally {reservation.finish(false);}
              this.mirrorClosures.set(id,structuredClone(close));
            }
          }
        }catch(e){this.forwardError=errorText(e);throw e;}
      })();
      try{await this.sourceWork;}finally{this.sourceWork=null;}
    }
    private async arm() {
      if(!this.identity||this.bootError||this.deleted||this.deleting)return;
      const trading=this.liveNeedsSync(),settlement=this.liveSettlementNeedsRefresh();
      if(trading||settlement) {
        const cadence=trading?10000:60000,jitter=parseInt(this.identity.id.slice(-2),16)%4*100;
        const at=(Math.floor(Date.now()/cadence)+1)*cadence+jitter;
        const old=await this.ctx.storage.getAlarm();if(old==null||old<Date.now()-cadence||old>at+cadence)await this.ctx.storage.setAlarm(at);
      }
    }
    async alarm() {
      if(this.deleted||this.deleting)return;
      // Trading stays on the existing ten-second cadence. Settlement-only
      // actors wake once per minute and never compete with active execution.
      const cadence=this.liveNeedsSync()?10000:60000;
      await this.ctx.storage.setAlarm((Math.floor(Date.now()/cadence)+1)*cadence+100);
      try {await this.tick();}finally {
        if(!this.bootError&&!this.liveNeedsSync()&&!this.liveSettlementNeedsRefresh()) {await this.ctx.storage.deleteAlarm();if(this.identity)await this.directory("/seat",{enabled:false}).catch(()=>undefined);}
      }
    }
    private async tick() {
      if(this.memberTick)return this.memberTick;
      this.memberTick=(async()=>{
        if(this.bootError||!this.identity||this.deleted||this.deleting)return;
        this.resetDailyCounters(Date.now());
        await this.refreshSource().catch(()=>undefined);
        try {if(this.liveNeedsSync())await this.syncLive(Date.now());}
        catch(e){this.runtime.live.operational=false;this.runtime.live.lastError=errorText(e);}
        this.launchLiveSettlementBackground();
        await this.saveCheckpoint(Date.now(),false).catch(e=>{this.runtime.live.lastError=errorText(e);this.runtime.live.operational=false;});
        this.launchTurnoverWork(Date.now());
        if(Date.now()-this.usageAt>=60000) {
          this.usageAt=Date.now();const t=turnoverView(this.turnoverState,this.turnoverError,Date.now());
          this.ctx.waitUntil(this.directory("/usage",{notional:t.systemTagged,fills:t.fillCount,through:t.checkedThrough,
            reportedAt:this.usageAt,partial:t.catchingUp,error:!!t.error}).catch(()=>undefined));
        }
      })();
      try{await this.memberTick;}finally{this.memberTick=null;}
    }
    private credentialView() {return this.credential?{configured:true,environment:"live",keyHint:this.credential.keyHint,status:"verified",lastVerifiedAt:this.credential.savedAt,lastError:null}
      :{configured:false,environment:null,keyHint:null,status:"missing",lastVerifiedAt:null,lastError:null};}
    private async saveCredential(raw:GateCredentials) {
      if(this.runtime.live.requestedEnabled||this.liveNeedsSync())throw new Error("请关闭本账户实盘，已有仓位与未决订单处理完成后再更换API");
      const c=normalizeGateCredentials(raw);if(c.environment!=="live")throw new Error("只接受Gate实盘API");
      const client=new GateLiveClient(c),snapshot=await client.snapshot(),equity=gateMarkedEquity(snapshot),available=Number(snapshot.account.available);
      if(!Number.isFinite(equity)||equity<0||!Number.isFinite(available)||available<0||snapshot.account.user==null)throw new Error("Gate账户身份或权益不可用");
      if(snapshot.account.in_dual_mode||["dual","dual_plus"].includes(String(snapshot.account.position_mode??"").toLowerCase()))throw new Error("请使用独立的单向持仓Gate账户");
      if(snapshot.positions.some(p=>Number(p.size??0)!==0)||snapshot.orders.length||snapshot.priceOrders.length)throw new Error("Gate仍有未纳管仓位或挂单；不接管其他账户的交易");
      const user=String(snapshot.account.user),accountHash=await digestMember(`gate-user:${user}`);
      await this.directory("/claim-account",{accountHash});
      const root=await memberVaultRoot(this.env.OWNER_ACCESS_TOKEN!,this.identity!.id),now=Date.now();
      const saved:Credential={encrypted:await encryptGateCredentials(c,root),keyHint:gateKeyHint(c.apiKey),user,accountHash,savedAt:now};
      if(this.runtime.live.requestedEnabled||this.liveNeedsSync())throw new Error("验证期间账户状态变化，API未替换");
      await this.ctx.storage.put(CREDENTIAL,saved);this.credential=saved;this.liveClient=client;
      this.turnoverAccountUser=user;this.turnoverState=null;this.turnoverAccountKey=null;this.turnoverError=null;delete this.runtime.live.turnoverAccountKey;
      Object.assign(this.runtime.live,{credentialConfigured:true,equity,available,lastSyncAt:now,lastError:null});await this.saveCheckpoint(now,true);
      return {ok:true,credential:this.credentialView(),verification:{equity,available,positions:0,orders:0,conditionalOrders:0,checkedAt:now}};
    }
    private async liveView() {return {...this.runtime.live,history:this.liveHistory,mirror:this.liveMirrorView(),turnover:turnoverView(this.turnoverState,this.turnoverError,Date.now())};}
    private adminState() {
      const openPositions=this.activeLivePositions().length,pendingEntries=this.activeLiveEntries().length;
      return {followStopped:!this.runtime.live.requestedEnabled,openPositions,pendingEntries,
        draining:openPositions>0||pendingEntries>0,credentialConfigured:!!this.credential};
    }
    private async adminStopFollowing() {
      this.controlGeneration++;
      if(!this.identity)return {ok:true,cleanupConfirmed:true,...this.adminState()};
      const result=await this.setLiveMode(false);
      await this.arm();
      if(!this.liveNeedsSync())await this.directory("/seat",{enabled:false}).catch(()=>undefined);
      return {ok:result.ok,cleanupConfirmed:result.ok,error:result.ok?null:result.error,...this.adminState()};
    }
    private async adminDeleteReady() {
      if(this.memberTick)await this.memberTick.catch(()=>undefined);
      if(this.liveSyncWork)await this.liveSyncWork.catch(()=>undefined);
      if(this.runtime.live.requestedEnabled)return {ok:false,error:"请先强制停止实盘跟随；停止后已有持仓会继续按原保护正常退出",...this.adminState()};
      const state=this.adminState();
      if(state.openPositions||state.pendingEntries)return {ok:false,
        error:`仍有${state.openPositions}个实盘持仓、${state.pendingEntries}个未决入场；账户不会被删除，等待它们正常退出后再试`,...state};
      if(this.credentialBusy)return {ok:false,error:"Gate API正在验证或修改，请稍后再删除",...state};
      if(this.credential) {
        const snapshot=await(await this.gateLive()).snapshot();
        const positions=snapshot.positions.filter(p=>Number(p.size??0)!==0).length;
        const orders=snapshot.orders.length+snapshot.priceOrders.length;
        if(positions||orders)return {ok:false,error:`Gate账户仍有${positions}个持仓、${orders}个挂单；为避免遗留风险，暂不删除账户`,...state};
      }
      return {ok:true,...state};
    }
    private async adminDeleteFinalize(id:string) {
      if(this.credentialBusy||this.deleting)return {ok:false,error:"账户修改或删除正在进行，请稍后重试",...this.adminState()};
      this.deleting=true;this.controlGeneration++;
      try {
      if(this.memberTick)await this.memberTick.catch(()=>undefined);
      if(this.liveSyncWork)await this.liveSyncWork.catch(()=>undefined);
      if(this.sourceWork)await this.sourceWork.catch(()=>undefined);
      const state=this.adminState();
      if(this.runtime.live.requestedEnabled||state.openPositions||state.pendingEntries)
        return {ok:false,error:"删除前状态再次变化；账户已停止新增跟随，但必须等现有风险全部退出后再完成删除",...state};
      // Invalidate the settlement reader before it can schedule more writes;
      // await turnover already in flight before atomically erasing its ledger.
      this.liveClient=null;
      if(this.turnoverWork)await this.turnoverWork.catch(()=>undefined);
      const deletedId=this.identity?.id??id;
      // Keep erasure and the permanent tombstone atomic. A failed write or
      // restart must never leave an empty executor that can initialize again.
      await this.ctx.storage.transaction(async tx=>{
        for(;;) {
          const rows=await tx.list({prefix:"",limit:128}),keys=[...rows.keys()].filter(key=>key!==DELETED);
          if(!keys.length)break;
          await tx.delete(keys);
        }
        await tx.put(DELETED,{id:deletedId,at:Date.now()});
        await tx.deleteAlarm();
      });
      this.deleted=true;this.deletedId=deletedId;this.identity=null;this.credential=null;this.feed=null;this.forwardState=null;this.liveClient=null;
      this.liveHistory=[];this.liveJournal.clear();this.mirrorClosures.clear();this.knownProgramTags.clear();
      this.turnoverState=null;this.turnoverError=null;this.turnoverAccountKey=null;this.turnoverAccountUser=null;
      Object.assign(this.runtime.live,{requestedEnabled:false,operational:false,activation:null,credentialConfigured:false,
        entries:{},positions:{},entrySkips:{},equity:null,available:null,lastSyncAt:null,lastError:null,auditEvents:[]});
      return {ok:true};
      }finally{this.deleting=false;}
    }
    async fetch(request:Request) {
      const url=new URL(request.url),path=url.pathname;
      try {
        if(this.bootError)return json({error:this.bootError},503);
        if(path==="/source-wake"&&request.method==="POST") {
          if(!this.env.OWNER_ACCESS_TOKEN||request.headers.get("x-member-wake-token")!==this.env.OWNER_ACCESS_TOKEN)
            return json({error:"内部唤醒未授权"},403);
          if(this.deleted||this.deleting||!this.identity||!this.liveNeedsSync())return json({ok:true,woken:false});
          await this.tick();await this.arm();return json({ok:true,woken:true,at:Date.now()});
        }
        const id=request.headers.get("x-verified-member"),createdAt=Number(request.headers.get("x-member-created-at"));
        const admin=request.headers.get("x-member-admin")==="owner";
        if(this.deleted) {
          // An interrupted two-stage deletion may have erased the executor
          // before the directory committed. Only its owner-admin retry can
          // acknowledge the tombstone; member access stays permanently denied.
          if(admin&&request.method==="POST"&&validMemberId(id)&&(id===this.deletedId||this.deletedId==="deleted")
            &&["/admin-stop","/admin-delete-ready","/admin-delete-finalize"].includes(path))
            return json({ok:true,deleted:true,cleanupConfirmed:true,...this.adminState()});
          return json({error:"会员账户已删除"},410);
        }
        if(this.deleting)return json({error:"会员账户正在删除，请稍后重试"},409);
        if(admin&&["/admin-stop","/admin-delete-ready","/admin-delete-finalize"].includes(path)) {
          if(!validMemberId(id))return json({error:"会员身份未确认"},401);
          if(this.identity&&this.identity.id!==id)return json({error:"账户归属不匹配"},403);
          if(path==="/admin-stop"&&request.method==="POST") {
            const result=await this.adminStopFollowing();
            return json(result,result.ok?200:409);
          }
          if(path==="/admin-delete-ready"&&request.method==="POST") {
            const result=await this.adminDeleteReady();
            return json(result,result.ok?200:409);
          }
          if(path==="/admin-delete-finalize"&&request.method==="POST") {
            const result=await this.adminDeleteFinalize(id);
            return json(result,result.ok?200:409);
          }
          return json({error:"不支持此管理操作"},405);
        }
        if(!validMemberId(id))return json({error:"会员身份未确认"},401);
        if(this.identity&&this.identity.id!==id)return json({error:"账户归属不匹配"},403);
        if(!this.identity) {
          if(!(createdAt>0&&createdAt<=Date.now()))return json({error:"账户记录无效"},400);
          this.identity={id,createdAt,label:decodeURIComponent(request.headers.get("x-member-label")??id)};
          await this.ctx.storage.put(IDENTITY,this.identity);
        }
        if(path==="/status"&&request.method==="GET") {
          await this.refreshSource(true).catch(()=>undefined);await this.arm();
          const live=await this.liveView(),f=this.feed;
          return json({version:MEMBERS_VERSION,generatedAt:Date.now(),lastSuccessAt:f?.sourceStatus.lastSuccessAt??null,
            state:f?.sourceStatus.state??"RECOVERY_REQUIRED",stale:!!this.forwardError,lastError:this.forwardError,
            authorityReady:!!f?.healthy,forward:f?.view?{...f.view,liveMirror:this.liveMirrorView()}:null,
            evidence:this.runtime.evidence,liveMode:{requestedEnabled:live.requestedEnabled,operational:live.operational},live,
            liveMirror:this.liveMirrorView(),member:{id,label:this.identity.label,sharedSource:true},legacyRetired:true});
        }
        if(path==="/live-status")return json({live:await this.liveView(),generatedAt:Date.now()});
        if(path==="/live-history"&&request.method==="GET")return json(await this.privateLiveHistory());
        if(path==="/credential-status")return json({credential:this.credentialView()});
        if(path==="/credentials"&&request.method==="PUT") {
          if(this.credentialBusy)throw new Error("API验证正在进行，请勿重复提交");
          this.controlGeneration++;
          this.credentialBusy=true;
          try{return json(await this.saveCredential(await request.json<GateCredentials>()));}finally{this.credentialBusy=false;}
        }
        if(path==="/credentials"&&request.method==="DELETE") {
          if(this.credentialBusy)throw new Error("API验证正在进行，请勿重复提交");
          this.controlGeneration++;
          this.credentialBusy=true;
          try {
          if(this.runtime.live.requestedEnabled||this.liveNeedsSync())throw new Error("存在开启状态、持仓或未决委托，不能删除API");
          if(this.credential) {const s=await(await this.gateLive()).snapshot();if(s.positions.some(p=>Number(p.size??0)!==0)||s.orders.length||s.priceOrders.length)throw new Error("Gate仍有仓位或挂单，不能删除API");}
          await this.ctx.storage.delete(CREDENTIAL);this.credential=null;this.liveClient=null;this.runtime.live.credentialConfigured=false;
          if(this.runtime.live.requestedEnabled||this.liveNeedsSync())throw new Error("删除期间账户状态变化");
          await this.saveCheckpoint(Date.now(),true);return json({ok:true,credential:this.credentialView()});
          }finally{this.credentialBusy=false;}
        }
        if(path==="/live-mode"&&request.method==="POST") {
          const generation=this.controlGeneration;
          const b=await request.json<{enabled?:unknown}>();if(typeof b.enabled!=="boolean")return json({error:"实盘开关无效"},400);
          if(this.deleted||this.deleting||generation!==this.controlGeneration)throw new Error("账户状态已变化，请重新确认实盘开关");
          if(!b.enabled)this.controlGeneration++;
          if(b.enabled) {
            if(this.credentialBusy)throw new Error("API验证期间不能开启实盘");
            await this.refreshSource();if(this.forwardError)throw new Error(this.forwardError);
            if(!this.credential)throw new Error("请先保存本人的Gate API");
            await this.directory("/seat",{enabled:true});
            if(this.deleted||this.deleting||generation!==this.controlGeneration||this.credentialBusy||!this.credential) {
              if(!this.liveNeedsSync()&&this.identity)await this.directory("/seat",{enabled:false}).catch(()=>undefined);
              throw new Error("开启期间账户权限或API状态已变化，请重新确认");
            }
          }
          const result=await this.setLiveMode(b.enabled);await this.arm();
          if(!this.liveNeedsSync())await this.directory("/seat",{enabled:false});
          return json(result,result.ok?200:409);
        }
        if(path==="/source") {
          const source=url.searchParams.get("id")??"";
          if(!/^ft-[a-zA-Z0-9_-]{1,100}$/.test(source))return json({error:"源单ID无效"},400);
          const binding=await this.ctx.storage.get<MirrorBinding>(`${LIVE_PARITY_PREFIX}binding:${source}`);
          return binding?json(binding):json({error:"本账户没有这笔复制映射"},404);
        }
        return json({error:"会员不能操作共享策略或其他账户"},403);
      }catch(e){return json({error:errorText(e)},409);}
    }
  };
}
