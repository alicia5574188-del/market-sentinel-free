/**
 * The only shape the living layer hands to advanceForward (type-only import from forward-relations, so the forward core
 * has no runtime dependency on the living modules). Undefined directive = the a38882f4 code path.
 */
export type LivingKind="N"|"F";
/** Compact note stored on Trade.entryContext.living (kept small: the 4MB forward state carries it). */
export type LivingNote={v:"living-v1"|"living-v2";k:LivingKind;pb:string;th:string|null;ep:string|null;ev:"probe"|"normal"|"strong"|"fast";
  mult:number;sc:number|null;t:number|null;n:number|null;per:string|null;rk:number|null;inv:number;ref:number|null;hold:number;why:string;
  /** fast handed off to the normal flow (C5) */ho?:number;
  /** v2 intent read at entry: capital state / human-nature emotion (e.g. "DEMAND/CONVICTION"), market state, the narrative
   * and the evidence numbers it was made from (price %, OI %, funding, aggressor, volume ratio) */
  in?:string;mk?:string;nar?:string;evd?:string;
  /** Old B1 MIXED probe flag (kept so old trades render). */
  mx?:1;
  /** Layer-1 sizing multiplier when < 1 (MIXED market → 0.5). */
  lm?:number;
  /** v3 environment at entry (Chinese: coin env + market env + why this playbook) and the planned take-profit (sweep-reclaim). */
  env?:string;tg?:number;
  /** burst-leader-v1: managed by the burst hold (lib/living/burst-leader.ts) instead of the fast / dyn / intent exits. */
  bh?:1;
  /** htf-donch20 (lib/living/htf-trend.ts): daily trend breakout. Only its stop / daily trail (and the liquidation guards) close it;
   * `inv` is the initial stop (entry − 2×ATR20), `ref` the 20-day high it broke, `atr` the daily ATR20 at the signal, `cl` the
   * signal-day close, `dy` the signal day (UTC "YYYY-MM-DD"). */
  hx?:1;atr?:number;cl?:number;dy?:string;
  /** dynamic-v1 pool playbook (lib/dynamic/playbooks.ts, id in `pb`): set together with hx (wide stop, own exits, no time exit
   * from the forward core); its stop trail / target / signal / time exits come from the same rule on the venue bars (LIVING_DYN_*).
   * `cf` the allocator's confidence (0.5–1) that scaled its risk. */
  dp?:1;cf?:number;
  /** dynamic-v1.4: the risk rate (fraction of equity) the pool order was sized with, for the pool log's CLOSE record */
  rr?:number;
  /** fixed paper notional (lib/fixed-notional.ts): `fx` the fixed size (U) the order was opened with, `szn` the notional the original
   * formula would have opened, `szr` / `szm` that size's risk / margin when the gates read it (gates "virtual") */
  fx?:number;szn?:number;szr?:number;szm?:number;
  /** dynamic-v1: the signal's time limit in bars of its interval (target is `tg`) */
  mb?:number};
export type LivingTradeAction={tradeId:string;action:"EXIT"|"GUARD"|"HANDOFF";stop?:number;code:string;reason:string;detail?:Record<string,number|string|null>};
export type LivingOrder={id:string;symbol:string;side:"LONG"|"SHORT";stop:number;
  /** fraction of equity risked before the multiple, and the multiple (normal: 5 x evidence; fast: 1..3, probe /3) */
  riskRate:number;multiple:number;kind:LivingKind;episodeId:string|null;
  /** fast trades: equity fraction the whole episode may risk (2%) and what its open trades already risk */
  episodeCap:number|null;
  winner:boolean;note:LivingNote;reason:string};
export type LivingDirective={version:"living-v1"|"living-v2";items:{fastProtect:boolean;fastFollow:boolean;newSource:boolean;noChase:boolean;
  liqSafety:boolean;thesisExit:boolean;sizing:boolean;burstLeader?:boolean;htfTrend?:boolean;dynAllocator?:boolean};actions:LivingTradeAction[];orders:LivingOrder[];
  /** "note": legacy stage/BTC gates no longer block — the unopened legacy row is kept as a note, the living flow decides. */
  legacyGate:"note"|"open"};
export type LivingResult={opened:{orderId:string;tradeId:string;symbol:string;side:"LONG"|"SHORT";risk:number;notional:number}[];
  rejected:{orderId:string;symbol:string;reason:string}[];applied:{tradeId:string;code:string;action:string}[]};
