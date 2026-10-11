/** Research only. It never places or cancels an order. */
export type ResearchBar={t:number;o:number;h:number;l:number;c:number;v:number};
export type ResearchSnap={symbol:string;bid:number;ask:number;last:number;depthBid:number;depthAsk:number;funding:number;m1:ResearchBar[];m5:ResearchBar[]};
export type LiveCandidate={symbol:string;rank:number;score:number;retZ1m:number;retZ5m:number;retZ15m:number;volZ5m:number;turnover:number;depthRatio:number;last:number};
export type LiveContext={
  symbol:string;btc1h:number|null;btcWindow:number|null;majors1h:number|null;majorsWindow:number|null;regime:string;consensus:number|null;
  corr1h:number|null;corrWindow:number|null;decoupled:boolean;ret15m:number;ret1h:number;retWindow:number;relWindow:number|null;
  volRank:number;windowHours:number;support:number[];resistance:number[];depthRatio:number;bookImbalance:number;
  spreadBps:number;funding:number;trades:string;
};
export type LiveAnalogy={
  count:number;enough:boolean;threshold:number;down:number;up:number;flat:number;downPct:number;mfe1h:number;mae1h:number;mfe4h:number;mae4h:number;
  worst4h:number;best4h:number;refs:{similarity:number;o1h:number;o4h:number;symbol:string}[];
};
export type LiveDecision={symbol:string;direction:"LONG"|"SHORT";level:"观望"|"弱信号"|"计划";confidence:number;reasoning:string[];entry:number;stop:number;tp1:number;tp2:number;stopWhy:string;invalidate:string[]};
export type LiveResearchView={
  ts:number;status:string;library:number;windowHours:number;candidates:LiveCandidate[];
  context:LiveContext|null;analogy:LiveAnalogy|null;decision:LiveDecision|null;
  log?:{at:number;symbol:string;level:string;confidence:number;btc1h:number|null}[];
};

export const RESEARCH_MAJORS=["BTC_USDT","ETH_USDT","SOL_USDT","BNB_USDT","XRP_USDT"];
const MAJORS=RESEARCH_MAJORS;
const zScore=(history:number[],current:number)=>{
  if(history.length<10)return 0;
  const mean=history.reduce((n,x)=>n+x,0)/history.length;
  const sd=Math.sqrt(history.reduce((n,x)=>n+(x-mean)**2,0)/history.length);
  return sd<1e-10?0:(current-mean)/sd;
};
const SIMILAR=0.8;
const retOver=(bars:ResearchBar[],seconds:number)=>{
  if(bars.length<2)return null;
  const last=bars.at(-1)!;
  const target=last.t-seconds;
  let past:ResearchBar|null=null;
  for(const bar of bars){if(bar.t<=target)past=bar;else break;}
  if(!past||!(past.c>0)||last.t-past.t<seconds*0.75)return null;
  return last.c/past.c-1;
};
const aligned=(a:ResearchBar[],b:ResearchBar[])=>{
  const closes=new Map(b.map(bar=>[bar.t,bar.c]));
  const xs:number[]=[],ys:number[]=[];
  for(let i=1;i<a.length;i++){
    const prev=a[i-1]!,cur=a[i]!,bp=closes.get(prev.t),bc=closes.get(cur.t);
    if(!(prev.c>0)||!(cur.c>0)||!(bp&&bc))continue;
    xs.push(cur.c/prev.c-1);ys.push(bc/bp-1);
  }
  return [xs,ys] as const;
};
const returns=(bars:ResearchBar[])=>bars.slice(1).map((bar,i)=>bars[i]!.c?bar.c/bars[i]!.c-1:0);
const corr=(a:number[],b:number[])=>{
  const n=Math.min(a.length,b.length);if(n<12)return 0;
  const x=a.slice(-n),y=b.slice(-n),mx=x.reduce((s,v)=>s+v,0)/n,my=y.reduce((s,v)=>s+v,0)/n;
  let num=0,dx=0,dy=0;
  for(let i=0;i<n;i++){const vx=x[i]!-mx,vy=y[i]!-my;num+=vx*vy;dx+=vx*vx;dy+=vy*vy;}
  return dx<1e-12||dy<1e-12?0:num/Math.sqrt(dx*dy);
};
const round=(n:number,d=4)=>Number(n.toFixed(d));

function scan(snaps:ResearchSnap[]):LiveCandidate[]{
  const rows=snaps.flatMap(snap=>{
    const m5=snap.m5;if(m5.length<31)return [];
    const r5=returns(m5),retZ5=zScore(r5.slice(-31,-1),r5.at(-1)??0);
    const r1=returns(snap.m1),retZ1=r1.length>=31?zScore(r1.slice(-31,-1),r1.at(-1)??0):0;
    const r15:number[]=[];
    for(let i=3;i<m5.length;i++){const past=m5[i-3]!.c;if(past)r15.push(m5[i]!.c/past-1);}
    const retZ15=r15.length>6?zScore(r15.slice(0,-1),r15.at(-1)??0):0;
    const vols=m5.map(bar=>bar.v),volZ=zScore(vols.slice(-31,-1),vols.at(-1)??0);
    const avg=vols.slice(-288).reduce((n,v)=>n+v,0)/Math.max(1,Math.min(vols.length,288));
    const turnover=avg>0?(vols.at(-1)??0)/avg:1;
    const depthRatio=snap.depthAsk>0?snap.depthBid/snap.depthAsk:1;
    // Depth is shown in context, not in the rank. A live book flickers every few
    // seconds and was swapping the subject, and therefore the analogies.
    const score=0.40*Math.abs(retZ5)+0.25*Math.abs(retZ1)+0.25*Math.abs(volZ)+0.10*Math.min(2,Math.abs(turnover-1));
    return [{symbol:snap.symbol,rank:0,score:round(score,3),retZ1m:round(retZ1,3),retZ5m:round(retZ5,3),retZ15m:round(retZ15,3),volZ5m:round(volZ,3),turnover:round(turnover,3),depthRatio:round(depthRatio,3),last:snap.last||m5.at(-1)!.c}];
  });
  return rows.sort((a,b)=>b.score-a.score).slice(0,5).map((row,i)=>({...row,rank:i+1}));
}

function contextOf(cand:LiveCandidate,snaps:Map<string,ResearchSnap>):LiveContext{
  const snap=snaps.get(cand.symbol)!,btc=snaps.get("BTC_USDT");
  const hours=Math.round((snap.m5.at(-1)!.t-snap.m5[0]!.t)/3600);
  const btc1h=btc?retOver(btc.m5,3600):null,btcWindow=btc?retOver(btc.m5,Math.max(3600,btc.m5.at(-1)!.t-btc.m5[0]!.t)):null;
  const majors=MAJORS.filter(symbol=>symbol!==cand.symbol&&snaps.has(symbol));
  const majors1h=majors.map(symbol=>retOver(snaps.get(symbol)!.m5,3600)).filter((v):v is number=>v!=null);
  const majorsWindow=majors.map(symbol=>{const bars=snaps.get(symbol)!.m5;return retOver(bars,Math.max(3600,bars.at(-1)!.t-bars[0]!.t));}).filter((v):v is number=>v!=null);
  const avg1h=majors1h.length?majors1h.reduce((n,v)=>n+v,0)/majors1h.length:null;
  const avgWindow=majorsWindow.length?majorsWindow.reduce((n,v)=>n+v,0)/majorsWindow.length:null;
  const consensus=majors1h.length?majors1h.filter(v=>Math.abs(v)>0.002).length/majors1h.length:null;
  const regime=avg1h==null?"看不出":avg1h>0.004&&(consensus??0)>0.6?"上涨":avg1h<-0.004&&(consensus??0)>0.6?"下跌":"震荡";
  const pair=btc?aligned(snap.m5,btc.m5):null;
  const corr1h=pair&&pair[0].length>=8?corr(pair[0].slice(-12),pair[1].slice(-12)):null;
  const corrWindow=pair&&pair[0].length>=12?corr(pair[0],pair[1]):null;
  const ret15=retOver(snap.m5,15*60)??0,ret1h=retOver(snap.m5,3600)??0,retWindow=retOver(snap.m5,Math.max(3600,snap.m5.at(-1)!.t-snap.m5[0]!.t))??0;
  const mine=returns(snap.m5);
  const rolling:number[]=[];
  for(let i=3;i<=mine.length;i++){const w=mine.slice(i-3,i);rolling.push(Math.sqrt(w.reduce((n,v)=>n+v*v,0)/w.length));}
  const cur=rolling.at(-1)??0,volRank=rolling.length?rolling.filter(v=>v<cur).length/rolling.length:0.5;
  const prices=snap.m5.map(bar=>bar.c),vols=snap.m5.map(bar=>bar.v);
  const support:number[]=[],resistance:number[]=[];
  if(prices.length>=30){
    const lo=Math.min(...prices),hi=Math.max(...prices);
    if(hi>lo){
      const bins=Array.from({length:20},()=>0);
      prices.forEach((price,i)=>{bins[Math.min(19,Math.floor((price-lo)/(hi-lo)*20))]!+=vols[i]??0;});
      const levels=bins.map((v,i)=>({v,p:lo+(i+0.5)*(hi-lo)/20})).sort((a,b)=>b.v-a.v).slice(0,8).map(row=>row.p).sort((a,b)=>a-b);
      const last=cand.last;
      support.push(...levels.filter(p=>p<last).slice(-3));
      resistance.push(...levels.filter(p=>p>last).slice(0,3));
    }
  }
  const depthRatio=snap.depthAsk>0?snap.depthBid/snap.depthAsk:1;
  const imbalance=snap.depthBid+snap.depthAsk>0?(snap.depthBid-snap.depthAsk)/(snap.depthBid+snap.depthAsk):0;
  return {symbol:cand.symbol,btc1h:btc1h==null?null:round(btc1h,5),btcWindow:btcWindow==null?null:round(btcWindow,5),majors1h:avg1h==null?null:round(avg1h,5),majorsWindow:avgWindow==null?null:round(avgWindow,5),
    regime,consensus:consensus==null?null:round(consensus,3),corr1h:corr1h==null?null:round(corr1h,3),corrWindow:corrWindow==null?null:round(corrWindow,3),decoupled:corr1h!=null&&corrWindow!=null&&corr1h<0.4&&corrWindow>0.5,
    ret15m:round(ret15,5),ret1h:round(ret1h,5),retWindow:round(retWindow,5),relWindow:avgWindow==null?null:round(retWindow-avgWindow,5),
    volRank:round(volRank,3),windowHours:hours,support:support.map(p=>round(p,6)),resistance:resistance.map(p=>round(p,6)),
    depthRatio:round(depthRatio,3),bookImbalance:round(imbalance,3),spreadBps:round(snap.bid>0?(snap.ask-snap.bid)/snap.bid*10_000:0,2),
    funding:snap.funding,trades:"没有逐笔。盘口用的是买一到买五的挂单量。"};
}

type Memory={vec:number[];o1h:number;o4h:number;mfe1h:number;mae1h:number;mfe4h:number;mae4h:number;symbol:string};
function vectorAt(m5:ResearchBar[],btc:ResearchBar[]|undefined,end:number){
  const slice=m5.slice(0,end+1);if(slice.length<16)return null;
  const ret15=retOver(slice,15*60)??0,ret1h=retOver(slice,3600)??0;
  const btcSlice=btc?btc.filter(bar=>bar.t<=slice.at(-1)!.t):[];
  const pair=aligned(slice,btcSlice);
  const rel=ret1h-(btcSlice.length>12?retOver(btcSlice,3600)??0:0);
  const c1=pair[0].length>=8?corr(pair[0].slice(-12),pair[1].slice(-12)):0;
  return [ret15*100,ret1h*100,c1,rel*100];
}
function library(snaps:ResearchSnap[]){
  const btc=snaps.find(s=>s.symbol==="BTC_USDT")?.m5;
  const out:Memory[]=[];
  for(const snap of snaps){
    const bars=snap.m5;
    for(let i=30;i<bars.length-12;i++){
      const vec=vectorAt(bars,btc,i);if(!vec)continue;
      const entry=bars[i]!.c;if(!(entry>0))continue;
      const ahead1=bars.slice(i+1,i+13),ahead4=bars.slice(i+1,i+49);
      const path=ahead4.length>=48?ahead4:ahead1;
      let mfe=0,mae=0;
      for(const bar of ahead1){mfe=Math.max(mfe,(bar.h-entry)/entry);mae=Math.min(mae,(bar.l-entry)/entry);}
      let mfe4=mfe,mae4=mae;
      for(const bar of path){mfe4=Math.max(mfe4,(bar.h-entry)/entry);mae4=Math.min(mae4,(bar.l-entry)/entry);}
      out.push({vec,o1h:bars[i+12]!.c/entry-1,o4h:(path.at(-1)!.c)/entry-1,mfe1h:mfe,mae1h:mae,mfe4h:mfe4,mae4h:mae4,symbol:snap.symbol});
    }
  }
  return out.slice(-600);
}
function similar(mem:Memory[],vec:number[]):LiveAnalogy{
  const empty:LiveAnalogy={count:0,enough:false,threshold:SIMILAR,down:0,up:0,flat:0,downPct:0,mfe1h:0,mae1h:0,mfe4h:0,mae4h:0,worst4h:0,best4h:0,refs:[]};
  const qn=Math.sqrt(vec.reduce((n,v)=>n+v*v,0));if(qn<1e-10||!mem.length)return empty;
  const passed=mem.map(row=>{
    const vn=Math.sqrt(row.vec.reduce((n,v)=>n+v*v,0));
    const sim=vn<1e-10?0:row.vec.reduce((n,v,i)=>n+v*vec[i]!,0)/(qn*vn);
    return {sim,row};
  }).filter(row=>row.sim>=SIMILAR).sort((a,b)=>b.sim-a.sim).slice(0,20);
  if(!passed.length)return empty;
  const o1=passed.map(x=>x.row.o1h),o4=passed.map(x=>x.row.o4h);
  const down=o1.filter(x=>x<-0.005).length,up=o1.filter(x=>x>0.005).length;
  const mean=(xs:number[])=>xs.reduce((n,v)=>n+v,0)/xs.length;
  return {count:passed.length,enough:passed.length>=5,threshold:SIMILAR,down,up,flat:passed.length-down-up,downPct:round(down/passed.length,3),
    mfe1h:round(mean(passed.map(x=>x.row.mfe1h)),5),mae1h:round(mean(passed.map(x=>x.row.mae1h)),5),
    mfe4h:round(mean(passed.map(x=>x.row.mfe4h)),5),mae4h:round(mean(passed.map(x=>x.row.mae4h)),5),
    worst4h:round(Math.min(...o4),5),best4h:round(Math.max(...o4),5),
    refs:passed.slice(0,5).map(x=>({similarity:round(x.sim,3),o1h:round(x.row.o1h,5),o4h:round(x.row.o4h,5),symbol:x.row.symbol}))};
}

export function researchLevel(confidence:number):LiveDecision["level"]{
  return confidence<0.55?"观望":confidence<0.65?"弱信号":"计划";
}
function decide(cand:LiveCandidate,ctx:LiveContext,analogy:LiveAnalogy|null):LiveDecision{
  let confidence=0.5;const reasoning:string[]=[];
  const direction:LiveDecision["direction"]=cand.retZ5m>0?"SHORT":"LONG";
  reasoning.push(`这一下是${cand.retZ5m>0?"涨":"跌"}（5 分钟 z ${cand.retZ5m.toFixed(2)}）。研究按反方向写成${direction==="LONG"?"做多":"做空"}。`);
  if(ctx.decoupled&&ctx.corr1h!=null&&ctx.corrWindow!=null){confidence+=0.08;reasoning.push(`和大盘的关系变了：近 1 小时 ${ctx.corr1h.toFixed(2)}，更长一段 ${ctx.corrWindow.toFixed(2)}。`);}
  if(direction==="SHORT"&&ctx.regime==="震荡"){confidence+=0.05;reasoning.push("大盘在震荡。");}
  else if(direction==="LONG"&&ctx.regime==="下跌"){confidence-=0.1;reasoning.push("大盘在跌，反着做多更危险。");}
  else if(direction==="SHORT"&&ctx.regime==="上涨"){confidence-=0.1;reasoning.push("大盘在涨，反着做空更危险。");}
  if(ctx.volRank>0.85){confidence+=0.08;reasoning.push(`这段波动在已有K线里排到 ${(ctx.volRank*100).toFixed(0)}%。`);}
  if(analogy){
    if(direction==="SHORT"&&analogy.downPct>0.55){confidence+=0.1;reasoning.push(`像现在这样的场面，之后 1 小时继续跌的有 ${(analogy.downPct*100).toFixed(0)}%。`);}
    else if(direction==="LONG"&&analogy.downPct<0.45){confidence+=0.1;reasoning.push(`像现在这样的场面，之后 1 小时往上走的有 ${((1-analogy.downPct)*100).toFixed(0)}%。`);}
    else {confidence-=0.08;reasoning.push("像现在这样的场面，之后的走势并不站在这个方向。");}
  }else reasoning.push(`相似度达到 ${SIMILAR.toFixed(2)} 的老场面不到 5 个，这一步不用来加分。`);
  if(direction==="SHORT"&&ctx.depthRatio<0.8){confidence+=0.05;reasoning.push(`卖盘更厚，买一到买五比卖盘少（${ctx.depthRatio.toFixed(2)}）。`);}
  else if(direction==="LONG"&&ctx.depthRatio>1.2){confidence+=0.05;reasoning.push(`买盘更厚（${ctx.depthRatio.toFixed(2)}）。`);}
  confidence=Math.max(0.15,Math.min(0.85,confidence));
  const level=researchLevel(confidence);
  const entry=cand.last;
  const adverse=analogy?Math.abs(analogy.mae1h):null;
  const raw=adverse==null?0.01:adverse*1.5;
  const stopPct=Math.max(0.008,Math.min(0.025,raw));
  const tp1Pct=analogy?Math.max(0.01,Math.min(0.04,Math.abs(analogy.mfe1h)*1.2)):0.015;
  const tp2Pct=analogy?Math.max(0.02,Math.min(0.08,Math.abs(analogy.mfe4h)*1.2)):0.03;
  const clamped=raw>0.025?"，高于 2.5% 就封顶":raw<0.008?"，低于 0.8% 就按 0.8%":"";
  const stopWhy=analogy
    ?`止损 ${(stopPct*100).toFixed(2)}% 来自：相似度达到 ${SIMILAR.toFixed(2)} 的 ${analogy.count} 个场面，平均最大不利 ${((adverse??0)*100).toFixed(2)}%，再乘 1.5${clamped}。`
    :`止损 ${(stopPct*100).toFixed(2)}% 是场面不够时的默认值，不是从历史里算出来的。`;
  const stop=direction==="SHORT"?entry*(1+stopPct):entry*(1-stopPct);
  const tp1=direction==="SHORT"?entry*(1-tp1Pct):entry*(1+tp1Pct);
  const tp2=direction==="SHORT"?entry*(1-tp2Pct):entry*(1+tp2Pct);
  return {symbol:cand.symbol,direction,level,confidence:round(confidence,3),reasoning,entry:round(entry,6),stop:round(stop,6),tp1:round(tp1,6),tp2:round(tp2,6),stopWhy,
    invalidate:[direction==="SHORT"?`价格回到 ${(entry*1.005).toFixed(6)}`:`价格回到 ${(entry*0.995).toFixed(6)}`,"和大盘的近 1 小时相关性回到 0.6 以上"]};
}

export function runLiveResearch(snaps:ResearchSnap[],now:number):LiveResearchView{
  const usable=snaps.filter(s=>s.m5.length>=31&&s.m5.at(-1)!.c>0);
  const candidates=scan(usable);
  const hours=usable.length?Math.round(Math.max(...usable.map(s=>s.m5.length))*5/60):0;
  if(!candidates.length)return {ts:now,status:"5 分钟K线还不够，扫描不出异动。",library:0,windowHours:hours,candidates:[],context:null,analogy:null,decision:null};
  const map=new Map(usable.map(s=>[s.symbol,s]));
  const top=candidates[0]!;
  const context=contextOf(top,map);
  const mem=library(usable);
  const vec=[context.ret15m*100,context.ret1h*100,context.corr1h??0,(context.ret1h-(context.btc1h??0))*100];
  const analogy=similar(mem,vec);
  return {ts:now,status:"只研究，不下单。账户里的单还是原来的做法。",library:mem.length,windowHours:hours,candidates,context,analogy,decision:decide(top,context,analogy.enough?analogy:null)};
}
