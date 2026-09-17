/** Online evidence controls. Pure, bounded, and without exchange authority.
 * These estimators are not confidence certificates or independent backtests.
 * Account returns are NEVER clipped: clipping below affects inference only.
 */
import type { Condition, Measurement, Rule, Trade } from "./forward-relations.ts";

export const EVIDENCE_POLICY = "participation-execution-v1.2";
export const PREVIOUS_POLICY = "evidence-calibration-v1.1";
const HOUR = 3_600_000;
const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const clip = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
function q(a: number[], p: number) { const s = [...a].sort((a,b)=>a-b); return s[Math.floor((s.length-1)*p)] ?? 0; }
export function evidenceHash(text: string) { let h=2166136261; for (let i=0;i<text.length;i++) h=Math.imul(h^text.charCodeAt(i),16777619); return (h>>>0).toString(36); }
export const modeledCost = (h: number) => .0022 + .0002 * h / 1440;
export function familyKey(r: Pick<Rule,"horizon"|"side"|"conditions">) {
  // Threshold/version changes must not erase execution feedback or risk exposure.
  return `${r.horizon}:${r.side}:${[...r.conditions].sort((a,b)=>a.feature-b.feature||a.op.localeCompare(b.op)).map(c=>`${c.feature}${c.op}`).join("+")}`;
}
export function matches(x: number[], conditions: Condition[]) {
  return conditions.every(c=>Number.isFinite(x[c.feature])&&(c.op==="GE"?x[c.feature]>=c.threshold:x[c.feature]<=c.threshold));
}
export type Feedback = { id:string; symbol:string; family:string; horizon:number; side:Trade["side"];
  openedAt:number; closedAt:number; notional:number; predictedNet:number; realizedNet:number;
  costRate:number; exitReason:string; policy:string };
export type Calibration = { groups:number; effectiveGroups:number; penalty:number; meanResidual:number;
  meanNet:number; latestAt:number; sourceKey:string };
export type Evidence = { policy:string; scope:"CROSS_ASSET"|"SINGLE_ASSET"; symbols:string[];
  sourceKey:string; family:string; cap:number; rawNet:number; costRate:number; quality:number;
  worstWithoutSymbol:number|null; calibration:Calibration;
  boundedNet?:number; calibratedNet?:number; uncertain?:boolean; warnings?:string[] };
export type Candidate = { conditions:Condition[]; side:Rule["side"]; horizon:number; stopRate:number;
  armRate:number; givebackRate:number; exitMode:Rule["exitMode"]; samples:number; trainGroups:number;
  checkGroups:number; estimatedNetRate:number; priorResponse:number; recentResponse:number;
  standardError:number; evidence:Evidence };
export type EvidenceDiagnostics = { tested:number; qualified:number; insufficient:number; costRejected:number;
  concentrationRejected:number; calibrationRejected:number; applicabilityRejected:number; expired:number;
  concentrationWarnings?:number; calibrationWarnings?:number };
export function blankDiagnostics():EvidenceDiagnostics { return {tested:0,qualified:0,insufficient:0,costRejected:0,
  concentrationRejected:0,calibrationRejected:0,applicabilityRejected:0,expired:0,concentrationWarnings:0,calibrationWarnings:0}; }

export function feedbackFromTrade(t:Trade):Feedback|null {
  if(t.status!=="CLOSED"||t.closedAt==null||t.netPnl==null||!Number.isFinite(t.netPnl)||!(t.notional>0))return null;
  return {id:t.id,symbol:t.symbol,family:familyKey(t.rule),horizon:t.rule.horizon,side:t.side,
    openedAt:t.openedAt,closedAt:t.closedAt,notional:t.notional,
    predictedNet:t.forecast?.baseNetRate??t.rule.evidence?.rawNet??t.rule.estimatedNetRate,
    realizedNet:t.netPnl/t.notional,costRate:(t.entryFee+t.exitFee+t.fundingAllowance)/t.notional,
    exitReason:t.exitReason??"",policy:t.forecast?.policy??"legacy-forward-v1.0"};
}
export function collectFeedback(old:Feedback[],history:Trade[],now:number):Feedback[] {
  const map=new Map(old.map(f=>[f.id,f]));
  for(const t of history){const f=feedbackFromTrade(t);if(f&&f.closedAt<=now&&!map.has(f.id))map.set(f.id,f);}
  return [...map.values()].filter(f=>f.closedAt<=now&&f.closedAt>=now-24*HOUR)
    .sort((a,b)=>a.closedAt-b.closedAt||a.id.localeCompare(b.id)).slice(-192);
}
export function executionCalibration(feedback:Feedback[],family:string,symbols:string[],now:number):Calibration {
  const selected=feedback.filter(f=>f.family===family&&symbols.includes(f.symbol)&&f.closedAt<=now&&f.closedAt>=now-24*HOUR);
  const batches=new Map<number,Feedback[]>();
  for(const f of selected){const key=Math.floor(f.openedAt/(f.horizon*60_000));const a=batches.get(key)??[];a.push(f);batches.set(key,a);}
  let weight=0,residual=0,net=0,latestAt=0;
  for(const batch of batches.values()){
    // Copies across coins in one interval are not independent successes/failures.
    // Tiny leftover orders cannot weigh as much as a full-sized execution.
    const cap=Math.max(1,q(batch.map(f=>f.notional),.5)*2);
    const denominator=batch.reduce((s,f)=>s+Math.min(f.notional,cap),0);
    const closed=Math.max(...batch.map(f=>f.closedAt));
    const w=2**(-(now-closed)/(6*HOUR));
    const r=batch.reduce((s,f)=>s+Math.min(f.notional,cap)*clip(f.realizedNet-f.predictedNet,-.1,.1),0)/denominator;
    const n=batch.reduce((s,f)=>s+Math.min(f.notional,cap)*f.realizedNet,0)/denominator;
    weight+=w;residual+=w*r;net+=w*n;latestAt=Math.max(latestAt,closed);
  }
  const meanResidual=weight?residual/weight:0;
  // A weak first result is shrunk, not a lose-once-disable rule. Past failures
  // decay while fresh market learning continues, avoiding permanent deadlock.
  // Positive past PnL does NOT magnify forecast or leverage. No cost subtraction
  // occurs here: realizedNet already includes the actual PAPER execution costs.
  return {groups:batches.size,effectiveGroups:weight,penalty:Math.max(0,-meanResidual)*weight/(weight+4),
    meanResidual,meanNet:weight?net/weight:0,latestAt,sourceKey:evidenceHash(JSON.stringify(selected.map(f=>f.id).sort()))};
}

function dedup(rows:Measurement[]) {
  const map=new Map<string,Measurement>();
  for(const r of rows){const k=`${r.symbol}:${r.at}:${r.horizon}`;if(!map.has(k))map.set(k,r);}
  return [...map.values()].sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
}
function stats(rows:Measurement[],sign:number,cap:number) {
  const time=new Map<number,Map<string,number[]>>();
  for(const r of rows){const key=Math.floor(r.at/(r.horizon*60_000)),bySymbol=time.get(key)??new Map<string,number[]>();
    const cell=bySymbol.get(r.symbol)??[];cell.push(clip(sign*r.response,-cap,cap));bySymbol.set(r.symbol,cell);time.set(key,bySymbol);}
  const values=[...time.values()].map(cell=>mean([...cell.values()].map(mean))),m=mean(values);
  return {mean:m,groups:values.length,se:values.length>1?Math.sqrt(values.reduce((s,v)=>s+(v-m)**2,0)/(values.length-1)/values.length):Infinity};
}
// Discovery and confidence are distinct. The raw estimate reproduces the
// active baseline's hypothesis test; it is NOT a confidence bound or proof of
// transferable edge. Bounded statistics below score how much to trust it.
export function evidenceQuality(rawNet:number,boundedNet:number,se:number,cost:number,penalty:number) {
  return .5 + .5 * clip((Math.min(rawNet,boundedNet)-penalty)/(cost+se),0,1);
}
export function costAwareGiveback(armRate:number,givebackRate:number,cost:number) {
  return Math.min(givebackRate,Math.max(0,armRate-cost*1.25));
}
export function inspectCondition(input:{rows:Measurement[];conditions:Condition[];horizon:number;now:number;
  feedback:Feedback[];scopeSymbol?:string},diagnostics:EvidenceDiagnostics):Candidate|null {
  const {conditions,horizon,now,feedback,scopeSymbol}=input;diagnostics.tested++;
  const ordered=dedup(input.rows.filter(r=>r.horizon===horizon&&r.endAt<=now&&r.availableAt<=now));
  const boundary=ordered[Math.floor(ordered.length*.6)]?.at??0;
  const eligible=(r:Measurement)=>(!scopeSymbol||r.symbol===scopeSymbol)&&matches(r.x,conditions);
  const train=ordered.filter(r=>r.endAt<=boundary&&eligible(r)),check=ordered.filter(r=>r.at>=boundary&&eligible(r));
  // Clip influence with a scale determined by earlier responses only.
  const cap=Math.min(.1,Math.max(modeledCost(horizon)*2,4*q(train.map(r=>Math.abs(r.response)),.5)));
  const initial=stats(train,1,Infinity),sign=initial.mean>=0?1:-1;
  const a=stats(train,sign,Infinity),b=stats(check,sign,Infinity);
  const boundedA=stats(train,sign,cap),boundedB=stats(check,sign,cap);
  if(train.length<(scopeSymbol?3:12)||check.length<(scopeSymbol?2:8)||a.groups<3||b.groups<2){diagnostics.insufficient++;return null;}
  const selected=[...train,...check],symbols=[...new Set(selected.map(r=>r.symbol))].sort();
  const se=.5*Math.max(a.se,b.se),cost=modeledCost(horizon);
  const rawNet=Math.min(a.mean,b.mean)-cost-se;
  if(!(rawNet>0)){diagnostics.costRejected++;return null;}
  const boundedNet=Math.min(boundedA.mean,boundedB.mean)-cost-.5*Math.max(boundedA.se,boundedB.se);
  let worstWithoutSymbol:number|null=null;
  const warnings:string[]=[];
  if(!scopeSymbol){
    if(symbols.length<3){diagnostics.insufficient++;return null;}
    // Sensitivity is retained as evidence, not a chain of unanimity vetoes.
    // Unknown transferability is explicitly an experimental pooled hypothesis.
    const leave=symbols.map(sym=>{
      const x=stats(train.filter(r=>r.symbol!==sym),sign,cap),y=stats(check.filter(r=>r.symbol!==sym),sign,cap);
      return x.groups>=3&&y.groups>=2?Math.min(x.mean,y.mean):-Infinity;
    });
    const worst=Math.min(...leave);worstWithoutSymbol=Number.isFinite(worst)?worst:null;
    if(worst-cost-se<=0){diagnostics.concentrationWarnings=(diagnostics.concentrationWarnings??0)+1;warnings.push("跨币反应依赖少数样本，作为待验证假设而非通用优势");}
  }
  const applicable=scopeSymbol?[scopeSymbol]:[...new Set(ordered.map(r=>r.symbol))].sort();
  if(!applicable.length){diagnostics.applicabilityRejected++;return null;}
  const side:Rule["side"]=sign>0?"LONG":"SHORT",family=familyKey({horizon,side,conditions});
  const calibration=executionCalibration(feedback,family,applicable,now),net=rawNet-calibration.penalty;
  if(net<=0){diagnostics.calibrationWarnings=(diagnostics.calibrationWarnings??0)+1;warnings.push("实际成交校准为非正，保留实验候选但降低排序与风险，不标作已证实盈利");}
  if(boundedNet<=0)warnings.push("稳健估计尚未支持成本后优势");
  const adverse=selected.map(r=>sign>0?r.down:r.up),favorable=selected.map(r=>sign>0?r.up:r.down);
  const stopRate=clip(q(adverse,.8)*1.15,.003,.10),armRate=Math.max(cost*2,q(favorable,.6));
  const givebackRate=costAwareGiveback(armRate,clip(q(selected.map((r,i)=>Math.max(0,favorable[i]-sign*r.response)),.6),.0025,Math.max(.0025,armRate*.8)),cost);
  const exitMode:Rule["exitMode"]=mean(favorable)>Math.max(.0001,mean(selected.map(r=>sign*r.response)))*1.7?"REACTION_DECAY":"HORIZON";
  const sourceKey=evidenceHash(JSON.stringify([scopeSymbol??"CROSS",applicable,conditions,selected.map(r=>[r.symbol,r.at,r.response,r.up,r.down]),calibration.sourceKey]));
  diagnostics.qualified++;
  return {conditions,side,horizon,stopRate,armRate,givebackRate,exitMode,samples:selected.length,
    trainGroups:a.groups,checkGroups:b.groups,estimatedNetRate:rawNet,priorResponse:sign*a.mean,recentResponse:sign*b.mean,standardError:se,
    evidence:{policy:EVIDENCE_POLICY,scope:scopeSymbol?"SINGLE_ASSET":"CROSS_ASSET",symbols:applicable,sourceKey,family,cap,
      rawNet,boundedNet,calibratedNet:net,uncertain:warnings.length>0,warnings,costRate:cost,
      quality:evidenceQuality(rawNet,boundedNet,se,cost,calibration.penalty),worstWithoutSymbol,calibration}};
}
export function ruleApplies(r:Rule,symbol:string) { return r.evidence?.policy===EVIDENCE_POLICY&&r.evidence.symbols.includes(symbol); }
export function entryEconomics(r:Rule,signalPrice:number,entryPrice:number,spread:number) {
  const cost=r.evidence?.costRate??modeledCost(r.horizon);
  const move=(r.side==="LONG"?1:-1)*(entryPrice/signalPrice-1);
  // Unfavourable movement is not a free better forecast: do not boost it.
  const contextInvalid=move < -Math.max(cost,r.stopRate*.5);
  const remaining=contextInvalid?0:r.estimatedNetRate-Math.max(0,move)-spread;
  return {remaining,contextInvalid,quality:remaining>0?.5+.5*clip(remaining/(cost+r.standardError),0,1):0};
}