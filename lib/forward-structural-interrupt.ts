export const STRUCTURAL_INTERRUPT_VERSION="forward-structural-interrupt-v1";

export type InterruptSide="LONG"|"SHORT";
export type InterruptCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type InterruptQuote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean};
export type InterruptRegion={
  id:string;symbol:string;lower:number;upper:number;center:number;widthRate:number;quality:number;
  outerLower?:number;outerUpper?:number;outerCenter?:number;outerWidthRate?:number;outerBars?:number;outerQuality?:number;atrRate?:number;
};
export type OuterRegion={lower:number;upper:number;center:number;widthRate:number;bars:number;quality:number};
export type InterruptTrack={
  symbol:string;side:InterruptSide;phase:"PRE_ALERT"|"CONFIRMED"|"COOLDOWN";boundary:number;startedAt:number;lastAt:number;
  lastQuoteAt:number;samples:number;outsideSamples:number;firstPrice:number;lastPrice:number;extremePrice:number;
  currentOutsideRate:number;maxExcursionRate:number;maxPullbackRate:number;hadPullback:boolean;restartSeen:boolean;
  confirmedAt:number|null;cooldownUntil:number;
};
export type MarketInterruptEvent={
  id:string;side:InterruptSide;startedAt:number;confirmedAt:number;lastAt:number;expiresAt:number;
  breadth:number;confirmedSymbols:string[];
};
export type StructuralInterruptState={
  version:typeof STRUCTURAL_INTERRUPT_VERSION;tracks:Record<string,InterruptTrack>;marketEvent:MarketInterruptEvent|null;
  vetoSide:InterruptSide|null;vetoUntil:number;vetoBreadth:number;
};
export type StructuralInterruptCandidate={
  symbol:string;side:InterruptSide;eventId:string;marketWide:boolean;boundary:number;confirmedAt:number;
  stopPrice:number;targetPrice:number;strength:number;outsideRate:number;atrRate:number;outerWidthRate:number;reason:string;
};

const TRACK_TTL_MS=90_000,EVENT_TTL_MS=45_000,COOLDOWN_MS=60_000,QUOTE_MAX_AGE_MS=8_000;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(values:number[])=>{const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]!:(a[a.length/2-1]!+a[a.length/2]!)/2):0;};
const fresh=(q:InterruptQuote|undefined,now:number)=>!!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=QUOTE_MAX_AGE_MS;
const midpoint=(q:InterruptQuote)=>(q.bestBid+q.bestAsk)/2;
const sideDir=(side:InterruptSide)=>side==="LONG"?1:-1;
const outsideRate=(side:InterruptSide,price:number,boundary:number)=>side==="LONG"?price/boundary-1:boundary/price-1;
const extremeFor=(side:InterruptSide,a:number,b:number)=>side==="LONG"?Math.max(a,b):Math.min(a,b);
const pullbackFromExtreme=(side:InterruptSide,price:number,extreme:number,boundary:number)=>
  Math.max(0,side==="LONG"?(extreme-price)/boundary:(price-extreme)/boundary);

function crossings(values:number[],center:number){
  let count=0,prior=0;
  for(const value of values){const side=value>center?1:value<center?-1:0;if(side&&prior&&side!==prior)count++;if(side)prior=side;}
  return count;
}

export function detectOuterRegion(rows:InterruptCandle[],inner:{lower:number;upper:number;widthRate:number},atrRate:number):OuterRegion|null{
  const completed=rows.filter(row=>[row.time,row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)
    &&row.time>0&&row.open>0&&row.close>0&&row.low>0&&row.high>=Math.max(row.open,row.close)&&row.low<=Math.min(row.open,row.close))
    .sort((a,b)=>a.time-b.time);
  if(completed.length<20)return null;
  const candidates:OuterRegion[]=[];
  for(const bars of[18,24,30,36,48]){
    const window=completed.slice(-(bars+1),-1);if(window.length!==bars)continue;
    const lower=Math.min(...window.map(row=>row.low)),upper=Math.max(...window.map(row=>row.high));
    if(!(lower>0&&upper>lower&&lower<=inner.lower&&upper>=inner.upper))continue;
    const closes=window.map(row=>row.close),center=clip(median(closes),lower,upper),width=upper-lower,widthRate=width/center;
    const maxWidthRate=Math.max(.010,Math.min(.10,Math.max(.00045,atrRate)*8));
    if(widthRate>maxWidthRate||widthRate<inner.widthRate*.98)continue;
    const cross=crossings(closes,center),edgeBand=width*.16;
    const touchesUpper=window.filter(row=>row.high>=upper-edgeBand).length,touchesLower=window.filter(row=>row.low<=lower+edgeBand).length;
    const drift=Math.abs(closes.at(-1)!-closes[0]!)/width,half=Math.floor(closes.length/2),
      halfShift=Math.abs(median(closes.slice(0,half))-median(closes.slice(half)))/width;
    if(cross<3||touchesUpper<2||touchesLower<2||drift>1||halfShift>.75)continue;
    const compact=1-clip(widthRate/maxWidthRate),quality=100*clip(.32*compact+.30*Math.min(1,cross/6)
      +.23*Math.min(1,(touchesUpper+touchesLower)/(bars*.35))+.15*Math.min(1,bars/36));
    if(quality<48)continue;
    candidates.push({lower,upper,center,widthRate,bars,quality});
  }
  if(!candidates.length)return null;
  return candidates.sort((a,b)=>b.bars-a.bars||b.quality-a.quality||a.widthRate-b.widthRate)[0]!;
}

export function initialStructuralInterruptState():StructuralInterruptState{
  return{version:STRUCTURAL_INTERRUPT_VERSION,tracks:{},marketEvent:null,vetoSide:null,vetoUntil:0,vetoBreadth:0};
}
export function normalizeStructuralInterruptState(value:unknown,now:number):StructuralInterruptState{
  if(!value||typeof value!=="object")return initialStructuralInterruptState();
  const raw=value as Partial<StructuralInterruptState>,tracks:Record<string,InterruptTrack>={};
  for(const [symbol,row] of Object.entries(raw.tracks??{})){
    if(!row||row.symbol!==symbol||!["LONG","SHORT"].includes(row.side)||!Number.isFinite(row.lastAt)||now-row.lastAt>TRACK_TTL_MS)continue;
    tracks[symbol]={...row,phase:["PRE_ALERT","CONFIRMED","COOLDOWN"].includes(row.phase)?row.phase:"PRE_ALERT",
      samples:Math.max(1,Math.floor(row.samples||1)),outsideSamples:Math.max(1,Math.floor(row.outsideSamples||1)),
      confirmedAt:Number.isFinite(row.confirmedAt??NaN)?row.confirmedAt:null,cooldownUntil:Number.isFinite(row.cooldownUntil)?row.cooldownUntil:0};
  }
  const event=raw.marketEvent&&Number.isFinite(raw.marketEvent.expiresAt)&&raw.marketEvent.expiresAt>now-10_000?raw.marketEvent:null;
  const vetoSide=raw.vetoUntil&&raw.vetoUntil>now&&["LONG","SHORT"].includes(raw.vetoSide??"")?raw.vetoSide!:null;
  return{version:STRUCTURAL_INTERRUPT_VERSION,tracks,marketEvent:event,vetoSide,vetoUntil:vetoSide?raw.vetoUntil!:0,
    vetoBreadth:vetoSide&&Number.isFinite(raw.vetoBreadth)?raw.vetoBreadth!:0};
}

function startTrack(symbol:string,side:InterruptSide,boundary:number,price:number,rate:number,qAt:number,now:number):InterruptTrack{
  return{symbol,side,phase:"PRE_ALERT",boundary,startedAt:now,lastAt:now,lastQuoteAt:qAt,samples:1,outsideSamples:1,
    firstPrice:price,lastPrice:price,extremePrice:price,currentOutsideRate:rate,maxExcursionRate:rate,maxPullbackRate:0,
    hadPullback:false,restartSeen:false,confirmedAt:null,cooldownUntil:0};
}

function updateTrack(track:InterruptTrack,price:number,rate:number,atrRate:number,qAt:number,now:number){
  if(qAt<=track.lastQuoteAt){track.lastAt=now;track.lastPrice=price;track.currentOutsideRate=rate;return track;}
  const priorMax=track.maxExcursionRate,priorExtreme=track.extremePrice,pullback=pullbackFromExtreme(track.side,price,priorExtreme,track.boundary);
  track.samples++;track.outsideSamples++;track.lastAt=now;track.lastQuoteAt=qAt;track.lastPrice=price;track.currentOutsideRate=rate;
  track.maxPullbackRate=Math.max(track.maxPullbackRate,pullback);
  if(pullback>=Math.max(.0006,atrRate*.12)&&pullback<=Math.max(.0015,priorMax*.50))track.hadPullback=true;
  const nextExtreme=extremeFor(track.side,priorExtreme,price),nextMax=Math.max(priorMax,outsideRate(track.side,nextExtreme,track.boundary));
  if(track.hadPullback&&nextMax>priorMax+Math.max(.0002,atrRate*.05))track.restartSeen=true;
  track.extremePrice=nextExtreme;track.maxExcursionRate=nextMax;
  const elapsed=now-track.startedAt,minExcursion=Math.max(.0022,atrRate*.70),currentFloor=Math.max(.0008,atrRate*.18,minExcursion*.55),
    pullbackCeiling=Math.max(atrRate*.50,nextMax*.50),
    sustained=elapsed>=4_000&&track.samples>=3&&track.outsideSamples>=3&&rate>=currentFloor&&track.maxPullbackRate<=pullbackCeiling,
    impulse=nextMax>=Math.max(.0045,atrRate*1.15),steady=track.samples>=4&&nextMax>=minExcursion;
  if(track.phase==="PRE_ALERT"&&sustained&&(impulse||track.restartSeen||steady)){track.phase="CONFIRMED";track.confirmedAt=now;}
  return track;
}

function activeTracks(state:StructuralInterruptState,side:InterruptSide,now:number,phase?:"PRE_ALERT"|"CONFIRMED"){
  return Object.values(state.tracks).filter(track=>track.side===side&&now-track.lastAt<=12_000
    &&(phase?track.phase===phase:track.phase!=="COOLDOWN"));
}

export function advanceStructuralInterrupt(input:{state:StructuralInterruptState;regions:Record<string,InterruptRegion>;
  quotes:Record<string,InterruptQuote>;now:number}):StructuralInterruptState{
  const state=normalizeStructuralInterruptState(structuredClone(input.state),input.now),watchable:string[]=[];
  for(const [symbol,region] of Object.entries(input.regions)){
    if(!(region.outerBars&&region.outerBars>=18&&region.outerLower&&region.outerUpper&&region.outerUpper>region.outerLower))continue;
    const quote=input.quotes[symbol];if(!fresh(quote,input.now))continue;watchable.push(symbol);
    const price=midpoint(quote!),atrRate=Math.max(.00045,region.atrRate??.00045),buffer=Math.max(.0008,atrRate*.18),
      up=outsideRate("LONG",price,region.outerUpper),down=outsideRate("SHORT",price,region.outerLower);
    const side:InterruptSide|null=up>=buffer&&up>=down?"LONG":down>=buffer?"SHORT":null,rate=side==="LONG"?up:side==="SHORT"?down:0;
    const prior=state.tracks[symbol];
    if(!side){
      if(prior&&prior.phase!=="COOLDOWN"){
        const returned=outsideRate(prior.side,price,prior.boundary)<=Math.max(.0002,atrRate*.08);
        if(returned){prior.phase="COOLDOWN";prior.cooldownUntil=input.now+COOLDOWN_MS;prior.lastAt=input.now;prior.lastPrice=price;prior.currentOutsideRate=0;}
      }else if(prior?.phase==="COOLDOWN"&&input.now>=prior.cooldownUntil)delete state.tracks[symbol];
      continue;
    }
    if(prior?.phase==="COOLDOWN"&&input.now<prior.cooldownUntil)continue;
    const boundary=side==="LONG"?region.outerUpper:region.outerLower;
    if(!prior||prior.side!==side||Math.abs(prior.boundary/boundary-1)>.002||input.now-prior.lastAt>20_000)
      state.tracks[symbol]=startTrack(symbol,side,boundary,price,rate,quote!.observedAt,input.now);
    else updateTrack(prior,price,rate,atrRate,quote!.observedAt,input.now);
  }
  for(const [symbol,track] of Object.entries(state.tracks)){
    if(track.phase==="COOLDOWN"&&input.now>=track.cooldownUntil)delete state.tracks[symbol];
    else if(input.now-track.lastAt>TRACK_TTL_MS)delete state.tracks[symbol];
  }
  const denom=Math.max(1,watchable.length),longPre=activeTracks(state,"LONG",input.now),shortPre=activeTracks(state,"SHORT",input.now),
    longConfirmed=activeTracks(state,"LONG",input.now,"CONFIRMED"),shortConfirmed=activeTracks(state,"SHORT",input.now,"CONFIRMED");
  const preSide=longPre.length>shortPre.length?"LONG":shortPre.length>longPre.length?"SHORT":null;
  const preCount=preSide==="LONG"?longPre.length:preSide==="SHORT"?shortPre.length:0,preBreadth=preCount/denom;
  if(preSide&&preCount>=4&&preBreadth>=.25){state.vetoSide=preSide;state.vetoUntil=input.now+15_000;state.vetoBreadth=preBreadth;}
  else if(state.vetoUntil<=input.now){state.vetoSide=null;state.vetoUntil=0;state.vetoBreadth=0;}
  const confirmedSide=longConfirmed.length>shortConfirmed.length?"LONG":shortConfirmed.length>longConfirmed.length?"SHORT":null,
    confirmed=confirmedSide==="LONG"?longConfirmed:confirmedSide==="SHORT"?shortConfirmed:[],breadth=confirmed.length/denom;
  if(confirmedSide&&confirmed.length>=3&&breadth>=.20){
    const start=Math.min(...confirmed.map(track=>track.startedAt)),id=`shock-${confirmedSide}-${Math.floor(start/30_000)}`;
    state.marketEvent={id,side:confirmedSide,startedAt:start,confirmedAt:Math.min(...confirmed.map(track=>track.confirmedAt??input.now)),
      lastAt:input.now,expiresAt:input.now+EVENT_TTL_MS,breadth,confirmedSymbols:confirmed.map(track=>track.symbol)};
    state.vetoSide=confirmedSide;state.vetoUntil=input.now+EVENT_TTL_MS;state.vetoBreadth=Math.max(state.vetoBreadth,breadth);
  }else if(state.marketEvent){
    const still=activeTracks(state,state.marketEvent.side,input.now,"CONFIRMED");
    if(still.length){state.marketEvent={...state.marketEvent,lastAt:input.now,expiresAt:input.now+EVENT_TTL_MS,
      breadth:still.length/denom,confirmedSymbols:still.map(track=>track.symbol)};}
    else if(state.marketEvent.expiresAt<=input.now)state.marketEvent=null;
  }
  return state;
}

export function structuralInterruptCandidates(input:{state:StructuralInterruptState;regions:Record<string,InterruptRegion>;
  quotes:Record<string,InterruptQuote>;now:number}):StructuralInterruptCandidate[]{
  const out:StructuralInterruptCandidate[]=[];
  for(const track of Object.values(input.state.tracks)){
    if(track.phase!=="CONFIRMED"||!track.confirmedAt||input.now-track.lastAt>12_000)continue;
    const region=input.regions[track.symbol],quote=input.quotes[track.symbol];if(!region||!fresh(quote,input.now))continue;
    const price=midpoint(quote!),atrRate=Math.max(.00045,region.atrRate??.00045),outerWidthRate=Math.max(region.outerWidthRate??region.widthRate,.001),
      marketWide=input.state.marketEvent?.side===track.side&&input.state.marketEvent.confirmedSymbols.includes(track.symbol)
        &&input.state.marketEvent.expiresAt>input.now,
      singleExtreme=track.maxExcursionRate>=Math.max(.0065,atrRate*1.35)&&(region.outerQuality??0)>=55;
    if(!marketWide&&!singleExtreme)continue;
    const eventId=marketWide?input.state.marketEvent!.id:`shock-${track.symbol}-${track.side}-${Math.floor(track.startedAt/30_000)}`,
      stopOffset=Math.max(.0015,atrRate*.45,outerWidthRate*.08),
      stopPrice=track.side==="LONG"?track.boundary*(1-stopOffset):track.boundary*(1+stopOffset),
      targetRate=Math.max(.006,Math.min(.03,Math.max(track.maxExcursionRate*1.5,atrRate*2.4,outerWidthRate*.45))),
      targetPrice=price*(1+sideDir(track.side)*targetRate),
      strength=clip(72+Math.min(16,track.maxExcursionRate/Math.max(atrRate,1e-9)*7)+(track.restartSeen?5:0)+(marketWide?7:0),0,100),
      reason=`极端结构中断｜外层${region.outerBars}根区域${track.side==="LONG"?"上":"下"}破｜2秒路径${track.samples}次连续确认｜外离${(track.currentOutsideRate*100).toFixed(2)}%${marketWide?`｜市场同步${(input.state.marketEvent!.breadth*100).toFixed(0)}%`:"｜单币特大位移"}`;
    if((track.side==="LONG"&&stopPrice>=price)||(track.side==="SHORT"&&stopPrice<=price))continue;
    out.push({symbol:track.symbol,side:track.side,eventId,marketWide,boundary:track.boundary,confirmedAt:track.confirmedAt,
      stopPrice,targetPrice,strength,outsideRate:track.currentOutsideRate,atrRate,outerWidthRate,reason});
  }
  return out.sort((a,b)=>b.strength-a.strength||b.outsideRate-a.outsideRate);
}

export function structuralInterruptBlockReason(state:StructuralInterruptState,symbol:string,side:InterruptSide,now:number){
  const local=state.tracks[symbol];
  if(local?.phase==="CONFIRMED"&&now-local.lastAt<=12_000&&local.side!==side)
    return`该币已确认${local.side==="LONG"?"向上":"向下"}极端结构突变，旧方向暂不新增`;
  if(state.marketEvent&&state.marketEvent.expiresAt>now&&state.marketEvent.side!==side)
    return`市场级${state.marketEvent.side==="LONG"?"上冲":"下杀"}突变已确认，旧方向暂不新增`;
  if(state.vetoSide&&state.vetoUntil>now&&state.vetoSide!==side)
    return`市场突变预警正在形成（同步${(state.vetoBreadth*100).toFixed(0)}%），旧方向先停止新增`;
  return null;
}
