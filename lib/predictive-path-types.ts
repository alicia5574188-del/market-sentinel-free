export const PREDICTIVE_PATH_VERSION="causal-predictive-path-v1";

export const PREDICTIVE_PATH_POLICY={
  directionAcquire:.60,
  directionKeep:.50,
  directionFlip:.62,
  flipBars:2,
  edgeExitProbability:.45,
  minTouch:.56,
  minSources:2,
  maxDisagreement:.012,
  minimumNetEdge:.00035,
  catastrophicStopMin:.005,
  catastrophicStopMax:.03,
} as const;

export type PredictiveSide="LONG"|"SHORT";
export type PredictiveBar={time:number;open:number;high:number;low:number;close:number;volume:number};
export type PredictiveQuote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean;
  sourceCount?:number;disagreementRate?:number;sourceBreadth?:number;directionalAgreement?:number;medianShortMove?:number};
export type PredictiveAncillary={fundingRate?:number;basisRate?:number;openInterest?:number;openInterestChangeRate?:number;
  liquidationLongNotionalRate?:number;liquidationShortNotionalRate?:number;liquidationImbalance?:number;
  takerLongShortLog?:number;accountLongShortLog?:number;topLongShortLog?:number;
  btcReturn15m?:number;btcReturn60m?:number;ethReturn15m?:number;ethReturn60m?:number;marketBreadth?:number};
export type PredictiveFeatureVector={version:typeof PREDICTIVE_PATH_VERSION;symbol:string;decisionAt:number;names:string[];values:number[];
  groups:Record<string,number[]>};

export type PredictiveEvidence={
  price:number;technical:number;derivatives:number;liquidation:number;multiVenue:number;context:number;
  persistence:number;uncertainty:number;
};

export type PredictiveDirectionMemory={
  side:PredictiveSide|null;
  since:number;
  lastBarTime:number;
  oppositeBars:number;
  weakBars:number;
};

export type PredictivePathForecast={
  version:typeof PREDICTIVE_PATH_VERSION;symbol:string;at:number;lastBarTime:number;
  upProbability:{m15:number;m30:number;m60:number;m120:number};
  expectedReturn:{m15:number;m30:number;m60:number;m120:number};
  long:{mfe60:number;mae60:number;targetBeforeRisk60:number;entryRegret10:number;netEv60:number};
  short:{mfe60:number;mae60:number;targetBeforeRisk60:number;entryRegret10:number;netEv60:number};
  crossVenue:{sourceCount:number;agreement:number;breadth:number;disagreementRate:number};
  evidence:PredictiveEvidence;
  rawSide:PredictiveSide|null;
  stableSide:PredictiveSide|null;
  directionProbability:number;
  entryQuality:number;
  enterNow:boolean;
  waitReason:string|null;
  confidence:number;
};

export type PredictiveEngineState={
  version:typeof PREDICTIVE_PATH_VERSION;
  updatedAt:number;
  symbols:Record<string,PredictivePathForecast>;
  directionMemory:Record<string,PredictiveDirectionMemory>;
};
