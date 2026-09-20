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
  if(raw.length>MAX_STATE_BYTES)throw new Error("前向状态超过预算；禁止丢弃账户后继续");
  const compressed=await gzip(raw),useGzip=compressed.length<raw.length;
  const bytes=useGzip?compressed:raw;
  const entries:Record<string,unknown>={};let count=0;
  const inline=options.compact===true;
  const chunkBytes=options.compact===true?FORWARD_COMPACT_BYTES:80*1024;
  for(let offset=inline?FORWARD_COMPACT_BYTES:0;offset<bytes.length;offset+=chunkBytes)
    entries[`${FORWARD_STORAGE}chunk:${count++}`]=bytes.slice(offset,offset+chunkBytes);
  entries[`${FORWARD_STORAGE}head`]={version:FORWARD_VERSION,count,length:bytes.length,sha256:await digest(bytes),
    ...(useGzip?{encoding:"gzip" as const,rawLength:raw.length}:{}),...(inline?{inline:bytes.slice(0,FORWARD_COMPACT_BYTES)}:{})} satisfies Head;
  const priorRevision=previous?.revision??0;
  const events=next.events.filter(e=>Number(e.id.split("-").at(-1))>priorRevision);
  const subjects=new Set(events.map(e=>e.subject));
  // Immutable per-cycle packets retain all market labels, rule versions, orders
  // and marked account paths without one database write per market observation.
  const archiveKey=`${FORWARD_STORAGE}archive:${String(now).padStart(16,"0")}:${next.revision}`;
  const packet={
    at:now,version:FORWARD_VERSION,policyVersion:next.policyVersion,policyUpgrade:next.policyUpgrade,
    strategyAuthorityVersion:next.strategyAuthorityVersion??"legacy-forward-rules-v1",cutoverAt:next.cutoverAt??null,
    turnEngine:next.turnEngine?{version:next.turnEngine.version,updatedAt:next.turnEngine.updatedAt,
      diagnostics:next.turnEngine.diagnostics,calibration:next.turnEngine.calibration}:null,
    startedAt:next.startedAt,revision:next.revision,events,
    evidenceDiagnostics:next.evidenceDiagnostics,entryDiagnostics:next.entryDiagnostics,
    feedback:next.feedback?.filter(f=>!(previous?.feedback??[]).some(p=>p.id===f.id))??[],
    measurements:next.lastCycleAt>(previous?.lastCycleAt??0)?next.samples.filter(m=>m.availableAt===next.lastCycleAt):[],
    rules:next.rules.filter(r=>subjects.has(r.id)),
    trades:[...next.positions,...next.history].filter(t=>subjects.has(t.id)),
    account:{balance:next.balance,positions:next.positions,fees:next.fees,fundingAllowance:next.fundingAllowance,
      turnover:next.turnover,resolved:next.resolved,wins:next.wins,maxDrawdown:next.maxDrawdown},daily:next.daily.at(-1)??null,
  };
  const encodedSize=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
  if(encodedSize(packet)<=112*1024)entries[archiveKey]=packet;
  else {
    // Large simultaneous label/exit/upgrade batches must not stall protective
    // commits. Split the ARCHIVE packet only; never split the atomic account
    // transaction or drop events. Existing paging traverses every part.
    const fields=["events","measurements","rules","trades","feedback"] as const;
    const header:Record<string,unknown>={...packet};for(const field of fields)delete header[field];
    const parts:Record<string,unknown>[]=[];let part:Record<string,unknown>={...header};
    for(const field of fields)for(const item of packet[field]){
      const prev=(part[field]??[]) as unknown[],trial={...part,[field]:[...prev,item]};
      if(encodedSize(trial)>112*1024){
        parts.push(part);part={at:now,version:FORWARD_VERSION,policyVersion:next.policyVersion,
          startedAt:next.startedAt,revision:next.revision,[field]:[item]};
        if(encodedSize(part)>112*1024)throw new Error("单项前向证据超出归档预算，拒绝截断");
      }else part=trial;
    }
    parts.push(part);
    for(let i=0;i<parts.length;i++)entries[i?`${archiveKey}:part:${String(i).padStart(2,"0")}`:archiveKey]={
      ...parts[i],archivePart:i,archiveParts:parts.length};
  }
  // Refuse oversized single KV records instead of relying on an opaque runtime
  // exception; account chunks already stay well below the 128KiB value ceiling.
  for (const [key,value] of Object.entries(entries)) {
    if(value instanceof Uint8Array)continue;
    // JSON.stringify(Uint8Array) is not the host's structured-clone encoding:
    // it expands every numeric index. Budget bytes plus bounded head metadata.
    const headValue=key===`${FORWARD_STORAGE}head`?value as Head:null;
    const valueSize=headValue?.inline
      ?headValue.inline.byteLength+encodedSize({...headValue,inline:undefined})
      :encodedSize(value);
    if(valueSize>120*1024)throw new Error(`前向归档包超过单值预算：${key}`);
  }
  return{entries,writes:Object.keys(entries).length,compression:{encoding:useGzip?"gzip":"utf8",rawBytes:raw.length,
    storedBytes:bytes.length,chunks:count,...(options.compact?{inlineHead:inline,chunkBytes}:{})}};
}


/** One transaction can preserve the final legacy account archive while making
 * a fresh Multi-Turn account the only readable financial head. Old account
 * chunks may remain physically present, but the new authenticated head cannot
 * reference them. No partial reset is publishable. */
export async function prepareForwardReset(previous:ForwardState,closedLegacy:ForwardState,next:ForwardState,now:number){
  if(!previous.storage.persistedAt)throw new Error("旧Forward账户尚未持久化，拒绝切换");
  if(closedLegacy.positions.length)throw new Error("旧Forward账户仍有未归档持仓，拒绝切换");
  if(next.positions.length||next.history.length||next.initialEquity!==1000||next.balance!==1000)
    throw new Error("Multi-Turn新账户初始状态异常");
  next.storage={persistedAt:now+1,error:null};
  const legacy=await prepareForwardWrite(previous,closedLegacy,now,{compact:true});
  const fresh=await prepareForwardWrite(null,next,now+1,{compact:true});
  const entries:Record<string,unknown>={};
  for(const[key,value]of Object.entries(legacy.entries))
    if(key.startsWith(`${FORWARD_STORAGE}archive:`))entries[key]=value;
  Object.assign(entries,fresh.entries,prepareForwardProtectionWrite(next).entries);
  return{state:next,entries,writes:Object.keys(entries).length,compression:fresh.compression};
}
