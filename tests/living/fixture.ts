/** Test-only fixture: local Gate 1m klines (two Beijing windows) and Gate contract specs. Read from disk, never fetched. */
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {createHash} from "node:crypto";

export type Bar={time:number;open:number;high:number;low:number;close:number;volume:number};
type Raw={segments:{from:number;to:number;symbols:Record<string,{p0:number;d:number[]}>}[];volumeRank:string[]};
let cache:{segments:{from:number;to:number;bars:Record<string,Bar[]>}[];volumeRank:string[]}|null=null;

export function livingFixture(){
  if(cache)return cache;
  const raw=JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/living/klines-1m.json.gz",import.meta.url))).toString("utf8")) as Raw;
  const segments=raw.segments.map(seg=>{
    const bars:Record<string,Bar[]>={};
    for(const [symbol,{p0,d}] of Object.entries(seg.symbols)){
      const rows:Bar[]=[];let prev=p0;
      for(let i=0,t=seg.from;i+3<d.length;i+=4,t+=60){
        const at=(q:number)=>prev+q*p0/1e5;
        const o=at(d[i]!),h=at(d[i+1]!),l=at(d[i+2]!),c=at(d[i+3]!);
        rows.push({time:t,open:o,high:Math.max(h,o,c),low:Math.min(l,o,c),close:c,volume:100});prev=c;
      }
      bars[symbol]=rows;
    }
    return {from:seg.from,to:seg.to,bars};
  });
  cache={segments,volumeRank:raw.volumeRank};return cache;
}
export function fixtureContracts():Record<string,{quantoMultiplier:number;leverageMax:number;maintenanceRate:number;minContracts:number}>{
  return JSON.parse(readFileSync(new URL("../fixtures/living/contracts.json",import.meta.url),"utf8"));
}
/** Segment holding `at` (unix ms). */
export function segmentAt(at:number){
  const seg=livingFixture().segments.find(s=>at>=s.from*1000&&at<s.to*1000);
  if(!seg)throw new Error(`fixture has no data at ${new Date(at).toISOString()}`);return seg;
}
/** Price path inside a minute: open -> (high or low first, by candle colour) -> other extreme -> close, piecewise linear. */
export function priceAt(rows:Bar[],at:number){
  const minute=Math.floor(at/60_000)*60,i=rows.length?(minute-rows[0]!.time)/60:-1;
  if(i<0)return null;if(i>=rows.length)return rows.at(-1)!.close;
  const r=rows[i]!,f=(at-minute*1000)/60_000;
  const pts=r.close>=r.open?[r.open,r.low,r.high,r.close]:[r.open,r.high,r.low,r.close];
  const seg=Math.min(2,Math.floor(f*3)),local=f*3-seg;
  return pts[seg]!+(pts[seg+1]!-pts[seg]!)*local;
}
export function sha(value:unknown){return createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");}
/** Beijing "MM-DD HH:MM[:SS]" in 2026 to unix ms. */
export function bj(s:string){
  const [md,hms]=s.split(" ");const [m,d]=md!.split("-").map(Number);const [H,M,S]=(hms!+":0").split(":").map(Number);
  return Date.UTC(2026,m!-1,d!,H!-8,M!,S!);
}
