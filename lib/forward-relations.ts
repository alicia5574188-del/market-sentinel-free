/** Forward-only market-response learning and generated-rule PAPER execution.
 * No legacy strategy import, exchange write, historical outcome preload or dynamic code evaluation.
 * Measurements are market observations, never shadow orders or synthetic fills.
 */
export const FORWARD_VERSION = "forward-relations-v1.0";
export const FORWARD_GRAMMAR = "conditional-response-conjunction-v1";
export const BAR_MS = 300_000;
export const HORIZONS = [15, 60, 180] as const;
export const FEATURES = ["5分钟推进", "15分钟推进", "1小时推进", "路径效率", "成交量变化", "收盘位置", "振幅变化", "相对市场推进"] as const;
export const PAPER_COST = { feeRate: .0007, slippageRate: .00025, fundingAllowancePerDay: .0002,
  assumption: "双边吃单费各7bp＋滑点各2.5bp＋实际买卖价差；资金费为每日2bp不利占位，并非Gate实际结算" };
const COST_FLOOR = .0022, DAY = 86_400_000;
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Quote = { bestBid: number; bestAsk: number; observedAt: number; fresh: boolean; entryReady?: boolean };
export type Contract = { quantoMultiplier: number; leverageMax: number; maintenanceRate: number; minContracts?: number };
export type Frame = { symbol: string; at: number; seenAt: number; price: number; x: number[] };
export type Measurement = Frame & { horizon: number; endAt: number; availableAt: number; response: number; up: number; down: number };
export type Pending = Frame & { horizon: number; dueAt: number };
export type Condition = { feature: number; op: "GE" | "LE"; threshold: number };
export type Rule = { id: string; signature: string; parentId: string | null; version: number; createdAt: number; expiresAt: number;
  status: "EXPERIMENTAL" | "DORMANT"; conditions: Condition[]; side: "LONG" | "SHORT"; horizon: number;
  stopRate: number; armRate: number; givebackRate: number; exitMode: "HORIZON" | "REACTION_DECAY";
  samples: number; trainGroups: number; checkGroups: number; estimatedNetRate: number; priorResponse: number | null;
  recentResponse: number; standardError: number; reason: string; mutation: "CREATE" | "REVISE" | "RECALL";
  grammar: string; liveEligible: false };
export type Trade = { id: string; symbol: string; side: "LONG" | "SHORT"; rule: Rule; openedAt: number; closedAt: number | null;
  status: "OPEN" | "CLOSED"; entryPrice: number; exitPrice: number | null; quantity: number; contracts: number;
  quantoMultiplier: number; notional: number; leverage: number; margin: number; plannedRisk: number; stopPrice: number;
  armPrice: number; favorable: number; adverse: number; lastPrice: number; lastQuoteAt: number; entryFee: number;
  exitFee: number; fundingAllowance: number; grossPnl: number | null; netPnl: number | null; exitReason: string | null;
  relationFailureBars: number; lastRelationBar: number; execution: "REAL_QUOTE_PAPER_MODEL"; liveEligible: false };
export type AuditEvent = { id: string; at: number; kind: "START" | "RULE" | "DORMANT" | "ENTRY" | "EXIT" | "PROTECTION" | "DATA_GAP" | "FIT";
  subject: string; reason: string; detail?: Record<string, string | number | null> };
export type Daily = { day: string; firstAt: number; lastAt: number; startEquity: number; endEquity: number; exactBoundary: boolean };
export type ForwardState = { version: string; startedAt: number; revision: number; lastCycleAt: number; lastFitAt: number;
  lastQuoteCycleAt: number; balance: number; initialEquity: number; peakEquity: number; maxDrawdown: number;
  resolved: number; wins: number; grossPnl: number; fees: number; fundingAllowance: number; turnover: number;
  observations: number; measured: number; invalidated: number; frames: Record<string, Frame>; pending: Record<string, Pending>;
  samples: Measurement[]; rules: Rule[]; positions: Trade[]; history: Trade[]; events: AuditEvent[]; daily: Daily[];
  lastBars: Record<string, number>; lastEntryBars: Record<string, number>; latestReason: string;
  fitDiagnostics: { tested: number; qualified: number; trainGroups: number; checkGroups: number; latestAt: number };
  selectedSymbols: string[]; storage: { persistedAt: number; error: string | null }; liveEligible: false };

const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
const clip = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export function quantile(v: number[], p: number) { const a = [...v].sort((x, y) => x-y); return a.length ? a[Math.min(a.length-1, Math.floor((a.length-1)*p))] : 0; }
const finite = (v: number) => Number.isFinite(v);
const hash = (v: string) => { let h=2166136261; for(let i=0;i<v.length;i++)h=Math.imul(h^v.charCodeAt(i),16777619);return(h>>>0).toString(36); };
const direction = (side: Trade["side"]) => side === "LONG" ? 1 : -1;
const dayKey = (now: number) => new Date(now + 7*3_600_000).toISOString().slice(0,10);
function event(s:ForwardState,now:number,kind:AuditEvent["kind"],subject:string,reason:string,detail?:AuditEvent["detail"]) {
  s.revision++;s.events.unshift({id:`f${s.startedAt}-${s.revision}`,at:now,kind,subject,reason,...(detail?{detail}:{})});s.events=s.events.slice(0,256);
}
export function initialForward(now:number):ForwardState {
  const s:ForwardState={version:FORWARD_VERSION,startedAt:now,revision:0,lastCycleAt:0,lastFitAt:0,lastQuoteCycleAt:0,
    balance:1000,initialEquity:1000,peakEquity:1000,maxDrawdown:0,resolved:0,wins:0,grossPnl:0,fees:0,fundingAllowance:0,turnover:0,
    observations:0,measured:0,invalidated:0,frames:{},pending:{},samples:[],rules:[],positions:[],history:[],events:[],daily:[],
    lastBars:{},lastEntryBars:{},latestReason:"启动真实行情前向实验；旧K线只计算特征，不回填学习收益或模拟订单。",
    fitDiagnostics:{tested:0,qualified:0,trainGroups:0,checkGroups:0,latestAt:0},selectedSymbols:[],storage:{persistedAt:0,error:null},liveEligible:false};
  event(s,now,"START",FORWARD_VERSION,s.latestReason);return s;
}
export function normalizeForward(v:ForwardState|null|undefined,now:number):ForwardState {
  if(!v)return initialForward(now);
  if(v.version!==FORWARD_VERSION||!finite(v.balance)||!Array.isArray(v.positions)||!Array.isArray(v.samples)||!Array.isArray(v.rules)||v.liveEligible!==false)
    throw new Error("前向账户存储格式异常；保留原数据，禁止自动重置");
  return v;
}
export function frameFromCandles(symbol:string,rows:Candle[],now:number):Frame|null {
  const a=rows.filter(r=>r.time*1000+BAR_MS<=now).slice(-25);
  if(a.length<25||a.some((r,i)=>![r.time,r.open,r.high,r.low,r.close,r.volume].every(finite)||r.open<=0||r.close<=0||r.low<=0
    ||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.volume<0||(i>0&&r.time!==a[i-1].time+300)))return null;
  const r=a[24],at=r.time*1000+BAR_MS;if(now-at>11*60_000)return null;
  const scale=Math.max(.0005,quantile(a.slice(0,-1).map(c=>(c.high-c.low)/c.close),.5));
  const changes=a.slice(-7).slice(1).map((c,i)=>Math.abs(c.close/a[a.length-7+i].close-1)),move6=r.close/a[18].close-1;
  const x=[(r.close/r.open-1)/scale,(r.close/a[21].close-1)/(scale*Math.sqrt(3)),(r.close/a[12].close-1)/(scale*Math.sqrt(12)),
    move6/Math.max(changes.reduce((p,c)=>p+c,0),1e-9),Math.log(Math.max(r.volume,1e-9)/Math.max(mean(a.slice(0,-1).map(c=>c.volume)),1e-9)),
    2*(r.close-r.low)/Math.max(r.high-r.low,1e-9)-1,Math.log(Math.max((r.high-r.low)/r.close,1e-9)/scale),0].map(v=>clip(v,-8,8));
  return{symbol,at,seenAt:now,price:r.close,x};
}
export function conditionMatches(x:number[],conditions:Condition[]) {
  return conditions.every(c=>finite(x[c.feature])&&(c.op==="GE"?x[c.feature]>=c.threshold:x[c.feature]<=c.threshold));
}
function clustered(rows:Measurement[],sign:number) {
  const groups=new Map<number,number[]>();for(const r of rows){const k=Math.floor(r.at/(r.horizon*60_000)),a=groups.get(k)??[];a.push(sign*r.response);groups.set(k,a);}
  const values=[...groups.values()].map(mean),m=mean(values),se=values.length>1?Math.sqrt(values.reduce((a,v)=>a+(v-m)**2,0)/(values.length-1)/values.length):Infinity;
  return{mean:m,se,groups:values.length};
}
function ruleCandidate(rows:Measurement[],conditions:Condition[],horizon:number) {
  const ordered=[...rows].sort((a,b)=>a.at-b.at),boundary=ordered[Math.floor(ordered.length*.6)]?.at??0;
  const train=ordered.filter(r=>r.endAt<=boundary&&conditionMatches(r.x,conditions)),check=ordered.filter(r=>r.at>=boundary&&conditionMatches(r.x,conditions));
  const a=clustered(train,1),sign=a.mean>=0?1:-1,b=clustered(check,sign),aa=clustered(train,sign);
  if(train.length<12||check.length<8||aa.groups<3||b.groups<2)return null;
  const net=Math.min(aa.mean,b.mean)-COST_FLOOR-.5*Math.max(aa.se,b.se);if(!(net>0))return null;
  const selected=[...train,...check],favorable=selected.map(r=>sign>0?r.up:r.down),adverse=selected.map(r=>sign>0?r.down:r.up);
  const stopRate=clip(quantile(adverse,.8)*1.15,.003,.10),armRate=Math.max(COST_FLOOR*2,quantile(favorable,.6));
  const givebackRate=clip(quantile(selected.map((r,i)=>Math.max(0,favorable[i]-sign*r.response)),.6),.0025,Math.max(.0025,armRate*.8));
  return{conditions,side:(sign>0?"LONG":"SHORT") as Rule["side"],horizon,stopRate,armRate,givebackRate,
    exitMode:(mean(favorable)>Math.max(.0001,mean(selected.map(r=>sign*r.response)))*1.7?"REACTION_DECAY":"HORIZON") as Rule["exitMode"],
    samples:selected.length,trainGroups:aa.groups,checkGroups:b.groups,estimatedNetRate:net,priorResponse:sign*aa.mean,
    recentResponse:sign*b.mean,standardError:Math.max(aa.se,b.se)};
}
export function synthesizeRules(s:ForwardState,now:number) {
  const candidates:NonNullable<ReturnType<typeof ruleCandidate>>[]=[];let tested=0,trainGroups=0,checkGroups=0;
  for(const h of HORIZONS){
    const rows=s.samples.filter(r=>r.horizon===h&&r.availableAt<=now&&r.endAt<=now&&r.at>=s.startedAt);if(rows.length<36||Math.max(...rows.map(r=>r.endAt))<now-h*60_000-BAR_MS)continue;
    const split=[...rows].sort((a,b)=>a.at-b.at)[Math.floor(rows.length*.6)].at,discovery=rows.filter(r=>r.endAt<=split);
    trainGroups=Math.max(trainGroups,clustered(discovery,1).groups);checkGroups=Math.max(checkGroups,clustered(rows.filter(r=>r.at>=split),1).groups);
    const stumps:NonNullable<ReturnType<typeof ruleCandidate>>[]=[];
    for(let f=0;f<FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const){
      const threshold=Math.round(quantile(discovery.map(r=>r.x[f]),p)*100)/100;tested++;
      const c=ruleCandidate(rows,[{feature:f,op,threshold}],h);if(c)stumps.push(c);
    }
    stumps.sort((a,b)=>b.estimatedNetRate-a.estimatedNetRate);const top=stumps.slice(0,3),pool=[...stumps];
    for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
      if(top[i].conditions[0].feature===top[j].conditions[0].feature)continue;tested++;
      const c=ruleCandidate(rows,[...top[i].conditions,...top[j].conditions],h);if(c)pool.push(c);
    }
    const kept=new Set<string>();for(const c of pool.sort((a,b)=>b.estimatedNetRate-a.estimatedNetRate)){
      const key=`${c.side}:${c.conditions.map(a=>a.feature).sort().join()}`;if(kept.has(key))continue;kept.add(key);candidates.push(c);if(kept.size>=2)break;
    }
  }
  s.lastFitAt=now;s.fitDiagnostics={tested,qualified:candidates.length,trainGroups,checkGroups,latestAt:now};
  const previous=s.rules.filter(r=>r.status==="EXPERIMENTAL");for(const r of previous)r.status="DORMANT";
  for(const c of candidates){
    const signature=hash(JSON.stringify([c.conditions,c.side,c.horizon,c.exitMode]));
    const parent=s.rules.find(r=>r.signature===signature)??previous.find(r=>r.horizon===c.horizon&&r.conditions[0].feature===c.conditions[0].feature);
    const mutation=parent?(parent.signature===signature&&!previous.includes(parent)?"RECALL":"REVISE"):"CREATE";
    const text=c.conditions.map(k=>`${FEATURES[k.feature]}${k.op==="GE"?"≥":"≤"}${k.threshold}`).join(" 且 "),old=parent?.recentResponse??null;
    const reason=`${text} 后${c.horizon}分钟反应${old==null?"形成新证据":`由${(old*100).toFixed(3)}%更新`}${old==null?"为":"至"}${(c.recentResponse*100).toFixed(3)}%；生成${c.side==="LONG"?"多":"空"}向实验，退出采用${c.exitMode==="REACTION_DECAY"?"回吐保护":"反应期限"}。估计不是胜率或盈利保证。`;
    const r:Rule={...c,id:`fr-${s.startedAt}-${s.revision+1}`,signature,parentId:parent?.id??null,version:(parent?.version??0)+1,
      createdAt:now,expiresAt:now+Math.max(60,c.horizon*2)*60_000,status:"EXPERIMENTAL",reason,mutation,grammar:FORWARD_GRAMMAR,liveEligible:false};
    s.rules.unshift(r);event(s,now,"RULE",r.id,reason,{mutation,oldResponse:old,newResponse:r.recentResponse,netEstimate:r.estimatedNetRate,samples:r.samples});
  }
  for(const r of previous)if(!candidates.some(c=>c.horizon===r.horizon&&c.conditions[0].feature===r.conditions[0].feature))
    event(s,now,"DORMANT",r.id,"新样本不再支持原规则的成本后反应；停止它的新开仓，不把失效直接当成反向机会。");
  s.rules=s.rules.slice(0,48);s.latestReason=candidates.length?`生成${candidates.length}条实验规则，等待条件与新鲜买卖价同时成立。`
    :`尚无足够的成本后条件反应：检验${tested}种表达，前段${trainGroups}、后段${checkGroups}个时间组；不会为制造交易强制入场。`;
  event(s,now,"FIT",FORWARD_GRAMMAR,s.latestReason,{tested,qualified:candidates.length,trainGroups,checkGroups});
}
function ingest(s:ForwardState,paths:Record<string,Candle[]>,now:number){
  const frames=Object.entries(paths).flatMap(([sym,rows])=>{const f=frameFromCandles(sym,rows,now);return f&&now-f.at<=180_000?[f]:[];});
  const byAt=new Map<number,Frame[]>();for(const f of frames){const a=byAt.get(f.at)??[];a.push(f);byAt.set(f.at,a);}
  for(const group of byAt.values()){const med=quantile(group.map(f=>f.x[1]),.5);for(const f of group)f.x[7]=clip(f.x[1]-med,-8,8);}
  s.selectedSymbols=frames.map(f=>f.symbol);
  for(const [sym,f]of Object.entries(s.frames))if(now-f.at>DAY&&!s.positions.some(t=>t.symbol===sym)){
    delete s.frames[sym];delete s.lastBars[sym];delete s.lastEntryBars[sym];
  }
  for(const f of frames){
    s.frames[f.symbol]=f;if(f.at<s.startedAt||f.at<=(s.lastBars[f.symbol]??0))continue;
    const rows=paths[f.symbol];s.lastBars[f.symbol]=f.at;
    for(const h of HORIZONS){
      const key=`${f.symbol}:${h}`,p=s.pending[key];
      if(p&&f.at>=p.dueAt){
        const route=rows.filter(r=>r.time*1000>=p.at&&r.time*1000<p.dueAt);
        const complete=route.length===h/5&&route.every((r,i)=>r.time*1000===p.at+i*BAR_MS);
        if(complete){const last=route.at(-1)!;s.samples.push({...p,endAt:p.dueAt,availableAt:now,response:last.close/p.price-1,
          up:Math.max(0,...route.map(r=>r.high/p.price-1)),down:Math.max(0,...route.map(r=>1-r.low/p.price))});s.measured++;}
        else{s.invalidated++;event(s,now,"DATA_GAP",key,"反应区间不连续，作废测量，不插值、不计成交。");}delete s.pending[key];
      }
      if(!s.pending[key]){s.pending[key]={...f,x:[...f.x],horizon:h,dueAt:f.at+h*60_000};s.observations++;}
    }
  }
  s.samples=HORIZONS.flatMap(h=>s.samples.filter(r=>r.horizon===h&&r.availableAt>=now-7*DAY).slice(-384));
  for(const[k,p]of Object.entries(s.pending))if(now-p.dueAt>11*60_000){delete s.pending[k];s.invalidated++;event(s,now,"DATA_GAP",k,"到期后仍无可核对行情，测量作废。");}
}
export function freshQuote(q:Quote|undefined,now:number):q is Quote {
  return!!q&&q.fresh&&[q.bestBid,q.bestAsk,q.observedAt].every(finite)&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now+1000&&now-q.observedAt<=8000;
}
function exitPrice(t:Trade,q:Quote){return(t.side==="LONG"?q.bestBid:q.bestAsk)*(1-direction(t.side)*PAPER_COST.slippageRate);}
export function forwardEquity(s:ForwardState,quotes:Record<string,Quote>,now:number){
  let floating=0,stalePositions=0;for(const t of s.positions){const q=quotes[t.symbol],px=freshQuote(q,now)?exitPrice(t,q):t.lastPrice;
    if(!freshQuote(q,now))stalePositions++;floating+=direction(t.side)*t.quantity*(px-t.entryPrice)-t.quantity*px*PAPER_COST.feeRate
      -t.notional*PAPER_COST.fundingAllowancePerDay*Math.max(0,now-t.openedAt)/DAY;}
  return{equity:s.balance+floating,floating,stalePositions};
}
function closeTrade(s:ForwardState,t:Trade,q:Quote,now:number,reason:string){
  const px=exitPrice(t,q);t.status="CLOSED";t.closedAt=now;t.exitPrice=px;t.exitReason=reason;t.lastPrice=px;t.lastQuoteAt=q.observedAt;
  t.exitFee=t.quantity*px*PAPER_COST.feeRate;t.fundingAllowance=t.notional*PAPER_COST.fundingAllowancePerDay*(now-t.openedAt)/DAY;
  t.grossPnl=direction(t.side)*t.quantity*(px-t.entryPrice);t.netPnl=t.grossPnl-t.entryFee-t.exitFee-t.fundingAllowance;
  s.balance+=t.grossPnl-t.exitFee-t.fundingAllowance;s.fees+=t.exitFee;s.fundingAllowance+=t.fundingAllowance;s.grossPnl+=t.grossPnl;
  s.turnover+=t.quantity*px;s.resolved++;s.wins+=Number(t.netPnl>0);s.history.unshift(t);s.history=s.history.slice(0,80);
  s.lastEntryBars[t.symbol]=Math.max(s.lastEntryBars[t.symbol]??0,s.frames[t.symbol]?.at??Math.floor(now/BAR_MS)*BAR_MS);
  event(s,now,"EXIT",t.id,reason,{netPnl:t.netPnl,entryRule:t.rule.id,holdingMinutes:(now-t.openedAt)/60000});
}
function manage(s:ForwardState,quotes:Record<string,Quote>,now:number){
  for(const t of s.positions){const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const px=exitPrice(t,q),d=direction(t.side),r=d*(px/t.entryPrice-1);t.lastPrice=px;t.lastQuoteAt=q.observedAt;
    if(t.favorable<t.rule.armRate&&r>=t.rule.armRate)event(s,now,"PROTECTION",t.id,"已观测有利反应触及生成的保护启动点；保存状态，原始止损不放宽。",{favorable:r,armRate:t.rule.armRate});
    t.favorable=Math.max(t.favorable,r);t.adverse=Math.max(t.adverse,-r);const f=s.frames[t.symbol];
    if(f&&f.at>t.lastRelationBar){const contrary=s.rules.some(a=>a.status==="EXPERIMENTAL"&&a.expiresAt>now&&a.side!==t.side&&a.horizon===t.rule.horizon&&conditionMatches(f.x,a.conditions));
      t.relationFailureBars=contrary?t.relationFailureBars+1:0;t.lastRelationBar=f.at;}
    const elapsed=now-t.openedAt,reason=r<=-t.rule.stopRate?"保护止损：当前可执行价触及原始风险边界"
      :elapsed>=t.rule.horizon*60_000?"反应期限结束：按生成规则退出"
      :elapsed>=15*60_000&&t.relationFailureBars>=2?"关系变化：连续两根已收盘K线出现相反方向的新证据"
      :t.rule.exitMode==="REACTION_DECAY"&&elapsed>=5*60_000&&t.favorable>=t.rule.armRate&&t.favorable-r>=t.rule.givebackRate?"反应回吐：有利波动后触发生成的回吐边界":null;
    if(reason)closeTrade(s,t,q,now,reason);
  }s.positions=s.positions.filter(t=>t.status==="OPEN");
}
function openTrades(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number){
  const candidates=Object.values(s.frames).flatMap(f=>s.rules.filter(r=>r.status==="EXPERIMENTAL"&&r.createdAt<=now&&r.expiresAt>now
    &&f.at>=s.startedAt&&now-f.at<=11*60_000&&conditionMatches(f.x,r.conditions)).map(r=>({f,r}))).sort((a,b)=>b.r.estimatedNetRate-a.r.estimatedNetRate);
  let blocker="";
  for(const{f,r}of candidates){
    if(s.positions.some(t=>t.symbol===f.symbol)||(s.lastEntryBars[f.symbol]??0)>=f.at)continue;
    const q=quotes[f.symbol],meta=contracts[f.symbol];if(!freshQuote(q,now)||q.entryReady===false){blocker="匹配规则等待新鲜、顺序核对完成的买卖盘口，不按旧K线补成交。";continue;}
    if(!meta||!finite(meta.quantoMultiplier)||meta.quantoMultiplier<=0||!finite(meta.leverageMax)||meta.leverageMax<1||!finite(meta.maintenanceRate)){blocker="等待合约乘数和杠杆元数据";continue;}
    const marked=forwardEquity(s,quotes,now),equity=marked.equity;if(equity<=0){blocker="净值不足，不自动充值或重置";break;}
    if(marked.stalePositions){blocker="已有持仓估值过期，暂停新增风险";break;}
    const spread=(q.bestAsk-q.bestBid)/((q.bestAsk+q.bestBid)/2);if(spread>.0015||r.estimatedNetRate<spread){blocker="价差已吃掉估计净优势";continue;}
    const d=direction(r.side),price=(r.side==="LONG"?q.bestAsk:q.bestBid)*(1+d*PAPER_COST.slippageRate);
    if(d*(price/f.price-1)>r.estimatedNetRate+COST_FLOOR){blocker="预期反应在可成交之前已发生；不追补过去的机会";continue;}
    const gross=s.positions.reduce((a,t)=>a+t.notional,0),risk=s.positions.reduce((a,t)=>a+t.plannedRisk,0),same=s.positions.filter(t=>t.side===r.side).reduce((a,t)=>a+t.plannedRisk,0);
    const budget=Math.min(equity*.015,equity*.10-risk,equity*.065-same),wanted=Math.max(0,Math.min(equity*1.5,equity*4-gross,budget/(r.stopRate+COST_FLOOR)));
    const count=Math.floor(wanted/(price*meta.quantoMultiplier));if(count<Math.max(1,meta.minContracts??1)){blocker="风险额度或最小张数不足";continue;}
    const quantity=count*meta.quantoMultiplier,notional=quantity*price;
    const leverage=Math.max(1,Math.min(meta.leverageMax,Math.ceil(notional/(equity*.2)),Math.floor(.8/(r.stopRate+meta.maintenanceRate+COST_FLOOR)))),margin=notional/leverage;
    if(s.positions.reduce((a,t)=>a+t.margin,0)+margin>equity*.75){blocker="模拟可用保证金不足";continue;}
    const t:Trade={id:`ft-${s.startedAt}-${s.revision+1}`,symbol:f.symbol,side:r.side,rule:structuredClone(r),openedAt:now,closedAt:null,status:"OPEN",
      entryPrice:price,exitPrice:null,quantity,contracts:count,quantoMultiplier:meta.quantoMultiplier,notional,leverage,margin,
      plannedRisk:notional*(r.stopRate+COST_FLOOR),stopPrice:price*(1-d*r.stopRate),armPrice:price*(1+d*r.armRate),favorable:0,adverse:0,
      lastPrice:price,lastQuoteAt:q.observedAt,entryFee:notional*PAPER_COST.feeRate,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,
      relationFailureBars:0,lastRelationBar:f.at,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false};
    s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=notional;s.positions.push(t);s.lastEntryBars[f.symbol]=f.at;
    event(s,now,"ENTRY",t.id,`${f.symbol}按规则${r.id}使用新鲜买卖价模拟成交；不是Gate实盘成交。`,{ruleId:r.id,notional,contracts:count});
  }
  if(blocker)s.latestReason=blocker;else if(s.positions.length)s.latestReason=`管理${s.positions.length}笔前向模拟持仓；原始保护止损不会放宽。`;
}
export function advanceForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;quotes:Record<string,Quote>;contracts:Record<string,Contract>}){
  const{now,paths,quotes,contracts}=input,s=structuredClone(input.state),before=s.revision;
  // Wait for a bounded Top30 refresh after the completed 5-minute boundary.
  const dataDue=!s.lastCycleAt||Math.floor((now-90_000)/BAR_MS)>Math.floor((s.lastCycleAt-90_000)/BAR_MS);
  if(dataDue){ingest(s,paths,now);s.lastCycleAt=now;if(now-s.lastFitAt>=15*60_000)synthesizeRules(s,now);
    for(const r of s.rules)if(r.status==="EXPERIMENTAL"&&r.expiresAt<=now){r.status="DORMANT";event(s,now,"DORMANT",r.id,"证据过期，停止新开仓，等待新反应。");}}
  manage(s,quotes,now);if(dataDue)openTrades(s,quotes,contracts,now);const marked=forwardEquity(s,quotes,now);
  if(!marked.stalePositions){s.peakEquity=Math.max(s.peakEquity,marked.equity);s.maxDrawdown=Math.max(s.maxDrawdown,1-marked.equity/Math.max(s.peakEquity,1e-9));}
  if(dataDue){const k=dayKey(now),a=s.daily.find(d=>d.day===k);if(a){a.endEquity=marked.equity;a.lastAt=now;}else s.daily.push({day:k,firstAt:now,lastAt:now,startEquity:s.daily.at(-1)?.endEquity??s.initialEquity,endEquity:marked.equity,exactBoundary:false});s.daily=s.daily.slice(-400);}
  s.lastQuoteCycleAt=now;return{state:s,changed:dataDue||s.revision!==before};
}
export function forwardWatchSymbols(s:ForwardState,now:number){
  const matched=Object.values(s.frames).filter(f=>now-f.at<11*60_000&&s.rules.some(r=>r.status==="EXPERIMENTAL"&&r.expiresAt>now&&conditionMatches(f.x,r.conditions)));
  return[...new Set([...s.positions.map(p=>p.symbol),...matched.map(f=>f.symbol)])];
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const marked=forwardEquity(s,quotes,now),count=Object.fromEntries(HORIZONS.map(h=>[h,s.samples.filter(r=>r.horizon===h).length]));
  return{version:s.version,grammar:FORWARD_GRAMMAR,mode:"REAL_FEED_PAPER",liveEligible:false,startedAt:s.startedAt,updatedAt:s.lastQuoteCycleAt,
    lastCycleAt:s.lastCycleAt,lastFitAt:s.lastFitAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...marked,
    targetEquity:s.initialEquity*2,netPnl:marked.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,
    fees:s.fees,fundingAllowance:s.fundingAllowance,turnover:s.turnover,observations:s.observations,measured:s.measured,invalidated:s.invalidated,
    pending:Object.keys(s.pending).length,sampleCounts:count,fitDiagnostics:s.fitDiagnostics,rules:s.rules,positions:s.positions,history:s.history,
    events:s.events.slice(0,80),daily:s.daily,marketCount:s.selectedSymbols.length,markets:s.selectedSymbols,latestReason:s.latestReason,storage:s.storage,
    nextCycleAt:s.lastCycleAt?(Math.floor((s.lastCycleAt-90_000)/BAR_MS)+1)*BAR_MS+90_000:now,cost:PAPER_COST,
    boundaries:{scope:"PAPER_ONLY",grammar:"最多两个连续特征条件；方向、期限、止损和回吐退出由新市场反应生成",historyBackfill:false,
      sampleMeaning:"市场条件与后来反应；不是影子订单或连胜晋级",accounting:"新鲜买卖价模拟成交；净值包含退出费用与资金占位",
      risk:"单笔目标风险1.5%，总风险10%，同向6.5%，总名义额4倍；这是初始实验预算，不是最佳仓位结论",
      validation:"前向实验未证明盈利或月翻倍；多重规则筛选存在估计偏差",liquidation:"当前盘口保护，不冒充交易所标记价格强平复现"}};
}
