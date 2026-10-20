/**
 * The only shape the living layer hands to advanceForward (type-only import from forward-relations, so the forward core
 * has no runtime dependency on the living modules). Undefined directive = the a38882f4 code path.
 */
export type LivingKind="N"|"F";
/** Compact note stored on Trade.entryContext.living (kept small: the 4MB forward state carries it). */
export type LivingNote={v:"living-v1";k:LivingKind;pb:string;th:string|null;ep:string|null;ev:"probe"|"normal"|"strong"|"fast";
  mult:number;sc:number|null;t:number|null;n:number|null;per:string|null;rk:number|null;inv:number;ref:number|null;hold:number;why:string;
  /** fast handed off to the normal flow (C5) */ho?:number};
export type LivingTradeAction={tradeId:string;action:"EXIT"|"GUARD"|"HANDOFF";stop?:number;code:string;reason:string;detail?:Record<string,number|string|null>};
export type LivingOrder={id:string;symbol:string;side:"LONG"|"SHORT";stop:number;
  /** fraction of equity risked before the multiple, and the multiple (normal: 5 x evidence; fast: 1..3, probe /3) */
  riskRate:number;multiple:number;kind:LivingKind;episodeId:string|null;
  /** fast trades: equity fraction the whole episode may risk (2%) and what its open trades already risk */
  episodeCap:number|null;
  winner:boolean;note:LivingNote;reason:string};
export type LivingDirective={version:"living-v1";items:{fastProtect:boolean;fastFollow:boolean;newSource:boolean;noChase:boolean;
  liqSafety:boolean;thesisExit:boolean;sizing:boolean};actions:LivingTradeAction[];orders:LivingOrder[];
  /** "note": legacy stage/BTC gates no longer block — the unopened legacy row is kept as a note, the living flow decides. */
  legacyGate:"note"|"open"};
export type LivingResult={opened:{orderId:string;tradeId:string;symbol:string;side:"LONG"|"SHORT";risk:number;notional:number}[];
  rejected:{orderId:string;symbol:string;reason:string}[];applied:{tradeId:string;code:string;action:string}[]};
