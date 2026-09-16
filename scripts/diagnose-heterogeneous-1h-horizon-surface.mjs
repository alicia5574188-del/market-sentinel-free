import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath='scripts/research-heterogeneous-1h-sleeve-portfolio.mjs';
const source=readFileSync(sourcePath,'utf8');
const importNeedle="import { writeFileSync } from 'node:fs';";
const candleStartNeedle='async function candles(symbol){';
const rawNeedle='\n\nconst raw=';
const addStartNeedle='function addCandidate(';
const loopNeedle='\nfor(const [t,obs]';
const outcomeNeedle='\nconst outcomeBySleeve=';
if(!source.includes(importNeedle)||!source.includes(candleStartNeedle)||!source.includes(addStartNeedle)||!source.includes(outcomeNeedle)){
  throw new Error('Expected base research script shape not found; refusing implicit strategy changes.');
}

let patched=source.replace(importNeedle,`${importNeedle}\nimport { gunzipSync } from 'node:zlib';`);

const candleStart=patched.indexOf(candleStartNeedle);
const candleEnd=patched.indexOf(rawNeedle,candleStart);
if(candleEnd<0)throw new Error('Could not isolate original candle loader.');
const archiveAdapter=[
  "const ARCHIVE_BASE='https://download.gatedata.org/futures_usdt/candlesticks_1h';",
  'const archiveDiagnostics={};',
  "function archiveMonths(){const out=[];let d=new Date(START*1000);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));while(d.getTime()/1000<END){out.push(d.toISOString().slice(0,7).replace('-',''));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return out;}",
  'function archiveMonthBounds(ym){const y=+ym.slice(0,4),m=+ym.slice(4,6)-1;return [Date.UTC(y,m,1)/1000,Date.UTC(y,m+1,1)/1000];}',
  "async function archiveMonth(symbol,ym,tries=5){const url=ARCHIVE_BASE+'/'+ym+'/'+symbol+'-'+ym+'.csv.gz';let last;for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.status===404)return {status:404,rows:[],bytes:0};const buf=Buffer.from(await r.arrayBuffer());if(r.ok){const text=gunzipSync(buf).toString('utf8'),rows=text.split(/\\r?\\n/).filter(Boolean).map(line=>parseCandle(line.split(','))).filter(Boolean);return {status:r.status,rows,bytes:buf.length};}last=new Error(String(r.status)+' '+url+' '+buf.toString('utf8').slice(0,160));if(r.status!==429&&r.status<500)break;}catch(e){last=e;}await sleep(300*(i+1));}throw last??new Error(url);}",
  "async function candles(symbol){const out=[],missing=[],invalid=[],errors=[];for(const ym of archiveMonths()){try{const got=await archiveMonth(symbol,ym);if(got.status===404){missing.push(ym);continue;}const [lo,hi]=archiveMonthBounds(ym),valid=got.rows.filter(r=>r.time>=lo&&r.time<hi&&r.time>=START&&r.time<END);if(valid.length!==got.rows.length)invalid.push({ym,total:got.rows.length,valid:valid.length});out.push(...valid);}catch(e){errors.push({ym,error:String(e)});}}const rows=[...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);archiveDiagnostics[symbol]={rows:rows.length,first:rows[0]?.time??null,last:rows.at(-1)?.time??null,missing,invalid,errors};return rows;}"
].join('\n');
patched=patched.slice(0,candleStart)+archiveAdapter+patched.slice(candleEnd);

const addStart=patched.indexOf(addStartNeedle);
const addEnd=patched.indexOf(loopNeedle,addStart);
if(addEnd<0)throw new Error('Could not isolate addCandidate.');
const horizonCandidate=`const HORIZONS=[1,2,4,8,12,24,48];\nfunction addCandidate(x,sleeve,dir,score,hold,extra={}){if(!dir||!(score>0)||!Number.isFinite(score))return;const pm=maps.get(x.symbol),entry=pm?.get(x.time+H);if(!entry)return;const grossByHold={};for(const h of HORIZONS){const exit=pm?.get(x.time+h*H);if(exit)grossByHold[h]=dir*(exit.close/entry.open-1);}const originalExit=pm?.get(x.time+hold*H);if(!originalExit)return;const gross=dir*(originalExit.close/entry.open-1);candidates.push({sleeve,symbol:x.symbol,signalTime:x.time,entryTime:x.time+H,exitTime:originalExit.time+H,dir,score,hold,gross,grossByHold,...extra});}`;
patched=patched.slice(0,addStart)+horizonCandidate+patched.slice(addEnd);

const cut=patched.indexOf(outcomeNeedle);
if(cut<0)throw new Error('Could not isolate post-candidate simulation.');
const diagnostic=String.raw`

function edgeStats(rows,h,cost){
  const vals=rows.map(x=>x.grossByHold[h]).filter(Number.isFinite);
  const nets=vals.map(x=>x-cost);
  const gains=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),loss=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0);
  return {count:vals.length,meanGross:mean(vals),medianGross:median(vals),grossHit:vals.length?vals.filter(x=>x>0).length/vals.length:0,meanNet:mean(nets),netHit:nets.length?nets.filter(x=>x>0).length/nets.length:0,pf:loss?gains/loss:gains?99:0};
}
function phaseStats(sleeve,h,months,scoreFloor){
  const rows=candidates.filter(x=>x.sleeve===sleeve&&x.score>=scoreFloor&&months.includes(monthKey(x.entryTime))&&Number.isFinite(x.grossByHold[h]));
  const base=edgeStats(rows,h,BASE_COST),stress=edgeStats(rows,h,STRESS_COST);
  const monthly=months.map(month=>{const a=rows.filter(x=>monthKey(x.entryTime)===month);const b=edgeStats(a,h,BASE_COST),s=edgeStats(a,h,STRESS_COST);return {month,count:a.length,meanGross:b.meanGross,meanBaseNet:b.meanNet,meanStressNet:s.meanNet,basePf:b.pf};});
  return {...base,meanStressNet:stress.meanNet,stressPf:stress.pf,positiveBaseMonths:monthly.filter(x=>x.meanBaseNet>0).length,positiveStressMonths:monthly.filter(x=>x.meanStressNet>0).length,monthly};
}
const strata=[{name:'ALL',scoreFloor:0},{name:'HIGH_SCORE_1_05',scoreFloor:1.05}];
const surface={},frozen=[];
for(const sleeve of SLEEVES){
  surface[sleeve]={};
  for(const stratum of strata){
    const horizons={};
    for(const h of HORIZONS)horizons[h]={calibration:phaseStats(sleeve,h,CAL_MONTHS,stratum.scoreFloor),blind:phaseStats(sleeve,h,BLIND_MONTHS,stratum.scoreFloor)};
    surface[sleeve][stratum.name]=horizons;
    const usable=HORIZONS.filter(h=>horizons[h].calibration.count>=100);
    const best=usable.sort((a,b)=>horizons[b].calibration.meanNet-horizons[a].calibration.meanNet)[0]??null;
    frozen.push({sleeve,stratum:stratum.name,scoreFloor:stratum.scoreFloor,selectedHorizon:best,calibration:best?horizons[best].calibration:null,blind:best?horizons[best].blind:null});
  }
}
const report={
  decision:'HORIZON_SURFACE_DIAGNOSTIC',
  authority:'RESEARCH_ONLY_NO_DEPLOYMENT',
  method:'Keep the five existing 1h sleeve entry definitions unchanged. Replace only the fixed exit horizon diagnostically with 1/2/4/8/12/24/48h forward closes. Select each sleeve horizon using Jul-Dec 2025 only, then report untouched Jan-Aug 2026.',
  cost:{base:BASE_COST,stress:STRESS_COST},
  data:{activeSymbols,availability:Object.fromEntries(activeSymbols.map(s=>[s,{rows:raw.get(s).length,first:raw.get(s)[0]?.time??null,last:raw.get(s).at(-1)?.time??null}])),archiveDiagnostics},
  candidateCount:candidates.length,
  candidateCountBySleeve:Object.fromEntries(SLEEVES.map(s=>[s,candidates.filter(x=>x.sleeve===s).length])),
  horizons:HORIZONS,
  strata,
  frozen,
  surface
};
writeFileSync('/tmp/heterogeneous-1h-horizon-surface.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,candidateCount:report.candidateCount,activeSymbols:activeSymbols.length,frozen:frozen.map(x=>({sleeve:x.sleeve,stratum:x.stratum,h:x.selectedHorizon,calNet:x.calibration?.meanNet,calPositiveMonths:x.calibration?.positiveBaseMonths,blindNet:x.blind?.meanNet,blindPositiveMonths:x.blind?.positiveBaseMonths}))},null,2));
`;
patched=patched.slice(0,cut)+diagnostic;

const out='/tmp/diagnose-heterogeneous-1h-horizon-surface-generated.mjs';
writeFileSync(out,patched);
await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
