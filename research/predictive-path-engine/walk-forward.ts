import type {WalkForwardFold,WalkForwardSample} from "./types.ts";

const DAY=86_400_000;
export interface WalkForwardConfig{
  trainDays:number;
  validationDays:number;
  testDays:number;
  stepDays:number;
  embargoMinutes:number;
  mode?:"ROLLING"|"EXPANDING";
}

function positive(name:string,v:number){if(!Number.isFinite(v)||v<=0)throw new Error(`${name} must be > 0`);}

export function buildPurgedWalkForward<T extends WalkForwardSample>(samples:T[],config:WalkForwardConfig):WalkForwardFold<T>[]{
  positive("trainDays",config.trainDays);positive("validationDays",config.validationDays);positive("testDays",config.testDays);
  positive("stepDays",config.stepDays);if(!Number.isFinite(config.embargoMinutes)||config.embargoMinutes<0)throw new Error("embargoMinutes invalid");
  const rows=[...samples].sort((a,b)=>a.decisionAt-b.decisionAt),first=rows.at(0)?.decisionAt,last=rows.at(-1)?.decisionAt;
  if(first==null||last==null)return[];
  const trainMs=config.trainDays*DAY,valMs=config.validationDays*DAY,testMs=config.testDays*DAY,stepMs=config.stepDays*DAY,
    embargo=config.embargoMinutes*60_000,mode=config.mode??"ROLLING",folds:WalkForwardFold<T>[]=[];
  let anchor=first+trainMs;
  for(let id=0;;id++,anchor+=stepMs){
    const trainEnd=anchor,validationStart=trainEnd+embargo,validationEnd=validationStart+valMs,
      testStart=validationEnd+embargo,testEnd=testStart+testMs;
    if(testEnd>last+1)break;
    const trainStart=mode==="EXPANDING"?first:trainEnd-trainMs;
    const train=rows.filter(r=>r.decisionAt>=trainStart&&r.decisionAt<trainEnd&&r.maxLabelEndAt<validationStart),
      validation=rows.filter(r=>r.decisionAt>=validationStart&&r.decisionAt<validationEnd&&r.maxLabelEndAt<testStart),
      test=rows.filter(r=>r.decisionAt>=testStart&&r.decisionAt<testEnd);
    if(train.length&&validation.length&&test.length)folds.push({id,train,validation,test,trainStart,trainEnd,validationStart,validationEnd,testStart,testEnd});
  }
  return folds;
}

export function assertNoLabelOverlap<T extends WalkForwardSample>(fold:WalkForwardFold<T>){
  if(fold.train.some(r=>r.maxLabelEndAt>=fold.validationStart))throw new Error(`fold ${fold.id} train label overlaps validation`);
  if(fold.validation.some(r=>r.maxLabelEndAt>=fold.testStart))throw new Error(`fold ${fold.id} validation label overlaps test`);
  if(fold.train.some(r=>r.decisionAt>=fold.trainEnd)||fold.validation.some(r=>r.decisionAt<fold.validationStart||r.decisionAt>=fold.validationEnd)
    ||fold.test.some(r=>r.decisionAt<fold.testStart||r.decisionAt>=fold.testEnd))throw new Error(`fold ${fold.id} partition boundaries invalid`);
}
