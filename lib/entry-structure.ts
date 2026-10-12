type Bar={time:number;high:number;low:number;close:number;volume:number};
export type ZoneNote={
  place:"上方"|"下方"|"内部";center:number;lower:number;upper:number;distancePct:number;touches:number;
};
export type EntryStructure={
  entry:number;
  support:ZoneNote|null;
  resistance:ZoneNote|null;
  pivotInside:ZoneNote|null;
  volumeBelow:ZoneNote|null;
  volumeAbove:ZoneNote|null;
  volumeInside:ZoneNote|null;
  topBookImbalance:number|null;
};

const BAR_MS=300_000;

function completed(rows:Bar[]|undefined,now:number){
  return (rows??[]).filter(b=>b.time>0&&b.high>=b.low&&b.low>0&&b.close>0&&b.volume>=0&&b.time*1000+BAR_MS<=now)
    .sort((a,b)=>a.time-b.time).slice(-120);
}
function round(n:number){return Number(n.toFixed(4));}
function note(price:number,lower:number,upper:number,touches:number):ZoneNote{
  const center=(lower+upper)/2;
  if(price>=lower&&price<=upper)return {place:"内部",center:round(center),lower:round(lower),upper:round(upper),distancePct:0,touches};
  if(upper<price)return {place:"下方",center:round(center),lower:round(lower),upper:round(upper),distancePct:round((price-upper)/price*100),touches};
  return {place:"上方",center:round(center),lower:round(lower),upper:round(upper),distancePct:round((lower-price)/price*100),touches};
}

function pivotZones(rows:Bar[],price:number){
  const lookback=3,points:number[]=[];
  for(let i=lookback;i<rows.length-lookback;i++){
    const high=rows[i]!.high,low=rows[i]!.low;
    if(high===Math.max(...rows.slice(i-lookback,i+lookback+1).map(b=>b.high)))points.push(high);
    if(low===Math.min(...rows.slice(i-lookback,i+lookback+1).map(b=>b.low)))points.push(low);
  }
  const zones:{lower:number;upper:number;touches:number}[]=[];
  for(const point of points.sort((a,b)=>a-b)){
    const last=zones.at(-1);
    if(!last||point>last.upper*(1.005))zones.push({lower:point,upper:point,touches:1});
    else{last.upper=Math.max(last.upper,point);last.lower=Math.min(last.lower,point);last.touches++;}
  }
  const inside=zones.find(z=>price>=z.lower&&price<=z.upper)??null;
  const support=zones.filter(z=>z.upper<price).at(-1)??null;
  const resistance=zones.find(z=>z.lower>price)??null;
  return {
    support:support?note(price,support.lower,support.upper,support.touches):null,
    resistance:resistance?note(price,resistance.lower,resistance.upper,resistance.touches):null,
    pivotInside:inside?note(price,inside.lower,inside.upper,inside.touches):null,
  };
}

function volumeZones(rows:Bar[],price:number){
  const low=Math.min(...rows.map(b=>b.low)),high=Math.max(...rows.map(b=>b.high));
  if(!(high>low))return {volumeBelow:null,volumeAbove:null,volumeInside:null};
  const bins=20,width=(high-low)/bins,vol=Array(bins).fill(0),count=Array(bins).fill(0);
  for(const bar of rows){
    const typical=(bar.high+bar.low+bar.close)/3;
    const index=Math.max(0,Math.min(bins-1,Math.floor((typical-low)/width)));
    vol[index]+=bar.volume;count[index]+=1;
  }
  const peak=Math.max(...vol);
  if(!(peak>0))return {volumeBelow:null,volumeAbove:null,volumeInside:null};
  const bands:{lower:number;upper:number;touches:number}[]=[];
  let current:{lower:number;upper:number;touches:number}|null=null;
  for(let i=0;i<bins;i++){
    if(vol[i]!<peak*0.7){if(current){bands.push(current);current=null;}continue;}
    if(!current)current={lower:low+i*width,upper:low+(i+1)*width,touches:count[i]!};
    else{current.upper=low+(i+1)*width;current.touches+=count[i]!;}
  }
  if(current)bands.push(current);
  const noted=bands.map(b=>note(price,b.lower,b.upper,b.touches));
  return {
    volumeInside:noted.find(z=>z.place==="内部")??null,
    volumeBelow:[...noted.filter(z=>z.place==="下方")].at(-1)??null,
    volumeAbove:noted.find(z=>z.place==="上方")??null,
  };
}

/** Snapshot only. Never selects a side or blocks an entry. */
export function readEntryStructure(input:{price:number;now:number;bars?:Bar[];bookImbalance?:number|null}):EntryStructure{
  const rows=completed(input.bars,input.now);
  const empty={entry:round(input.price),support:null,resistance:null,pivotInside:null,volumeBelow:null,volumeAbove:null,volumeInside:null,
    topBookImbalance:Number.isFinite(input.bookImbalance)?round(input.bookImbalance!):null};
  if(rows.length<20||!(input.price>0))return empty;
  return {...empty,...pivotZones(rows,input.price),...volumeZones(rows,input.price)};
}
