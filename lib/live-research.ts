/** Research only. It never places or cancels an order. */
export type ResearchBar={t:number;o:number;h:number;l:number;c:number;v:number};
export type ResearchSnap={symbol:string;bid:number;ask:number;last:number;depthBid:number;depthAsk:number;funding:number;m1:ResearchBar[];m5:ResearchBar[]};
export type LiveCandidate={symbol:string;rank:number;score:number;retZ1m:number;retZ5m:number;retZ15m:number;volZ5m:number;turnover:number;depthRatio:number;last:number;priceWords:string;volumeWords:string};
export type LiveContext={
  symbol:string;btc1h:number|null;btcWindow:number|null;majors1h:number|null;majorsWindow:number|null;regime:string;consensus:number|null;
  corr1h:number|null;corrWindow:number|null;decoupled:boolean;ret15m:number;ret1h:number;retWindow:number;relWindow:number|null;
  volRank:number;windowHours:number;support:number[];resistance:number[];supportText:string;resistanceText:string;depthRatio:number;bookImbalance:number;
  spreadBps:number;funding:number;trades:string;sections:{title:string;body:string;conclusion:string}[];
};
export type LiveAnalogy={
  count:number;enough:boolean;threshold:number;minSim:number;maxSim:number;down:number;up:number;flat:number;downPct:number;mfe1h:number;mae1h:number;mfe4h:number;mae4h:number;
  worst4h:number;best4h:number;refs:{similarity:number;o1h:number;o4h:number;symbol:string}[];story:string;lean:string;caution:string|null;
};
export type LiveDecision={
  symbol:string;direction:"LONG"|"SHORT"|null;level:"观望"|"弱信号"|"明确信号";confidence:number;
  observation:string;evidence:string[];conflict:string|null;conclusion:string;reasoning:string[];
  headline:string;why:string[];planSide:"LONG"|"SHORT";holdText:string;waitFor:string[];stopPct:number;tp1Pct:number;tp2Pct:number;
  entry:number;stop:number;tp1:number;tp2:number;stopWhy:string;invalidate:string[];
};
export type ResearchLogRow={at:number;symbol:string;level:string;confidence:number;btc1h:number|null;direction?:"LONG"|"SHORT"|null;price?:number;laterRet?:number|null;verdict?:string|null};
export type LiveResearchView={
  ts:number;status:string;library:number;windowHours:number;candidates:LiveCandidate[];
  context:LiveContext|null;analogy:LiveAnalogy|null;decision:LiveDecision|null;
  scanned:number;found:number;nextAt:number;
  today?:{scans:number;symbols:number;long:number;short:number;watch:number};
  log?:ResearchLogRow[];
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
const multiple=(z:number)=>Math.abs(z).toFixed(1);
export function priceWords(z:number){
  const a=Math.abs(z),up=z>=0;
  if(a<0.5)return "价格正常";
  if(a<1.5)return up?`价格偏强，大约是平时的 ${multiple(z)} 倍`:`价格偏弱，大约是平时的 ${multiple(z)} 倍`;
  if(a<3)return up?`价格比平时猛 ${multiple(z)} 倍（明显偏强）`:`价格比平时弱 ${multiple(z)} 倍（明显偏弱）`;
  return up?`价格比平时猛 ${multiple(z)} 倍（极端偏强）`:`价格比平时弱 ${multiple(z)} 倍（极端偏弱）`;
}
export function volumeWords(z:number){
  if(Math.abs(z)<0.5)return "成交量正常";
  if(z>=3)return "成交量极端偏多";
  if(z>=1.5)return "成交量明显偏多";
  if(z>=0.5)return "成交量偏多";
  if(z<=-3)return "成交量极端偏少";
  if(z<=-1.5)return "成交量明显偏少";
  return "成交量偏少";
}
const corrWords=(v:number|null)=>v==null?"还没算出来":v<-0.2?"和大盘反着走":v<0.2?"基本独立，没怎么跟着大盘":v<0.6?"有点跟着大盘":"跟大盘很紧";
const bookWords=(ratio:number)=>ratio<0.8?"卖盘比买盘厚":ratio>1.2?"买盘比卖盘厚":"买卖力量差不多";
const fundingWords=(rate:number)=>{
  const text=`${rate>=0?"+":""}${(rate*100).toFixed(2)}%`;
  if(rate>0.00005)return `资金费 ${text}。做多的人在付钱给做空的人。`;
  if(rate<-0.00005)return `资金费 ${text}。做空的人在付钱给做多的人。`;
  return `资金费 ${text}。两边差不多，谁也不用怎么付钱。`;
};

function scan(snaps:ResearchSnap[]){
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
    return [{symbol:snap.symbol,rank:0,score:round(score,3),retZ1m:round(retZ1,3),retZ5m:round(retZ5,3),retZ15m:round(retZ15,3),volZ5m:round(volZ,3),turnover:round(turnover,3),depthRatio:round(depthRatio,3),last:snap.last||m5.at(-1)!.c,priceWords:priceWords(retZ5),volumeWords:volumeWords(volZ)}];
  });
  const found=rows.filter(row=>Math.abs(row.retZ5m)>=1||Math.abs(row.volZ5m)>=1).length;
  return {rows:rows.sort((a,b)=>b.score-a.score).slice(0,5).map((row,i)=>({...row,rank:i+1})),scanned:rows.length,found};
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
  const hi=prices.length?Math.max(...prices):cand.last,lo=prices.length?Math.min(...prices):cand.last;
  const supportText=support.length?support.map(p=>round(p,6)).join(" / "):cand.last<=lo*1.002?"创新低，下面没有现成的支撑":"这段K线里看不出";
  const resistanceText=resistance.length?resistance.map(p=>round(p,6)).join(" / "):cand.last>=hi*0.998?"创新高，上面没有现成的压力":"这段K线里看不出";
  const pct=(v:number|null)=>v==null?"没接到":`${v>=0?"+":""}${(v*100).toFixed(2)}%`;
  const spreadBps=round(snap.bid>0?(snap.ask-snap.bid)/snap.bid*10_000:0,2);
  const decoupled=corr1h!=null&&corrWindow!=null&&corr1h<0.4&&corrWindow>0.5;
  const sections=[
    {title:"它自己",body:`最近 15 分钟 ${pct(ret15)}。最近 1 小时 ${pct(ret1h)}。`,conclusion:volRank>=0.9?"这段起伏是最近这截K线里最猛的一档。":volRank>=0.6?"这段起伏偏大。":"这段起伏不算突出。"},
    {title:"大盘",body:`BTC 最近 1 小时 ${pct(btc1h)}。主流币 ${pct(avg1h)}。`,conclusion:regime==="看不出"?"大盘数据还没接到。":regime==="震荡"?"大盘在晃，没有方向。":`大盘在${regime}。`},
    {title:"它和大盘的关系",body:`最近 1 小时 ${corrWords(corr1h)}。更长一段 ${corrWords(corrWindow)}。`,conclusion:corr1h==null?"关系还算不出来。":decoupled?"它自己在走，没有跟着大盘。":"它还是有点跟着大盘。"},
    {title:"盘口",body:`${bookWords(depthRatio)}。买卖价差 ${spreadBps.toFixed(1)}，${spreadBps>20?"偏大":"正常"}。`,conclusion:depthRatio<0.8?"卖的挂单更厚。":depthRatio>1.2?"买的挂单更厚。":"看不出哪边更强。"},
    {title:"合约",body:fundingWords(snap.funding),conclusion:snap.funding>0.00005?"做多的人在付钱，略微看空。":snap.funding<-0.00005?"做空的人在付钱，略微看多。":"资金费看不出方向。"},
    {title:"关键价位",body:`支撑：${supportText}。压力：${resistanceText}。`,conclusion:resistanceText.includes("创新高")?"价格已经在这段的高处，上面没有现成压力。":supportText.includes("创新低")?"价格已经在这段的低处，下面没有现成支撑。":"上面这些是这段K线里成交比较多的位置。"},
  ];
  return {symbol:cand.symbol,btc1h:btc1h==null?null:round(btc1h,5),btcWindow:btcWindow==null?null:round(btcWindow,5),majors1h:avg1h==null?null:round(avg1h,5),majorsWindow:avgWindow==null?null:round(avgWindow,5),
    regime,consensus:consensus==null?null:round(consensus,3),corr1h:corr1h==null?null:round(corr1h,3),corrWindow:corrWindow==null?null:round(corrWindow,3),decoupled,
    ret15m:round(ret15,5),ret1h:round(ret1h,5),retWindow:round(retWindow,5),relWindow:avgWindow==null?null:round(retWindow-avgWindow,5),
    volRank:round(volRank,3),windowHours:hours,support:support.map(p=>round(p,6)),resistance:resistance.map(p=>round(p,6)),supportText,resistanceText,
    depthRatio:round(depthRatio,3),bookImbalance:round(imbalance,3),spreadBps,funding:snap.funding,trades:"没有逐笔成交。盘口只看买一到买五、卖一到卖五的挂单。",sections};
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
function similar(mem:Memory[],vec:number[],hours:number):LiveAnalogy{
  const empty:LiveAnalogy={count:0,enough:false,threshold:SIMILAR,minSim:0,maxSim:0,down:0,up:0,flat:0,downPct:0,mfe1h:0,mae1h:0,mfe4h:0,mae4h:0,worst4h:0,best4h:0,refs:[],story:`最近 ${hours} 小时的K线里，还没有足够像的场面。`,lean:"看不出后来会涨还是会跌。",caution:null};
  const qn=Math.sqrt(vec.reduce((n,v)=>n+v*v,0));if(qn<1e-10||!mem.length)return empty;
  const passed=mem.map(row=>{
    const vn=Math.sqrt(row.vec.reduce((n,v)=>n+v*v,0));
    const sim=vn<1e-10?0:row.vec.reduce((n,v,i)=>n+v*vec[i]!,0)/(qn*vn);
    return {sim,row};
  }).filter(row=>row.sim>=SIMILAR).sort((a,b)=>b.sim-a.sim).slice(0,20);
  if(!passed.length)return empty;
  const o1=passed.map(x=>x.row.o1h),o4=passed.map(x=>x.row.o4h);
  const down=o1.filter(x=>x<-0.005).length,up=o1.filter(x=>x>0.005).length,flat=passed.length-down-up;
  const mean=(xs:number[])=>xs.reduce((n,v)=>n+v,0)/xs.length;
  const sims=passed.map(x=>x.sim);
  const refs=passed.slice(0,5).map(x=>({similarity:round(x.sim,3),o1h:round(x.row.o1h,5),o4h:round(x.row.o4h,5),symbol:x.row.symbol}));
  const top=refs.slice(0,3);
  const topDown=top.filter(row=>row.o1h<-0.005).length,topUp=top.filter(row=>row.o1h>0.005).length;
  const lean=down/passed.length>0.55?"后来比较常跌。":up/passed.length>0.45?"偏向后来涨，或者至少不跌。":(up+flat)/passed.length>=0.6?"偏向涨或者横着，没有一边倒。":"涨、横、跌都有，看不出偏向。";
  const caution=top.length>=3&&topDown===3&&down/passed.length<0.5?"最像的 3 个后来都跌了，但全部场面里跌的不是多数。两边对不上，要更小心。"
    :top.length>=3&&topUp===3&&up/passed.length<0.5?"最像的 3 个后来都涨了，但全部场面里涨的不是多数。两边对不上，要更小心。":null;
  return {count:passed.length,enough:passed.length>=5,threshold:SIMILAR,minSim:round(Math.min(...sims),3),maxSim:round(Math.max(...sims),3),down,up,flat,downPct:round(down/passed.length,3),
    mfe1h:round(mean(passed.map(x=>x.row.mfe1h)),5),mae1h:round(mean(passed.map(x=>x.row.mae1h)),5),
    mfe4h:round(mean(passed.map(x=>x.row.mfe4h)),5),mae4h:round(mean(passed.map(x=>x.row.mae4h)),5),
    worst4h:round(Math.min(...o4),5),best4h:round(Math.max(...o4),5),refs,
    story:`在最近 ${hours} 小时的K线里，找到 ${passed.length} 个和现在像的场面。`,lean,caution};
}

export function researchLevel(confidence:number):LiveDecision["level"]{
  return confidence<0.55?"观望":confidence<0.65?"弱信号":"明确信号";
}
function decide(cand:LiveCandidate,ctx:LiveContext,analogy:LiveAnalogy|null):LiveDecision{
  const pct=(v:number)=>`${v>=0?"+":""}${(v*100).toFixed(2)}%`;
  const prior:"LONG"|"SHORT"=cand.retZ5m>0?"SHORT":"LONG";
  const observation=`${cand.symbol.replace("_"," / ")} 最近 15 分钟 ${pct(ctx.ret15m)}，最近 1 小时 ${pct(ctx.ret1h)}。${priceWords(cand.retZ5m)}。涨猛了容易回、跌猛了容易弹，这只是假设，不单独决定方向。`;
  const sideName=(side:"LONG"|"SHORT")=>side==="LONG"?"做多":"做空";
  const votes:{side:"LONG"|"SHORT"|null;text:string}[]=[];
  if(ctx.funding>0.00005)votes.push({side:"SHORT",text:"做多的人在付钱给做空的人，这笔偏空。"});
  else if(ctx.funding<-0.00005)votes.push({side:"LONG",text:"做空的人在付钱给做多的人，这笔偏多。"});
  else votes.push({side:null,text:"资金费两边差不多，看不出谁更挤。"});
  if(ctx.depthRatio<0.8)votes.push({side:"SHORT",text:"卖盘比买盘厚，这笔偏空。"});
  else if(ctx.depthRatio>1.2)votes.push({side:"LONG",text:"买盘比卖盘厚，这笔偏多。"});
  else votes.push({side:null,text:"买卖挂单差不多，看不出方向。"});
  if(!analogy||!analogy.enough)votes.push({side:null,text:"像现在的老场面不够 5 个，这条先不算。"});
  else if(analogy.downPct>0.55)votes.push({side:"SHORT",text:`像现在的场面里，${(analogy.downPct*100).toFixed(0)}% 过 1 小时是跌的，这笔偏空。`});
  else if(analogy.downPct<0.45)votes.push({side:"LONG",text:`像现在的场面里，跌的只有 ${(analogy.downPct*100).toFixed(0)}%，更多是涨或者横着，这笔偏多。`});
  else votes.push({side:null,text:"像现在的场面，后来涨的、横的、跌的都有，看不出偏向。"});
  if(ctx.regime==="上涨")votes.push({side:"LONG",text:"大盘在涨，环境偏多。"});
  else if(ctx.regime==="下跌")votes.push({side:"SHORT",text:"大盘在跌，环境偏空。"});
  else votes.push({side:null,text:ctx.regime==="看不出"?"大盘数据不够，这条不算。":"大盘在晃，这条不算方向。"});
  const cast=votes.filter((vote):vote is {side:"LONG"|"SHORT";text:string}=>vote.side!=null);
  const longs=cast.filter(vote=>vote.side==="LONG"),shorts=cast.filter(vote=>vote.side==="SHORT");
  const direction:LiveDecision["direction"]=longs.length===shorts.length?null:longs.length>shorts.length?"LONG":"SHORT";
  const agree=Math.max(longs.length,shorts.length),against=Math.min(longs.length,shorts.length);
  const conflict=longs.length>0&&shorts.length>0?`证据互相矛盾：${longs.length} 条偏多，${shorts.length} 条偏空。` :null;
  let confidence=0.4;
  if(agree>=3&&against===0)confidence=0.74;
  else if(agree>=3&&against>0)confidence=0.58;
  else if(agree===2&&against===0)confidence=0.60;
  else if(agree===2&&against>0)confidence=0.50;
  else if(agree===1)confidence=0.46;
  if(agree<2)confidence=Math.min(confidence,0.50);
  confidence=Math.max(0.15,Math.min(0.85,confidence));
  const level=researchLevel(confidence);
  const shown=level==="观望"?null:direction;
  const hypothesis=direction==null?"":direction===prior?"这和「涨猛了容易回、跌猛了容易弹」同向。":"这和「涨猛了容易回、跌猛了容易弹」相反，以这几条证据为准。";
  const headline=level==="明确信号"&&shown?`${sideName(shown)}。这是明确信号。研究页只写出来，不会下单。`
    :level==="弱信号"&&shown?`偏${sideName(shown)}，但这只是弱信号，先不下单。`
    :direction?`目前不下单。票数偏向${sideName(direction)}，但不够。`:"目前不下单。看不出该做多还是做空。";
  const conclusion=headline;
  const why=[...votes.map(vote=>vote.text),...(conflict?[conflict]:[]),...(direction? [hypothesis]:[])].filter(Boolean);
  const waitFor=level==="观望"?[
    Math.abs(cand.retZ5m)<3?`等这一下再猛一点。现在大约是平时的 ${Math.abs(cand.retZ5m).toFixed(1)} 倍，超过 3 倍才算很猛。`:"",
    ctx.depthRatio>=0.8&&ctx.depthRatio<=1.2?"等买盘或者卖盘明显更厚。":"",
    Math.abs(ctx.funding)<0.001?"等资金费明显偏一边，比如做多的人付钱超过 0.1%。":"",
    ctx.btc1h==null||Math.abs(ctx.btc1h)<0.005?"等大盘自己走出方向，BTC 1 小时涨跌超过 0.5%。":"",
  ].filter(Boolean):[];
  const entry=cand.last;
  const adverse=analogy?Math.abs(analogy.mae1h):null;
  const raw=adverse==null?0.01:adverse*1.5;
  const stopPct=Math.max(0.008,Math.min(0.025,raw));
  const tp1Pct=analogy?Math.max(0.01,Math.min(0.04,Math.abs(analogy.mfe1h)*1.2)):0.015;
  const tp2Pct=analogy?Math.max(0.02,Math.min(0.08,Math.abs(analogy.mfe4h)*1.2)):0.03;
  const clamped=raw>0.025?"，高于 2.5% 就封顶":raw<0.008?"，低于 0.8% 就按 0.8%":"";
  const stopWhy=analogy&&analogy.enough
    ?`止损离开进场 ${(stopPct*100).toFixed(2)}%。这是像现在的场面里，平均最多走错的那段，再放宽一半${clamped}。`
    :`止损离开进场 ${(stopPct*100).toFixed(2)}%。像的场面不够，这是默认距离，不是算出来的。`;
  const planSide=direction??prior;
  const stop=planSide==="SHORT"?entry*(1+stopPct):entry*(1-stopPct);
  const tp1=planSide==="SHORT"?entry*(1-tp1Pct):entry*(1+tp1Pct);
  const tp2=planSide==="SHORT"?entry*(1-tp2Pct):entry*(1+tp2Pct);
  return {symbol:cand.symbol,direction:shown,level,confidence:round(confidence,3),observation,evidence:votes.map(vote=>vote.text),conflict,conclusion,reasoning:why,
    headline,why,planSide,holdText:"2 小时",waitFor,stopPct:round(stopPct,4),tp1Pct:round(tp1Pct,4),tp2Pct:round(tp2Pct,4),
    entry:round(entry,6),stop:round(stop,6),tp1:round(tp1,6),tp2:round(tp2,6),stopWhy,
    invalidate:[planSide==="SHORT"?`价格涨回 ${(entry*1.005).toFixed(6)}`:`价格跌回 ${(entry*0.995).toFixed(6)}`,"重新紧紧跟着大盘走"]};
}

export function reviewResearchLog(rows:ResearchLogRow[],snaps:{symbol:string;m5:ResearchBar[]}[],now:number):ResearchLogRow[]{
  return rows.map(row=>{
    if(row.verdict||now-row.at<3_600_000)return row;
    if(row.direction==null)return {...row,laterRet:null,verdict:"当时没给方向"};
    if(!(row.price&&row.price>0))return {...row,laterRet:null,verdict:"当时没记下价格"};
    const bars=snaps.find(snap=>snap.symbol===row.symbol)?.m5??[];
    const target=row.at/1000+3600;
    const hit=bars.find(bar=>bar.t>=target-300)||(bars.at(-1)&&bars.at(-1)!.t+300>=target?bars.at(-1)!:null);
    if(!hit)return row;
    const laterRet=hit.c/row.price-1;
    const verdict=Math.abs(laterRet)<0.001?"几乎没动":(row.direction==="SHORT"?laterRet<0:laterRet>0)?"对":"错";
    return {...row,laterRet,verdict};
  });
}

export function runLiveResearch(snaps:ResearchSnap[],now:number):LiveResearchView{
  const usable=snaps.filter(s=>s.m5.length>=31&&s.m5.at(-1)!.c>0);
  const scanResult=scan(usable);
  const candidates=scanResult.rows;
  const hours=usable.length?Math.round(Math.max(...usable.map(s=>s.m5.length))*5/60):0;
  const nextAt=now+30_000;
  if(!candidates.length)return {ts:now,status:"5 分钟K线还不够，这一轮扫不出异动。",library:0,windowHours:hours,candidates:[],context:null,analogy:null,decision:null,scanned:scanResult.scanned,found:scanResult.found,nextAt};
  const map=new Map(usable.map(s=>[s.symbol,s]));
  const top=candidates[0]!;
  const context=contextOf(top,map);
  const mem=library(usable);
  const vec=[context.ret15m*100,context.ret1h*100,context.corr1h??0,(context.ret1h-(context.btc1h??0))*100];
  const analogy=similar(mem,vec,hours);
  return {ts:now,status:"只写在研究页上，不会下单。",library:mem.length,windowHours:hours,candidates,context,analogy,decision:decide(top,context,analogy.enough?analogy:null),scanned:scanResult.scanned,found:scanResult.found,nextAt};
}
