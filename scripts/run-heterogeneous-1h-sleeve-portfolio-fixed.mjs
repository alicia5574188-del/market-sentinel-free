import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = 'scripts/research-heterogeneous-1h-sleeve-portfolio.mjs';
const source = readFileSync(sourcePath, 'utf8');
const importNeedle = "import { writeFileSync } from 'node:fs';";
const candleStartNeedle = 'async function candles(symbol){';
const rawNeedle = '\n\nconst raw=';
if (!source.includes(importNeedle) || !source.includes(candleStartNeedle)) {
  throw new Error('Expected research script shape not found; refusing to alter strategy logic implicitly.');
}

let patched = source.replace(importNeedle, `${importNeedle}\nimport { gunzipSync } from 'node:zlib';`);
const candleStart = patched.indexOf(candleStartNeedle);
const candleEnd = patched.indexOf(rawNeedle, candleStart);
if (candleEnd < 0) throw new Error('Could not isolate original candle loader.');

const archiveAdapter = [
  "const ARCHIVE_BASE='https://download.gatedata.org/futures_usdt/candlesticks_1h';",
  'const archiveDiagnostics={};',
  "function archiveMonths(){const out=[];let d=new Date(START*1000);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));while(d.getTime()/1000<END){out.push(d.toISOString().slice(0,7).replace('-',''));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return out;}",
  'function archiveMonthBounds(ym){const y=+ym.slice(0,4),m=+ym.slice(4,6)-1;return [Date.UTC(y,m,1)/1000,Date.UTC(y,m+1,1)/1000];}',
  "async function archiveMonth(symbol,ym,tries=5){const url=ARCHIVE_BASE+'/'+ym+'/'+symbol+'-'+ym+'.csv.gz';let last;for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.status===404)return {url,status:404,rows:[],bytes:0};const buf=Buffer.from(await r.arrayBuffer());if(r.ok){const text=gunzipSync(buf).toString('utf8'),rows=text.split(/\\r?\\n/).filter(Boolean).map(line=>parseCandle(line.split(','))).filter(Boolean);return {url,status:r.status,rows,bytes:buf.length};}last=new Error(String(r.status)+' '+url+' '+buf.toString('utf8').slice(0,160));if(r.status!==429&&r.status<500)break;}catch(e){last=e;}await sleep(300*(i+1));}throw last??new Error(url);}",
  "async function candles(symbol){const out=[],missing=[],invalid=[],errors=[],months=[];for(const ym of archiveMonths()){try{const got=await archiveMonth(symbol,ym);if(got.status===404){missing.push(ym);months.push({ym,status:404,rows:0});continue;}const [lo,hi]=archiveMonthBounds(ym),valid=got.rows.filter(r=>r.time>=lo&&r.time<hi&&r.time>=START&&r.time<END);if(valid.length!==got.rows.length)invalid.push({ym,total:got.rows.length,valid:valid.length});out.push(...valid);months.push({ym,status:got.status,rows:valid.length,bytes:got.bytes,first:valid[0]?.time??null,last:valid.at(-1)?.time??null});}catch(e){errors.push({ym,error:String(e)});months.push({ym,status:null,rows:0,error:String(e)});}}const rows=[...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);archiveDiagnostics[symbol]={rows:rows.length,first:rows[0]?.time??null,last:rows.at(-1)?.time??null,missing,invalid,errors,months};writeFileSync('/tmp/gate-1h-archive-diagnostics.json',JSON.stringify(archiveDiagnostics,null,2));return rows;}"
].join('\n');

patched = patched.slice(0, candleStart) + archiveAdapter + patched.slice(candleEnd);
const out = '/tmp/research-heterogeneous-1h-sleeve-portfolio-fixed.mjs';
writeFileSync(out, patched);
await import(`${pathToFileURL(out).href}?v=${Date.now()}`);

const reportPath='/tmp/heterogeneous-1h-sleeve-portfolio-report.json';
try{
  const report=JSON.parse(readFileSync(reportPath,'utf8'));
  const diagnostics=JSON.parse(readFileSync('/tmp/gate-1h-archive-diagnostics.json','utf8'));
  report.data={...(report.data??{}),source:{venue:'Gate',dataset:'official historical downloads',market:'futures_usdt',interval:'1h',urlPattern:'https://download.gatedata.org/futures_usdt/candlesticks_1h/YYYYMM/SYMBOL-YYYYMM.csv.gz'},archiveDiagnostics:diagnostics};
  writeFileSync(reportPath,JSON.stringify(report,null,2));
}catch(e){
  console.error('REPORT_DIAGNOSTIC_AUGMENT_FAIL',String(e));
  process.exitCode=1;
}
