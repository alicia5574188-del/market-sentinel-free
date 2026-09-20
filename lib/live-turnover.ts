/** Verified Gate fills only. Analytics has no order/switch/strategy authority. */
import { gzip, gunzip, MAX_STATE_BYTES } from "./storage-codec.ts";

export const LIVE_TURNOVER_VERSION="gate-confirmed-turnover-v2";
export const LIVE_TURNOVER_PREFIX="live-turnover:v2:";
export const FILL_PAGE_SIZE=100;
export type GateConfirmedFill={id?:string|number;trade_id?:string|number;order_id?:string|number;
  create_time?:number|string;contract?:string;size?:number|string;close_size?:number|string;
  price?:number|string;trade_value?:number|string;fee?:number|string;text?:string};
type Window={from:number;to:number;offset:number};
export type TurnoverState={version:typeof LIVE_TURNOVER_VERSION;startedAt:number;createdAt:number;
  total:number;opening:number;closing:number;unclassified:number;systemTagged:number;fees:number;systemTaggedFees:number;fills:number;
  through:number;lastScanAt:number;pending:Window|null};
type Fill={key:string;at:number;day:string;notional:number;opening:number;closing:number;unclassified:number;
  systemTagged:number;fee:number;systemTaggedFee:number;fingerprint:string};
type Bucket={version:typeof LIVE_TURNOVER_VERSION;day:string;seen:Record<string,string>};
type Packed={encoding:"gzip";bytes:Uint8Array};
type Reader={get<T>(key:string):Promise<T|undefined>};
const known=(x:unknown)=>x!==undefined&&x!==null&&String(x).trim()!==""&&Number.isFinite(Number(x));
const stableId=(x:unknown)=>typeof x==="number"&&!Number.isSafeInteger(x)?null:/^\d{1,40}$/.test(String(x))?String(x):null;
export function initialTurnover(startedAt:number,now:number):TurnoverState {
  if(!Number.isSafeInteger(startedAt)||startedAt<=0||startedAt>now)throw new Error("实盘成交额统计起点无效");
  return {version:LIVE_TURNOVER_VERSION,startedAt,createdAt:now,total:0,opening:0,closing:0,unclassified:0,
    systemTagged:0,fees:0,systemTaggedFees:0,fills:0,through:Math.floor(startedAt/1000)-1,lastScanAt:0,pending:null};
}
export function validateTurnover(s:TurnoverState) {
  if(s.version!==LIVE_TURNOVER_VERSION||![s.total,s.opening,s.closing,s.unclassified,s.systemTagged,s.fees,s.systemTaggedFees,s.fills,s.through,s.startedAt,s.createdAt,s.lastScanAt].every(x=>Number.isFinite(x)&&x>=0)
    ||Math.abs(s.total-s.opening-s.closing-s.unclassified)>1e-7*Math.max(1,s.total))
    throw new Error("成交额账本异常，拒绝清零覆盖");
  if(s.pending&&(![s.pending.from,s.pending.to,s.pending.offset].every(Number.isSafeInteger)||s.pending.offset<0||s.pending.from>s.pending.to))
    throw new Error("成交额分页游标异常");
  return s;
}
export function nextFillWindow(s:TurnoverState,now:number):Window|null {
  validateTurnover(s);if(s.pending)return {...s.pending};
  // Frozen upper boundary avoids chasing a moving newest page. Revisit two
  // minutes at the frontier to include delayed/indexing-lagged responses.
  const from=Math.max(Math.floor(s.startedAt/1000),s.through-120);
  const to=Math.min(Math.floor((now-15_000)/1000),from+86400-1);
  return to>=from?{from,to,offset:0}:null;
}
export function normalizeGateFill(row:GateConfirmedFill,multipliers:Record<string,number>):Fill {
  const id=stableId(row.trade_id??row.id),contract=row.contract;
  if(!id||!contract||!known(row.create_time)||!known(row.size)||!known(row.price))throw new Error("Gate成交记录缺少有效ID/数量/价格/时间");
  const size=Math.abs(Number(row.size)),price=Number(row.price),at=Math.round(Number(row.create_time)*1000);
  if(!(size>0&&price>0&&at>0))throw new Error("零成交或无效成交不能计入成交额");
  // Prefer exchange-native USDT trade value. Time-range responses without it
  // require the actual contract multiplier, never an invented multiplier=1.
  const multiplier=multipliers[contract];
  const notional=known(row.trade_value)&&Number(row.trade_value)>0?Number(row.trade_value)
    :Number.isFinite(multiplier)&&multiplier>0?size*price*multiplier:NaN;
  if(!Number.isFinite(notional)||notional<=0)throw new Error(`${contract} 成交乘数缺失，金额待核对`);
  const closeKnown=known(row.close_size);
  if(closeKnown&&Number(row.close_size)!==0&&Math.sign(Number(row.close_size))!==Math.sign(Number(row.size)))
    throw new Error(`${contract} 成交开平数量方向矛盾`);
  if(!known(row.fee))throw new Error("Gate成交记录缺少实际手续费，拒绝估算");
  const fee=Math.max(0,Number(row.fee));if(!Number.isFinite(fee))throw new Error("Gate手续费不是有效数字");
  const closing=closeKnown?notional*Math.min(size,Math.abs(Number(row.close_size)))/size:0;
  const opening=closeKnown?notional-closing:0,unclassified=closeKnown?0:notional,system=/^t-ms-[esx]-/.test(row.text??"");
  return {key:`${contract}:${id}`,at,day:new Date(at).toISOString().slice(0,10),notional,opening,closing,unclassified,
    systemTagged:system?notional:0,fee,systemTaggedFee:system?fee:0,
    fingerprint:JSON.stringify([at,String(row.order_id??""),Number(row.size),price,notional,fee,closeKnown?Number(row.close_size):null])};
}
export async function prepareTurnoverPage(input:{state:TurnoverState;window:Window;rows:GateConfirmedFill[];
  accountKey:string;storage:Reader;multipliers:Record<string,number>;now:number}) {
  const {state,window,rows,accountKey,storage,multipliers,now}=input;
  validateTurnover(state);if(!/^[a-f0-9]{64}$/.test(accountKey))throw new Error("成交额账户命名空间无效");
  if(rows.length>FILL_PAGE_SIZE||window.offset>50000)throw new Error("成交额分页超出预算，保留已核对部分");
  const expected=nextFillWindow(state,now);
  if(!expected||JSON.stringify(expected)!==JSON.stringify(window))throw new Error("成交额分页范围发生变化");
  const normalized=rows.map(r=>normalizeGateFill(r,multipliers));
  if(normalized.some(r=>r.at<window.from*1000||r.at>window.to*1000+999))throw new Error("Gate成交记录超出请求的固定时间范围");
  const s=structuredClone(state),entries:Record<string,unknown>={},buckets=new Map<string,Bucket>(),changed=new Set<string>();
  for(const row of normalized){
    if(row.at<s.startedAt)continue;
    const key=`${LIVE_TURNOVER_PREFIX}${accountKey}:day:${row.day}`;
    let bucket=buckets.get(key);
    if(!bucket){
      const saved=await storage.get<Packed>(key);
      if(saved){
        if(saved.encoding!=="gzip"||!(saved.bytes instanceof Uint8Array))throw new Error("成交额去重账本损坏");
        bucket=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await gunzip(saved.bytes))) as Bucket;
        if(bucket.version!==LIVE_TURNOVER_VERSION||bucket.day!==row.day||!bucket.seen)throw new Error("成交额日期账本不匹配");
      }else bucket={version:LIVE_TURNOVER_VERSION,day:row.day,seen:{}};
      buckets.set(key,bucket);
    }
    const prior=bucket.seen[row.key];
    if(prior){if(prior!==row.fingerprint)throw new Error("Gate同一成交ID的金额被更正，等待核对，不重复累计");continue;}
    bucket.seen[row.key]=row.fingerprint;changed.add(key);
    s.total+=row.notional;s.opening+=row.opening;s.closing+=row.closing;s.unclassified+=row.unclassified;
    s.systemTagged+=row.systemTagged;s.fees+=row.fee;s.systemTaggedFees+=row.systemTaggedFee;s.fills++;
  }
  for(const key of changed){
    const raw=new TextEncoder().encode(JSON.stringify(buckets.get(key)));
    if(raw.length>MAX_STATE_BYTES)throw new Error("成交额单日去重记录超过预算，未丢弃旧成交");
    const bytes=await gzip(raw);if(bytes.length>112*1024)throw new Error("成交额单日去重压缩包超过预算");
    entries[key]={encoding:"gzip",bytes} satisfies Packed;
  }
  s.lastScanAt=now;
  if(rows.length===FILL_PAGE_SIZE)s.pending={...window,offset:window.offset+FILL_PAGE_SIZE};
  else{s.through=Math.max(s.through,window.to);s.pending=null;}
  validateTurnover(s);
  entries[`${LIVE_TURNOVER_PREFIX}${accountKey}:summary`]=s;
  return {state:s,entries,writes:Object.keys(entries).length,newFills:s.fills-state.fills};
}
export function turnoverView(state:TurnoverState|null,error:string|null,now:number) {
  return {version:LIVE_TURNOVER_VERSION,scope:"GATE_USDT_ACCOUNT" as const,includesManualTrades:true,
    startedAt:state?.startedAt??null,total:state?.lastScanAt?state.total:null,opening:state?.lastScanAt?state.opening:null,
    closing:state?.lastScanAt?state.closing:null,unclassified:state?.lastScanAt?state.unclassified:null,
    systemTagged:state?.lastScanAt?state.systemTagged:null,fees:state?.lastScanAt?state.fees:null,
    systemTaggedFees:state?.lastScanAt?state.systemTaggedFees:null,fillCount:state?.fills??0,checkedThrough:state?state.through*1000:null,
    lastScanAt:state?.lastScanAt??null,catchingUp:!state?.lastScanAt||Boolean(state?.pending)||!state||now-state.through*1000>120000,
    error,method:"逐笔Gate成交ID去重，开仓＋平仓名义金额；手续费使用Gate成交记录fee字段累计，不用模型费率估算"};
}
