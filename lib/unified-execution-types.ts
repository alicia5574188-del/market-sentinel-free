import type {ShadowCapsule} from './shadow-inverse-ledger.ts';
import type {ReactionArea} from './winner-policy.ts';

export const UNIFIED_EXECUTION_VERSION='return-continuation-v1';
export type UnifiedBranch='RETURN'|'CONTINUATION';
export type Acceptance={side:'LONG'|'SHORT';at:number;bars:number[];path:'HOLD_OUTSIDE'|'RETEST_RESTART';stop:number;boundary:number;epsilon:number};
export type UnifiedTrade={version:typeof UNIFIED_EXECUTION_VERSION;branch:UnifiedBranch;sourceId:string;referenceId:string;
  entryReason:string;holdReason:string;exitCondition:string;lastDecisionAt:number;lastBarAt:number;
  region:ReactionArea|null;epsilon:number;confirmation:Acceptance|null;initialStop:number|null;
  referenceContracts:number;referenceClosedAt?:number;referenceExitReason?:string|null;
  predecessorId?:string;predecessorNet?:number;decision:'HOLD'|'REVIEW'|'EXIT';
  explanationEvents:{at:number;kind:'ENTRY'|'CONFIRM'|'REDUCE'|'EXIT';reason:string;price:number;quoteAt:number}[];
};
export type UnifiedEpisode={sourceId:string;symbol:string;createdAt:number;region:ReactionArea|null;epsilon:number;
  handled:boolean;converted:boolean;ended:boolean;confirmation:Acceptance|null;continuationSeen?:boolean;lastBarAt:number;reason:string};
export type UnifiedExecution={version:typeof UNIFIED_EXECUTION_VERSION;cutoverAt:number;reference:ShadowCapsule;
  episodes:Record<string,UnifiedEpisode>;legacyIds:string[];completedConversions:number;droppedEpisodes:number};
