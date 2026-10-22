/** Owner 大脑 page: the living research layer's status, its cache key and the plain-Chinese labels. Display only; the
 * status read is a Worker→DO call (no Gate request). */
import {useCallback,useEffect} from "react";
import {operatorRequest} from "./operator-ui.ts";
import {prefetchPanel,usePanel} from "./panel-cache.ts";

export type BrainMode="off"|"compute-only"|"paper-enabled";
export type BrainSide="LONG"|"SHORT";
export type BrainEv={p15?:number|null;oi15?:number|null;oi60?:number|null;funding?:number|null;taker15?:number|null;vol15?:number|null;basis?:number|null};
export type BrainStatus={version:string;mode:BrainMode;configured:BrainMode;acting:boolean;fallback:{at:number;until:number;reason:string}|null;
  items:{key:string;label:string;on:boolean}[];loadedAt?:number;
  market:{state:string;side:BrainSide|null;confidence:number;sentence:string;at:number;restored?:boolean;allowed:{pb:string;label:string;side:BrainSide}[]}|null;
  marketTimeline?:{at:number;state:string;side:BrainSide|null;sentence:string}[];
  board?:{symbol:string;capital:string;emotion:string;crowd:string|null;strength:number;why:string;action:{pb:string;label:string;side:BrainSide}|null;noTrade:string|null;ev:BrainEv}[];
  positions?:{id:string;symbol:string;side:BrainSide;entry:number;stop:number;openedAt:number;living:boolean;playbook:string|null;intent:string|null;story:string|null;
    evidence:string|null;invalidation:string|number|null;hold:string|null;holdAt:number|null}[];
  thesis:{sentence:string;structure:string;side:string|null;since:number;playbooks:string[]}|null;
  probes?:{probe:string;label:string;score:number;t:number;n:number;modulator:number}[];
  fast:{state:string;side:BrainSide|null;reason:string|null;flow?:{real:boolean|null;kind:string;why?:string}|null;episodes:number;surges7d?:number;
    last?:{id:string;side:BrainSide;end:string|null;alertAt:number;after15:number|null}[]};
  watches:{symbol:string;side:BrainSide;pb:string;expiresAt:number;reason:string|null;intent?:string|null;why?:string|null;zone?:[number,number];invalidation?:number}[];
  selfCheck?:{byPlaybook:{pb:string;label:string;n:number;winRate:number;avgR:number}[];fast:{alerts:number;fake:number;confirmed:number;follow30:number[]};intentReads:Record<string,number>};
  decisions?:Record<string,unknown>[];
  basket:number;flowSymbols?:number;lastFeedAt:number;flowAt?:number;cpu:{planMs:number;maxPlanMs:number;hubMs:number};writesToday:number;lastError:string|null};

export const BRAIN_KEY="brain-status";
export const BRAIN_POLL_MS=30_000;
export async function fetchBrain():Promise<BrainStatus>{return await operatorRequest<BrainStatus>("/api/living/status");}
/** What may stay on the device: the read itself. No error text, no raw log rows. */
export function persistBrain(v:BrainStatus|null){
  if(!v||typeof v!=="object")return null;
  const {lastError:_e,...rest}=v as BrainStatus&{recent?:unknown};void _e;
  return {...rest,recent:undefined,lastError:null,decisions:(v.decisions??[]).slice(0,30)};
}
export function prefetchBrain(scope:string){prefetchPanel(scope,BRAIN_KEY,fetchBrain,persistBrain,20_000);}

/** Cached brain status: instant from the device, refreshed in the background, every 30s only while the page is visible. */
export function useBrain(scope:string,enabled:boolean){
  const panel=usePanel<BrainStatus>(scope,BRAIN_KEY,fetchBrain,{persist:persistBrain,fresh:20_000,enabled});
  const {refresh}=panel;
  const tick=useCallback(()=>{if(typeof document!=="undefined"&&document.hidden)return;void refresh().catch(()=>undefined);},[refresh]);
  useEffect(()=>{
    if(!enabled)return;
    const id=setInterval(tick,BRAIN_POLL_MS);
    const vis=()=>{if(!document.hidden)tick();};document.addEventListener("visibilitychange",vis);
    return()=>{clearInterval(id);document.removeEventListener("visibilitychange",vis);};
  },[enabled,tick]);
  return panel;
}

export const MODE_LABEL:Record<BrainMode,string>={"off":"关闭","compute-only":"只计算","paper-enabled":"作用于模拟盘"};
export const STATE_LABEL:Record<string,string>={RISK_ON:"资金在进攻",RISK_OFF:"资金在撤退",SQUEEZE:"逼空中",PANIC:"恐慌踩踏",CAPITULATION:"投降式出清",FOMO:"追涨情绪",
  COMPLACENT:"安逸拥挤",CALM:"平静",MIXED:"分歧",WARMING:"数据刚接上"};
export const CAPITAL_LABEL:Record<string,string>={DEMAND:"新多进场",SUPPLY:"新空进场",SQUEEZE_UP:"空头被逼平",FLUSH_DOWN:"多头被洗出",ABSORB_BID:"下方有人接",
  ABSORB_ASK:"上方有人压",DRIFT:"无量漂移",UNVERIFIED:"资金未核实",NONE:"无动作"};
export const EMOTION_LABEL:Record<string,string>={FOMO:"追涨",PANIC:"恐慌",CAPITULATION:"投降",EXHAUSTION:"力竭",BLOWOFF:"冲顶",COMPLACENCY:"安逸",CONVICTION:"坚定",CALM:"平静",NONE:"—"};
export const DECISION_LABEL:Record<string,string>={ENTRY:"开单",ENTRY_RECORD:"本该开单（只记录）",RECORD_ONLY:"没开",WATCH:"等位置",EXIT:"出场",EXIT_RECORD:"本该出场（只记录）",
  PROTECT:"保护",PROTECT_RECORD:"本该保护（只记录）",HOLD_CHANGE:"持有判断变了",INTENT_MARKET:"市场判断变了",CLOSED:"平仓",FAST_ALERT:"集体异动",FAST_CONFIRM:"异动确认",
  FAST_END:"异动结束",FAST_FAKE:"异动是假动作",FAST_EXHAUST:"异动力竭",FAST_REVERSED:"异动反转",FAST_TIMEOUT:"异动超时",FAST_SURGE:"只有价格没有资金"};
/** Exit reasons of research-layer trades, in the brain's own words. */
export const BRAIN_EXIT:Record<string,string>={
  LIVING_INTENT_MARKET_FLIP:"市场意图转向，持有理由没了",LIVING_INTENT_GONE:"这个币的资金反了，持有理由没了",LIVING_INTENT_DONE:"目标兑现，落袋",LIVING_INTENT_CLIMAX_TAKE:"利润交给后来追进的人群（追涨杀跌的人接盘），离场",LIVING_DYN_LOCK:"动态锁利：利润回吐到按波动算的允许幅度，离场",LIVING_DYN_REVERSED:"资金反转离场：持有理由连续两分钟反过来了",LIVING_DYN_LOSS_REPAIR:"反弹减亏离场：亏过以后反弹到目标，先走",LIVING_DYN_EXTEND_END:"延长持有到计划时长的 3 倍，离场",LIVING_DYN_EXTEND:"延长持有：利润还在高位",
  LIVING_INTENT_LOCK:"资金反向，锁利润后被打到",LIVING_INTENT_MARKET_LOCK:"市场转向，锁利润后被打到",LIVING_INTENT_GREED_LOCK:"大家开始追（贪婪），锁利润后被打到",
  LIVING_INTENT_FEAR_LOCK:"多头开始踩踏（恐慌），锁利润后被打到",LIVING_THESIS_TIMEOUT:"拿到计划时长，理由没兑现",LIVING_GUARD_STOP:"打到研究层收紧后的保护价",
  LIVING_FAST_LIQ_GUARD:"集体异动：离爆仓太近，先平",LIVING_FAST_TIGHTEN:"集体异动：收紧止损后被打到",LIVING_FAST_CONFIRM_EXIT:"集体异动确认：亏着的单平掉",
  LIVING_FAST_BREAKEVEN:"集体异动：拉到保本后被打到",LIVING_FAST_GIVEBACK:"顺势单利润回吐就走",LIVING_FAST_TIME:"快速跟进 10 分钟没走出来",
  LIVING_FAST_FAKE:"集体异动是假动作，平掉",LIVING_BURST_TRAIL:"爆发单：从最好的位置回吐到 70%，锁利离场",LIVING_BURST_BREAKEVEN:"爆发单：浮盈过 0.8% 后回到保本加手续费",LIVING_BURST_MAXHOLD:"爆发单：拿满 4 小时",LIVING_FAST_EXHAUST:"集体异动力竭，平掉",LIVING_THESIS_FLIP:"市场判断反了",LIVING_THESIS_STRUCTURE:"结构破了",
  LIVING_THESIS_BREAKEVEN:"保本后被打到",LIVING_THESIS_UNREWARDED:"这种做法市场不再给钱",
  LIVING_STOP:"打到开仓止损价",LIVING_FALLBACK_TIMEOUT:"大脑暂停期间拿满计划时长 1.5 倍，兜底平掉",
};
export const bj=(ms:number|null|undefined)=>ms?new Date(ms+8*3_600_000).toISOString().slice(5,16).replace("T"," "):"—";
export const pct=(v:number|null|undefined,d=2)=>v==null||!Number.isFinite(v)?"—":`${v>=0?"+":""}${(v*100).toFixed(d)}%`;
export const sideCn=(s:BrainSide|string|null|undefined)=>s==="LONG"?"多":s==="SHORT"?"空":"";
export const coinName=(s:string)=>s.replace("_USDT","");
export const plain=(v:unknown)=>v==null?"":typeof v==="number"?String(Number(v.toPrecision(6))):String(v);
