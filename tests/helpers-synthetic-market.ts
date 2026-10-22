/**
 * Seeded synthetic 5m market for the dynamic-v1 short-pool tests: BTC drives alts (beta + idiosyncratic noise), volatility
 * regimes switch, and a few events are injected so every short family has something to react to (alt pump, liquidation-style
 * flush with a long wick and volume climax, BTC impulse hours, a trend day, round-number tests). Deterministic.
 */
import {Series,aggregate,type Bar,type Iv} from "../lib/dynamic/series.ts";
export function rng(seed:number){let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
const gauss=(r:()=>number)=>{const u=Math.max(1e-12,r()),v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
export type Market=Record<string,Record<"5m"|"15m"|"1h",Series>>;
export function synthMarket(days=45,start=Date.UTC(2026,5,1)/1000,seed=7):Market{
  const r=rng(seed),n=days*288,syms={BTC_USDT:{p:100_000,beta:0,idio:1},ETH_USDT:{p:3_500,beta:1.1,idio:.6},AAA_USDT:{p:2,beta:1.3,idio:1.2},BBB_USDT:{p:.5,beta:.9,idio:1.4}};
  const out:Market={};const bars:Record<string,Bar[]>={};const px:Record<string,number>={};for(const [k,v] of Object.entries(syms)){bars[k]=[];px[k]=v.p;}
  let vol=.0012;
  for(let i=0;i<n;i++){const t=start+i*300,day=Math.floor(i/288),bar=i%288;
    if(i%288===0)vol=[.0008,.0012,.002][Math.floor(r()*3)]!;
    let btcR=vol*gauss(r);
    if(day%5===2&&bar>=150&&bar<162)btcR+=.0012;// BTC impulse hour (+1.4%)
    if(day%9===4&&bar>=40)btcR+=.00012;// trend day
    if(day%7===3&&bar===200)btcR+=.006;// one big BTC 5m bar
    for(const [k,v] of Object.entries(syms)){
      let ret=k==="BTC_USDT"?btcR:v.beta*btcR+v.idio*vol*gauss(r);
      if(k==="AAA_USDT"&&day%11===5&&bar>=96&&bar<132)ret+=.0028;// pump +10% in 3 h
      if(k==="AAA_USDT"&&day%11===5&&bar>=132&&bar<162)ret-=.0012;
      if(k==="AAA_USDT"&&day%11===8&&bar>=96&&bar<132)ret-=.0028;// dump −10% in 3 h
      if(k==="AAA_USDT"&&day%11===8&&bar>=132&&bar<162)ret+=.0012;
      let volm=1000*(1+.3*r());let wickDown=0,wickUp=0;
      if(k==="ETH_USDT"&&(day%6===1||day%6===4)&&bar>=120&&bar<132){ret+=day%6===1?.0016:-.0016;volm*=5;}// 1 h burst
      if(k==="BBB_USDT"&&day%8===2&&bar>=60&&bar<72)ret+=.0028;// 1 h squeeze
      if(k==="BBB_USDT"&&day%8===2&&bar===72){ret=-.004;wickUp=.025;volm*=8;}
      if(k==="BBB_USDT"&&day%8===6&&bar>=60&&bar<72)ret-=.0028;// 1 h flush
      if(k==="BBB_USDT"&&day%8===6&&bar===72){ret=.004;wickDown=.025;volm*=8;}
      if(Math.abs(ret)>3*vol)volm*=1+Math.abs(ret)/vol;
      const o=px[k]!,c=o*Math.exp(ret),hi=Math.max(o,c)*(1+Math.abs(gauss(r))*vol*.5+wickUp),lo=Math.min(o,c)*(1-Math.abs(gauss(r))*vol*.5-wickDown);
      bars[k]!.push({t,o,h:hi,l:lo,c,v:volm});px[k]=c;}
  }
  for(const k of Object.keys(syms)){const s5=new Series(k,"5m");s5.merge(bars[k]!);const m={"5m":s5} as Record<"5m"|"15m"|"1h",Series>;
    for(const iv of ["15m","1h"] as Iv[]){const s=new Series(k,iv);s.merge(aggregate(s5,iv));m[iv as "15m"|"1h"]=s;}out[k]=m;}
  return out;
}
