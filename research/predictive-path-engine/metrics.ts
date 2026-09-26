export function brierScore(probabilities:number[],outcomes:number[]){
  if(probabilities.length!==outcomes.length||!probabilities.length)throw new Error("brier arrays invalid");
  return probabilities.reduce((s,p,i)=>{if(p<0||p>1||!Number.isFinite(p))throw new Error("probability invalid");
    const y=outcomes[i]!;if(y!==0&&y!==1)throw new Error("binary outcome invalid");return s+(p-y)**2;},0)/probabilities.length;
}

export function pinballLoss(predictions:number[],actual:number[],quantile:number){
  if(predictions.length!==actual.length||!predictions.length)throw new Error("pinball arrays invalid");
  if(!(quantile>0&&quantile<1))throw new Error("quantile must be in (0,1)");
  return predictions.reduce((s,p,i)=>{const e=actual[i]!-p;return s+(e>=0?quantile*e:(quantile-1)*e);},0)/predictions.length;
}

export function meanAbsoluteError(predictions:number[],actual:number[]){
  if(predictions.length!==actual.length||!predictions.length)throw new Error("mae arrays invalid");
  return predictions.reduce((s,p,i)=>s+Math.abs(actual[i]!-p),0)/predictions.length;
}

export function calibrationBins(probabilities:number[],outcomes:number[],binCount=10){
  if(probabilities.length!==outcomes.length||!probabilities.length)throw new Error("calibration arrays invalid");
  if(!Number.isInteger(binCount)||binCount<2)throw new Error("binCount invalid");
  const bins=Array.from({length:binCount},(_,i)=>({from:i/binCount,to:(i+1)/binCount,count:0,meanPrediction:0,observedRate:0}));
  probabilities.forEach((p,i)=>{if(p<0||p>1)throw new Error("probability invalid");const y=outcomes[i]!;
    const index=Math.min(binCount-1,Math.floor(p*binCount)),b=bins[index]!;b.count++;b.meanPrediction+=p;b.observedRate+=y;});
  return bins.map(b=>b.count?{...b,meanPrediction:b.meanPrediction/b.count,observedRate:b.observedRate/b.count}:b);
}
