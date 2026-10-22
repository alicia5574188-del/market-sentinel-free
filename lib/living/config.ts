/**
 * Living research layer (spec /workspace/living_research/spec.md, C7/C8): version, master switch, per-item flags and
 * every initial threshold in one place. Stored in its own key (living:v1:config), never inside the 4MB forward state.
 *
 * Modes:
 *  - off           : nothing new runs and advanceForward gets no living input (decisions identical to a38882f4).
 *  - compute-only  : everything is computed and logged; advanceForward still gets no living input.
 *  - paper-enabled : the enabled items act on the PAPER account only. Live switch, Gate orders: never touched.
 */
export const LIVING_VERSION="living-v2" as const;
export const LIVING_RULE_EPOCH="living-v2" as const;
export const LIVING_KEY_PREFIX="living:v1:";
export const LIVING_CONFIG_KEY=`${LIVING_KEY_PREFIX}config`;
/** Every own value stays at or below this (same rule as market-intelligence shadow research). */
export const LIVING_MAX_VALUE_BYTES=96*1024;

export type LivingMode="off"|"compute-only"|"paper-enabled";
export const LIVING_MODES:readonly LivingMode[]=["off","compute-only","paper-enabled"];
/** C7 items 1-7. */
/** burstLeader (burst-leader-v1): open only on a sudden market-wide burst (1–3 leaders, 1.5% risk, wide stop, burst hold); every
 * other entry is recorded only. */
export const LIVING_ITEMS=["fastProtect","fastFollow","newSource","noChase","liqSafety","thesisExit","sizing","burstLeader"] as const;
export type LivingItem=typeof LIVING_ITEMS[number];
export type LivingItems=Record<LivingItem,boolean>;
export const LIVING_ITEM_LABELS:Record<LivingItem,string>={
  fastProtect:"1 快速保护",fastFollow:"2 快速跟进",newSource:"3 资金意图开单（五步闭环）",noChase:"4 到位置再确认（不追价）",
  liqSafety:"5 维持保证金率≤2%、止损≤爆仓距离40%",thesisExit:"6 持有理由没了就走",sizing:"7 证据倍数仓位",
  burstLeader:"8 只做全市场突然爆发：选 1-3 个领涨币，大仓位宽止损（其它开单只记录）"};

export type LivingConfig={version:typeof LIVING_VERSION;mode:LivingMode;items:LivingItems;updatedAt:number;
  /** First moment paper-enabled acted on the account (run-log rule_epoch boundary). */
  epochStartedAt:number|null;
  /** Automatic fallback to compute-only (module error / stale data), C8. */
  fallback:{at:number;until:number;reason:string}|null};

export const allItems=(on:boolean):LivingItems=>Object.fromEntries(LIVING_ITEMS.map(k=>[k,on])) as LivingItems;
export function defaultLivingConfig(now:number):LivingConfig{
  return {version:LIVING_VERSION,mode:"paper-enabled",items:allItems(true),updatedAt:now,epochStartedAt:null,fallback:null};
}
export function normalizeLivingConfig(raw:unknown,now:number):LivingConfig{
  const base=defaultLivingConfig(now),v=raw as Partial<LivingConfig>|null|undefined;
  if(!v||typeof v!=="object"||(v.version!==LIVING_VERSION&&(v.version as unknown)!=="living-v1"))return base;
  const mode=LIVING_MODES.includes(v.mode as LivingMode)?v.mode as LivingMode:base.mode;
  const items={...base.items};
  for(const k of LIVING_ITEMS)if(typeof v.items?.[k]==="boolean")items[k]=v.items[k];
  const fb=v.fallback&&Number.isFinite(v.fallback.until)&&Number.isFinite(v.fallback.at)?
    {at:v.fallback.at,until:v.fallback.until,reason:String(v.fallback.reason??"").slice(0,200)}:null;
  return {version:LIVING_VERSION,mode,items,updatedAt:Number.isFinite(v.updatedAt)?v.updatedAt!:now,
    epochStartedAt:Number.isFinite(v.epochStartedAt)?v.epochStartedAt!:null,fallback:fb};
}
export type LivingEffective={mode:LivingMode;configured:LivingMode;items:LivingItems;fallback:LivingConfig["fallback"];acting:boolean};
/** What actually runs now: a live fallback turns paper-enabled into compute-only. */
export function effectiveLiving(c:LivingConfig,now:number):LivingEffective{
  const fb=c.fallback&&c.fallback.until>now?c.fallback:null;
  const mode=c.mode==="paper-enabled"&&fb?"compute-only":c.mode;
  return {mode,configured:c.mode,items:{...c.items},fallback:fb,acting:mode==="paper-enabled"};
}
export const FALLBACK_MS=60*60_000;
export function withFallback(c:LivingConfig,now:number,reason:string):LivingConfig{
  if(c.fallback&&c.fallback.until>now)return c;
  return {...c,fallback:{at:now,until:now+FALLBACK_MS,reason:reason.slice(0,200)},updatedAt:now};
}

/** Fast lane (B1-B7) initial values. B7 may move the alert z thresholds by ±0.5 per week (stored offset, not here). */
export const FAST={
  basketSize:60,windows:[30,60,180,300] as const,ringMs:11*60_000,freshMs:6_000,minFresh:45,maxDisagreement:.003,
  breadthMove:.0005,sigmaEveryMs:30_000,sigmaKeep:720,sigmaMinSamples:60,
  sigmaFloor:{30:.00025,60:.0004,180:.0007,300:.0009} as Record<30|60|180|300,number>,
  alertZ60:3.5,alertBeta60:.75,alertMajorZ60:2.5,alertZ30:4,alertBeta30:.80,alertSamples:2,
  confirmWithinMs:120_000,confirmB180:.0035,confirmZ180:3,confirmBeta180:.80,confirmMaxRetrace:.40,
  confirmBtc:.0015,confirmEth:.0025,confirmTopAgree:9,
  fakeWithinMs:5*60_000,fakeRetrace:.60,fakeMinExtreme:.0015,exhaustQuietMs:3*60_000,exhaustNoExtremeMs:5*60_000,exhaustRetrace:.50,
  maxEpisodeMs:20*60_000,cooldownMs:15*60_000,fakeCooldownMs:10*60_000,
  // B4 protection
  liqMoveMultiple:2.5,liqMinDistance:.015,tightenFraction:.5,tightenMin:.0035,confirmMaxRemaining:.006,
  withMoveArm:.01,withMoveGiveback:.40,coinFollowFraction:.5,
  // B5 follow
  followMmr:.02,followSpread:.0006,followVolume:20_000_000,followMax:3,followWindowMs:10*60_000,
  probeBasketRetrace:.25,probeZ60:2,probeCoinNear:.003,probeFraction:1/3,
  pullCoinMin:.30,pullCoinMax:.60,pullBasketMin:.25,pullBasketMax:.50,newExtremeMs:30_000,
  stopMin:.006,stopMax:.015,timeExitMs:10*60_000,timeExitMin:.005,
  pctLow:.60,pctHigh:.90,
  // B7
  bucketEdges:[3,4,5] as const,step2:8,step3:20,worst3:-3,missedMove:.01,fakeShareUp:.60,weekMs:7*24*3_600_000,
} as const;

/** Steps 1-5 initial values (C1-C6). */
export const STEPS={
  cost:2*(.0007+.00025),
  rewardScore:.0010,rewardT:2,rewardN:30,halfLifeShortMs:6*3_600_000,halfLifeLongMs:48*3_600_000,
  persistenceWindowMs:6*3_600_000,persistenceSpanMs:7*24*3_600_000,
  thesisDebounceBars:2,thesisPredictMs:4*3_600_000,
  selectTop:3,selectMin:.5,selectVolume:20_000_000,selectSpread:.0004,selectMmr:.02,
  waitPositionMs:30*60_000,stopMin:.006,stopMax:.020,
  exitUnrewardedT:-1,holdOverrun:1.5,
} as const;

/** Sizing (parent decision): normal = equity x 0.55% (0.65% premium) x 5 x evidence; fast = equity x 0.55% x fast multiple (1..3). */
export const SIZING={
  riskRate:.0055,premiumRiskRate:.0065,normalMultiple:5,
  evidence:{probe:.3,normal:.6,strong:1} as const,
  fastRiskRate:.0055,fastMaxMultiple:3,episodeRiskCap:.02,
  expansion:5,
  mmrMax:.02,stopLiqFraction:.40,liqStopMultiple:1.5,
} as const;
