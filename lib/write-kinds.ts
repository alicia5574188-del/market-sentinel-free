/** Measurement only: which kinds of Durable Object storage rows this object
 * commits each UTC day. It never admits, defers or blocks a write; the
 * reservations that already guard writes stay the only authority. */
export const WRITE_KINDS_VERSION="do-write-kinds-v1";
export type WriteTag=string|Record<string,number>;
export type WriteKindBook={version:typeof WRITE_KINDS_VERSION;day:string;since:number;total:number;counts:Record<string,number>;
  previous?:{day:string;total:number;counts:Record<string,number>}|null};

const dayOf=(now:number)=>new Date(now).toISOString().slice(0,10);
// Literal prefixes (tests pin them to the storage modules' constants).
const RULES:[string,string][]=[
  ["forward-relations:v1:head","forward-head"],
  ["forward-relations:v1:chunk:","forward-chunk"],
  ["forward-relations:v1:archive:","forward-archive"],
  ["forward-relations:v1:protection","forward-protection"],
  ["forward-relations:v1:sample","forward-samples"],
  ["market-intelligence:trade-paths:v2","trade-path"],
  ["market-intelligence:order-journal:v1","order-journal"],
  ["live-parity:v1:","live-parity"],
];
/** A storage key's kind: a known prefix, else its first segment. */
export function writeKindOfKey(key:string){
  for(const [prefix,kind] of RULES)if(key.startsWith(prefix))return kind;
  const head=key.split(":")[0]||"other";
  return head.length>40?head.slice(0,40):head;
}
export function writeKeyBreakdown(keys:Iterable<string>){
  const out:Record<string,number>={};
  for(const key of keys){const kind=writeKindOfKey(key);out[kind]=(out[kind]??0)+1;}
  return out;
}
const MAX_KINDS=48;
function add(counts:Record<string,number>,kind:string,n:number){
  if(!(kind in counts)&&Object.keys(counts).length>=MAX_KINDS)kind="other";
  counts[kind]=(counts[kind]??0)+n;
}
/** Records `writes` committed rows under `tag`. A breakdown that names fewer
 * rows than were committed charges the rest to "unclassified". */
export function noteWriteKinds(book:WriteKindBook|undefined|null,now:number,tag:WriteTag,writes:number):WriteKindBook{
  const day=dayOf(now);
  let next:WriteKindBook=book&&book.version===WRITE_KINDS_VERSION&&typeof book.counts==="object"&&book.counts?book
    :{version:WRITE_KINDS_VERSION,day,since:now,total:0,counts:{},previous:null};
  if(next.day<day)next={version:WRITE_KINDS_VERSION,day,since:now,total:0,counts:{},previous:{day:next.day,total:next.total,counts:next.counts}};
  if(!Number.isSafeInteger(writes)||writes<1)return next;
  next.total+=writes;
  if(typeof tag==="string"){add(next.counts,tag,writes);return next;}
  let named=0;
  for(const [kind,n] of Object.entries(tag)){if(!Number.isSafeInteger(n)||n<1)continue;const take=Math.min(n,writes-named);if(take<1)break;add(next.counts,kind,take);named+=take;}
  if(named<writes)add(next.counts,"unclassified",writes-named);
  return next;
}
/** Compact health view: kinds sorted by count, with the elapsed share of the day. */
export function writeKindsView(book:WriteKindBook|undefined|null,now:number){
  if(!book||book.version!==WRITE_KINDS_VERSION)return {version:WRITE_KINDS_VERSION,day:dayOf(now),since:null,total:0,perHour:null,counts:{},previous:null};
  const current=book.day===dayOf(now);
  const sorted=(c:Record<string,number>)=>Object.fromEntries(Object.entries(c).sort((a,b)=>b[1]-a[1]));
  const hours=current?Math.max(1/60,(now-Math.max(book.since,Date.parse(`${book.day}T00:00:00Z`)))/3_600_000):null;
  return {version:WRITE_KINDS_VERSION,day:current?book.day:dayOf(now),since:current?book.since:null,total:current?book.total:0,
    perHour:current&&hours?Math.round(book.total/hours):null,counts:current?sorted(book.counts):{},
    previous:current?(book.previous?{...book.previous,counts:sorted(book.previous.counts)}:null):{day:book.day,total:book.total,counts:sorted(book.counts)}};
}
