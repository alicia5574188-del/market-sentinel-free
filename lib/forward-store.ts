import { FORWARD_VERSION, normalizeForward, type ForwardState } from "./forward-relations.ts";
import { gzip, gunzip, MAX_STATE_BYTES } from "./storage-codec.ts";
import { buildForwardProtectionCheckpoint, restoreForwardProtectionCheckpoint } from "./forward-protection-checkpoint.ts";

export const FORWARD_STORAGE = "forward-relations:v1:";
export const FORWARD_PROTECTION_STORAGE = `${FORWARD_STORAGE}protection`;
// Keep 16 KiB below the Durable Object single-value ceiling for typed-array
// serialization and metadata. No base64 conversion or state-field omission.
export const FORWARD_COMPACT_BYTES = 112*1024;
type Head = { version: string; count: number; length: number; sha256: string; encoding?: "gzip"; rawLength?: number;
  inline?: Uint8Array };
type Reader = { get<T>(key: string): Promise<T | undefined> };
export type Store = Reader & { put(entries: Record<string, unknown>): Promise<void>; delete(keys: string[]): Promise<number> };
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map(v=>v.toString(16).padStart(2,"0")).join("");

export async function readForwardStore(storage: Reader, now: number) {
  const head=await storage.get<Head>(`${FORWARD_STORAGE}head`);
  if(!head)return normalizeForward(null,now);
  if(head.version!==FORWARD_VERSION||!Number.isSafeInteger(head.count)||head.count<0||head.count>32
    ||!Number.isSafeInteger(head.length)||head.length<1||head.length>MAX_STATE_BYTES
    ||(head.encoding!==undefined&&head.encoding!=="gzip")
    ||(head.inline!==undefined?!(head.inline instanceof Uint8Array)||head.inline.byteLength<1
      ||head.inline.byteLength>FORWARD_COMPACT_BYTES:head.count<1))throw new Error("前向存储头异常，拒绝重置账户");
  // Legacy count includes every external chunk. Compact count includes only
  // the chunks AFTER the authenticated inline first segment, starting at 0.
  const external=await Promise.all(Array.from({length:head.count},(_,i)=>storage.get<Uint8Array>(`${FORWARD_STORAGE}chunk:${i}`)));
  const chunks=head.inline?[head.inline,...external]:external;
  const bytes=new Uint8Array(head.length);let offset=0;
  for(const chunk of chunks){if(!chunk||offset+chunk.byteLength>bytes.length)throw new Error("前向存储分片缺失");bytes.set(chunk,offset);offset+=chunk.byteLength;}
  if(offset!==bytes.length||await digest(bytes)!==head.sha256)throw new Error("前向存储校验失败，原账户不会被覆盖");
  const raw=head.encoding==="gzip"?await gunzip(bytes):bytes;
  if(head.encoding==="gzip"&&raw.length!==head.rawLength)throw new Error("前向解压长度校验失败");
  const state=normalizeForward(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)) as ForwardState,now);
  // An overlay belongs to exactly one durable full-account generation. Old
  // overlays need no delete/write on each full commit and cannot resurrect a
  // reset account, a closed position or a previous financial revision.
  return restoreForwardProtectionCheckpoint(state,await storage.get<unknown>(FORWARD_PROTECTION_STORAGE));
}

/** At most ONE bounded KV record, never another full-state/archive packet.
 * The caller must await its commit before publishing the observed protection.
 */
export function prepareForwardProtectionWrite(next:ForwardState){
  if(!Number.isFinite(next.storage.persistedAt)||next.storage.persistedAt<=0)
    throw new Error("前向整包账户尚未持久化，拒绝保存孤立保护检查点");
  const checkpoint=buildForwardProtectionCheckpoint(next);
  if(new TextEncoder().encode(JSON.stringify(checkpoint)).length>120*1024)
    throw new Error("前向保护检查点超过单值预算；保留原账户，不截断保护状态");
  return {entries:{[FORWARD_PROTECTION_STORAGE]:checkpoint},writes:1};
}

export async function prepareForwardWrite(previous:ForwardState|null,next:ForwardState,now:number,options:{compact?:boolean}={}){
  const raw=new TextEncoder().encode(JSON.stringify(next));
  if(raw.length>MAX_STATE_BYTES)throw new Error("Adaptive 10状态超过预算；禁止截断账户");
  const compressed=await gzip(raw),useGzip=compressed.length<raw.length,bytes=useGzip?compressed:raw;
  const entries:Record<string,unknown>={};let count=0;
  const inline=options.compact===true,chunkBytes=inline?FORWARD_COMPACT_BYTES:80*1024;
  for(let offset=inline?FORWARD_COMPACT_BYTES:0;offset<bytes.length;offset+=chunkBytes)
    entries[`${FORWARD_STORAGE}chunk:${count++}`]=bytes.slice(offset,offset+chunkBytes);
  entries[`${FORWARD_STORAGE}head`]={version:FORWARD_VERSION,count,length:bytes.length,sha256:await digest(bytes),
    ...(useGzip?{encoding:"gzip" as const,rawLength:raw.length}:{}),...(inline?{inline:bytes.slice(0,FORWARD_COMPACT_BYTES)}:{})} satisfies Head;

  const priorRevision=previous?.revision??0,events=next.events.filter(e=>{
    const n=Number(e.id.split("-").at(-1));return !previous||!Number.isFinite(n)||n>priorRevision;
  });
  const subjects=new Set(events.map(e=>e.subject));
  const trades=[...next.positions,...next.history].filter(t=>subjects.has(t.id));
  const packet={at:now,version:FORWARD_VERSION,engineVersion:next.engineVersion,policyVersion:next.policyVersion,
    startedAt:next.startedAt,revision:next.revision,events,trades,
    account:{balance:next.balance,positions:next.positions,fees:next.fees,fundingAllowance:next.fundingAllowance,
      turnover:next.turnover,resolved:next.resolved,wins:next.wins,maxDrawdown:next.maxDrawdown},
    daily:next.daily.at(-1)??null,marketPulse:next.marketPulse,
    opportunities:next.opportunities.slice(0,12).map(o=>({symbol:o.symbol,side:o.side,mode:o.mode,score:o.score,eligible:o.eligible,
      premium:o.premium,netRemainingSpaceRate:o.netRemainingSpaceRate,edgeRatio:o.edgeRatio}))};
  const archiveKey=`${FORWARD_STORAGE}archive:${String(now).padStart(16,"0")}:${next.revision}`;
  const encoded=new TextEncoder().encode(JSON.stringify(packet));
  if(encoded.length>112*1024)throw new Error("Adaptive 10单次归档超过预算；拒绝丢弃交易证据");
  entries[archiveKey]=packet;

  for(const[key,value]of Object.entries(entries)){
    if(value instanceof Uint8Array)continue;
    const headValue=key===`${FORWARD_STORAGE}head`?value as Head:null;
    const size=headValue?.inline?headValue.inline.byteLength+new TextEncoder().encode(JSON.stringify({...headValue,inline:undefined})).length
      :new TextEncoder().encode(JSON.stringify(value)).length;
    if(size>120*1024)throw new Error(`Adaptive 10存储项超过预算：${key}`);
  }
  return{entries,writes:Object.keys(entries).length,compression:{encoding:useGzip?"gzip":"utf8",rawBytes:raw.length,
    storedBytes:bytes.length,chunks:count,...(options.compact?{inlineHead:inline,chunkBytes}:{})}};
}


/** Explicit owner reset only. Strategy upgrades never call this function.
 * Reset archives are deliberately split one open trade per record. A manual
 * reset must not become less reliable merely because the portfolio currently
 * contains many positions. */
export async function prepareForwardReset(previous:ForwardState,closedLegacy:ForwardState,next:ForwardState,now:number){
  if(!previous.storage.persistedAt)throw new Error("旧Forward账户尚未持久化，拒绝切换");
  if(closedLegacy.positions.length)throw new Error("旧Forward账户仍有未归档持仓，拒绝切换");
  if(next.positions.length||next.history.length||next.initialEquity!==1000||next.balance!==1000)
    throw new Error("新模拟账户初始状态异常");
  next.storage={persistedAt:now+1,error:null};
  const fresh=await prepareForwardWrite(null,next,now+1,{compact:true});
  const openIds=new Set(previous.positions.map(t=>t.id)),resetTrades=closedLegacy.history.filter(t=>openIds.has(t.id));
  const archiveEntries:Record<string,unknown>={};
  for(let i=0;i<resetTrades.length;i++){
    const trade=resetTrades[i]!,events=closedLegacy.events.filter(e=>e.subject===trade.id);
    const packet={at:now,type:"ACCOUNT_RESET",version:FORWARD_VERSION,engineVersion:previous.engineVersion,policyVersion:previous.policyVersion,
      startedAt:previous.startedAt,revision:closedLegacy.revision,events,trades:[trade],
      account:{balance:closedLegacy.balance,positions:[],fees:closedLegacy.fees,fundingAllowance:closedLegacy.fundingAllowance,
        turnover:closedLegacy.turnover,resolved:closedLegacy.resolved,wins:closedLegacy.wins,maxDrawdown:closedLegacy.maxDrawdown},
      daily:closedLegacy.daily.at(-1)??null,marketPulse:closedLegacy.marketPulse,opportunities:[]};
    if(new TextEncoder().encode(JSON.stringify(packet)).length>112*1024)
      throw new Error(`重置归档单笔记录超过预算：${trade.symbol}`);
    archiveEntries[`${FORWARD_STORAGE}archive:${String(now+i).padStart(16,"0")}:reset:${i}`]=packet;
  }
  const accountEntries={...fresh.entries,...prepareForwardProtectionWrite(next).entries};
  return{state:next,archiveEntries,accountEntries,writes:Object.keys(archiveEntries).length+Object.keys(accountEntries).length,compression:fresh.compression};
}
