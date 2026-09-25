/**
 * Forward Path Relation 3.0 — one causal learner for entry and exit.
 *
 * Every completed 5m market frame may start one root observation. A root is
 * evaluated along the same 5/10/15/20/30/45/60m path, so checkpoints are not
 * counted as independent samples. Rules are validated across non-overlapping
 * time groups and carry a learned exit profile into each PAPER trade.
 */
export const FORWARD_RELATION_V2_VERSION="forward-path-relation-v3";
export const RELATION_HORIZONS=[15,30,45,60] as const;
export const REACTION_CHECKPOINTS=[5,10,15,20,30,45,60] as const;
export const RELATION_FEATURES=["5分钟推进","15分钟推进","1小时推进","路径效率","成交量变化","收盘位置","振幅变化","相对市场推进"] as const;
export type RelationHorizon=typeof RELATION_HORIZONS[number];
export type RelationCheckpoint=typeof REACTION_CHECKPOINTS[number];
export type RelationSide="LONG"|"SHORT";
export type RelationStatus="ACTIVE"|"PRESSURED"|"DEGRADED"|"RECOVERING";
export type RelationScope="BASE"|"RECENT";
export type RelationCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type RelationEnvironment={breadth:number;dispersion:number;expansion:number};
export type RelationFrame={symbol:string;at:number;price:number;x:number[];env:RelationEnvironment};
export type RelationPending={symbol:string;at:number;price:number;x:number[];env:RelationEnvironment;dueAt:number};
export type RelationMeasurement={symbol:string;at:number;response:number;up:number;down:number;x:number[];env:RelationEnvironment;
  cp:Partial<Record<RelationCheckpoint,number>>;upAt:Partial<Record<RelationHorizon,number>>;
  downAt:Partial<Record<RelationHorizon,number>>;relativeAt:Partial<Record<RelationHorizon,number>>;
  pathEfficiency:number;reversals:number};
export type RelationCondition={feature:number;op:"GE"|"LE";threshold:number};
export type RelationExitPoint={expectedRate:number;adverseRate:number;remainingEdgeRate:number};
export type RelationExitProfile={version:"sample-exit-plan-v1";bestHoldMinutes:RelationHorizon;feedbackDeadlineMinutes:number;
  maxHoldMinutes:number;normalAdverseRate:number;targetRate:number;protectionActivationRate:number;retentionRate:number;
  samples:number;groups:number;path:Partial<Record<RelationCheckpoint,RelationExitPoint>>};
export type RelationRule={id:string;signature:string;scope:RelationScope;horizon:RelationHorizon;side:RelationSide;conditions:RelationCondition[];
  longNet:number;recentNet:number;standardError:number;samples:number;longGroups:number;recentGroups:number;health:number;status:RelationStatus;
  livePathScore:number;environmentFit:number;stopRate:number;targetRate:number;exitProfile:RelationExitProfile;
  updatedAt:number;lastQualifiedAt:number;symbols:string[];reason:string};
export type RelationCandidate={symbol:string;ruleId:string;side:RelationSide;horizon:RelationHorizon;status:RelationStatus;health:number;
  score:number;netRate:number;grossRate:number;stopRate:number;environmentFit:number;livePathScore:number;reserve:boolean;
  exitProfile:RelationExitProfile;reason:string};
export type RelationEngineState={version:typeof FORWARD_RELATION_V2_VERSION;startedAt:number;updatedAt:number;observations:number;measured:number;invalidated:number;
  frames:Record<string,RelationFrame>;pending:Record<string,RelationPending>;samples:RelationMeasurement[];rules:RelationRule[];lastBars:Record<string,number>;
  diagnostics:{markets:number;matureSamples:number;effectiveGroups:number;rules:number;active:number;pressured:number;degraded:number;recovering:number;
    liveAnomalies:number;qualified15:number;qualified30:number;qualified45:number;qualified60:number;warmup:string}};

const BAR_MS=300_000,DAY=86_400_000,ROOT_HORIZON_MS=60*60_000,RULE_LIMIT=18,COST=.0019;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const median=(v:number[])=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]!:(a[a.length/2-1]!+a[a.length/2]!)/2):0;};
const quantile=(v:number[],p:number)=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)))]!:0;};
const finite=(v:number)=>Number.isFinite(v);
const sign=(side:RelationSide)=>side==="LONG"?1:-1;
const hash=(v:string)=>{let h=2166136261;for(let i=0;i<v.length;i++)h=Math.imul(h^v.charCodeAt(i),16777619);return(h>>>0).toString(36);};
const rootKey=(symbol:string,at:number)=>symbol+":"+at;
const cpValue=(r:RelationMeasurement,h:number)=>Number(r.cp[h as RelationCheckpoint]);
const directional=(r:RelationMeasurement,h:RelationHorizon,side:RelationSide)=>sign(side)*cpValue(r,h);
const adverseAt=(r:RelationMeasurement,h:RelationHorizon,side:RelationSide)=>side==="LONG"?Number(r.downAt[h]??0):Number(r.upAt[h]??0);
const favorableAt=(r:RelationMeasurement,h:RelationHorizon,side:RelationSide)=>side==="LONG"?Number(r.upAt[h]??0):Number(r.downAt[h]??0);

function blankDiagnostics(){
  return{markets:0,matureSamples:0,effectiveGroups:0,rules:0,active:0,pressured:0,degraded:0,recovering:0,liveAnomalies:0,
    qualified15:0,qualified30:0,qualified45:0,qualified60:0,warmup:"正在积累第一批完整路径样本"};
}
export function initialRelationEngine(now:number):RelationEngineState{return{version:FORWARD_RELATION_V2_VERSION,startedAt:now,updatedAt:0,
  observations:0,measured:0,invalidated:0,frames:{},pending:{},samples:[],rules:[],lastBars:{},diagnostics:blankDiagnostics()};}

function valid(c:RelationCandle){return[c.time,c.open,c.high,c.low,c.close,c.volume].every(finite)&&c.time>0&&c.open>0&&c.close>0&&c.low>0
  &&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0;}
function validPath(rows:RelationCandle[],now:number){const a=rows.filter(r=>valid(r)&&r.time*1000+BAR_MS<=now).sort((x,y)=>x.time-y.time).slice(-180);
  if(a.length<25)return null;for(let i=1;i<a.length;i++)if(a[i]!.time-a[i-1]!.time!==300)return null;return a;}
function rawFrame(symbol:string,rows:RelationCandle[],now:number):RelationFrame|null{const a=validPath(rows,now);if(!a)return null;const w=a.slice(-25),r=w[24]!,at=(r.time+300)*1000;
  if(now-at>11*60_000)return null;const scale=Math.max(.0005,quantile(w.slice(0,-1).map(c=>(c.high-c.low)/c.close),.5));
  const changes=w.slice(-7).slice(1).map((c,i)=>Math.abs(c.close/w[w.length-7+i]!.close-1)),move6=r.close/w[18]!.close-1;
  const x=[(r.close/r.open-1)/scale,(r.close/w[21]!.close-1)/(scale*Math.sqrt(3)),(r.close/w[12]!.close-1)/(scale*Math.sqrt(12)),
    move6/Math.max(changes.reduce((p,c)=>p+c,0),1e-9),Math.log(Math.max(r.volume,1e-9)/Math.max(mean(w.slice(0,-1).map(c=>c.volume)),1e-9)),
    2*(r.close-r.low)/Math.max(r.high-r.low,1e-9)-1,Math.log(Math.max((r.high-r.low)/r.close,1e-9)/scale),0].map(v=>clip(v,-8,8));
  return{symbol,at,price:r.close,x,env:{breadth:.5,dispersion:0,expansion:0}};}
function environment(frames:RelationFrame[]){if(!frames.length)return{breadth:.5,dispersion:0,expansion:0};const med=median(frames.map(f=>f.x[1]??0));
  const breadth=frames.filter(f=>(f.x[1]??0)>0).length/frames.length,dispersion=median(frames.map(f=>Math.abs((f.x[1]??0)-med))),
    expansion=median(frames.map(f=>Math.max(0,f.x[6]??0)));return{breadth,dispersion,expansion};}
function buildFrames(paths:Record<string,RelationCandle[]>,now:number){const frames=Object.entries(paths).flatMap(([symbol,rows])=>{const f=rawFrame(symbol,rows,now);return f?[f]:[];});
  const byAt=new Map<number,RelationFrame[]>();for(const f of frames){const a=byAt.get(f.at)??[];a.push(f);byAt.set(f.at,a);}for(const group of byAt.values()){
    const med=median(group.map(f=>f.x[1]??0));for(const f of group)f.x[7]=clip((f.x[1]??0)-med,-8,8);}const env=environment(frames);for(const f of frames)f.env=env;return frames;}
function matches(x:number[],conditions:RelationCondition[]){return conditions.every(c=>finite(x[c.feature]??NaN)&&(c.op==="GE"?(x[c.feature]??0)>=c.threshold:(x[c.feature]??0)<=c.threshold));}
function routeFor(rows:RelationCandle[],p:RelationPending){return rows.filter(r=>r.time*1000>=p.at&&r.time*1000<p.dueAt).sort((a,b)=>a.time-b.time);}
function contiguousRoute(route:RelationCandle[],p:RelationPending){return route.length>0&&route[0]!.time*1000===p.at&&route.every((r,i)=>i===0||r.time-route[i-1]!.time===300);}
function measurement(route:RelationCandle[],p:RelationPending):RelationMeasurement{
  const cp:Partial<Record<RelationCheckpoint,number>>={},upAt:Partial<Record<RelationHorizon,number>>={},downAt:Partial<Record<RelationHorizon,number>>={};
  let path=0,reversals=0,priorSign=0;for(let i=0;i<route.length;i++){const row=route[i]!,ret=row.close/p.price-1;
    path+=Math.abs(i?row.close/route[i-1]!.close-1:ret);const s=Math.sign(i?row.close/route[i-1]!.close-1:ret);if(s&&priorSign&&s!==priorSign)reversals++;if(s)priorSign=s;
    const minute=(i+1)*5;if(REACTION_CHECKPOINTS.includes(minute as RelationCheckpoint))cp[minute as RelationCheckpoint]=ret;
    if(RELATION_HORIZONS.includes(minute as RelationHorizon)){const prefix=route.slice(0,i+1);upAt[minute as RelationHorizon]=Math.max(0,...prefix.map(r=>r.high/p.price-1));
      downAt[minute as RelationHorizon]=Math.max(0,...prefix.map(r=>1-r.low/p.price));}}
  const response=Number(cp[60]??0),last=route.at(-1)!;return{symbol:p.symbol,at:p.at,response,up:Number(upAt[60]??0),down:Number(downAt[60]??0),
    x:[...p.x],env:{...p.env},cp,upAt,downAt,relativeAt:{},pathEfficiency:Math.abs(response)/Math.max(path,1e-9),reversals};
}
function refreshRelative(rows:RelationMeasurement[]){
  const byAt=new Map<number,RelationMeasurement[]>();for(const r of rows){const a=byAt.get(r.at)??[];a.push(r);byAt.set(r.at,a);}
  for(const group of byAt.values())for(const h of RELATION_HORIZONS){const values=group.map(r=>cpValue(r,h)).filter(Number.isFinite);if(values.length<3)continue;
    const m=median(values);for(const r of group)if(Number.isFinite(cpValue(r,h)))r.relativeAt[h]=cpValue(r,h)-m;}
}
function thinSamples(rows:RelationMeasurement[],now:number){
  const sorted=rows.filter(r=>now-r.at<=48*60*60_000).sort((a,b)=>a.at-b.at),seen=new Set<string>(),out:RelationMeasurement[]=[];
  for(let i=sorted.length-1;i>=0;i--){const r=sorted[i]!,age=now-r.at,bucket=age<=3*60*60_000?5:age<=12*60*60_000?15:60,
      key=r.symbol+":"+Math.floor(r.at/(bucket*60_000));if(seen.has(key))continue;seen.add(key);out.push(r);}
  return out.reverse().slice(-3600);
}
function groupRows(rows:RelationMeasurement[],h:RelationHorizon,side:RelationSide){
  const d=sign(side),m=new Map<number,Map<string,number[]>>();for(const r of rows){const v=cpValue(r,h);if(!Number.isFinite(v))continue;
    const key=Math.floor(r.at/(h*60_000)),symbols=m.get(key)??new Map<string,number[]>(),cell=symbols.get(r.symbol)??[];cell.push(d*v);symbols.set(r.symbol,cell);m.set(key,symbols);}
  return[...m.entries()].sort((a,b)=>a[0]-b[0]).map(([key,symbols])=>({key,symbols:[...symbols.keys()],value:mean([...symbols.values()].map(mean))}));}
function standardError(v:number[]){if(v.length<2)return Infinity;const m=mean(v),variance=v.reduce((n,x)=>n+(x-m)**2,0)/(v.length-1);return Math.sqrt(variance/v.length);}
function envFit(rows:RelationMeasurement[],current:RelationEnvironment){if(!rows.length)return .5;const hist={breadth:median(rows.map(r=>r.env.breadth)),
  dispersion:median(rows.map(r=>r.env.dispersion)),expansion:median(rows.map(r=>r.env.expansion))};const distance=Math.abs(current.breadth-hist.breadth)/.65+
    Math.abs(current.dispersion-hist.dispersion)/2.5+Math.abs(current.expansion-hist.expansion)/2.5;return clip(1-distance/3,.2,1);}
function livePathScore(state:RelationEngineState,paths:Record<string,RelationCandle[]>,conditions:RelationCondition[],side:RelationSide,
  history:RelationMeasurement[],now:number){const d=sign(side),scores:{at:number;score:number}[]=[];for(const p of Object.values(state.pending)){
    if(!matches(p.x,conditions)||now-p.at<5*60_000)continue;const rows=validPath(paths[p.symbol]??[],now);if(!rows)continue;
    const elapsed=Math.min(60,Math.max(5,Math.floor((now-p.at)/(5*60_000))*5)),cp=REACTION_CHECKPOINTS.filter(x=>x<=elapsed).at(-1);if(!cp)continue;
    const current=rows.filter(r=>r.time*1000>=p.at&&r.time*1000<p.at+cp*60_000).at(-1);if(!current)continue;const actual=d*(current.close/p.price-1);
    const hist=history.map(r=>d*Number(r.cp[cp]??NaN)).filter(Number.isFinite),expected=hist.length?median(hist):COST*.5,scale=Math.max(COST,Math.abs(expected));
    scores.push({at:p.at,score:clip(.55+(actual-expected*.35)/(2.4*scale),0,1)});}
  if(!scores.length)return .65;const byAt=new Map<number,number[]>();for(const r of scores){const a=byAt.get(r.at)??[];a.push(r.score);byAt.set(r.at,a);}
  return mean([...byAt.entries()].sort((a,b)=>a[0]-b[0]).slice(-3).map(([,v])=>mean(v)));
}
function baseCandidate(rows:RelationMeasurement[],conditions:RelationCondition[]){
  const matched=rows.filter(r=>matches(r.x,conditions)).sort((a,b)=>a.at-b.at);if(matched.length<24)return null;
  const boundary=matched[Math.floor(matched.length*.6)]?.at??0,train=matched.filter(r=>r.at<=boundary),check=matched.filter(r=>r.at>boundary),choices:any[]=[];
  for(const h of RELATION_HORIZONS){const trainRaw=train.map(r=>cpValue(r,h)).filter(Number.isFinite),side:RelationSide=mean(trainRaw)>=0?"LONG":"SHORT",
      a=groupRows(train,h,side),b=groupRows(check,h,side);if(a.length<3||b.length<2)continue;const av=a.map(x=>x.value),bv=b.map(x=>x.value),
      se=Math.max(standardError(av),standardError(bv));if(!finite(se))continue;const net=Math.min(mean(av),mean(bv))-COST-.5*se;
    if(net>0)choices.push({h,side,net,se,selected:[...train,...check].filter(r=>Number.isFinite(cpValue(r,h))),groups:a.length+b.length});}
  return choices.sort((a,b)=>b.net-a.net)[0]??null;
}
function recentCandidate(rows:RelationMeasurement[],conditions:RelationCondition[]){
  const matched=rows.filter(r=>matches(r.x,conditions)),choices:any[]=[];for(const h of RELATION_HORIZONS)for(const side of["LONG","SHORT"] as const){
    const g=groupRows(matched,h,side).slice(-3);if(g.length<3||g.some(x=>x.symbols.length<3))continue;const v=g.map(x=>x.value),aligned=v.filter(x=>x>0).length,
      se=standardError(v),net=mean(v)-COST-.65*se;if(aligned>=2&&finite(se)&&net>0)choices.push({h,side,net,se,selected:matched.filter(r=>Number.isFinite(cpValue(r,h))).slice(-180),groups:3});}
  return choices.sort((a,b)=>b.net-a.net)[0]??null;
}
function exitProfile(selected:RelationMeasurement[],side:RelationSide,best:RelationHorizon):RelationExitProfile{
  const d=sign(side),usable=selected.filter(r=>Number.isFinite(cpValue(r,best))),winners=usable.filter(r=>directional(r,best,side)>COST),base=winners.length>=8?winners:usable;
  const first=base.map(r=>REACTION_CHECKPOINTS.find(m=>m<=best&&d*Number(r.cp[m]??-Infinity)>COST*.35)??best),
    adverse=base.map(r=>adverseAt(r,best,side)),favorable=base.map(r=>favorableAt(r,best,side)).filter(v=>v>0),
    retention=base.map(r=>{const f=favorableAt(r,best,side);return f>0?clip(Math.max(0,directional(r,best,side))/f,0,1):0;});
  const path:RelationExitProfile["path"]={};for(const cp of REACTION_CHECKPOINTS){if(cp>best)continue;const present=base.filter(r=>Number.isFinite(Number(r.cp[cp]??NaN)));if(!present.length)continue;
    const expected=median(present.map(r=>d*Number(r.cp[cp]!))),adv=cp>=15?quantile(present.map(r=>adverseAt(r,Math.min(best,cp) as RelationHorizon,side)).filter(Number.isFinite),.8):quantile(adverse,.8),
      remaining=median(present.map(r=>d*(cpValue(r,best)-Number(r.cp[cp]!))));
    path[cp]={expectedRate:expected,adverseRate:Math.max(.0015,adv||quantile(adverse,.8)),remainingEdgeRate:remaining};}
  const bestNet=mean(usable.map(r=>directional(r,best,side)))-COST;let maxHold=60;for(const h of RELATION_HORIZONS){if(h<=best)continue;
    const later=usable.map(r=>directional(r,h,side)).filter(Number.isFinite);if(later.length&&mean(later)-COST<Math.max(0,bestNet*.45)){maxHold=h;break;}}
  const target=Math.max(.003,quantile(favorable,.60),median(usable.map(r=>Math.max(0,directional(r,best,side))))+COST);
  return{version:"sample-exit-plan-v1",bestHoldMinutes:best,feedbackDeadlineMinutes:clip(quantile(first,.80),5,Math.min(30,best)),
    maxHoldMinutes:Math.max(best,maxHold),normalAdverseRate:clip(quantile(adverse,.80)*1.10,.003,.03),targetRate:target,
    protectionActivationRate:clip(Math.max(COST*1.2,quantile(favorable,.35)*.65),COST*1.1,Math.max(COST*1.2,target*.75)),
    retentionRate:clip(quantile(retention,.35)+.10,.60,.90),samples:usable.length,groups:groupRows(usable,best,side).length,path};
}
function ruleFrom(input:{state:RelationEngineState;paths:Record<string,RelationCandle[]>;conditions:RelationCondition[];scope:RelationScope;side:RelationSide;
  horizon:RelationHorizon;net:number;se:number;selected:RelationMeasurement[];groups:number;now:number;currentEnv:RelationEnvironment}){
  const {state,paths,conditions,scope,side,horizon,net,se,selected,groups,now,currentEnv}=input,g=groupRows(selected,horizon,side),recent=g.slice(-3),
    recentNet=recent.length?mean(recent.map(x=>x.value))-COST-.35*standardError(recent.map(x=>x.value)):net,
    live=livePathScore(state,paths,conditions,side,selected,now),fit=envFit(selected,currentEnv),profile=exitProfile(selected,side,horizon);
  const baseQuality=clip(net/Math.max(COST*2,.008)),recentQuality=clip(.5+recentNet/Math.max(COST*4,.012),0,1);let health=clip(.42*baseQuality+.28*recentQuality+.20*live+.10*fit,.12,1);
  const signature=hash(JSON.stringify([scope,side,conditions])),previous=state.rules.find(r=>r.signature===signature);let status:RelationStatus;
  if((recent.length>=2&&recentNet<-COST*.25&&live<.5)||live<.28)status="DEGRADED";
  else if(recentNet<=0||live<.55||fit<.42)status="PRESSURED";
  else if(previous&&(previous.status==="PRESSURED"||previous.status==="DEGRADED")&&recentNet>COST*.25&&live>=.55)status="RECOVERING";
  else status="ACTIVE";
  if(status==="DEGRADED")health=clip(health,.15,.32);else if(status==="PRESSURED")health=clip(health,.34,.62);else if(status==="RECOVERING")health=clip(health,.5,.80);else health=clip(health,.64,1);
  if(scope==="RECENT")health=Math.min(health,.72);
  const symbols=[...new Set(selected.map(r=>r.symbol))].sort(),id="fr3-"+signature,
    reason=horizon+"分钟最佳路径｜"+(scope==="RECENT"?"近期":"长期")+"真实反应｜"+status+"｜健康"+Math.round(health*100)+"｜净反应"+(net*100).toFixed(2)+"%｜路径"+Math.round(live*100);
  return{id,signature,scope,horizon,side,conditions,longNet:net,recentNet,standardError:se,samples:selected.length,longGroups:groups,recentGroups:recent.length,
    health,status,livePathScore:live,environmentFit:fit,stopRate:profile.normalAdverseRate,targetRate:profile.targetRate,exitProfile:profile,
    updatedAt:now,lastQualifiedAt:now,symbols,reason} satisfies RelationRule;
}
function synthesize(state:RelationEngineState,paths:Record<string,RelationCandle[]>,now:number,currentEnv:RelationEnvironment){
  const rows=state.samples.filter(r=>now-r.at<=48*60*60_000),made:RelationRule[]=[];if(rows.length<24){state.rules=[];return;}
  const discovery=rows.slice(0,Math.max(1,Math.floor(rows.length*.6))),stumps:{conditions:RelationCondition[];base:any}[]=[];
  for(let f=0;f<RELATION_FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const){const threshold=Math.round(quantile(discovery.map(r=>r.x[f]??0),p)*100)/100,
    conditions=[{feature:f,op,threshold}],base=baseCandidate(rows,conditions);if(base)stumps.push({conditions,base});}
  stumps.sort((a,b)=>b.base.net-a.base.net);const pool=[...stumps];for(let i=0;i<Math.min(4,stumps.length);i++)for(let j=i+1;j<Math.min(4,stumps.length);j++){
    if(stumps[i]!.conditions[0]!.feature===stumps[j]!.conditions[0]!.feature)continue;const conditions=[...stumps[i]!.conditions,...stumps[j]!.conditions],base=baseCandidate(rows,conditions);if(base)pool.push({conditions,base});}
  const kept=new Set<string>();for(const row of pool.sort((a,b)=>b.base.net-a.base.net)){const key=row.base.side+":"+row.conditions.map((c:RelationCondition)=>c.feature).sort().join(",");
    if(kept.has(key))continue;kept.add(key);made.push(ruleFrom({state,paths,conditions:row.conditions,scope:"BASE",side:row.base.side,horizon:row.base.h,net:row.base.net,
      se:row.base.se,selected:row.base.selected,groups:row.base.groups,now,currentEnv}));if(kept.size>=6)break;}
  const recentRows=rows.slice(-Math.min(rows.length,420)),recentPool:RelationCondition[][]=[];for(let f=0;f<RELATION_FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const)
    recentPool.push([{feature:f,op,threshold:Math.round(quantile(recentRows.map(r=>r.x[f]??0),p)*100)/100}]);
  for(const conditions of recentPool){const rapid=recentCandidate(recentRows,conditions);if(!rapid)continue;made.push(ruleFrom({state,paths,conditions,scope:"RECENT",side:rapid.side,
    horizon:rapid.h,net:rapid.net,se:rapid.se,selected:rapid.selected,groups:rapid.groups,now,currentEnv}));}
  const best=new Map<string,RelationRule>();for(const r of made){const key=r.scope+":"+r.side+":"+r.conditions.map(c=>c.feature+c.op).join("-"),prior=best.get(key);
    if(!prior||r.health*r.longNet>prior.health*prior.longNet)best.set(key,r);}
  const next=[...best.values()].sort((a,b)=>b.health*b.longNet-a.health*a.longNet).slice(0,RULE_LIMIT);
  for(const old of state.rules){if(next.some(r=>r.signature===old.signature))continue;if(now-old.lastQualifiedAt>3*60*60_000)continue;
    next.push({...old,status:"DEGRADED",health:Math.min(.25,old.health),updatedAt:now,reason:"旧关系未再通过新路径样本验证；仅保留低风险探测，不推导反向"});}
  state.rules=next.sort((a,b)=>b.health*b.longNet-a.health*a.longNet).slice(0,RULE_LIMIT);
}
function migrateMeasurement(raw:any):RelationMeasurement|null{
  if(!raw||typeof raw!=="object"||typeof raw.symbol!=="string"||!finite(Number(raw.at))||!Array.isArray(raw.x))return null;
  const cp:RelationMeasurement["cp"]={};for(const m of REACTION_CHECKPOINTS){const v=Number(raw.cp?.[m]);if(finite(v))cp[m]=v;}
  const oldH=Number(raw.horizon),response=Number(raw.response);if(finite(response)&&RELATION_HORIZONS.includes(oldH as RelationHorizon))cp[oldH as RelationHorizon]=response;
  const upAt:RelationMeasurement["upAt"]={},downAt:RelationMeasurement["downAt"]={};if(RELATION_HORIZONS.includes(oldH as RelationHorizon)){
    const u=Number(raw.up),d=Number(raw.down);if(finite(u))upAt[oldH as RelationHorizon]=Math.max(0,u);if(finite(d))downAt[oldH as RelationHorizon]=Math.max(0,d);}
  for(const h of RELATION_HORIZONS){const u=Number(raw.upAt?.[h]),d=Number(raw.downAt?.[h]);if(finite(u))upAt[h]=Math.max(0,u);if(finite(d))downAt[h]=Math.max(0,d);}
  if(!Object.keys(cp).length)return null;return{symbol:raw.symbol,at:Number(raw.at),response:finite(Number(cp[60]))?Number(cp[60]):response||0,up:Number(upAt[60]??raw.up??0),
    down:Number(downAt[60]??raw.down??0),x:raw.x.map(Number).slice(0,8),env:{breadth:Number(raw.env?.breadth??.5),dispersion:Number(raw.env?.dispersion??0),expansion:Number(raw.env?.expansion??0)},
    cp,upAt,downAt,relativeAt:{},pathEfficiency:Number(raw.pathEfficiency??0),reversals:Number(raw.reversals??0)};
}
export function normalizeRelationEngine(value:unknown,now:number):RelationEngineState{
  if(!value||typeof value!=="object")return initialRelationEngine(now);const raw=value as any,out=initialRelationEngine(Number(raw.startedAt)>0?Number(raw.startedAt):now);
  out.updatedAt=Number(raw.updatedAt)||0;out.observations=Math.max(0,Number(raw.observations)||0);out.measured=Math.max(0,Number(raw.measured)||0);
  out.invalidated=Math.max(0,Number(raw.invalidated)||0);out.lastBars=raw.lastBars&&typeof raw.lastBars==="object"?{...raw.lastBars}:{};
  out.samples=Array.isArray(raw.samples)?raw.samples.map(migrateMeasurement).filter((x):x is RelationMeasurement=>!!x):[];refreshRelative(out.samples);out.samples=thinSamples(out.samples,now);
  if(raw.version===FORWARD_RELATION_V2_VERSION&&raw.pending&&typeof raw.pending==="object"){for(const [key,p] of Object.entries(raw.pending as Record<string,any>)){
    if(p&&finite(Number(p.at))&&finite(Number(p.dueAt))&&Number(p.dueAt)-Number(p.at)===ROOT_HORIZON_MS)out.pending[key]={symbol:String(p.symbol),at:Number(p.at),price:Number(p.price),x:Array.isArray(p.x)?p.x.map(Number).slice(0,8):[],
      env:{breadth:Number(p.env?.breadth??.5),dispersion:Number(p.env?.dispersion??0),expansion:Number(p.env?.expansion??0)},dueAt:Number(p.dueAt)};}}
  return out;
}
export function advanceRelationEngine(input:{state?:RelationEngineState|null;paths:Record<string,RelationCandle[]>;now:number}){
  const state=normalizeRelationEngine(input.state,input.now),frames=buildFrames(input.paths,input.now),currentEnv=environment(frames);state.frames=Object.fromEntries(frames.map(f=>[f.symbol,f]));
  let matured=0,updated=0;for(const [key,p] of Object.entries(state.pending)){if(input.now<p.at+15*60_000)continue;
    const rows=validPath(input.paths[p.symbol]??[],input.now),route=rows?routeFor(rows,p):[],complete=rows&&contiguousRoute(route,p);
    if(complete&&route.length>=3){const next=measurement(route,p),idx=state.samples.findIndex(r=>r.symbol===p.symbol&&r.at===p.at),
        prior=idx>=0?state.samples[idx]:undefined,firstMature=!prior||!Number.isFinite(Number(prior.cp[15]??NaN));
      if(idx>=0)state.samples[idx]=next;else state.samples.push(next);if(firstMature&&Number.isFinite(Number(next.cp[15]??NaN))){state.measured++;matured++;}else updated++;
      if(route.length>=12)delete state.pending[key];
    } else if(input.now-p.dueAt>15*60_000){state.invalidated++;delete state.pending[key];}}
  for(const f of frames){if(f.at<=(state.lastBars[f.symbol]??0))continue;state.lastBars[f.symbol]=f.at;const key=rootKey(f.symbol,f.at);
    if(!state.pending[key]){state.pending[key]={symbol:f.symbol,at:f.at,price:f.price,x:[...f.x],env:{...f.env},dueAt:f.at+ROOT_HORIZON_MS};state.observations++;}}
  if(matured||updated){refreshRelative(state.samples);state.samples=thinSamples(state.samples,input.now);}
  if(matured||updated||!state.rules.length)synthesize(state,input.paths,input.now,currentEnv);else state.rules=state.rules.map(r=>{const selected=state.samples.filter(x=>matches(x.x,r.conditions)&&Number.isFinite(cpValue(x,r.horizon))),
    live=livePathScore(state,input.paths,r.conditions,r.side,selected,input.now),fit=envFit(selected,currentEnv),weakened=live<r.livePathScore-.08||fit<r.environmentFit-.15||fit<.42;
    if(!weakened)return{...r,livePathScore:live,environmentFit:fit,updatedAt:input.now};const status:RelationStatus=live<.28||fit<.28?"DEGRADED":"PRESSURED",
      health=status==="DEGRADED"?Math.min(.30,r.health):Math.min(.60,r.health);return{...r,livePathScore:live,environmentFit:fit,status,health,updatedAt:input.now,
        reason:"进行中路径/市场环境偏离历史｜"+status+"｜路径"+Math.round(live*100)+"｜环境"+Math.round(fit*100)+"｜不自动反手"};});
  state.updatedAt=input.now;const count=(s:RelationStatus)=>state.rules.filter(r=>r.status===s).length,qualified=(h:RelationHorizon)=>state.rules.filter(r=>r.horizon===h).length,
    groups=new Set(state.samples.map(r=>Math.floor(r.at/(15*60_000)))).size;let warmup="路径学习已运行";if(state.samples.length<24)warmup="冷启动：已成熟"+state.samples.length+"份根样本，继续积累完整路径";
  else if(!state.rules.length)warmup="已有"+state.samples.length+"份路径样本，尚无扣成本后稳定关系";
  state.diagnostics={markets:frames.length,matureSamples:state.samples.length,effectiveGroups:groups,rules:state.rules.length,active:count("ACTIVE"),pressured:count("PRESSURED"),
    degraded:count("DEGRADED"),recovering:count("RECOVERING"),liveAnomalies:state.rules.filter(r=>r.livePathScore<.45).length,qualified15:qualified(15),qualified30:qualified(30),
    qualified45:qualified(45),qualified60:qualified(60),warmup};return state;
}
export function relationCandidates(state:RelationEngineState){const rows:RelationCandidate[]=[];for(const frame of Object.values(state.frames))for(const rule of state.rules){
  if(!matches(frame.x,rule.conditions)||!rule.symbols.includes(frame.symbol))continue;const reserve=rule.scope==="RECENT"||rule.status!=="ACTIVE"||rule.health<.68,
    net=Math.max(COST*.15,rule.longNet*clip(.45+.55*rule.health,.2,1)),gross=net+COST,edge=net/Math.max(rule.stopRate,COST),
    score=clip(32+36*rule.health+10*rule.environmentFit+10*rule.livePathScore+12*clip(edge/.8),0,100);if(rule.health<.15||!(rule.longNet>0))continue;
  rows.push({symbol:frame.symbol,ruleId:rule.id,side:rule.side,horizon:rule.horizon,status:rule.status,health:rule.health,score,netRate:net,grossRate:gross,
    stopRate:rule.stopRate,environmentFit:rule.environmentFit,livePathScore:rule.livePathScore,reserve,exitProfile:structuredClone(rule.exitProfile),
    reason:rule.reason+"｜当前条件再次匹配；"+(reserve?"降权参与":"正常参与")});}
  return rows.sort((a,b)=>Number(b.status==="ACTIVE")-Number(a.status==="ACTIVE")||b.score-a.score||b.netRate-a.netRate);
}
