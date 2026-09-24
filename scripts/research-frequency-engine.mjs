import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-frequency-12m.json";
const OUTPUT = process.env.FREQUENCY_OUTPUT ?? "/tmp/frequency-engine-research.json";
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || raw.months.length !== 12) throw new Error("Expected a continuous 12-month Gate 5m dataset");

const CORE = ["BTC_USDT","ETH_USDT","SOL_USDT","XRP_USDT","BNB_USDT","DOGE_USDT","ADA_USDT","LINK_USDT","LTC_USDT","AVAX_USDT","BCH_USDT"];
const SYSTEMS = ["SHOCK_TRANSITION","COMPRESSION","DIRECTIONAL_TREND","NON_TREND_EXPANSION","BALANCED_ROTATION"];
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const BASE_SLIPPAGE = 0.00025;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIVE = 300;
const STEPS_PER_HOUR = 12;
const WARMUP_STEPS = 30 * 24 * STEPS_PER_HOUR;

const STRATEGIES = [
  {system:"SHOCK_TRANSITION",id:"shock_transition-aligned_downshock_reversal-14",tactic:"ALIGNED_DOWNSHOCK_REVERSAL",stopFloor:.06,stopAtr:6,rewardRisk:1.5,maxHoldHours:72,params:{symbol24:.08,rebound6:.008},exitModel:"TARGET"},
  {system:"SHOCK_TRANSITION",id:"shock_transition-counter_downshock_survivor-15",tactic:"COUNTER_DOWNSHOCK_SURVIVOR",stopFloor:.06,stopAtr:6,rewardRisk:2.2,maxHoldHours:96,params:{relative24:.05,rebound6:.004},exitModel:"TARGET"},
  {system:"COMPRESSION",id:"compression-false_release-4",tactic:"FALSE_RELEASE",stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:48,params:{volume:1.1,reclaim:.005},exitModel:"TARGET"},
  {system:"COMPRESSION",id:"compression-quiet_pullback_resume-21",tactic:"QUIET_PULLBACK_RESUME",stopFloor:.03,stopAtr:5,rewardRisk:2.2,maxHoldHours:96,params:{relative7:.05,pullbackMin:.003,pullbackMax:.01,resume6:.006},exitModel:"TARGET"},
  {system:"DIRECTIONAL_TREND",id:"directional_trend-bear-market_rebound-12",tactic:"BEAR_MARKET_REBOUND",stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:72,params:{drop24:.05,rebound6:.008},exitModel:"TARGET"},
  {system:"DIRECTIONAL_TREND",id:"directional_trend-bull-relative_momentum-7",tactic:"BULL_RELATIVE_MOMENTUM",stopFloor:.06,stopAtr:6,maxHoldHours:168,params:{relative7:.03,confirm24:.005},exitModel:"TRAIL",trailScale:.8},
  {system:"DIRECTIONAL_TREND",id:"directional_trend-bear-breakdown_trail-2",tactic:"BEAR_BREAKDOWN_TRAIL",stopFloor:.10,stopAtr:8,maxHoldHours:720,params:{symbol30:.08,breadth:.30},exitModel:"TRAIL",trailScale:.6},
  {system:"DIRECTIONAL_TREND",id:"directional_trend-bear-defensive_relative-2",tactic:"BEAR_DEFENSIVE_RELATIVE",stopFloor:.05,stopAtr:5,rewardRisk:1.5,maxHoldHours:72,params:{relative7:.03,confirm6:0},exitModel:"TARGET"},
  {system:"NON_TREND_EXPANSION",id:"non_trend_expansion-refined_breadth_continuation-10",tactic:"REFINED_BREADTH_CONTINUATION",stopFloor:.035,stopAtr:5,rewardRisk:2,maxHoldHours:72,params:{symbol24:.055,impulse6:.003},exitModel:"TARGET"},
  {system:"NON_TREND_EXPANSION",id:"non_trend_expansion-expansion_defender-14",tactic:"EXPANSION_DEFENDER",stopFloor:.05,stopAtr:5,rewardRisk:1.5,maxHoldHours:72,params:{relative24:.04,resume6:.004},exitModel:"TARGET"},
  {system:"BALANCED_ROTATION",id:"balanced_rotation-relative_pullback_resume-4",tactic:"RELATIVE_PULLBACK_RESUME",stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:96,params:{relative7:.04,pullbackMin:.003,pullbackMax:.01,resume6:.006},exitModel:"TARGET"},
  {system:"BALANCED_ROTATION",id:"balanced_rotation-short_horizon_reversal-8",tactic:"SHORT_HORIZON_REVERSAL",stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:72,params:{relative24:.05,reversal6:.003},exitModel:"TARGET"},
];
const BY_SYSTEM = Object.fromEntries(SYSTEMS.map(system => [system, STRATEGIES.filter(s => s.system === system)]));
const sum = xs => xs.reduce((a,b)=>a+b,0);
const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
const median = xs => { if (!xs.length) return 0; const a=[...xs].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
const rangeRate = row => (row.high-row.low)/Math.max(row.close,1e-12);
const monthKey = ms => new Date(ms).toISOString().slice(0,7).replace("-","");

const datasets = new Map(raw.datasets.map(d => [d.symbol, d.rows]));
const AVAILABLE = raw.datasets.map(d => d.symbol);
if (!CORE.every(s => datasets.has(s))) throw new Error("Frequency dataset must include the 11-symbol regime core");
const reference = datasets.get(CORE[0]);
for (const [symbol, rows] of datasets) {
  if (rows.length !== reference.length || rows[0]?.time !== reference[0]?.time || rows.at(-1)?.time !== reference.at(-1)?.time) {
    throw new Error(`${symbol} is not aligned with the reference 5m timeline`);
  }
}

function hourly(rows) {
  const out=[]; let b=null;
  for (const r of rows) {
    const t=Math.floor(r.time/3600)*3600;
    if (!b || b.time!==t) { if (b?.samples===12) out.push(b); b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,samples:1}; }
    else { b.high=Math.max(b.high,r.high); b.low=Math.min(b.low,r.low); b.close=r.close; b.volume+=r.volume; b.samples++; }
  }
  if (b?.samples===12) out.push(b);
  return out.map(({samples,...row})=>row);
}
const hourlyBySymbol = new Map([...datasets].map(([s,rows]) => [s,hourly(rows)]));
const hourRangeBySymbol = new Map([...hourlyBySymbol].map(([s,rows]) => [s,rows.map(rangeRate)]));

function classify(context) {
  const aligned24=Math.max(context.breadth24,1-context.breadth24);
  if (Math.abs(context.median24)>=.04 || (Math.abs(context.median24)>=.02 && aligned24>=.82)) return "SHOCK_TRANSITION";
  if (context.compression<=.68 && Math.abs(context.median24)<.025) return "COMPRESSION";
  if ((context.median30>=.08 && context.median7>=.015 && context.breadth30>=.60)
    || (context.median30<=-.08 && context.median7<=-.015 && context.breadth30<=.40)) return "DIRECTIONAL_TREND";
  if (Math.abs(context.median24)>=.018 || aligned24>=.75) return "NON_TREND_EXPANSION";
  return "BALANCED_ROTATION";
}

const contexts=[];
for (let h=720; h<hourlyBySymbol.get(CORE[0]).length; h++) {
  const fs=[];
  for (const s of CORE) {
    const rows=hourlyBySymbol.get(s); const ranges=hourRangeBySymbol.get(s);
    if (!rows[h] || rows[h].time !== hourlyBySymbol.get(CORE[0])[h].time) continue;
    const r24=rows[h].close/rows[h-24].close-1, r7=rows[h].close/rows[h-168].close-1, r30=rows[h].close/rows[h-720].close-1;
    const compression=median(ranges.slice(h-5,h+1))/Math.max(median(ranges.slice(h-168,h-6)),1e-9);
    fs.push({r24,r7,r30,compression});
  }
  if (fs.length < 8) continue;
  const base={median24:median(fs.map(f=>f.r24)),median7:median(fs.map(f=>f.r7)),median30:median(fs.map(f=>f.r30)),
    breadth24:fs.filter(f=>f.r24>0).length/fs.length,breadth7:fs.filter(f=>f.r7>0).length/fs.length,
    breadth30:fs.filter(f=>f.r30>0).length/fs.length,compression:median(fs.map(f=>f.compression)),markets:fs.length};
  contexts[h]={...base,regime:classify(base),time:hourlyBySymbol.get(CORE[0])[h].time};
}

const volumePrefix = new Map();
for (const [s,rows] of datasets) {
  const p=new Float64Array(rows.length+1);
  for (let i=0;i<rows.length;i++) p[i+1]=p[i]+rows[i].volume;
  volumePrefix.set(s,p);
}
const segmentSum=(p,a,b)=>p[Math.max(0,b+1)]-p[Math.max(0,a)];

class MonoDeque {
  constructor(max=true){this.max=max;this.a=[];this.head=0;}
  push(index,value){while(this.a.length>this.head && (this.max ? this.a.at(-1).v<=value : this.a.at(-1).v>=value)) this.a.pop(); this.a.push({i:index,v:value});}
  trim(minIndex){while(this.head<this.a.length && this.a[this.head].i<minIndex)this.head++; if(this.head>256 && this.head*2>this.a.length){this.a=this.a.slice(this.head);this.head=0;}}
  value(){return this.head<this.a.length?this.a[this.head].v:null;}
}
const rolling = new Map(AVAILABLE.map(s=>[s,{max1:new MonoDeque(true),min1:new MonoDeque(false),max24:new MonoDeque(true),min24:new MonoDeque(false),max7:new MonoDeque(true),min7:new MonoDeque(false)}]));

function signal(config,f){
  const p=config.params;
  if(config.tactic==="ALIGNED_DOWNSHOCK_REVERSAL"){if(f.context.median24>=0||f.context.median30>=0||f.r24>-p.symbol24||f.r6<p.rebound6)return null;return{direction:1,strength:-f.r24+f.r6};}
  if(config.tactic==="COUNTER_DOWNSHOCK_SURVIVOR"){if(f.context.median24>=0||f.context.median30<=0||f.relative24<p.relative24||f.r6<p.rebound6)return null;return{direction:1,strength:f.relative24+f.r6};}
  if(config.tactic==="FALSE_RELEASE"){if(f.volumeBurst<p.volume)return null;const highFail=f.current.high>f.high24&&f.current.close<f.high24*(1-p.reclaim);const lowFail=f.current.low<f.low24&&f.current.close>f.low24*(1+p.reclaim);if(highFail===lowFail)return null;return{direction:highFail?-1:1,strength:f.volumeBurst+Math.abs(f.r1)};}
  if(config.tactic==="QUIET_PULLBACK_RESUME"||config.tactic==="RELATIVE_PULLBACK_RESUME"){const direction=sign(f.relative7),pullback=direction*f.r24;if(!direction||Math.abs(f.relative7)<p.relative7||pullback>-p.pullbackMin||pullback<-p.pullbackMax||direction*f.r6<p.resume6)return null;return{direction,strength:Math.abs(f.relative7)+Math.abs(f.r24)+direction*f.r6};}
  if(config.tactic==="BEAR_MARKET_REBOUND"){if(f.context.median30>=0||f.r24>-p.drop24||f.r6<p.rebound6)return null;return{direction:1,strength:-f.r24+f.r6};}
  if(config.tactic==="BULL_RELATIVE_MOMENTUM"){const direction=sign(f.relative7);if(f.context.median30<=0||!direction||Math.abs(f.relative7)<p.relative7||direction*f.relative24<p.confirm24)return null;return{direction,strength:Math.abs(f.relative7)+direction*f.relative24};}
  if(config.tactic==="BEAR_BREAKDOWN_TRAIL"){if(f.context.median30>=0||f.r30d>-p.symbol30||f.context.breadth30>p.breadth||f.current.close>=f.low7d)return null;return{direction:-1,strength:-f.r30d+(1-f.context.breadth30)*.02};}
  if(config.tactic==="BEAR_DEFENSIVE_RELATIVE"){if(f.context.median30>=0||-f.relative7<p.relative7||-f.r6<p.confirm6)return null;return{direction:1,strength:-f.relative7-f.r6};}
  if(config.tactic==="REFINED_BREADTH_CONTINUATION"){const direction=sign(f.context.median24),boundary=direction>0?f.high24:f.low24;if(!direction||sign(f.r24)!==direction||Math.abs(f.r24)<p.symbol24||direction*f.r6<p.impulse6||direction*(f.current.close/boundary-1)<0)return null;return{direction,strength:Math.abs(f.r24)+direction*f.r6};}
  if(config.tactic==="EXPANSION_DEFENDER"){const marketDirection=sign(f.context.median24),direction=-marketDirection;if(!marketDirection||direction*f.relative24<p.relative24||direction*f.r6<p.resume6)return null;return{direction,strength:direction*f.relative24+direction*f.r6};}
  if(config.tactic==="SHORT_HORIZON_REVERSAL"){const original=sign(f.relative24),direction=-original;if(!original||Math.abs(f.relative24)<p.relative24||direction*f.r6<p.reversal6)return null;return{direction,strength:Math.abs(f.relative24)+direction*f.r6};}
  return null;
}

const snapshots = new Array(reference.length);
for(let i=1;i<reference.length;i++){
  const j=i-1;
  for(const s of AVAILABLE){
    const rows=datasets.get(s),q=rolling.get(s);
    const curr=rows[j]; q.max1.push(j,curr.high);q.min1.push(j,curr.low);q.max1.trim(j-11);q.min1.trim(j-11);
    const prior=j-12;
    if(prior>=0){const r=rows[prior];q.max24.push(prior,r.high);q.min24.push(prior,r.low);q.max7.push(prior,r.high);q.min7.push(prior,r.low);q.max24.trim(prior-287);q.min24.trim(prior-287);q.max7.trim(prior-2015);q.min7.trim(prior-2015);}
  }
  if(i<WARMUP_STEPS+12)continue;
  const h=Math.floor(i/12)-1,context=contexts[h]; if(!context)continue;
  const candidates=[];
  for(const s of AVAILABLE){
    const rows=datasets.get(s),q=rolling.get(s),p=volumePrefix.get(s),ranges=hourRangeBySymbol.get(s);
    if(j-8640<0||h<5||!ranges[h])continue;
    const current={close:rows[j].close,high:q.max1.value(),low:q.min1.value()};
    const recent=segmentSum(p,j-71,j),base=segmentSum(p,j-575,j-72);
    const f={symbol:s,current,r1:rows[j].close/rows[j-12].close-1,r6:rows[j].close/rows[j-72].close-1,
      r24:rows[j].close/rows[j-288].close-1,r7d:rows[j].close/rows[j-2016].close-1,r30d:rows[j].close/rows[j-8640].close-1,
      atr6:median(ranges.slice(h-5,h+1)),volumeBurst:(recent/6)/Math.max(base/42,1e-9),high24:q.max24.value(),low24:q.min24.value(),high7d:q.max7.value(),low7d:q.min7.value(),context};
    f.relative24=f.r24-context.median24;f.relative7=f.r7d-context.median7;
    for(const config of BY_SYSTEM[context.regime]){
      const found=signal(config,f);if(!found)continue;
      const stopRate=Math.min(.20,Math.max(config.stopFloor,config.stopAtr*f.atr6));
      const targetRate=config.exitModel==="TRAIL"?Math.min(.8,Math.max(stopRate*10,.5)):Math.max(stopRate*(config.rewardRisk??1.5),BASE_FRICTION*2.2);
      candidates.push({system:config.system,configId:config.id,tactic:config.tactic,symbol:s,direction:found.direction,strength:found.strength,stopRate,targetRate,maxHoldHours:config.maxHoldHours,exitModel:config.exitModel,trailScale:config.trailScale??.8});
    }
  }
  snapshots[i]=candidates;
}

function periodMetrics(trades,start,end){
  const xs=trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=sum(xs.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(xs.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));
  return{trades:xs.length,netPnl:sum(xs.map(t=>t.netPnl)),profitFactor:l?g/l:g?99:0,winRate:xs.length?xs.filter(t=>t.netPnl>0).length/xs.length:0};
}

function replay(profile,{friction=BASE_FRICTION,slippage=BASE_SLIPPAGE}={}){
  const universe=new Set(profile.symbols),cadenceSteps=profile.cadenceMin/5;
  const accounts=Object.fromEntries(SYSTEMS.map(id=>[id,{equity:1000,open:new Map(),cooldowns:new Map()}]));
  const closed=[],rejects={risk:0,occupied:0,cooldown:0,dedup:0};
  const edge=new Map(); let peak=5000,maxDrawdown=0,signalChecks=0,eventAttempts=0,entries=0;
  const startMs=raw.from*1000,endMs=raw.now*1000,splitMs=Date.UTC(2026,4,1);
  const openRisk=(a,side)=>[...a.open.values()].filter(t=>!side||t.side===side).reduce((n,t)=>n+t.plannedRisk,0);
  const close=(a,t,price,now,outcome)=>{const d=t.side==="LONG"?1:-1,gross=d*(price-t.entryPrice)/t.entryPrice,net=gross-friction,pnl=t.notional*net;a.open.delete(t.symbol);a.equity=Math.max(.01,a.equity+pnl);if(profile.mode==="COOLDOWN")a.cooldowns.set(`${t.configId}:${t.symbol}`,now+24*HOUR);closed.push({...t,closedAt:now,exitPrice:price,outcome,netPnl:pnl,netReturnRate:net});};
  for(let i=WARMUP_STEPS+12;i<reference.length;i++){
    const now=reference[i].time*1000;
    for(const a of Object.values(accounts))for(const t of [...a.open.values()]){
      const row=datasets.get(t.symbol)[i],price=row.open,d=t.side==="LONG"?1:-1,move=d*(price-t.entryPrice)/t.entryPrice;
      t.maxFav=Math.max(t.maxFav,move);const stop=t.activeStop;
      const stopped=t.side==="LONG"?price<=stop:price>=stop,targeted=t.side==="LONG"?price>=t.targetPrice:price<=t.targetPrice;
      if(stopped){close(a,t,stop,now,"STOP");continue;}if(t.exitModel!=="TRAIL"&&targeted){close(a,t,t.targetPrice,now,"TARGET");continue;}
      if(t.exitModel==="TRAIL"){const extreme=t.side==="LONG"?t.entryPrice*(1+t.maxFav):t.entryPrice*(1-t.maxFav),candidate=extreme*(1-d*t.stopRate*t.trailScale);t.activeStop=t.side==="LONG"?Math.max(stop,candidate):Math.min(stop,candidate);}
      if(now-t.openedAt>=t.maxHoldHours*HOUR)close(a,t,price,now,"EDGE_DECAY");
    }
    const eq=sum(Object.values(accounts).map(a=>a.equity));peak=Math.max(peak,eq);maxDrawdown=Math.max(maxDrawdown,(peak-eq)/Math.max(peak,1e-9));
    if(i%cadenceSteps!==0)continue;
    const rawCandidates=(snapshots[i]??[]).filter(c=>universe.has(c.symbol));signalChecks+=rawCandidates.length;
    let candidates=rawCandidates;
    if(profile.mode==="EDGE"){
      const present=new Map(rawCandidates.map(c=>[`${c.configId}:${c.symbol}`,c]));
      for(const [key,state] of edge)if(state.active&&!present.has(key)){state.active=false;state.entered=false;state.falseSince=now;}
      const eligible=[];
      for(const c of rawCandidates){const key=`${c.configId}:${c.symbol}`;let state=edge.get(key);if(!state){state={active:false,entered:false,falseSince:-Infinity,lastEntry:-Infinity};edge.set(key,state);}if(!state.active){const falseAge=now-state.falseSince;state.active=true;state.entered=false;state.wasArmed=false;state.wasArmed=false;state.eligibleRise=false;if(falseAge>=profile.falseConfirmMin*60_000&&now-state.lastEntry>=profile.rearmMin*60_000)state.eligibleRise=true;}
        if(!state.entered&&state.eligibleRise)eligible.push({...c,_edgeKey:key}); else rejects.dedup++;}
      candidates=eligible;
    }
    candidates.sort((a,b)=>b.strength-a.strength||a.configId.localeCompare(b.configId));
    for(const c of candidates){eventAttempts++;const a=accounts[c.system],key=`${c.configId}:${c.symbol}`,side=c.direction>0?"LONG":"SHORT";
      if(a.open.has(c.symbol)){rejects.occupied++;continue;}if(profile.mode==="COOLDOWN"&&(a.cooldowns.get(key)??0)>now){rejects.cooldown++;continue;}
      const row=datasets.get(c.symbol)[i],market=row.open,entry=market*(1+c.direction*slippage),stop=entry*(1-c.direction*c.stopRate),target=entry*(1+c.direction*c.targetRate);
      const mult=Math.min(.5,.015/Math.max(c.stopRate+friction,1e-9));if(mult<.05)continue;const notional=a.equity*mult,plannedRisk=notional*(c.stopRate+friction);
      if(openRisk(a)+plannedRisk>a.equity*.10+1e-8||openRisk(a,side)+plannedRisk>a.equity*.065+1e-8){rejects.risk++;continue;}
      const t={configId:c.configId,tactic:c.tactic,symbol:c.symbol,system:c.system,side,openedAt:now,entryPrice:entry,stopPrice:stop,targetPrice:target,activeStop:stop,stopRate:c.stopRate,targetRate:c.targetRate,notional,plannedRisk,maxFav:0,maxHoldHours:c.maxHoldHours,exitModel:c.exitModel,trailScale:c.trailScale};
      a.open.set(c.symbol,t);entries++;if(profile.mode==="EDGE"){const st=edge.get(c._edgeKey);st.entered=true;st.lastEntry=now;}
    }
  }
  const gains=sum(closed.filter(t=>t.netPnl>0).map(t=>t.netPnl)),loss=Math.abs(sum(closed.filter(t=>t.netPnl<=0).map(t=>t.netPnl))),monthly=new Map();for(const t of closed){const m=monthKey(t.closedAt);monthly.set(m,(monthly.get(m)??0)+t.netPnl);}
  const elapsedDays=(endMs-startMs)/DAY,first8End=Date.UTC(2026,5,1);
  return{profile:{name:profile.name,cadenceMin:profile.cadenceMin,mode:profile.mode,rearmMin:profile.rearmMin??null,falseConfirmMin:profile.falseConfirmMin??null,symbols:profile.symbols.length},trades:closed.length,tradesPerDay:closed.length/elapsedDays,entries,netPnl:sum(closed.map(t=>t.netPnl)),profitFactor:loss?gains/loss:gains?99:0,winRate:closed.length?closed.filter(t=>t.netPnl>0).length/closed.length:0,maxDrawdown,positiveMonths:[...monthly.values()].filter(x=>x>0).length,activeMonths:monthly.size,monthly:Object.fromEntries([...monthly].sort()),rejects,signalChecks,eventAttempts,endEquity:sum(Object.values(accounts).map(a=>a.equity)),openAtEnd:sum(Object.values(accounts).map(a=>a.open.size)),train:periodMetrics(closed,startMs,first8End),test:periodMetrics(closed,first8End,endMs)};
}

const core60={name:"core-60m-production-cooldown",cadenceMin:60,mode:"COOLDOWN",symbols:CORE};
const expanded=AVAILABLE;
const profiles=[core60,
  {name:"expanded-60m-production-cooldown",cadenceMin:60,mode:"COOLDOWN",symbols:expanded},
  {name:"expanded-30m-edge-4h",cadenceMin:30,mode:"EDGE",rearmMin:240,falseConfirmMin:60,symbols:expanded},
  {name:"expanded-15m-edge-4h",cadenceMin:15,mode:"EDGE",rearmMin:240,falseConfirmMin:60,symbols:expanded},
  {name:"expanded-15m-edge-2h",cadenceMin:15,mode:"EDGE",rearmMin:120,falseConfirmMin:60,symbols:expanded},
  {name:"expanded-15m-edge-1h",cadenceMin:15,mode:"EDGE",rearmMin:60,falseConfirmMin:30,symbols:expanded},
  {name:"expanded-5m-edge-2h",cadenceMin:5,mode:"EDGE",rearmMin:120,falseConfirmMin:30,symbols:expanded},
  {name:"expanded-5m-edge-1h",cadenceMin:5,mode:"EDGE",rearmMin:60,falseConfirmMin:30,symbols:expanded},
  {name:"expanded-5m-edge-30m",cadenceMin:5,mode:"EDGE",rearmMin:30,falseConfirmMin:15,symbols:expanded},
];
const baseResults=profiles.map(p=>replay(p));
const baseline=baseResults[0];
const qualityGate=r=>r.tradesPerDay>=15&&r.netPnl>0&&r.profitFactor>=Math.max(1.10,baseline.profitFactor*.90)&&r.maxDrawdown<=Math.max(.12,baseline.maxDrawdown*1.15)&&r.train.netPnl>0&&r.train.profitFactor>=1.02&&r.test.netPnl>0&&r.test.profitFactor>=1.02;
const ranked=baseResults.slice(1).sort((a,b)=>Number(qualityGate(b))-Number(qualityGate(a))||b.tradesPerDay-a.tradesPerDay||b.profitFactor-a.profitFactor);
const best=ranked[0];
const bestProfile=profiles.find(p=>p.name===best.profile.name);
const stress=bestProfile?replay(bestProfile,{friction:STRESS_FRICTION,slippage:BASE_SLIPPAGE}):null;
const adverse=bestProfile?replay(bestProfile,{friction:BASE_FRICTION,slippage:BASE_SLIPPAGE*2}):null;
const gates=best?{frequency:best.tradesPerDay>=15,netPositive:best.netPnl>0,profitFactor:best.profitFactor>=Math.max(1.10,baseline.profitFactor*.90),drawdown:best.maxDrawdown<=Math.max(.12,baseline.maxDrawdown*1.15),train:best.train.netPnl>0&&best.train.profitFactor>=1.02,test:best.test.netPnl>0&&best.test.profitFactor>=1.02,stress:stress.netPnl>0&&stress.profitFactor>=1.02,adverse:adverse.netPnl>0&&adverse.profitFactor>=1.02}:{};
const report={generatedAt:new Date().toISOString(),dataset:{sha256:raw.sha256,months:raw.months,days:raw.days,requested:raw.requestedSymbols,available:AVAILABLE,availableCount:AVAILABLE.length},architecture:{regimeContextUniverse:CORE,executionUniverse:AVAILABLE,marketStateCadence:"1h canonical core context",signalSampling:"rolling clock-horizon features sampled at profile cadence",risk:"unchanged 1.5% single-risk sizing / 10% account cap / 6.5% same-side cap",exit:"5m executable-open lifecycle; stop/target/trail semantics retained",dedup:"EDGE profiles require a signal to disappear before it can form another independent event"},baseline,results:baseResults,best,stress,adverse,gates,targetMet:Object.values(gates).length>0&&Object.values(gates).every(Boolean),notes:["The 11 liquid majors remain the regime-classification core so adding satellites does not rewrite market-state thresholds.","Frequency profiles change only execution-universe breadth, signal sampling cadence and event re-arm/de-duplication. Strategy thresholds, stop floors, reward/risk, max holds and account risk caps remain frozen.","Historical order-book spread/depth is unavailable. Base friction remains 0.14% plus 0.025% entry slippage; stress raises round-trip friction to 0.22%; adverse entry doubles slippage.","A 15+/day result is accepted only if both chronological train/test partitions are positive and stress/adverse tests remain positive."]};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("FREQUENCY_ENGINE_RESULT="+JSON.stringify({targetMet:report.targetMet,available:AVAILABLE.length,baseline:{tradesPerDay:baseline.tradesPerDay,pf:baseline.profitFactor,net:baseline.netPnl,dd:baseline.maxDrawdown},best:best&&{name:best.profile.name,tradesPerDay:best.tradesPerDay,trades:best.trades,pf:best.profitFactor,net:best.netPnl,dd:best.maxDrawdown,train:best.train,test:best.test},stress:stress&&{pf:stress.profitFactor,net:stress.netPnl,dd:stress.maxDrawdown},adverse:adverse&&{pf:adverse.profitFactor,net:adverse.netPnl,dd:adverse.maxDrawdown},gates},null,2));