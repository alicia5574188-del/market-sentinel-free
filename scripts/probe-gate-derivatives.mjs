const BASE = "https://api.gateio.ws/api/v4";
const SYMBOLS = (process.env.DERIVATIVE_PROBE_SYMBOLS ?? "BTC_USDT,ETH_USDT,SUI_USDT,APT_USDT").split(",").filter(Boolean);
const FROM = Math.floor(Date.UTC(2025,8,1)/1000);
const TO = Math.floor(Date.UTC(2026,8,1)/1000);
const STATS_FROM = Math.max(FROM, Math.floor(Date.now()/1000) - 179*24*3600);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  const res = await fetch(BASE + path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function stats(symbol) {
  const all=[]; let cursor=STATS_FROM;
  for(let page=0;page<20 && cursor<TO;page++){
    const rows=await get(`/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${cursor}&interval=4h&limit=1000`);
    if(!Array.isArray(rows)||!rows.length)break;
    const clean=rows.filter(r=>Number(r.time)>=STATS_FROM&&Number(r.time)<TO);
    all.push(...clean);
    const last=Math.max(...rows.map(r=>Number(r.time)||0));
    if(!(last>cursor))break;
    cursor=last+1;
    if(rows.length<1000)break;
    await sleep(120);
  }
  const by=new Map(all.map(r=>[Number(r.time),r]));
  return [...by.values()].sort((a,b)=>Number(a.time)-Number(b.time));
}
async function premium(symbol){
  const all=[],step=3600*8,chunk=step*900;
  for(let a=FROM;a<TO;a+=chunk){const b=Math.min(TO,a+chunk);const rows=await get(`/futures/usdt/premium_index?contract=${encodeURIComponent(symbol)}&from=${a}&to=${b}&interval=8h`);if(Array.isArray(rows))all.push(...rows);await sleep(120);}
  const by=new Map(all.map(r=>[Number(r.t),r]));return [...by.values()].sort((a,b)=>Number(a.t)-Number(b.t));
}
async function funding(symbol){
  const rows=await get(`/futures/usdt/funding_rate?contract=${encodeURIComponent(symbol)}&limit=1000`);
  return Array.isArray(rows)?rows.sort((a,b)=>Number(a.t)-Number(b.t)):[];
}
const out={from:FROM,to:TO,statsFrom:STATS_FROM,symbols:{}};
for(const s of SYMBOLS){
  let st=[],pr=[],fu=[],errors=[];
  try{st=await stats(s);}catch(e){errors.push(`stats:${e.message}`);}await sleep(150);
  try{pr=await premium(s);}catch(e){errors.push(`premium:${e.message}`);}await sleep(150);
  try{fu=await funding(s);}catch(e){errors.push(`funding:${e.message}`);}await sleep(150);
  out.symbols[s]={errors,stats:{count:st.length,first:st[0]?.time??null,last:st.at(-1)?.time??null,sample:st.at(-1)??null},premium:{count:pr.length,first:pr[0]?.t??null,last:pr.at(-1)?.t??null,sample:pr.at(-1)??null},funding:{count:fu.length,first:fu[0]?.t??null,last:fu.at(-1)?.t??null,sample:fu.at(-1)??null}};
}
console.log("DERIVATIVE_PROBE="+JSON.stringify(out,null,2));