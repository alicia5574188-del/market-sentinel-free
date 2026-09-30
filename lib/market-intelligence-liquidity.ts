export const LIQUIDITY_MAP_VERSION="market-liquidity-map-v1";

export type LiquidityCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type LiquidityZoneTier="GLOBAL"|"TRADE";
export type LiquidityDepartureState="INSIDE"|"TESTING"|"ACCEPTED"|"REJECTED";
export type LiquiditySide="UP"|"DOWN";

export type LiquidityZone={
  id:string;tier:LiquidityZoneTier;lower:number;upper:number;center:number;widthRate:number;
  strength:number;touches:number;pivotScore:number;absorptionScore:number;revisits:number;
  firstTouchedAt:number;lastTouchedAt:number;
};

export type LiquidityDeparture={
  state:LiquidityDepartureState;side:LiquiditySide|null;confidence:number;startedAt:number|null;
  distanceRate:number;outsideBars:number;reason:string;
};

export type SymbolLiquidityMap={
  version:typeof LIQUIDITY_MAP_VERSION;ready:boolean;updatedAt:number;bars:number;atrRate:number;
  globalZones:LiquidityZone[];tradeZones:LiquidityZone[];
  activeZone:LiquidityZone|null;nextAbove:LiquidityZone|null;nextBelow:LiquidityZone|null;
  accumulation:number;upperDepletion:number;lowerDepletion:number;
  departure:LiquidityDeparture;targetDistanceRate:number|null;openSpace:boolean;reason:string;
};

export type MarketLiquidityContext={
  version:typeof LIQUIDITY_MAP_VERSION;updatedAt:number;ready:boolean;readySymbols:number;totalSymbols:number;
  insideShare:number;testingShare:number;acceptedShare:number;rejectedShare:number;highAccumulationShare:number;
  upMigrationShare:number;downMigrationShare:number;oneSidedDepletionShare:number;migrationBreadth:number;
  summary:string;
};

export type MarketLiquidityResearch={
  version:typeof LIQUIDITY_MAP_VERSION;updatedAt:number;market:MarketLiquidityContext;symbols:Record<string,SymbolLiquidityMap>;
};

export function initialMarketLiquidityResearch(now:number):MarketLiquidityResearch{
  return{version:LIQUIDITY_MAP_VERSION,updatedAt:now,market:{version:LIQUIDITY_MAP_VERSION,updatedAt:now,ready:false,
    readySymbols:0,totalSymbols:0,insideShare:0,testingShare:0,acceptedShare:0,rejectedShare:0,highAccumulationShare:0,
    upMigrationShare:0,downMigrationShare:0,oneSidedDepletionShare:0,migrationBreadth:0,summary:"等待足够的全市场5分钟历史建立流动性地图。"},symbols:{}};
}

type Point={price:number;weight:number;bar:number;pivot:number;absorption:number;at:number};
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const median=(xs:number[])=>{const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;};
const tr=(row:LiquidityCandle,prev?:LiquidityCandle)=>Math.max(row.high-row.low,prev?Math.abs(row.high-prev.close):0,prev?Math.abs(row.low-prev.close):0);
const completed=(rows:LiquidityCandle[],now:number)=>rows.filter(r=>r&&[r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)
  &&r.time>0&&r.close>0&&r.high>=r.low&&r.volume>=0&&r.time*1000+300_000<=now).sort((a,b)=>a.time-b.time);
const overlap=(a:{lower:number;upper:number},b:{lower:number;upper:number})=>a.lower<=b.upper&&b.lower<=a.upper;

function pointsFor(rows:LiquidityCandle[],radius:number,atr:number){
  const points:Point[]=[],volMed=Math.max(1e-12,median(rows.slice(-36).map(r=>r.volume)));
  for(let i=radius;i<rows.length-radius;i++){
    const row=rows[i]!,neighbors=rows.slice(i-radius,i+radius+1),range=Math.max(1e-12,row.high-row.low),
      pivotHigh=neighbors.every(x=>row.high>=x.high),pivotLow=neighbors.every(x=>row.low<=x.low),
      prominenceHigh=pivotHigh?Math.max(0,row.high-Math.max(...neighbors.filter((_,j)=>j!==radius).map(x=>x.high))):0,
      prominenceLow=pivotLow?Math.max(0,Math.min(...neighbors.filter((_,j)=>j!==radius).map(x=>x.low))-row.low):0,
      volRatio=clip(row.volume/volMed,0,4),rangeRatio=range/Math.max(atr,1e-12),
      absorption=clip((volRatio-1)/2)*clip((1.15-rangeRatio)/.85);
    if(pivotHigh)points.push({price:row.high,weight:1+.9*clip(prominenceHigh/Math.max(atr,.000001)),bar:i,pivot:1,absorption:0,at:(row.time+300)*1000});
    if(pivotLow)points.push({price:row.low,weight:1+.9*clip(prominenceLow/Math.max(atr,.000001)),bar:i,pivot:1,absorption:0,at:(row.time+300)*1000});
    if(absorption>.08){
      const typical=(row.high+row.low+row.close)/3;
      points.push({price:typical,weight:.45+1.4*absorption,bar:i,pivot:0,absorption,at:(row.time+300)*1000});
    }
    points.push({price:row.close,weight:.12,bar:i,pivot:0,absorption:0,at:(row.time+300)*1000});
  }
  return points;
}

function buildZones(rows:LiquidityCandle[],tier:LiquidityZoneTier,now:number,atr:number){
  if(rows.length<24)return[];
  const last=rows.at(-1)!.close,width=Math.max(atr*(tier==="GLOBAL"?.95:.70),last*(tier==="GLOBAL"?.0018:.0012)),
    pts=pointsFor(rows,tier==="GLOBAL"?3:2,atr).sort((a,b)=>a.price-b.price),groups:Point[][]=[];
  for(const p of pts){
    const g=groups.at(-1);
    if(!g){groups.push([p]);continue;}
    const center=g.reduce((n,x)=>n+x.price*x.weight,0)/Math.max(1e-12,g.reduce((n,x)=>n+x.weight,0));
    if(Math.abs(p.price-center)<=width*1.15)g.push(p);else groups.push([p]);
  }
  const zones=groups.map((g,idx)=>{
    const weights=g.reduce((n,x)=>n+x.weight,0),center=g.reduce((n,x)=>n+x.price*x.weight,0)/Math.max(weights,1e-12),
      bars=[...new Set(g.map(x=>x.bar))],touches=bars.length,pivot=g.reduce((n,x)=>n+x.pivot*x.weight,0),
      absorption=g.reduce((n,x)=>n+x.absorption*x.weight,0),first=Math.min(...g.map(x=>x.at)),lastAt=Math.max(...g.map(x=>x.at)),
      recency=clip(1-(now-lastAt)/(tier==="GLOBAL"?8*60*60_000:3*60*60_000)),
      strength=clip(.28*clip(touches/7)+.28*clip(pivot/6)+.28*clip(absorption/4)+.16*recency),
      spread=Math.max(width,Math.max(...g.map(x=>Math.abs(x.price-center)),0)+width*.35),
      lower=center-spread,upper=center+spread;
    return{id:`${tier.toLowerCase()}-${idx}-${Math.round(center*1e6)}`,tier,lower,upper,center,
      widthRate:(upper-lower)/Math.max(center,1e-12),strength,touches,pivotScore:clip(pivot/6),absorptionScore:clip(absorption/4),
      revisits:0,firstTouchedAt:first,lastTouchedAt:lastAt} satisfies LiquidityZone;
  }).filter(z=>z.strength>=.30&&z.touches>=2&&(z.pivotScore>=.08||z.absorptionScore>=.06)).sort((a,b)=>a.center-b.center);
  const merged:LiquidityZone[]=[];
  for(const z of zones){
    const prev=merged.at(-1);
    if(prev&&overlap(prev,z)){
      const wa=Math.max(.05,prev.strength),wb=Math.max(.05,z.strength),center=(prev.center*wa+z.center*wb)/(wa+wb);
      prev.lower=Math.min(prev.lower,z.lower);prev.upper=Math.max(prev.upper,z.upper);prev.center=center;
      prev.widthRate=(prev.upper-prev.lower)/Math.max(center,1e-12);prev.strength=clip(Math.max(prev.strength,z.strength)+.08*Math.min(prev.strength,z.strength));
      prev.touches+=z.touches;prev.pivotScore=clip((prev.pivotScore+z.pivotScore)/2);prev.absorptionScore=clip((prev.absorptionScore+z.absorptionScore)/2);
      prev.firstTouchedAt=Math.min(prev.firstTouchedAt,z.firstTouchedAt);prev.lastTouchedAt=Math.max(prev.lastTouchedAt,z.lastTouchedAt);
    }else merged.push({...z});
  }
  for(const z of merged){
    let revisits=0,wasInside=false,left=false;
    for(const r of rows){
      const inside=r.high>=z.lower&&r.low<=z.upper;
      if(inside&&!wasInside&&left)revisits++;
      if(!inside&&wasInside)left=true;
      wasInside=inside;
    }
    z.revisits=revisits;z.strength=clip(z.strength+.04*clip(revisits/3));
  }
  return merged.sort((a,b)=>b.strength-a.strength||b.lastTouchedAt-a.lastTouchedAt).slice(0,tier==="GLOBAL"?8:6);
}

function boundaryDepletion(rows:LiquidityCandle[],zone:LiquidityZone,atr:number,side:LiquiditySide){
  const recent=rows.slice(-18),tests=recent.filter(r=>side==="UP"?r.high>=zone.upper-atr*.35:r.low<=zone.lower+atr*.35);
  if(!tests.length)return 0;
  const rejection=tests.map(r=>side==="UP"?(r.high-r.close)/Math.max(atr,1e-12):(r.close-r.low)/Math.max(atr,1e-12)),
    half=Math.max(1,Math.floor(rejection.length/2)),early=mean(rejection.slice(0,half)),late=mean(rejection.slice(-half)),
    weakening=clip((early-late)/(Math.max(.25,early))),
    closes=tests.filter(r=>side==="UP"?r.close>=zone.upper-atr*.25:r.close<=zone.lower+atr*.25).length/tests.length;
  return clip(.50*clip(tests.length/5)+.30*weakening+.20*closes);
}

function zoneMetrics(rows:LiquidityCandle[],zone:LiquidityZone,atr:number){
  const recent=rows.slice(-18),volMed=Math.max(1e-12,median(rows.slice(-36).map(r=>r.volume))),inside=(r:LiquidityCandle)=>r.close>=zone.lower&&r.close<=zone.upper,
    dwell=recent.filter(inside).length/Math.max(1,recent.length),
    absorption=mean(recent.filter(r=>r.high>=zone.lower&&r.low<=zone.upper).map(r=>{
      const vr=clip(r.volume/volMed,0,4),rr=(r.high-r.low)/Math.max(atr,1e-12);return clip((vr-1)/2)*clip((1.2-rr)/.9);
    })),
    boundaryTests=recent.filter(r=>r.high>=zone.upper-atr*.3||r.low<=zone.lower+atr*.3).length,
    failedExits=recent.slice(1).reduce((n,r,i)=>{
      const p=recent[i]!,pOut=p.close>zone.upper+atr*.15||p.close<zone.lower-atr*.15;return n+Number(pOut&&inside(r));
    },0),
    accumulation=clip(.38*dwell+.27*absorption+.20*clip(failedExits/3)+.15*clip(boundaryTests/6));
  return{accumulation,upperDepletion:boundaryDepletion(rows,zone,atr,"UP"),lowerDepletion:boundaryDepletion(rows,zone,atr,"DOWN")};
}

function departure(rows:LiquidityCandle[],zone:LiquidityZone,atr:number):LiquidityDeparture{
  const recent=rows.slice(-7),last=recent.at(-1)!,
    above=(r:LiquidityCandle)=>r.close>zone.upper+atr*.15,below=(r:LiquidityCandle)=>r.close<zone.lower-atr*.15,
    inside=(r:LiquidityCandle)=>r.close>=zone.lower&&r.close<=zone.upper;
  if(inside(last)){
    for(let i=recent.length-2;i>=Math.max(0,recent.length-5);i--){
      const r=recent[i]!,side:LiquiditySide|null=above(r)?"UP":below(r)?"DOWN":null;
      if(!side)continue;
      const maxExc=side==="UP"?Math.max(...recent.slice(i,i+2).map(x=>x.high-zone.upper)):Math.max(...recent.slice(i,i+2).map(x=>zone.lower-x.low)),
        confidence=clip(.45+.25*clip(maxExc/Math.max(atr,1e-12))+.20*clip((recent.length-1-i)/3)+.10*zone.strength);
      return{state:"REJECTED",side,confidence,startedAt:r.time*1000,distanceRate:0,outsideBars:1,
        reason:`曾向${side==="UP"?"上":"下"}离开但重新回到流动性区域，外部价格暂未被市场接受。`};
    }
    return{state:"INSIDE",side:null,confidence:clip(zone.strength),startedAt:null,distanceRate:0,outsideBars:0,reason:"价格仍被当前流动性区域吸收。"};
  }
  const side:LiquiditySide=last.close>zone.upper?"UP":"DOWN",same=(r:LiquidityCandle)=>side==="UP"?above(r):below(r),
    outsideBars=recent.slice(-3).filter(same).length,
    distance=side==="UP"?Math.max(0,last.close-zone.upper):Math.max(0,zone.lower-last.close),
    maxExc=side==="UP"?Math.max(...recent.slice(-4).map(x=>Math.max(0,x.high-zone.upper))):Math.max(...recent.slice(-4).map(x=>Math.max(0,zone.lower-x.low))),
    retained=clip(distance/Math.max(atr*.2,maxExc)),volMed=Math.max(1e-12,median(rows.slice(-36).map(r=>r.volume))),
    vol=clip((last.volume/volMed-1)/2),confidence=clip(.42*clip(outsideBars/3)+.26*clip(distance/Math.max(atr,1e-12))+.20*retained+.12*vol),
    state:LiquidityDepartureState=outsideBars>=2&&confidence>=.60?"ACCEPTED":"TESTING";
  return{state,side,confidence,startedAt:recent.find(same)?.time?recent.find(same)!.time*1000:null,
    distanceRate:distance/Math.max(last.close,1e-12),outsideBars,
    reason:state==="ACCEPTED"?`已连续在区域${side==="UP"?"上方":"下方"}成交并保留离开距离，新价格开始被接受。`:
      `正在尝试向${side==="UP"?"上":"下"}离开，但接受证据尚未完整。`};
}

function nearestZones(zones:LiquidityZone[],price:number,exclude:LiquidityZone|null){
  const clean=zones.filter(z=>!exclude||!overlap(z,exclude)),above=clean.filter(z=>z.lower>price).sort((a,b)=>a.lower-b.lower)[0]??null,
    below=clean.filter(z=>z.upper<price).sort((a,b)=>b.upper-a.upper)[0]??null;
  return{above,below};
}

export function buildSymbolLiquidityMap(rowsIn:LiquidityCandle[],now:number):SymbolLiquidityMap{
  const rows=completed(rowsIn,now);
  if(rows.length<72)return{version:LIQUIDITY_MAP_VERSION,ready:false,updatedAt:now,bars:rows.length,atrRate:0,globalZones:[],tradeZones:[],
    activeZone:null,nextAbove:null,nextBelow:null,accumulation:0,upperDepletion:0,lowerDepletion:0,
    departure:{state:"INSIDE",side:null,confidence:0,startedAt:null,distanceRate:0,outsideBars:0,reason:"等待至少6小时完整5分钟历史。"},
    targetDistanceRate:null,openSpace:false,reason:"流动性地图数据不足：至少需要72根完成5分钟K线。"};
  const last=rows.at(-1)!,trs=rows.slice(-30).map((r,i,a)=>tr(r,i?a[i-1]:undefined)),atr=Math.max(last.close*.0008,median(trs)),
    globalRows=rows.slice(-120),tradeRows=rows.slice(-48),globalZones=buildZones(globalRows,"GLOBAL",now,atr),
    tradeZones=buildZones(tradeRows,"TRADE",now,atr),all=[...tradeZones,...globalZones],
    containing=all.filter(z=>last.close>=z.lower&&last.close<=z.upper).sort((a,b)=>b.strength-a.strength),
    recent=all.filter(z=>now-z.lastTouchedAt<=90*60_000&&Math.min(Math.abs(last.close-z.lower),Math.abs(last.close-z.upper))<=atr*6)
      .sort((a,b)=>b.lastTouchedAt-a.lastTouchedAt||b.strength-a.strength),
    activeZone=containing[0]??recent[0]??null;
  if(!activeZone){
    const next=nearestZones(globalZones,last.close,null);
    return{version:LIQUIDITY_MAP_VERSION,ready:true,updatedAt:now,bars:rows.length,atrRate:atr/last.close,globalZones,tradeZones,
      activeZone:null,nextAbove:next.above,nextBelow:next.below,accumulation:0,upperDepletion:0,lowerDepletion:0,
      departure:{state:"TESTING",side:null,confidence:0,startedAt:null,distanceRate:0,outsideBars:0,reason:"当前价格远离已知流动性密集区。"},
      targetDistanceRate:null,openSpace:true,reason:"当前价格位于已知主要流动性区域之间，等待新的区域形成或确认迁移。"};
  }
  const m=zoneMetrics(rows,activeZone,atr),d=departure(rows,activeZone,atr),
    unique=[...globalZones,...tradeZones].filter((z,i,a)=>a.findIndex(x=>Math.abs(x.center-z.center)<=atr*.8)===i),
    next=nearestZones(unique,last.close,activeZone),target=d.side==="UP"?next.above:d.side==="DOWN"?next.below:null,
    targetDistanceRate=target?(d.side==="UP"?Math.max(0,target.lower-last.close):Math.max(0,last.close-target.upper))/last.close:null,
    openSpace=!target&&d.state==="ACCEPTED",
    reason=`当前主要流动性区 ${activeZone.lower.toFixed(6)}–${activeZone.upper.toFixed(6)}，强度 ${Math.round(activeZone.strength*100)}；积累 ${Math.round(m.accumulation*100)}，上沿消耗 ${Math.round(m.upperDepletion*100)}，下沿消耗 ${Math.round(m.lowerDepletion*100)}。 ${d.reason}`;
  return{version:LIQUIDITY_MAP_VERSION,ready:true,updatedAt:now,bars:rows.length,atrRate:atr/last.close,
    globalZones:globalZones.slice(0,5),tradeZones:tradeZones.slice(0,4),
    activeZone,nextAbove:next.above,nextBelow:next.below,accumulation:m.accumulation,upperDepletion:m.upperDepletion,lowerDepletion:m.lowerDepletion,
    departure:d,targetDistanceRate,openSpace,reason};
}

export function buildMarketLiquidityResearch(paths:Record<string,LiquidityCandle[]>,now:number):MarketLiquidityResearch{
  const symbols=Object.fromEntries(Object.entries(paths).map(([symbol,rows])=>[symbol,buildSymbolLiquidityMap(rows,now)])),
    maps=Object.values(symbols),ready=maps.filter(x=>x.ready),n=Math.max(1,ready.length),
    inside=ready.filter(x=>x.departure.state==="INSIDE").length/n,testing=ready.filter(x=>x.departure.state==="TESTING").length/n,
    accepted=ready.filter(x=>x.departure.state==="ACCEPTED").length/n,rejected=ready.filter(x=>x.departure.state==="REJECTED").length/n,
    highAccum=ready.filter(x=>x.accumulation>=.65).length/n,
    up=ready.filter(x=>x.departure.state==="ACCEPTED"&&x.departure.side==="UP").length/n,
    down=ready.filter(x=>x.departure.state==="ACCEPTED"&&x.departure.side==="DOWN").length/n,
    oneSided=ready.filter(x=>Math.max(x.upperDepletion,x.lowerDepletion)>=.68&&Math.abs(x.upperDepletion-x.lowerDepletion)>=.18).length/n,
    breadth=up-down,market:MarketLiquidityContext={version:LIQUIDITY_MAP_VERSION,updatedAt:now,ready:ready.length>=Math.min(8,Math.max(3,Math.ceil(maps.length*.35))),
      readySymbols:ready.length,totalSymbols:maps.length,insideShare:inside,testingShare:testing,acceptedShare:accepted,rejectedShare:rejected,
      highAccumulationShare:highAccum,upMigrationShare:up,downMigrationShare:down,oneSidedDepletionShare:oneSided,migrationBreadth:breadth,
      summary:`流动性地图覆盖 ${ready.length}/${maps.length}；区域内 ${Math.round(inside*100)}%，已接受迁移 ${Math.round(accepted*100)}%，离开失败 ${Math.round(rejected*100)}%，高积累 ${Math.round(highAccum*100)}%。`};
  return{version:LIQUIDITY_MAP_VERSION,updatedAt:now,market,symbols};
}
