import type {Opportunity} from './forward-relations.ts';
import type {WinnerPlan,WinnerManagement,ReactionArea} from './winner-policy.ts';
import type {PositionIntelligenceState} from './position-intelligence-engine.ts';
import type {Acceptance,UnifiedBranch} from './unified-execution-types.ts';

export const DIRECT_STRATEGY_VERSION='dual-thesis-v2';
/** Geometric memory on the ACTUAL return position. No companion order or wallet. */
export type ReturnLogic={moveSide:'LONG'|'SHORT';entryPrice:number;openedAt:number;peakAdvance:number;
  firstAdvanceAt:number|null;plan:WinnerPlan;management?:WinnerManagement;assessment?:PositionIntelligenceState;
  entryResidual:number;entryRelativeStrength:number;entryRemainingSpaceRate:number;entryScore:number;validated:boolean;pendingExitReason?:string};
export type DirectPlan={id:string;symbol:string;at:number;quoteAt:number;branch:UnifiedBranch;side:'LONG'|'SHORT';
  phase:'OBSERVE'|'VALIDATING'|'READY'|'HOLDING'|'WAIT_LOCATION'|'EXECUTING';reason:string;holdReason:string;exitCondition:string;
  confirmation:Acceptance|null;region:ReactionArea|null;candidate:Opportunity;continuationSeen?:boolean;consumed?:boolean};
export type DirectMemory={id:string;region:ReactionArea|null;continuationSeen:boolean};
export type DirectStrategy={version:typeof DIRECT_STRATEGY_VERSION;cutoverAt:number;plans:Record<string,DirectPlan>;memory?:Record<string,DirectMemory>;
  marketAuthority?:import('./market-authority.ts').MarketAuthority;
  episodeResearch?:import('./episode-research.ts').EpisodeResearch;
  adaptive?:{version:'adaptive-causal-v1';cutoverAt:number};
  specialMove?:{version:'special-move-v1';cutoverAt:number};
  specialResearch?:import('./special-move.ts').SpecialResearch;
  eventResponse?:{version:'event-response-v1';cutoverAt:number};
  eventResearch?:import('./event-response.ts').EventResearch;
  eventResearchError?:string;
  completedConversions:number;retiredAt:number;summary:string};
