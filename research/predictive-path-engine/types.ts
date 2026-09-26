export type PredictiveSide="LONG"|"SHORT";
export type DirectionClass=-1|0|1;

export interface GatePathBar{
  symbol:string;
  openTime:number;
  closeTime:number;
  open:number;
  high:number;
  low:number;
  close:number;
  volume:number;
}

export interface FeatureEvidence{
  key:string;
  value:number;
  source:string;
  eventAt:number;
  observedAt:number;
}

export interface FeatureRow{
  symbol:string;
  decisionAt:number;
  features:Record<string,number>;
  evidence:FeatureEvidence[];
}

export interface HorizonLabel{
  horizonMinutes:number;
  labelEndAt:number;
  futureReturnRate:number;
  direction:DirectionClass;
  longMfeRate:number;
  longMaeRate:number;
  shortMfeRate:number;
  shortMaeRate:number;
  terminalPrice:number;
}

export interface FirstTouchSpec{
  id:string;
  rewardRate:number;
  riskRate:number;
  maxMinutes:number;
}

export type FirstTouchOutcome="TARGET"|"RISK"|"AMBIGUOUS"|"NONE"|"CENSORED";

export interface FirstTouchLabel{
  specId:string;
  side:PredictiveSide;
  outcome:FirstTouchOutcome;
  touchedAt:number|null;
}

export interface EntryRegretLabel{
  waitMinutes:number;
  longImprovementRate:number;
  shortImprovementRate:number;
  longBestPrice:number;
  shortBestPrice:number;
}

export interface ReversalHazardSpec{
  id:string;
  activationRate:number;
  reversalRate:number;
  maxMinutes:number;
}

export type ReversalHazardOutcome="REVERSED"|"SURVIVED"|"NOT_ACTIVATED"|"CENSORED";

export interface ReversalHazardLabel{
  specId:string;
  side:PredictiveSide;
  outcome:ReversalHazardOutcome;
  activatedAt:number|null;
  reversedAt:number|null;
}

export interface PredictiveLabels{
  symbol:string;
  decisionAt:number;
  entryPrice:number;
  maxLabelEndAt:number;
  horizons:HorizonLabel[];
  firstTouch:FirstTouchLabel[];
  entryRegret:EntryRegretLabel[];
  reversalHazard:ReversalHazardLabel[];
}

export interface PredictiveDatasetRow{
  feature:FeatureRow;
  labels:PredictiveLabels;
}

export interface WalkForwardSample{
  decisionAt:number;
  maxLabelEndAt:number;
}

export interface WalkForwardFold<T extends WalkForwardSample>{
  id:number;
  train:T[];
  validation:T[];
  test:T[];
  trainStart:number;
  trainEnd:number;
  validationStart:number;
  validationEnd:number;
  testStart:number;
  testEnd:number;
}
