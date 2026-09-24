/**
 * Forward Relation 2.0 — causal market-response learner.
 *
 * Direction is never forecast from a fixed strategy. A relation earns trading
 * authority only after completed, real market responses support it after costs.
 * The lifecycle can withdraw risk early when the *ongoing* response path stops
 * resembling profitable history, but an opposite direction must earn its own
 * mature evidence before it can receive normal risk.
 */
export const FORWARD_RELATION_V2_VERSION="forward-relation-v2";
export const RELATION_HORIZONS=[15,60,180] as const;
export const REACTION_CHECKPOINTS=[5,10,15,30,60,180] as const;
export const RELATION_FEATURES=["5分钟推进","15分钟推进","1小时推进","路径效率","成交量变化","收盘位置","振幅变化","相对市场推进"] as const;
export type RelationHorizon=typeof RELATION_HORIZONS[number];
export type RelationCheckpoint=typeof REACTION_CHECKPOINTS[number];
export type RelationSide="LONG"|"SHORT";
export type RelationStatus="ACTIVE"|"PRESSURED"|"DEGRADED"|"RECOVERING";
export type RelationScope="BASE"|"RECENT";
export type RelationCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type RelationEnvironment={breadth:number;dispersion:number;expansion:number};
export type RelationFrame={symbol:string;at:number;price:number;x:number[];env:RelationEnvironment};
export type RelationPending={symbol:string;at:number;price:number;x:number[];env:RelationEnvironment;horizon:RelationHorizon;dueAt:number};
export type RelationMeasurement={symbol:string;at:number;horizon:RelationHorizon;response:number;up:number;down:number;x:number[];
  env:RelationEnvironment;cp:Partial<Record<RelationCheckpoint,number>>};
export type RelationCondition={feature:number;op:"GE"|"LE";threshold:number};
export type RelationRule={id:string;signature:string;scope:RelationScope;horizon:RelationHorizon;side:RelationSide;conditions:RelationCondition[];
  longNet:number;recentNet:number;standardError:number;samples:number;longGroups:number;recentGroups:number;health:number;status:RelationStatus;
  livePathScore:number;environmentFit:number;stopRate:number;targetRate:number;updatedAt:number;lastQualifiedAt:number;symbols:string[];reason:string};
export type RelationCandidate={symbol:string;ruleId:string;side:RelationSide;horizon:RelationHorizon;status:RelationStatus;health:number;
  score:number;netRate:number;grossRate:number;stopRate:number;environmentFit:number;livePathScore:number;reserve:boolean;reason:string};
export type RelationEngineState={version:typeof FORWARD_RELATION_V2_VERSION;startedAt:number;updatedAt:number;observations:number;measured:number;invalidated:number;
  frames:Record<string,RelationFrame>;pending:Record<string,RelationPending>;samples:RelationMeasurement[];rules:RelationRule[];lastBars:Record<string,number>;
  diagnostics:{markets:number;matureSamples:number;rules:number;active:number;pressured:number;degraded:number;recovering:number;liveAnomalies:number;
    qualified15:number;qualified60:number;qualified180:number;warmup:string}};

const BAR_MS=300_000,DAY=86_400_000,SAMPLE_LIMIT_PER_HORIZON=128,RULE_LIMIT=24;
const COST=.0019;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const median=(v:number[])=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]!:(a[a.length/2-1]!+a[a.length/2]!)/2):0;};
const quantile=(v:number[],p:number)=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)))]!:0;};
const finite=(v:number)=>Number.isFinite(v);
const sign=(side:RelationSide)=>side==="LONG"?1:-1;
const hash=(v:string)=>{let h=2166136261;for(let i=0;i<v.length;i++)h=Math.imul(h^v.charCodeAt(i),16777619);return(h>>>0).toString(36);};
const pendingKey=(symbol:string,horizon:RelationHorizon)=>`${symbol}:${horizon}`;

export function initialRelationEngine(now:number):RelationEngineState{return{version:FORWARD_RELATION_V2_VERSION,startedAt:now,updatedAt:0,
  observations:0,measured:0,invalidated:0,frames:{},pending:{},samples:[],rules:[],lastBars:{},diagnostics:{markets:0,matureSamples:0,rules:0,
    active:0,pressured:0,degraded:0,recovering:0,liveAnomalies:0,qualified15:0,qualified60:0,qualified180:0,warmup:"正在积累第一批真实市场反应"}};}

function valid(c:RelationCandle){return[c.time,c.open,c.high,c.low,c.close,c.volume].every(finite)&&c.time>0&&c.open>0&&c.close>0&&c.low>0
  &&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0;}
function validPath(rows:RelationCandle[],now:number){const a=rows.filter(r=>valid(r)&&r.time*1000+BAR_MS<=now).sort((x,y)=>x.time-y.time).slice(-120);
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
function groups(rows:RelationMeasurement[],side:RelationSide){const d=sign(side),m=new Map<number,Map<string,number[]>>();for(const r of rows){
  const k=Math.floor(r.at/(r.horizon*60_000)),symbols=m.get(k)??new Map<string,number[]>(),cell=symbols.get(r.symbol)??[];cell.push(d*r.response);symbols.set(r.symbol,cell);m.set(k,symbols);}
  return[...m.entries()].sort((a,b)=>a[0]-b[0]).map(([key,symbols])=>({key,symbols:[...symbols.keys()],value:mean([...symbols.values()].map(mean))}));}
function standardError(v:number[]){if(v.length<2)return Infinity;const m=mean(v),variance=v.reduce((n,x)=>n+(x-m)**2,0)/(v.length-1);return Math.sqrt(variance/v.length);}
function routeFor(rows:RelationCandle[],p:RelationPending,untilAt:number){return rows.filter(r=>r.time*1000>=p.at&&r.time*1000<Math.min(p.dueAt,untilAt))
  .sort((a,b)=>a.time-b.time);}
function completeRoute(route:RelationCandle[],p:RelationPending){const n=p.horizon/5;return route.length===n&&route.every((r,i)=>r.time*1000===p.at+i*BAR_MS);}
function measurement(route:RelationCandle[],p:RelationPending):RelationMeasurement{const last=route.at(-1)!,cp:Partial<Record<RelationCheckpoint,number>>={};
  for(const m of REACTION_CHECKPOINTS){if(m>p.horizon)continue;const row=route[m/5-1];if(row)cp[m]=row.close/p.price-1;}
  return{symbol:p.symbol,at:p.at,horizon:p.horizon,response:last.close/p.price-1,up:Math.max(0,...route.map(r=>r.high/p.price-1)),
    down:Math.max(0,...route.map(r=>1-r.low/p.price)),x:[...p.x],env:{...p.env},cp};}
function envFit(rows:RelationMeasurement[],current:RelationEnvironment){if(!rows.length)return .5;const hist={breadth:median(rows.map(r=>r.env.breadth)),
  dispersion:median(rows.map(r=>r.env.dispersion)),expansion:median(rows.map(r=>r.env.expansion))};const distance=Math.abs(current.breadth-hist.breadth)/.65+
    Math.abs(current.dispersion-hist.dispersion)/2.5+Math.abs(current.expansion-hist.expansion)/2.5;return clip(1-distance/3,.2,1);}
function livePathScore(state:RelationEngineState,paths:Record<string,RelationCandle[]>,conditions:RelationCondition[],horizon:RelationHorizon,side:RelationSide,
  history:RelationMeasurement[],now:number){const d=sign(side),scores:{at:number;symbol:string;score:number}[]=[];for(const p of Object.values(state.pending)){
    if(p.horizon!==horizon||!matches(p.x,conditions)||now-p.at<5*60_000)continue;const rows=validPath(paths[p.symbol]??[],now);if(!rows)continue;
    const elapsed=Math.min(horizon,Math.max(5,Math.floor((now-p.at)/(5*60_000))*5)),cp=REACTION_CHECKPOINTS.filter(x=>x<=elapsed&&x<=horizon).at(-1);if(!cp)continue;
    const current=rows.filter(r=>r.time*1000>=p.at&&r.time*1000<p.at+cp*60_000).at(-1);if(!current)continue;const actual=d*(current.close/p.price-1);
    const hist=history.map(r=>d*(r.cp[cp]??NaN)).filter(Number.isFinite),expected=hist.length?median(hist):COST*.5,scale=Math.max(COST,Math.abs(expected));
    scores.push({at:p.at,symbol:p.symbol,score:clip(.55+(actual-expected*.35)/(2.4*scale),0,1)});}
  if(!scores.length)return .65;const byAt=new Map<number,number[]>();for(const r of scores){const a=byAt.get(r.at)??[];a.push(r.score);byAt.set(r.at,a);}const recent=[...byAt.entries()]
    .sort((a,b)=>a[0]-b[0]).slice(-3).map(([,v])=>mean(v));return mean(recent);}
function baseCandidate(rows:RelationMeasurement[],conditions:RelationCondition[],horizon:RelationHorizon){const ordered=rows.filter(r=>r.horizon===horizon&&matches(r.x,conditions)).sort((a,b)=>a.at-b.at);
  if(ordered.length<20)return null;const boundary=ordered[Math.floor(ordered.length*.6)]?.at??0,train=ordered.filter(r=>r.at<=boundary),check=ordered.filter(r=>r.at>boundary);
  if(train.length<12||check.length<8)return null;const trainMean=mean(train.map(r=>r.response)),side:RelationSide=trainMean>=0?"LONG":"SHORT",a=groups(train,side),b=groups(check,side);
  if(a.length<3||b.length<2)return null;const av=a.map(x=>x.value),bv=b.map(x=>x.value),se=Math.max(standardError(av),standardError(bv));if(!finite(se))return null;
  const net=Math.min(mean(av),mean(bv))-COST-.5*se;if(!(net>0))return null;return{side,net,se,selected:[...train,...check],longGroups:a.length+b.length};}
function recentCandidate(rows:RelationMeasurement[],conditions:RelationCondition[]){const matched=rows.filter(r=>r.horizon===15&&matches(r.x,conditions)),gLong=groups(matched,"LONG").slice(-3),
  gShort=groups(matched,"SHORT").slice(-3);if(gLong.length<3)return null;const pick=(side:RelationSide,g:{symbols:string[];value:number}[])=>{
    if(g.some(x=>x.symbols.length<3))return null;const v=g.map(x=>x.value),aligned=v.filter(x=>x>0).length,se=standardError(v),net=mean(v)-COST-.65*se;
    return aligned>=2&&finite(se)&&net>0?{side,net,se}:null;};const a=pick("LONG",gLong),b=pick("SHORT",gShort);if(!a)return b;if(!b)return a;return a.net>=b.net?a:b;}
function ruleFrom(input:{state:RelationEngineState;paths:Record<string,RelationCandle[]>;conditions:RelationCondition[];horizon:RelationHorizon;scope:RelationScope;
  side:RelationSide;net:number;se:number;selected:RelationMeasurement[];longGroups:number;now:number;currentEnv:RelationEnvironment}){
  const {state,paths,conditions,horizon,scope,side,net,se,selected,longGroups,now,currentEnv}=input,g=groups(selected,side),recent=g.slice(-3),recentNet=recent.length?
    mean(recent.map(x=>x.value))-COST-.35*standardError(recent.map(x=>x.value)):net,live=livePathScore(state,paths,conditions,horizon,side,selected,now),fit=envFit(selected,currentEnv);
  const baseQuality=clip(net/Math.max(COST*2,.008)),recentQuality=clip(.5+recentNet/Math.max(COST*4,.012),0,1);let health=clip(.42*baseQuality+.28*recentQuality+.20*live+.10*fit,.12,1);
  const signature=hash(JSON.stringify([scope,horizon,side,conditions])),previous=state.rules.find(r=>r.signature===signature);let status:RelationStatus;
  if((recent.length>=2&&recentNet<-COST*.25&&live<.5)||live<.28)status="DEGRADED";
  else if(recentNet<=0||live<.55||fit<.42)status="PRESSURED";
  else if(previous&&(previous.status==="PRESSURED"||previous.status==="DEGRADED")&&recentNet>COST*.25&&live>=.55)status="RECOVERING";
  else status="ACTIVE";
  if(status==="DEGRADED")health=clip(health,.15,.32);else if(status==="PRESSURED")health=clip(health,.34,.62);else if(status==="RECOVERING")health=clip(health,.5,.80);else health=clip(health,.64,1);
  if(scope==="RECENT")health=Math.min(health,.72);
  const adverse=selected.map(r=>side==="LONG"?r.down:r.up),favorable=selected.map(r=>side==="LONG"?r.up:r.down),stopRate=clip(quantile(adverse,.8)*1.15,.003,.03),
    targetRate=Math.max(.003,quantile(favorable,.6),net+COST),symbols=[...new Set(selected.map(r=>r.symbol))].sort();
  const id=`fr2-${signature}`,lastQualifiedAt=now,reason=`${horizon}分钟${scope==="RECENT"?"近期":"长期"}真实反应｜${status}｜健康${Math.round(health*100)}｜长期净反应${(net*100).toFixed(2)}%｜近期${(recentNet*100).toFixed(2)}%｜路径${Math.round(live*100)}`;
  return{id,signature,scope,horizon,side,conditions,longNet:net,recentNet,standardError:se,samples:selected.length,longGroups,recentGroups:recent.length,health,status,
    livePathScore:live,environmentFit:fit,stopRate,targetRate,updatedAt:now,lastQualifiedAt,symbols,reason} satisfies RelationRule;}

function synthesize(state:RelationEngineState,paths:Record<string,RelationCandle[]>,now:number,currentEnv:RelationEnvironment){const fresh=state.samples.filter(r=>now-r.at<=7*DAY),made:RelationRule[]=[];
  for(const horizon of RELATION_HORIZONS){const rows=fresh.filter(r=>r.horizon===horizon);if(rows.length<20)continue;const discovery=rows.slice(0,Math.max(1,Math.floor(rows.length*.6))),stumps:{conditions:RelationCondition[];base:NonNullable<ReturnType<typeof baseCandidate>>}[]=[];
    for(let f=0;f<RELATION_FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const){const threshold=Math.round(quantile(discovery.map(r=>r.x[f]??0),p)*100)/100,
      conditions=[{feature:f,op,threshold}],base=baseCandidate(rows,conditions,horizon);if(base)stumps.push({conditions,base});}
    stumps.sort((a,b)=>b.base.net-a.base.net);const pool=[...stumps];for(let i=0;i<Math.min(3,stumps.length);i++)for(let j=i+1;j<Math.min(3,stumps.length);j++){
      if(stumps[i]!.conditions[0]!.feature===stumps[j]!.conditions[0]!.feature)continue;const conditions=[...stumps[i]!.conditions,...stumps[j]!.conditions],base=baseCandidate(rows,conditions,horizon);if(base)pool.push({conditions,base});}
    const kept=new Set<string>();for(const row of pool.sort((a,b)=>b.base.net-a.base.net)){const key=`${row.base.side}:${row.conditions.map(c=>c.feature).sort().join(",")}`;if(kept.has(key))continue;kept.add(key);
      made.push(ruleFrom({state,paths,conditions:row.conditions,horizon,scope:"BASE",side:row.base.side,net:row.base.net,se:row.base.se,selected:row.base.selected,
        longGroups:row.base.longGroups,now,currentEnv}));if(kept.size>=3)break;}
  }
  const rows15=fresh.filter(r=>r.horizon===15);if(rows15.length>=12){const discovery=rows15.slice(-Math.min(rows15.length,96)),conditionsPool:RelationCondition[][]=[];
    for(let f=0;f<RELATION_FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const){conditionsPool.push([{feature:f,op,threshold:Math.round(quantile(discovery.map(r=>r.x[f]??0),p)*100)/100}]);}
    for(const conditions of conditionsPool){const rapid=recentCandidate(discovery,conditions);if(!rapid)continue;const selected=discovery.filter(r=>matches(r.x,conditions)).slice(-36);
      made.push(ruleFrom({state,paths,conditions,horizon:15,scope:"RECENT",side:rapid.side,net:rapid.net,se:rapid.se,selected,longGroups:3,now,currentEnv}));}
  }
  const best=new Map<string,RelationRule>();for(const r of made){const key=`${r.horizon}:${r.side}:${r.conditions.map(c=>`${c.feature}${c.op}`).join("-")}`,
    prior=best.get(key);if(!prior||r.health*r.longNet>prior.health*prior.longNet)best.set(key,r);}const next=[...best.values()].sort((a,b)=>b.health*b.longNet-a.health*a.longNet).slice(0,RULE_LIMIT);
  for(const old of state.rules){if(next.some(r=>r.signature===old.signature))continue;if(now-old.lastQualifiedAt>Math.max(3*60*60_000,old.horizon*4*60_000))continue;
    next.push({...old,status:"DEGRADED",health:Math.min(.25,old.health),updatedAt:now,reason:"旧关系未再通过成熟样本验证；仅保留低风险探测，不推导反向"});}
  state.rules=next.sort((a,b)=>b.health*b.longNet-a.health*a.longNet).slice(0,RULE_LIMIT);
}

export function advanceRelationEngine(input:{state?:RelationEngineState|null;paths:Record<string,RelationCandle[]>;now:number}){const state=input.state?.version===FORWARD_RELATION_V2_VERSION?
  structuredClone(input.state):initialRelationEngine(input.now),frames=buildFrames(input.paths,input.now),currentEnv=environment(frames);state.frames=Object.fromEntries(frames.map(f=>[f.symbol,f]));
  let matured=0;for(const f of frames){if(f.at<=(state.lastBars[f.symbol]??0))continue;const rows=validPath(input.paths[f.symbol]??[],input.now);if(!rows)continue;state.lastBars[f.symbol]=f.at;
    for(const horizon of RELATION_HORIZONS){const key=pendingKey(f.symbol,horizon),p=state.pending[key];if(p&&f.at>=p.dueAt){const route=routeFor(rows,p,p.dueAt);
      if(completeRoute(route,p)){state.samples.push(measurement(route,p));state.measured++;matured++;}else state.invalidated++;delete state.pending[key];}
      if(!state.pending[key]){state.pending[key]={symbol:f.symbol,at:f.at,price:f.price,x:[...f.x],env:{...f.env},horizon,dueAt:f.at+horizon*60_000};state.observations++;}}
  }
  state.samples=RELATION_HORIZONS.flatMap(h=>state.samples.filter(r=>r.horizon===h&&input.now-r.at<=7*DAY).sort((a,b)=>a.at-b.at).slice(-SAMPLE_LIMIT_PER_HORIZON));
  if(matured||!state.rules.length)synthesize(state,input.paths,input.now,currentEnv);else if(state.rules.length){
    state.rules=state.rules.map(r=>{const selected=state.samples.filter(x=>x.horizon===r.horizon&&matches(x.x,r.conditions)),live=livePathScore(state,input.paths,r.conditions,r.horizon,r.side,selected,input.now);
      if(live>=r.livePathScore-.08)return{...r,livePathScore:live,updatedAt:input.now};const status:RelationStatus=live<.28?"DEGRADED":"PRESSURED",health=status==="DEGRADED"?Math.min(.30,r.health):Math.min(.60,r.health);
      return{...r,livePathScore:live,status,health,updatedAt:input.now,reason:`进行中真实反应路径偏离历史｜${status}｜路径${Math.round(live*100)}｜不自动反手`};});}
  state.updatedAt=input.now;const counts=(status:RelationStatus)=>state.rules.filter(r=>r.status===status).length,qualified=(h:RelationHorizon)=>state.rules.filter(r=>r.horizon===h).length,
    liveAnomalies=state.rules.filter(r=>r.livePathScore<.45).length;let warmup="关系学习已运行";if(state.samples.length<20)warmup=`冷启动：已成熟${state.samples.length}份真实反应，继续积累`;
  else if(!state.rules.length)warmup=`已有${state.samples.length}份成熟反应，尚无扣成本后稳定关系`;
  state.diagnostics={markets:frames.length,matureSamples:state.samples.length,rules:state.rules.length,active:counts("ACTIVE"),pressured:counts("PRESSURED"),
    degraded:counts("DEGRADED"),recovering:counts("RECOVERING"),liveAnomalies,qualified15:qualified(15),qualified60:qualified(60),qualified180:qualified(180),warmup};return state;}

export function relationCandidates(state:RelationEngineState){const rows:RelationCandidate[]=[];for(const frame of Object.values(state.frames))for(const rule of state.rules){
  if(!matches(frame.x,rule.conditions))continue;const reserve=rule.status!=="ACTIVE"||rule.health<.68,net=Math.max(COST*.15,rule.longNet*clip(.45+.55*rule.health,.2,1)),gross=net+COST,
    edge=net/Math.max(rule.stopRate,COST),score=clip(32+36*rule.health+10*rule.environmentFit+10*rule.livePathScore+12*clip(edge/.8),0,100);
  if(rule.health<.15||!(rule.longNet>0))continue;rows.push({symbol:frame.symbol,ruleId:rule.id,side:rule.side,horizon:rule.horizon,status:rule.status,health:rule.health,
    score,netRate:net,grossRate:gross,stopRate:rule.stopRate,environmentFit:rule.environmentFit,livePathScore:rule.livePathScore,reserve,
    reason:`${rule.reason}｜当前条件再次匹配；${reserve?"降权参与":"正常参与"}`});}
  return rows.sort((a,b)=>Number(b.status==="ACTIVE")-Number(a.status==="ACTIVE")||b.score-a.score||b.netRate-a.netRate);}
