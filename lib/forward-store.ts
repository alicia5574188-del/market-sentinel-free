import { FORWARD_VERSION, normalizeForward, type ForwardState } from "./forward-relations.ts";
import type { RelationMeasurement } from "./forward-relation-v2.ts";
import { gzip, gunzip, MAX_STATE_BYTES } from "./storage-codec.ts";
import { buildForwardProtectionCheckpoint, restoreForwardProtectionCheckpoint } from "./forward-protection-checkpoint.ts";

export const FORWARD_STORAGE = "forward-relations:v1:";
export const FORWARD_PROTECTION_STORAGE = `${FORWARD_STORAGE}protection`;
export const FORWARD_STORAGE_STATE_VERSION=`${FORWARD_VERSION}:sample-pack-v1`;
export const FORWARD_PAGED_STATE_VERSION=`${FORWARD_VERSION}:paged-samples-v2`;
export const FORWARD_SAMPLE_MANIFEST_STORAGE=`${FORWARD_STORAGE}sample-manifest`;
export const FORWARD_SAMPLE_PAGE_PREFIX=`${FORWARD_STORAGE}sample-page:`;
// Keep 16 KiB below the Durable Object single-value ceiling for typed-array
// serialization and metadata. No base64 conversion or state-field omission.
export const FORWARD_COMPACT_BYTES = 112*1024;
type Head = { version: string; count: number; length: number; sha256: string; encoding?: "gzip"; rawLength?: number;
  inline?: Uint8Array; sampleManifestSha256?:string };
type SamplePageMeta={id:string;key:string;count:number;firstAt:number;lastAt:number;length:number;rawLength:number;
  sha256:string;rawSha256?:string;encoding:"gzip"|"utf8"};
export type ForwardSampleManifest={version:typeof FORWARD_PAGED_STATE_VERSION;count:number;pages:SamplePageMeta[]};
type Reader = { get<T>(key: string): Promise<T | undefined> };
export type Store = Reader & { put(entries: Record<string, unknown>): Promise<void>; delete(keys: string[]): Promise<number> };
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map(v=>v.toString(16).padStart(2,"0")).join("");

const SAMPLE_CHECKPOINTS=[5,10,15,20,30,45,60] as const;
const SAMPLE_PAGE_MS=60*60_000,SAMPLE_PAGE_ROWS=96,FORWARD_ACCOUNT_MAX_BYTES=1024*1024,FORWARD_SAMPLE_PAGE_MAX_BYTES=512*1024;
const packed=(row:Record<number,string|number>|Record<string,string|number>|undefined,keys:readonly number[])=>
  keys.map(key=>{const value=Number(row?.[key as keyof typeof row]);return Number.isFinite(value)?value:null;});
function packSample(row:RelationMeasurement){
  return [
    "m1",row.symbol,row.at,row.response,row.up,row.down,row.x,
    [row.env.breadth,row.env.dispersion,row.env.expansion],
    packed(row.cp as Record<number,number>,SAMPLE_CHECKPOINTS),
    packed(row.upAt as Record<number,number>,SAMPLE_CHECKPOINTS),
    packed(row.downAt as Record<number,number>,SAMPLE_CHECKPOINTS),
    row.pathEfficiency,row.reversals,
  ];
}
function compactForwardState(next:ForwardState,includeSamples=true){
  const samples=includeSamples?next.relationEngine.samples.map(packSample):[],paged=!includeSamples;
  return{...next,storage:{...next.storage,layout:paged?FORWARD_PAGED_STATE_VERSION:next.storage.layout,
      ...(paged?{sampleIntegrity:"raw-sha256" as const}:{})},
    relationEngine:{...next.relationEngine,samples}};
}
const encodeJson=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
function sampleBuckets(samples:RelationMeasurement[]){
  const out=new Map<string,RelationMeasurement[]>();
  let priorHour="",shard=-1;
  for(const sample of [...samples].sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol))){
    const hour=String(Math.floor(sample.at/SAMPLE_PAGE_MS)*SAMPLE_PAGE_MS).padStart(16,"0");
    if(hour!==priorHour){priorHour=hour;shard=0;}
    let id=`${hour}:${String(shard).padStart(3,"0")}`,rows=out.get(id)??[];
    if(rows.length>=SAMPLE_PAGE_ROWS){shard++;id=`${hour}:${String(shard).padStart(3,"0")}`;rows=[];}
    rows.push(sample);out.set(id,rows);
  }
  return out;
}
async function encodeSamplePages(samples:RelationMeasurement[]){
  const pages:{meta:SamplePageMeta;bytes:Uint8Array;rawText:string}[]=[];
  for(const[id,rows]of sampleBuckets(samples)){
    const raw=encodeJson({version:FORWARD_PAGED_STATE_VERSION,id,samples:rows.map(packSample)});
    if(raw.length>FORWARD_SAMPLE_PAGE_MAX_BYTES)throw new Error(`Forward样本分页超过预算：${id}`);
    const compressed=await gzip(raw),useGzip=compressed.length<raw.length,bytes=useGzip?compressed:raw;
    if(bytes.length>FORWARD_COMPACT_BYTES)throw new Error(`Forward样本分页存储项超过预算：${id}`);
    pages.push({meta:{id,key:`${FORWARD_SAMPLE_PAGE_PREFIX}${id}`,count:rows.length,firstAt:rows[0]!.at,lastAt:rows.at(-1)!.at,
      length:bytes.length,rawLength:raw.length,sha256:await digest(bytes),rawSha256:await digest(raw),encoding:useGzip?"gzip":"utf8"},bytes,
      rawText:new TextDecoder().decode(raw)});
  }
  return pages;
}

const SHA256=/^[0-9a-f]{64}$/;
function validPackedPage(samples:unknown[],meta:SamplePageMeta){
  const hourText=meta.id.split(":")[0]!,hour=Number(hourText);let priorAt=-1,priorSymbol="";
  if(!/^\d{16}:\d{3}$/.test(meta.id)||!Number.isSafeInteger(hour)||hour<0||hour%SAMPLE_PAGE_MS!==0)return false;
  for(const value of samples){
    if(!Array.isArray(value)||value.length<13||value[0]!=="m1"||typeof value[1]!=="string"||!value[1]
      ||!Number.isSafeInteger(value[2])||value[2]<hour||value[2]>=hour+SAMPLE_PAGE_MS
      ||![value[3],value[4],value[5],value[11],value[12]].every(Number.isFinite)
      ||!Array.isArray(value[6])||value[6].length!==8||!value[6].every(Number.isFinite)
      ||!Array.isArray(value[7])||value[7].length!==3||!value[7].every(Number.isFinite)
      ||![value[8],value[9],value[10]].every(row=>Array.isArray(row)&&row.length===SAMPLE_CHECKPOINTS.length
        &&row.every(item=>item===null||Number.isFinite(item))))return false;
    const at=value[2] as number,symbol=value[1];
    if(at<priorAt||(at===priorAt&&symbol.localeCompare(priorSymbol)<0))return false;
    priorAt=at;priorSymbol=symbol;
  }
  return samples.length===meta.count&&samples.length>0&&samples.length<=SAMPLE_PAGE_ROWS
    &&(samples[0] as unknown[])[2]===meta.firstAt&&(samples.at(-1) as unknown[])[2]===meta.lastAt;
}

export async function readForwardStore(storage: Reader, now: number) {
  const head=await storage.get<Head>(`${FORWARD_STORAGE}head`);
  if(!head)return normalizeForward(null,now);
  if((head.version!==FORWARD_VERSION&&head.version!==FORWARD_STORAGE_STATE_VERSION&&head.version!==FORWARD_PAGED_STATE_VERSION)
    ||!Number.isSafeInteger(head.count)||head.count<0||head.count>32
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
  const raw=head.encoding==="gzip"?await gunzip(bytes,head.version===FORWARD_PAGED_STATE_VERSION?FORWARD_ACCOUNT_MAX_BYTES:MAX_STATE_BYTES):bytes;
  if(head.encoding==="gzip"&&raw.length!==head.rawLength)throw new Error("前向解压长度校验失败");
  if(head.version===FORWARD_PAGED_STATE_VERSION&&raw.length>FORWARD_ACCOUNT_MAX_BYTES)throw new Error("前向账户主状态超过预算；拒绝截断账户");
  const decoded=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)) as ForwardState;
  if(head.version===FORWARD_PAGED_STATE_VERSION){
    const manifest=await storage.get<ForwardSampleManifest>(FORWARD_SAMPLE_MANIFEST_STORAGE);
    if(!manifest||manifest.version!==FORWARD_PAGED_STATE_VERSION||!Number.isSafeInteger(manifest.count)||manifest.count<0
      ||!Array.isArray(manifest.pages)||manifest.pages.length>64
      ||await digest(encodeJson(manifest))!==head.sampleManifestSha256)throw new Error("Forward样本manifest校验失败，原账户不会被覆盖");
    const pageBytes=await Promise.all(manifest.pages.map(page=>storage.get<Uint8Array>(page.key))),samples:unknown[]=[];
    let count=0,prior="",legacyRecovered=false;
    for(let i=0;i<manifest.pages.length;i++){
      const meta=manifest.pages[i]!,value=pageBytes[i];
      if(!value||meta.key!==`${FORWARD_SAMPLE_PAGE_PREFIX}${meta.id}`||meta.id<=prior||value.length>FORWARD_COMPACT_BYTES
        ||!Number.isSafeInteger(meta.length)||meta.length<1||meta.length>FORWARD_COMPACT_BYTES
        ||!Number.isSafeInteger(meta.rawLength)||meta.rawLength<1||meta.rawLength>FORWARD_SAMPLE_PAGE_MAX_BYTES
        ||!Number.isSafeInteger(meta.count)||meta.count<1||meta.count>SAMPLE_PAGE_ROWS
        ||!Number.isSafeInteger(meta.firstAt)||!Number.isSafeInteger(meta.lastAt)||meta.firstAt>meta.lastAt
        ||!SHA256.test(meta.sha256)||(meta.encoding!=="gzip"&&meta.encoding!=="utf8"))
        throw new Error(`Forward样本分页校验失败：${meta.id}`);
      prior=meta.id;const compressedMatches=value.length===meta.length&&await digest(value)===meta.sha256;
      let pageRaw:Uint8Array,page:{version?:string;id?:string;samples?:unknown[]};
      try{pageRaw=meta.encoding==="gzip"?await gunzip(value,FORWARD_SAMPLE_PAGE_MAX_BYTES):value;}
      catch{throw new Error(`Forward样本分页解压失败：${meta.id}`);}
      const rawLengthMatches=pageRaw.length===meta.rawLength,rawSha256=await digest(pageRaw);
      if(meta.rawSha256!==undefined){
        if(!rawLengthMatches||!SHA256.test(meta.rawSha256)||rawSha256!==meta.rawSha256)
          throw new Error(`Forward样本分页原始校验失败：${meta.id}`);
      }else if(!compressedMatches||!rawLengthMatches)legacyRecovered=true;
      try{page=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(pageRaw)) as typeof page;}
      catch{throw new Error(`Forward样本分页JSON失败：${meta.id}`);}
      if(page.version!==FORWARD_PAGED_STATE_VERSION||page.id!==meta.id||!Array.isArray(page.samples)||!validPackedPage(page.samples,meta))
        throw new Error(`Forward样本分页内容异常：${meta.id}`);
      samples.push(...page.samples);count+=page.samples.length;
    }
    if(count!==manifest.count)throw new Error("Forward样本manifest数量异常");
    decoded.relationEngine={...decoded.relationEngine,samples:samples as RelationMeasurement[]};
    decoded.storage={...decoded.storage,layout:FORWARD_PAGED_STATE_VERSION,
      sampleIntegrity:legacyRecovered||manifest.pages.some(page=>page.rawSha256===undefined)?"legacy-recovered":"raw-sha256"};
  }
  const state=normalizeForward(decoded,now);
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
  const pages=await encodeSamplePages(next.relationEngine.samples),manifest:ForwardSampleManifest={version:FORWARD_PAGED_STATE_VERSION,
    count:next.relationEngine.samples.length,pages:pages.map(page=>page.meta)},manifestSha256=await digest(encodeJson(manifest));
  const raw=encodeJson(compactForwardState(next,false));
  if(raw.length>FORWARD_ACCOUNT_MAX_BYTES)throw new Error("Forward账户主状态超过预算；禁止截断金融记录");
  const compressed=await gzip(raw),useGzip=compressed.length<raw.length,bytes=useGzip?compressed:raw;
  const entries:Record<string,unknown>={};let count=0;
  const inline=options.compact===true,chunkBytes=inline?FORWARD_COMPACT_BYTES:80*1024;
  for(let offset=inline?FORWARD_COMPACT_BYTES:0;offset<bytes.length;offset+=chunkBytes)
    entries[`${FORWARD_STORAGE}chunk:${count++}`]=bytes.slice(offset,offset+chunkBytes);
  const previousPages=previous?.storage.layout===FORWARD_PAGED_STATE_VERSION?await encodeSamplePages(previous.relationEngine.samples):[],
    previousById=new Map(previousPages.map(page=>[page.meta.id,page]));
  let changedSamplePages=0;
  for(const page of pages){const prior=previousById.get(page.meta.id);if(!prior||prior.rawText!==page.rawText){entries[page.meta.key]=page.bytes;changedSamplePages++;}}
  const priorManifest=previous?.storage.layout===FORWARD_PAGED_STATE_VERSION?{
    version:FORWARD_PAGED_STATE_VERSION,count:previous.relationEngine.samples.length,pages:previousPages.map(page=>page.meta)} satisfies ForwardSampleManifest:null;
  if(!priorManifest||previous?.storage.sampleIntegrity!=="raw-sha256"||JSON.stringify(priorManifest)!==JSON.stringify(manifest))
    entries[FORWARD_SAMPLE_MANIFEST_STORAGE]=manifest;
  entries[`${FORWARD_STORAGE}head`]={version:FORWARD_PAGED_STATE_VERSION,count,length:bytes.length,sha256:await digest(bytes),sampleManifestSha256:manifestSha256,
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
    storedBytes:bytes.length,chunks:count,sampleCount:manifest.count,samplePages:manifest.pages.length,changedSamplePages,
    ...(options.compact?{inlineHead:inline,chunkBytes}:{})}};
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
  const accountEntries:Record<string,unknown>={...fresh.entries,...prepareForwardProtectionWrite(next).entries};
  return{state:next,archiveEntries,accountEntries,writes:Object.keys(archiveEntries).length+Object.keys(accountEntries).length,compression:fresh.compression};
}
