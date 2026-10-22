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
/** burstLeader (burst-leader-v1): open only on a sudden market-wide burst (1–3 leaders, ≤ 0.75% risk since dynamic-v1.3, wide stop, burst hold); every
 * other entry is recorded only. */
/** htfTrend (htf-donch20, C1b): daily trend breakout long — once a day after 00:00 UTC, BTC > 100-day SMA, 20-day closing breakout
 * among the 30 most liquid coins, stop 2×ATR20, 10-day-low trail, 0.75% risk, max 8; its own slots, its own exits. Off = no new
 * daily-breakout entries (open ones keep their stop and daily trail). */
/** dynAllocator (dynamic-v1): the research layer's allocator decides which pool playbooks may open paper trades (and how big) from
 * their shadow trades' good/bad cycles in the current BTC/ETH state. On = pool entries (incl. the daily breakout) only when the
 * allocator allows them; until a pattern is established it allows none (record only). Off = no pool entries except the daily
 * breakout on switch 9 as before. Open pool trades keep their own exits.
 * dynamic-v1.3 (one scheme): burst-leader (8) and the daily breakout (9) are pool members too — with 10 on, their entries need the
 * predictor gate, share the pool slots and are sized ≤ 0.75% by the gate's confidence; their own exits always run. */
export const LIVING_ITEMS=["fastProtect","fastFollow","newSource","noChase","liqSafety","thesisExit","sizing","burstLeader","htfTrend","dynAllocator"] as const;
export type LivingItem=typeof LIVING_ITEMS[number];
export type LivingItems=Record<LivingItem,boolean>;
export const LIVING_ITEM_LABELS:Record<LivingItem,string>={
  fastProtect:"1 快速保护",fastFollow:"2 快速跟进",newSource:"3 资金意图开单（五步闭环）",noChase:"4 到位置再确认（不追价）",
  liqSafety:"5 维持保证金率≤2%、止损≤爆仓距离40%",thesisExit:"6 持有理由没了就走",sizing:"7 证据倍数仓位",
  burstLeader:"8 全市场突然爆发选领涨（打法池成员：每次爆发的前 3 个币都记影子单；开关 10 开着时由预测器决定开不开、风险最多 0.75%；其它普通开单只记录）",
  htfTrend:"9 日线突破做多：BTC 在 100 日均线上时，前 30 大币日线收盘创 20 日新高就做多，止损 2 倍日波动、按 10 日低点跟踪（打法池成员，开关 10 开着时由预测器决定，最多 0.75%）",
  dynAllocator:"10 动态分配（总方案）：所有打法（短线池、爆发选领涨、日线突破）按周期预测器开模拟单——未来 6 小时在赚钱期的概率 ≥58%、预测记录不差，风险 0.125–0.5%（爆发 ≤0.75%），影子交易和预测相反立刻暂停；打法池最多 8 笔、每套 4 笔、一币一笔"};

export type LivingConfig={version:typeof LIVING_VERSION;mode:LivingMode;items:LivingItems;updatedAt:number;
  /** First moment paper-enabled acted on the account (run-log rule_epoch boundary). */
  epochStartedAt:number|null;
  /** Legacy (C8 automatic 1-hour compute-only fallback). Removed: the paper brain never pauses itself any more; a stale coin only
   *  skips its own new entries and an error only skips that tick. Kept as a field (always null) so old stored configs and the UI still read. */
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
  return {version:LIVING_VERSION,mode,items,updatedAt:Number.isFinite(v.updatedAt)?v.updatedAt!:now,
    epochStartedAt:Number.isFinite(v.epochStartedAt)?v.epochStartedAt!:null,fallback:null};// a stored old fallback is dropped on restore
}
export type LivingEffective={mode:LivingMode;configured:LivingMode;items:LivingItems;fallback:LivingConfig["fallback"];acting:boolean};
/** What actually runs now: exactly the configured mode (no automatic pause; paper-enabled always acts). */
export function effectiveLiving(c:LivingConfig,_now:number):LivingEffective{
  return {mode:c.mode,configured:c.mode,items:{...c.items},fallback:null,acting:c.mode==="paper-enabled"};
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
