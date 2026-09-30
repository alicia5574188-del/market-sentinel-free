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
if(!source.includes(importNeedle)||!source.includes(candleStartNeedle)||!source.includes(addStartNeedle)||!source.includes(outcomeNeedle))throw new Error('Unexpected base research script shape.');

let patched=source.replace(importNeedle,`${importNeedle}\nimport { gunzipSync } from 'node:zlib';`);
const candleStart=patched.indexOf(candleStartNeedle),candleEnd=patched.indexOf(rawNeedle,candleStart);
if(candleEnd<0)throw new Error('Could not isolate candle loader.');
const archiveAdapter=[
  "const ARCHIVE_BASE='https://download.gatedata.org/futures_usdt/candlesticks_1h';",
  'const archiveDiagnostics={};',
  "function archiveMonths(){const out=[];let d=new Date(START*1000);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));while(d.getTime()/1000<END){out.push(d.toISOString().slice(0,7).replace('-',''));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return out;}",
  'function archiveMonthBounds(ym){const y=+ym.slice(0,4),m=+ym.slice(4,6)-1;return [Date.UTC(y,m,1)/1000,Date.UTC(y,m+1,1)/1000];}',
  "async function archiveMonth(symbol,ym,tries=5){const url=ARCHIVE_BASE+'/'+ym+'/'+symbol+'-'+ym+'.csv.gz';let last;for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.status===404)return {status:404,rows:[]};const buf=Buffer.from(await r.arrayBuffer());if(r.ok){const rows=gunzipSync(buf).toString('utf8').split(/\\r?\\n/).filter(Boolean).map(line=>parseCandle(line.split(','))).filter(Boolean);return {status:r.status,rows};}last=new Error(String(r.status)+' '+url);if(r.status!==429&&r.status<500)break;}catch(e){last=e;}await sleep(300*(i+1));}throw last??new Error(url);}",
  "async function candles(symbol){const out=[],missing=[],invalid=[],errors=[];for(const ym of archiveMonths()){try{const got=await archiveMonth(symbol,ym);if(got.status===404){missing.push(ym);continue;}const [lo,hi]=archiveMonthBounds(ym),valid=got.rows.filter(r=>r.time>=lo&&r.time<hi&&r.time>=START&&r.time<END);if(valid.length!==got.rows.length)invalid.push({ym,total:got.rows.length,valid:valid.length});out.push(...valid);}catch(e){errors.push({ym,error:String(e)});}}const rows=[...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);archiveDiagnostics[symbol]={rows:rows.length,first:rows[0]?.time??null,last:rows.at(-1)?.time??null,missing,invalid,errors};return rows;}"
].join('\n');
patched=patched.slice(0,candleStart)+archiveAdapter+patched.slice(candleEnd);

const addStart=patched.indexOf(addStartNeedle),addEnd=patched.indexOf(loopNeedle,addStart);
if(addEnd<0)throw new Error('Could not isolate addCandidate.');
const horizonCandidate=`const ROUTER_HORIZONS=[1,2,4,8,12,24,48];\nfunction addCandidate(x,sleeve,dir,score,hold,extra={}){if(!dir||!(score>0)||!Number.isFinite(score))return;const pm=maps.get(x.symbol),entry=pm?.get(x.time+H);if(!entry)return;const grossByHold={};for(const h of ROUTER_HORIZONS){const exit=pm?.get(x.time+h*H);if(exit)grossByHold[h]=dir*(exit.close/entry.open-1);}const originalExit=pm?.get(x.time+hold*H);if(!originalExit)return;candidates.push({sleeve,symbol:x.symbol,signalTime:x.time,entryTime:x.time+H,dir,score,originalHold:hold,grossByHold,...extra});}`;
patched=patched.slice(0,addStart)+horizonCandidate+patched.slice(addEnd);

const cut=patched.indexOf(outcomeNeedle);
if(cut<0)throw new Error('Could not isolate original portfolio simulation.');
const router=String.raw`

const ROUTE_MONTHS=[...CAL_MONTHS,...BLIND_MONTHS];
const ROUTER_LOOKBACK_DAYS=60,ROUTER_FRAC=.05,ROUTER_MAX_PER_HOUR=4,ROUTER_MIN_BASE_SHARE=.02,ROUTER_WEIGHTED_SHARE=.90;
function quantile(a,q){if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,l=Math.floor(p),u=Math.ceil(p);return l===u?b[l]:b[l]+(b[u]-b[l])*(p-l);}
function monthStartTs(month){return Date.UTC(+month.slice(0,4),+month.slice(5,7)-1,1)/1000;}
function altExitTime(c,h){return c.signalTime+(h+1)*H;}
function routeForMonth(month){
  const end=monthStartTs(month),start=end-ROUTER_LOOKBACK_DAYS*DAY,bySleeve={};
  for(const sleeve of SLEEVES){
    const recent=candidates.filter(c=>c.sleeve===sleeve&&c.entryTime>=start&&c.entryTime<end);
    const scores=recent.map(c=>c.score),q25=quantile(scores,.25),q50=quantile(scores,.50),q70=quantile(scores,.70),q75=quantile(scores,.75),scale=Math.max(q75-q25,.05);
    let best=null;
    for(const h of ROUTER_HORIZONS){
      const vals=recent.filter(c=>c.score>=q70&&Number.isFinite(c.grossByHold[h])&&altExitTime(c,h)<=end).map(c=>c.grossByHold[h]-BASE_COST);
      if(!vals.length)continue;
      const m=mean(vals),sd=stdev(vals),se=sd/Math.sqrt(Math.max(1,vals.length)),selection=m-.35*se;
      const row={h,count:vals.length,meanNet:m,sd,se,selection};
      if(!best||(row.count>=30&&best.count<30)||(row.count>=30&&best.count>=30&&row.selection>best.selection)||(row.count<30&&best.count<30&&row.selection>best.selection))best=row;
    }
    if(!best)best={h:8,count:0,meanNet:-BASE_COST,sd:0,se:0,selection:-BASE_COST};
    const edgeZ=best.count>=15&&best.sd>1e-9?clamp(best.meanNet/(best.sd/Math.sqrt(Math.min(best.count,100))),-3,3):clamp(best.meanNet/.01,-3,3);
    const weight=clamp(Math.exp(.45*edgeZ),.25,3);
    bySleeve[sleeve]={...best,edgeZ,weight,scoreQ25:q25,scoreMedian:q50,scoreQ70:q70,scoreQ75:q75,scoreScale:scale,recentCandidates:recent.length};
  }
  const sumWeight=SLEEVES.reduce((s,x)=>s+bySleeve[x].weight,0);
  for(const sleeve of SLEEVES)bySleeve[sleeve].dailyCap=DAILY_ENTRY_BUDGET*(ROUTER_MIN_BASE_SHARE+ROUTER_WEIGHTED_SHARE*bySleeve[sleeve].weight/Math.max(sumWeight,1e-9));
  return {month,lookbackStart:new Date(start*1000).toISOString(),asOf:new Date(end*1000).toISOString(),bySleeve};
}
const routeConfigs=Object.fromEntries(ROUTE_MONTHS.map(m=>[m,routeForMonth(m)]));
function simulateRouterMonth(month,cost){
  const route=routeConfigs[month],monthCandidates=candidates.filter(c=>monthKey(c.entryTime)===month),grouped=new Map();
  for(const c of monthCandidates){const cfg=route.bySleeve[c.sleeve],z=(c.score-cfg.scoreMedian)/cfg.scoreScale,tier=c.score>=cfg.scoreQ70?1.45:.70,priority=cfg.weight*tier*clamp(1+.22*z,.35,2.2),a=grouped.get(c.entryTime)??[];a.push({...c,priority,chosenHorizon:cfg.h});grouped.set(c.entryTime,a);}
  let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),usedDay=new Map(),usedSleeveDay=new Map(),trades=[];
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),net=p.gross-cost,pnl=p.entryEq*ROUTER_FRAC*net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));trades.push({...p,net,pnl});}}
  for(const [t,a] of [...grouped].sort((x,y)=>x[0]-y[0])){
    release(t);const d=dayKey(t);let used=usedDay.get(d)??0,nHour=0;
    for(const c of a.sort((x,y)=>y.priority-x.priority)){
      if(nHour>=ROUTER_MAX_PER_HOUR)break;const cfg=route.bySleeve[c.sleeve],sdKey=d+'|'+c.sleeve,sleeveUsed=usedSleeveDay.get(sdKey)??0,key=c.sleeve+'|'+c.symbol;
      if((busy.get(key)??0)>t)continue;if(used+ROUTER_FRAC>DAILY_ENTRY_BUDGET+1e-9)continue;if(sleeveUsed+ROUTER_FRAC>cfg.dailyCap+1e-9)continue;if(active.length*ROUTER_FRAC+ROUTER_FRAC>MAX_GROSS+1e-9)continue;
      const gross=c.grossByHold[c.chosenHorizon];if(!Number.isFinite(gross))continue;const exitTime=altExitTime(c,c.chosenHorizon);
      active.push({...c,gross,exitTime,entryEq:equity});busy.set(key,exitTime);used+=ROUTER_FRAC;usedDay.set(d,used);usedSleeveDay.set(sdKey,sleeveUsed+ROUTER_FRAC);nHour++;
    }
  }
  release(monthStartTs(month)+40*DAY);
  const nets=trades.map(x=>x.net),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0),sleeves={};
  for(const x of trades){const z=sleeves[x.sleeve]??{trades:0,sumNet:0};z.trades++;z.sumNet+=x.net;sleeves[x.sleeve]=z;}
  return {month,totalReturn:equity-1,maxDD,trades:trades.length,avgTradesPerDay:trades.length/daysInMonth(month),avgDailyTwoWayTurnover:trades.length*ROUTER_FRAC*2/daysInMonth(month),meanTradeNet:mean(nets),pf:l?g/l:g?99:0,hit:nets.length?nets.filter(x=>x>0).length/nets.length:0,sleeves};
}
function simulateRouter(cost){const monthly=ROUTE_MONTHS.map(m=>simulateRouterMonth(m,cost));return {monthly,totalCompounded:monthly.reduce((e,x)=>e*(1+x.totalReturn),1)-1,avgMonthReturn:mean(monthly.map(x=>x.totalReturn)),medianMonthReturn:median(monthly.map(x=>x.totalReturn)),minMonthReturn:Math.min(...monthly.map(x=>x.totalReturn)),positiveMonths:monthly.filter(x=>x.totalReturn>0).length,monthsAtLeast5pct:monthly.filter(x=>x.totalReturn>=.05).length,avgTradesPerDay:mean(monthly.map(x=>x.avgTradesPerDay)),avgDailyTwoWayTurnover:mean(monthly.map(x=>x.avgDailyTwoWayTurnover)),maxDD:Math.max(...monthly.map(x=>x.maxDD)),trades:monthly.reduce((s,x)=>s+x.trades,0)};}
const base=simulateRouter(BASE_COST),stress=simulateRouter(STRESS_COST);
const report={decision:base.avgMonthReturn>=.05&&base.positiveMonths>=11&&stress.avgMonthReturn>=0?'CAUSAL_ROUTER_PORTFOLIO_TARGET_MET':'CAUSAL_ROUTER_PORTFOLIO_TARGET_NOT_MET',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',method:'One predeclared causal router. Five existing sleeve entry definitions remain unchanged. At each month start, only the prior 60 days choose each sleeve holding horizon and sleeve budget. Every sleeve keeps a nonzero daily budget floor; no sleeve is permanently removed and no NO_TRADE state is used.',cost:{base:BASE_COST,stress:STRESS_COST},router:{lookbackDays:ROUTER_LOOKBACK_DAYS,horizons:ROUTER_HORIZONS,frac:ROUTER_FRAC,maxPerHour:ROUTER_MAX_PER_HOUR,minBaseShare:ROUTER_MIN_BASE_SHARE,weightedShare:ROUTER_WEIGHTED_SHARE},data:{activeSymbols,availability:Object.fromEntries(activeSymbols.map(s=>[s,{rows:raw.get(s).length,first:raw.get(s)[0]?.time??null,last:raw.get(s).at(-1)?.time??null}])),archiveDiagnostics},candidateCount:candidates.length,routeConfigs,base,stress};
writeFileSync('/tmp/causal-1h-sleeve-router-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,candidateCount:report.candidateCount,activeSymbols:activeSymbols.length,base:{avgMonthReturn:base.avgMonthReturn,positiveMonths:base.positiveMonths,monthsAtLeast5pct:base.monthsAtLeast5pct,avgTradesPerDay:base.avgTradesPerDay,totalCompounded:base.totalCompounded,maxDD:base.maxDD},stress:{avgMonthReturn:stress.avgMonthReturn,positiveMonths:stress.positiveMonths,avgTradesPerDay:stress.avgTradesPerDay,totalCompounded:stress.totalCompounded,maxDD:stress.maxDD}},null,2));
`;
patched=patched.slice(0,cut)+router;
const out='/tmp/research-causal-1h-sleeve-router-generated.mjs';
writeFileSync(out,patched);
await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
