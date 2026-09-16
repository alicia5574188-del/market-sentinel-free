import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const SYMBOLS=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','DOGE_USDT','ADA_USDT','BNB_USDT','SUI_USDT','AVAX_USDT','LINK_USDT','LTC_USDT','BCH_USDT','AAVE_USDT','UNI_USDT','ARB_USDT','FIL_USDT','PEPE_USDT','ENA_USDT'];
const H=3600,DAY=86400;
const START=Date.UTC(2024,0,1)/1000,SIGNAL_START=Date.UTC(2025,0,1)/1000,END=Date.UTC(2026,8,1)/1000;
const BASE_COST=.00165,STRESS_COST=.00270,MAX_GROSS=2.0,DAILY_ENTRY_BUDGET=2.0;
const CAL_MONTHS=['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12'];
const BLIND_MONTHS=['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
const ARCHIVE_BASE='https://download.gatedata.org/futures_usdt/candlesticks_1h';
const SLEEVES=['TREND_BREAK','TREND_PULLBACK_RESUME','RELATIVE_TREND'];
const EXIT_PROFILES=[];
for(const stopATR of [1.5,2.0])for(const targetATR of [3.0,5.0])for(const maxHold of [72,120])EXIT_PROFILES.push({stopATR,targetATR,maxHold,trailTriggerATR:2.0,trailATR:1.25,key:`s${stopATR}|t${targetATR}|h${maxHold}`});
const SCORE_FLOORS=[.6,.9,1.2];
const FRACS=[.075,.10,.15];
const MAX_PER_SIGNAL=[1,2,3];

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const n=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sign=x=>x>0?1:x<0?-1:0;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(Math.max(0,a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)));};
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2;};
const madScale=a=>{if(a.length<3)return 1e-9;const m=median(a),mad=median(a.map(x=>Math.abs(x-m)));return Math.max(1.4826*mad,1e-9);};
const dayKey=t=>new Date(t*1000).toISOString().slice(0,10);
const monthKey=t=>dayKey(t).slice(0,7);
const daysInMonth=m=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)).getUTCDate();

function parseCandle(x){const time=n(x.t??x[0]),volume=n(x.v??x[1])??0,close=n(x.c??x[2]),high=n(x.h??x[3]),low=n(x.l??x[4]),open=n(x.o??x[5]);return time>0&&open>0&&close>0&&high>=low&&low>0?{time,volume,open,high,low,close}:null;}
function archiveMonths(){const out=[];let d=new Date(START*1000);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));while(d.getTime()/1000<END){out.push(d.toISOString().slice(0,7).replace('-',''));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return out;}
function archiveMonthBounds(ym){const y=+ym.slice(0,4),m=+ym.slice(4,6)-1;return [Date.UTC(y,m,1)/1000,Date.UTC(y,m+1,1)/1000];}
async function archiveMonth(symbol,ym,tries=5){const url=`${ARCHIVE_BASE}/${ym}/${symbol}-${ym}.csv.gz`;let last;for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.status===404)return {url,status:404,rows:[],bytes:0};const buf=Buffer.from(await r.arrayBuffer());if(r.ok){const text=gunzipSync(buf).toString('utf8'),rows=text.split(/\r?\n/).filter(Boolean).map(line=>parseCandle(line.split(','))).filter(Boolean);return {url,status:r.status,rows,bytes:buf.length};}last=new Error(`${r.status} ${url} ${buf.toString('utf8').slice(0,160)}`);if(r.status!==429&&r.status<500)break;}catch(e){last=e;}await sleep(300*(i+1));}throw last??new Error(url);}
const archiveDiagnostics={};
async function candles(symbol){const out=[],missing=[],invalid=[],errors=[],months=[];for(const ym of archiveMonths()){try{const got=await archiveMonth(symbol,ym);if(got.status===404){missing.push(ym);months.push({ym,status:404,rows:0});continue;}const [lo,hi]=archiveMonthBounds(ym),valid=got.rows.filter(r=>r.time>=lo&&r.time<hi&&r.time>=START&&r.time<END);if(valid.length!==got.rows.length)invalid.push({ym,total:got.rows.length,valid:valid.length});out.push(...valid);months.push({ym,status:got.status,rows:valid.length,bytes:got.bytes,first:valid[0]?.time??null,last:valid.at(-1)?.time??null});}catch(e){errors.push({ym,error:String(e)});months.push({ym,status:null,rows:0,error:String(e)});}}const rows=[...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);archiveDiagnostics[symbol]={rows:rows.length,first:rows[0]?.time??null,last:rows.at(-1)?.time??null,missing,invalid,errors,months};return rows;}

const raw=new Map();let cursor=0;async function worker(){while(cursor<SYMBOLS.length){const s=SYMBOLS[cursor++];try{raw.set(s,await candles(s));}catch(e){console.error('FETCH_FAIL',s,String(e));raw.set(s,[]);}}}await Promise.all(Array.from({length:6},worker));
const activeSymbols=[...raw].filter(([,rows])=>rows.length>14000&&(rows.at(-1)?.time??0)>=Date.UTC(2026,7,31,23)/1000).map(([s])=>s);
const maps=new Map(activeSymbols.map(s=>[s,new Map(raw.get(s).map(r=>[r.time,r]))]));
if(!activeSymbols.includes('BTC_USDT')||!activeSymbols.includes('ETH_USDT'))throw new Error('BTC/ETH historical coverage required.');

const featuresByTime=new Map();
for(const symbol of activeSymbols){
  const rows=raw.get(symbol),rets=Array(rows.length).fill(0);
  for(let i=1;i<rows.length;i++)rets[i]=rows[i].close/rows[i-1].close-1;
  for(let i=336;i<rows.length;i++){
    const r=rows[i];if(r.time-rows[i-336].time!==336*H)continue;
    if(new Date(r.time*1000).getUTCHours()%4!==0)continue;
    const r4=r.close/rows[i-4].close-1,r24=r.close/rows[i-24].close-1,r72=r.close/rows[i-72].close-1,r168=r.close/rows[i-168].close-1,r336=r.close/rows[i-336].close-1;
    const vol24=stdev(rets.slice(i-23,i+1)),vol72=stdev(rets.slice(i-71,i+1)),vol168=stdev(rets.slice(i-167,i+1));if(!(vol24>1e-8)||!(vol72>1e-8)||!(vol168>1e-8))continue;
    const z72=r72/(vol72*Math.sqrt(72)),z168=r168/(vol168*Math.sqrt(168)),z336=r336/(vol168*Math.sqrt(336));
    const tr=rows.slice(i-23,i+1).map((x,j)=>{const prev=j===0?rows[i-24].close:rows[i-24+j].close;return Math.max(x.high-x.low,Math.abs(x.high-prev),Math.abs(x.low-prev));});
    const atr24=mean(tr),atrPct=atr24/r.close;if(!(atrPct>0))continue;
    const prev72=rows.slice(i-72,i),prev168=rows.slice(i-168,i),hi72=Math.max(...prev72.map(x=>x.high)),lo72=Math.min(...prev72.map(x=>x.low)),hi168=Math.max(...prev168.map(x=>x.high)),lo168=Math.min(...prev168.map(x=>x.low));
    const pos72=(r.close-lo72)/Math.max(hi72-lo72,r.close*1e-9),pos168=(r.close-lo168)/Math.max(hi168-lo168,r.close*1e-9);
    let travel72=0;for(let j=i-71;j<=i;j++)travel72+=Math.abs(rows[j].close-rows[j-1].close);const eff72=Math.abs(r.close-rows[i-72].close)/Math.max(travel72,r.close*1e-9);
    const sma72=mean(rows.slice(i-71,i+1).map(x=>x.close)),sma168=mean(rows.slice(i-167,i+1).map(x=>x.close)),sma336=mean(rows.slice(i-335,i+1).map(x=>x.close));
    const align=((r.close>sma72?1:-1)+(sma72>sma168?1:-1)+(sma168>sma336?1:-1))/3;
    const lv=Math.log1p(Math.max(0,r.volume)),prevLv=rows.slice(i-168,i).map(x=>Math.log1p(Math.max(0,x.volume))),zVol=(lv-median(prevLv))/madScale(prevLv);
    const f={symbol,time:r.time,open:r.open,high:r.high,low:r.low,close:r.close,r4,r24,r72,r168,r336,z72,z168,z336,vol24,vol72,vol168,atrPct,hi72,lo72,hi168,lo168,pos72,pos168,eff72,align,zVol};
    const a=featuresByTime.get(r.time)??[];a.push(f);featuresByTime.set(r.time,a);
  }
}

const signalCandidates=[];
function addSignal(x,sleeve,dir,score){if(!dir||!(score>0)||!Number.isFinite(score))return;const pm=maps.get(x.symbol),entry=pm?.get(x.time+H);if(!entry)return;signalCandidates.push({symbol:x.symbol,sleeve,signalTime:x.time,entryTime:x.time+H,dir,score,atrPct:x.atrPct,entryOpen:entry.open});}
for(const [t,obs] of [...featuresByTime].sort((a,b)=>a[0]-b[0])){
  if(t<SIGNAL_START||obs.length<Math.max(10,Math.ceil(activeSymbols.length*.6)))continue;
  const btc=obs.find(x=>x.symbol==='BTC_USDT'),eth=obs.find(x=>x.symbol==='ETH_USDT');if(!btc||!eth)continue;
  const market72=.5*(btc.r72+eth.r72),market168=.5*(btc.r168+eth.r168);
  const rels72=obs.map(x=>x.r72-market72),relMed=median(rels72),relScale=madScale(rels72);
  for(const x of obs){
    const longTrend=x.align>.3&&x.z168>.45&&x.z336>.35,shortTrend=x.align<-.3&&x.z168<-.45&&x.z336<-.35;
    if(longTrend&&x.close>x.hi72&&x.eff72>.22){const score=.30*clamp(x.z168,0,4)+.22*clamp(x.z336,0,4)+.18*clamp((x.close/x.hi72-1)/x.atrPct,0,3)+.18*clamp(x.eff72*3,0,3)+.12*clamp(Math.max(0,x.zVol)*.35,0,2);addSignal(x,'TREND_BREAK',1,score);}
    if(shortTrend&&x.close<x.lo72&&x.eff72>.22){const score=.30*clamp(-x.z168,0,4)+.22*clamp(-x.z336,0,4)+.18*clamp((x.lo72/x.close-1)/x.atrPct,0,3)+.18*clamp(x.eff72*3,0,3)+.12*clamp(Math.max(0,x.zVol)*.35,0,2);addSignal(x,'TREND_BREAK',-1,score);}
    const trendDir=longTrend?1:shortTrend?-1:0;
    if(trendDir&&trendDir*x.r24<0&&trendDir*x.r4>0&&Math.abs(x.r24)<3*x.atrPct&&x.eff72>.16){const score=.34*clamp(Math.abs(x.z168),0,4)+.20*clamp(Math.abs(x.z336),0,4)+.20*clamp(Math.abs(x.r24)/x.atrPct,0,3)+.16*clamp(Math.abs(x.r4)/x.atrPct,0,3)+.10*clamp(x.eff72*3,0,3);addSignal(x,'TREND_PULLBACK_RESUME',trendDir,score);}
    const rel=(x.r72-market72-relMed)/relScale,relDir=sign(rel);const marketDir=sign(.6*market168+.4*market72);
    if(Math.abs(rel)>=1.5&&relDir*x.r4>0&&Math.abs(x.z168)>.25&&x.eff72>.18){const score=.40*clamp(Math.abs(rel),0,4)+.22*clamp(Math.abs(x.z168),0,4)+.18*clamp(Math.abs(x.r4)/x.atrPct,0,3)+.12*clamp(x.eff72*3,0,3)+.08*(relDir===marketDir?1:.25);addSignal(x,'RELATIVE_TREND',relDir,score);}
  }
}
const dedup=new Map();for(const c of signalCandidates){const k=`${c.symbol}|${c.entryTime}`;const p=dedup.get(k);if(!p||c.score>p.score)dedup.set(k,c);}const baseCandidates=[...dedup.values()].sort((a,b)=>a.entryTime-b.entryTime||b.score-a.score);

function pathOutcome(c,profile){
  const pm=maps.get(c.symbol),entry=c.entryOpen,atrAbs=Math.max(entry*c.atrPct,entry*1e-6);if(!pm||!(entry>0)||!(atrAbs>0))return null;
  let stop=entry-c.dir*profile.stopATR*atrAbs,target=entry+c.dir*profile.targetATR*atrAbs,trailActive=false,best=entry;
  const initialStop=stop;
  for(let k=0;k<profile.maxHold;k++){
    const bar=pm.get(c.entryTime+k*H);if(!bar)break;
    if(c.dir>0){if(bar.open<=stop)return finish(bar.time,bar.open,'STOP_GAP',k+1);if(bar.open>=target)return finish(bar.time,bar.open,'TARGET_GAP',k+1);}else{if(bar.open>=stop)return finish(bar.time,bar.open,'STOP_GAP',k+1);if(bar.open<=target)return finish(bar.time,bar.open,'TARGET_GAP',k+1);}
    const stopHit=c.dir>0?bar.low<=stop:bar.high>=stop;
    const targetHit=c.dir>0?bar.high>=target:bar.low<=target;
    if(stopHit)return finish(bar.time,stop,trailActive?'TRAIL_STOP':'STOP',k+1);
    if(targetHit)return finish(bar.time,target,'TARGET',k+1);
    best=c.dir>0?Math.max(best,bar.high):Math.min(best,bar.low);
    const favorable=c.dir*(best-entry);
    if(favorable>=profile.trailTriggerATR*atrAbs){trailActive=true;const candidate=c.dir>0?best-profile.trailATR*atrAbs:best+profile.trailATR*atrAbs;stop=c.dir>0?Math.max(stop,candidate):Math.min(stop,candidate);}
  }
  const last=pm.get(c.entryTime+(profile.maxHold-1)*H);if(!last)return null;return finish(last.time,last.close,'TIME',profile.maxHold);
  function finish(exitBarTime,exitPrice,reason,heldHours){const gross=c.dir*(exitPrice/entry-1);return {exitTime:exitBarTime+H,exitPrice,gross,reason,heldHours,mfeATR:c.dir*(best-entry)/atrAbs,initialStop};}
}

const outcomesByProfile=new Map();
for(const p of EXIT_PROFILES){const a=[];for(const c of baseCandidates){const o=pathOutcome(c,p);if(o)a.push({...c,...o,profile:p.key});}outcomesByProfile.set(p.key,a);}
function rawSummary(profileKey,months){const a=outcomesByProfile.get(profileKey).filter(c=>months.includes(monthKey(c.entryTime))),nets=a.map(c=>c.gross-BASE_COST),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0),reasons={},sleeves={};for(const c of a){reasons[c.reason]=(reasons[c.reason]??0)+1;const z=sleeves[c.sleeve]??{trades:0,sumNet:0};z.trades++;z.sumNet+=c.gross-BASE_COST;sleeves[c.sleeve]=z;}return {count:a.length,meanGross:mean(a.map(c=>c.gross)),meanBaseNet:mean(nets),hit:nets.length?nets.filter(x=>x>0).length/nets.length:0,pf:l?g/l:g?99:0,meanHeldHours:mean(a.map(c=>c.heldHours)),reasons,sleeves};}

function simulateMonth(policy,cost,month){
  const source=outcomesByProfile.get(policy.profile),monthCandidates=source.filter(c=>monthKey(c.entryTime)===month&&c.score>=policy.floor),grouped=new Map();for(const c of monthCandidates){const a=grouped.get(c.entryTime)??[];a.push(c);grouped.set(c.entryTime,a);}
  let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),usedDay=new Map(),trades=[];
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),net=p.gross-cost,pnl=p.entryEq*policy.frac*net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));trades.push({...p,net,pnl});}}
  for(const [t,a] of [...grouped].sort((x,y)=>x[0]-y[0])){release(t);const d=dayKey(t);let used=usedDay.get(d)??0,nTime=0;for(const c of a.sort((x,y)=>y.score-x.score)){if(nTime>=policy.maxPer)break;if((busy.get(c.symbol)??0)>t)continue;if(used+policy.frac>DAILY_ENTRY_BUDGET+1e-9)break;if(active.length*policy.frac+policy.frac>MAX_GROSS+1e-9)break;active.push({...c,entryEq:equity});busy.set(c.symbol,c.exitTime);used+=policy.frac;nTime++;}usedDay.set(d,used);}release(Date.UTC(+month.slice(0,4),+month.slice(5,7),1)/1000+45*DAY);
  const nets=trades.map(x=>x.net),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0),reasons={},sleeves={};for(const x of trades){reasons[x.reason]=(reasons[x.reason]??0)+1;const z=sleeves[x.sleeve]??{trades:0,sumNet:0};z.trades++;z.sumNet+=x.net;sleeves[x.sleeve]=z;}return {month,totalReturn:equity-1,maxDD,trades:trades.length,avgTradesPerDay:trades.length/daysInMonth(month),avgDailyTwoWayTurnover:trades.length*policy.frac*2/daysInMonth(month),meanTradeNet:mean(nets),pf:l?g/l:g?99:0,hit:nets.length?nets.filter(x=>x>0).length/nets.length:0,meanHeldHours:mean(trades.map(x=>x.heldHours)),reasons,sleeves};
}
function simulate(policy,cost,months){const monthly=months.map(m=>simulateMonth(policy,cost,m)),compound=monthly.reduce((e,x)=>e*(1+x.totalReturn),1)-1;return {months,monthly,totalCompounded:compound,maxDD:Math.max(...monthly.map(x=>x.maxDD)),avgMonthReturn:mean(monthly.map(x=>x.totalReturn)),medianMonthReturn:median(monthly.map(x=>x.totalReturn)),minMonthReturn:Math.min(...monthly.map(x=>x.totalReturn)),positiveMonths:monthly.filter(x=>x.totalReturn>0).length,monthsAtLeast5pct:monthly.filter(x=>x.totalReturn>=.05).length,avgTradesPerDay:mean(monthly.map(x=>x.avgTradesPerDay)),avgDailyTwoWayTurnover:mean(monthly.map(x=>x.avgDailyTwoWayTurnover)),trades:monthly.reduce((s,x)=>s+x.trades,0),meanHeldHours:mean(monthly.map(x=>x.meanHeldHours).filter(Number.isFinite))};}

const policies=[];for(const profile of EXIT_PROFILES)for(const floor of SCORE_FLOORS)for(const frac of FRACS)for(const maxPer of MAX_PER_SIGNAL)policies.push({profile:profile.key,floor,frac,maxPer,key:`${profile.key}|q${floor}|n${frac}|m${maxPer}`});
const evaluated=[];for(const policy of policies){const calibration=simulate(policy,BASE_COST,CAL_MONTHS),calibrationStress=simulate(policy,STRESS_COST,CAL_MONTHS);evaluated.push({policy,calibration,calibrationStress});}
const feasible=evaluated.filter(x=>x.calibration.avgMonthReturn>=.05&&x.calibration.positiveMonths>=9&&x.calibration.minMonthReturn>-.05&&x.calibrationStress.avgMonthReturn>=0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn);
const target=feasible[0]??null,bestReturn=[...evaluated].sort((a,b)=>b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null,bestFrequencyPositive=[...evaluated].filter(x=>x.calibration.avgMonthReturn>0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null;
function enrich(x){if(!x)return null;return {...x,blind:simulate(x.policy,BASE_COST,BLIND_MONTHS),blindStress:simulate(x.policy,STRESS_COST,BLIND_MONTHS)};}
function pareto(rows){const out=[];for(const a of rows){if(rows.some(b=>b!==a&&b.calibration.avgTradesPerDay>=a.calibration.avgTradesPerDay&&b.calibration.avgMonthReturn>=a.calibration.avgMonthReturn&&(b.calibration.avgTradesPerDay>a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn>a.calibration.avgMonthReturn)))continue;out.push(a);}return out.sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay).slice(0,24);}
const rawProfiles=Object.fromEntries(EXIT_PROFILES.map(p=>[p.key,{calibration:rawSummary(p.key,CAL_MONTHS),blind:rawSummary(p.key,BLIND_MONTHS)}]));
const report={decision:target?'MULTIDAY_PATH_TARGET_FOUND':'MULTIDAY_PATH_NO_5PCT_CALIBRATION',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',goal:'seek lower-turnover multi-day trend edge with path-dependent ATR exits, then maximize practical trade frequency subject to >=5% monthly after-cost portfolio target',method:'Gate official 1h OHLCV. Signals evaluated every 4h across trend breakout, trend pullback-resume, and BTC/ETH-relative trend continuation. Entry is next 1h open. Exit is simulated hour by hour with ATR stop, ATR target, trailing stop after 2 ATR favorable excursion, and 72h/120h maximum hold. If stop and target touch in same bar, stop is assumed first. 2025 selects policy; Jan-Aug 2026 is fixed blind.',cost:{base:BASE_COST,stress:STRESS_COST},data:{start:new Date(START*1000).toISOString(),signalStart:new Date(SIGNAL_START*1000).toISOString(),end:new Date(END*1000).toISOString(),activeSymbols,source:{venue:'Gate',dataset:'official historical downloads',market:'futures_usdt',interval:'1h',urlPattern:`${ARCHIVE_BASE}/YYYYMM/SYMBOL-YYYYMM.csv.gz`},archiveDiagnostics},signalCount:signalCandidates.length,candidateCount:baseCandidates.length,sleeves:Object.fromEntries(SLEEVES.map(s=>[s,baseCandidates.filter(c=>c.sleeve===s).length])),exitProfiles:EXIT_PROFILES,rawProfiles,calibrationMonths:CAL_MONTHS,blindMonths:BLIND_MONTHS,policyCount:policies.length,feasibleCount:feasible.length,target:enrich(target),bestReturn:enrich(bestReturn),bestFrequencyPositive:enrich(bestFrequencyPositive),paretoFrontier:pareto(evaluated)};
writeFileSync('/tmp/multiday-trend-path-exits-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,activeSymbols:activeSymbols.length,signalCount:report.signalCount,candidateCount:report.candidateCount,sleeves:report.sleeves,policyCount:report.policyCount,feasibleCount:report.feasibleCount,target:report.target,bestReturn:report.bestReturn,bestFrequencyPositive:report.bestFrequencyPositive,paretoFrontier:report.paretoFrontier},null,2));
