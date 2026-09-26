import type {FeatureRow,PredictiveDatasetRow,PredictiveLabels} from "./types.ts";

export function assertCausalFeatureRow(row:FeatureRow){
  if(!row.symbol)throw new Error("feature row symbol required");
  if(!Number.isFinite(row.decisionAt)||row.decisionAt<=0)throw new Error("feature row decisionAt invalid");
  for(const [key,value] of Object.entries(row.features)){
    if(!Number.isFinite(value))throw new Error(`feature ${key} is not finite`);
  }
  for(const e of row.evidence){
    if(!e.key||!e.source)throw new Error("feature evidence key/source required");
    if(!Number.isFinite(e.value)||!Number.isFinite(e.eventAt)||!Number.isFinite(e.observedAt))throw new Error(`feature evidence ${e.key} invalid`);
    if(e.eventAt>e.observedAt)throw new Error(`feature evidence ${e.key} observed before source event`);
    if(e.observedAt>row.decisionAt)throw new Error(`lookahead feature rejected: ${e.key}`);
  }
}

export function joinFeatureAndLabels(feature:FeatureRow,labels:PredictiveLabels):PredictiveDatasetRow{
  assertCausalFeatureRow(feature);
  if(feature.symbol!==labels.symbol||feature.decisionAt!==labels.decisionAt)throw new Error("feature/label identity mismatch");
  if(labels.maxLabelEndAt<=feature.decisionAt)throw new Error("labels do not extend beyond decision");
  return{feature,labels};
}
