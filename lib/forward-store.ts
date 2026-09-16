import { FORWARD_VERSION, normalizeForward, type ForwardState } from "./forward-relations.ts";

export const FORWARD_STORAGE = "forward-relations:v1:";
type Head = { version: string; count: number; length: number; sha256: string };
type Reader = { get<T>(key: string): Promise<T | undefined> };
export type Store = Reader & { put(entries: Record<string, unknown>): Promise<void>; delete(keys: string[]): Promise<number> };
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map(v=>v.toString(16).padStart(2,"0")).join("");

export async function readForwardStore(storage: Reader, now: number) {
  const head=await storage.get<Head>(`${FORWARD_STORAGE}head`);
  if(!head)return normalizeForward(null,now);
  if(head.version!==FORWARD_VERSION||head.count<1||head.count>32||head.length<1)throw new Error("前向存储头异常，拒绝重置账户");
  const chunks=await Promise.all(Array.from({length:head.count},(_,i)=>storage.get<Uint8Array>(`${FORWARD_STORAGE}chunk:${i}`)));
  const bytes=new Uint8Array(head.length);let offset=0;
  for(const chunk of chunks){if(!chunk||offset+chunk.byteLength>bytes.length)throw new Error("前向存储分片缺失");bytes.set(chunk,offset);offset+=chunk.byteLength;}
  if(offset!==bytes.length||await digest(bytes)!==head.sha256)throw new Error("前向存储校验失败，原账户不会被覆盖");
  return normalizeForward(JSON.parse(new TextDecoder().decode(bytes)) as ForwardState,now);
}

export async function prepareForwardWrite(previous:ForwardState|null,next:ForwardState,now:number){
  const bytes=new TextEncoder().encode(JSON.stringify(next));
  if(bytes.length>2*1024*1024)throw new Error("前向状态超过预算；禁止丢弃账户后继续");
  const entries:Record<string,unknown>={};let count=0;
  for(let offset=0;offset<bytes.length;offset+=80*1024)entries[`${FORWARD_STORAGE}chunk:${count++}`]=bytes.slice(offset,offset+80*1024);
  entries[`${FORWARD_STORAGE}head`]={version:FORWARD_VERSION,count,length:bytes.length,sha256:await digest(bytes)} satisfies Head;
  const priorRevision=previous?.revision??0;
  const events=next.events.filter(e=>Number(e.id.split("-").at(-1))>priorRevision);
  const subjects=new Set(events.map(e=>e.subject));
  // Immutable per-cycle packets retain all market labels, rule versions, orders
  // and marked account paths without one database write per market observation.
  const archiveKey=`${FORWARD_STORAGE}archive:${String(now).padStart(16,"0")}:${next.revision}`;
  const packet={
    at:now,version:FORWARD_VERSION,policyVersion:next.policyVersion,policyUpgrade:next.policyUpgrade,
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
  for (const [key,value] of Object.entries(entries)) if (!(value instanceof Uint8Array)
    && new TextEncoder().encode(JSON.stringify(value)).length > 120*1024)
    throw new Error(`前向归档包超过单值预算：${key}`);
  return{entries,writes:Object.keys(entries).length};
}
