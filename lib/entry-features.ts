/**
 * Entry features for rule research, captured once, the tick a record (opened or not-opened) first appears.
 * Built only from data the worker already holds (5m candles, the all-ticker radar snapshot, BTC/ETH hourly paths,
 * the regime's per-coin moves). Never read by an entry, an exit, sizing, a stop or live copying.
 * Price changes are signed as the price moved (positive = up), not by trade side.
 */
import type {Candle, Trade} from './forward-relations.ts';

export type RadarRow={symbol:string;last:number;high24h:number;low24h:number;change24hRate:number;fundingRate:number;openInterest:number;volume24hUsd:number};
export type FeatureInput={
  t:Trade;now:number;bars5m?:readonly Candle[]|null;
  radar?:ReadonlyMap<string,RadarRow>|null;radarAt?:number|null;
  /** Radar open interest from 60-120 minutes ago (rolling hourly anchor). */
  oiAnchor?:{at:number;oi:ReadonlyMap<string,number>}|null;
  btcHourly?:readonly Candle[]|null;ethHourly?:readonly Candle[]|null;
  /** BTC 5m candles if BTC is in the worker's 5m set (used only when fresh). */
  btcBars5m?:readonly Candle[]|null;
  /** In-memory BTC mid samples (~1/min, oldest first) from quotes the worker already holds. */
  btcMids?:readonly {at:number;px:number}[]|null;
  /** Regime per-coin ~30-minute moves (fractions). */
  moves?:readonly {symbol:string;move:number}[]|null;
};
const RADAR_FRESH_MS=5*60_000;
const r4=(v:number|null)=>v==null||!Number.isFinite(v)?null:Math.round(v*1e4)/1e4;
const pct=(now:number|null|undefined,then:number|null|undefined)=>now!=null&&then!=null&&then>0&&now>0?r4((now/then-1)*100):null;
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;

function closeAgo(bars:readonly Candle[],n:number){return bars.length>n?bars[bars.length-1-n]!.close:null;}
function hourlyChange(bars:readonly Candle[]|null|undefined,hours:number,now?:number){
  if(!bars||bars.length<=hours)return null;
  // A stored hourly path that is no longer refreshed must not be reported as "now".
  if(now!=null&&(bars.at(-1)!.time*1000+3_600_000)<now-HOURLY_FRESH_MS)return null;
  return pct(bars.at(-1)!.close,bars[bars.length-1-hours]!.close);
}
const HOURLY_FRESH_MS=2*3_600_000,BTC_5M_FRESH_MS=15*60_000,BTC_MID_NOW_MS=3*60_000,BTC_MID_TOL_MS=10*60_000;
/** BTC % change over the last `hours`, from data current at `now`; null rather than a stale value. */
export function btcChange(input:Pick<FeatureInput,'now'|'btcBars5m'|'btcMids'|'btcHourly'>,hours:number):number|null{
  const {now}=input,n=hours*12;
  const b5=(input.btcBars5m??[]).filter(b=>b&&b.close>0);
  if(b5.length>n&&(b5.at(-1)!.time*1000+300_000)>=now-BTC_5M_FRESH_MS)return pct(b5.at(-1)!.close,b5[b5.length-1-n]!.close);
  const mids=(input.btcMids??[]).filter(m=>m&&m.px>0&&Number.isFinite(m.at)&&m.at<=now);
  const latest=mids.at(-1);
  if(latest&&now-latest.at<=BTC_MID_NOW_MS){
    const target=now-hours*3_600_000;let best:{at:number;px:number}|null=null;
    for(const m of mids)if(!best||Math.abs(m.at-target)<Math.abs(best.at-target))best=m;
    if(best&&Math.abs(best.at-target)<=BTC_MID_TOL_MS)return pct(latest.px,best.px);
  }
  return hourlyChange(input.btcHourly,hours,now);
}

export function entryFeatures(input:FeatureInput):Record<string,number|string|boolean|null>{
  const {t,now}=input,entry=t.entryPrice,dir=t.side==='LONG'?1:-1;
  const at=new Date(t.openedAt);
  const out:Record<string,number|string|boolean|null>={v:1,
    leverage:t.leverage>0?t.leverage:null,
    stop_dist_pct:entry>0&&t.stopPrice>0?r4(Math.abs(entry-t.stopPrice)/entry*100):null,
    hour_utc:at.getUTCHours(),weekday:at.getUTCDay()};
  // 5m candles (up to the last 10 hours the worker keeps)
  const bars=(input.bars5m??[]).filter(b=>b&&b.close>0&&b.high>=b.low&&b.low>0);
  const last=bars.at(-1)?.close??null;
  out.chg_1h_pct=pct(last,closeAgo(bars,12));
  out.chg_4h_pct=pct(last,closeAgo(bars,48));
  out.chg_window_pct=pct(last,bars[0]?.close);
  out.window_min=bars.length*5;
  const range=(xs:readonly Candle[])=>xs.map(b=>(b.high-b.low)/b.close);
  const recent=bars.slice(-12),prior=bars.slice(-60,-12);
  const atr=mean(range(recent)),atrPrior=mean(range(prior));
  out.atr_5m_pct=atr==null?null:r4(atr*100);
  out.atr_ratio=atr!=null&&atrPrior!=null&&atrPrior>0?r4(atr/atrPrior):null;
  const vRecent=mean(bars.slice(-3).map(b=>b.volume||0)),vPrior=mean(bars.slice(-51,-3).map(b=>b.volume||0));
  out.vol_surge=vRecent!=null&&vPrior!=null&&vPrior>0?r4(vRecent/vPrior):null;
  if(bars.length&&entry>0){
    const hi=Math.max(...bars.map(b=>b.high)),lo=Math.min(...bars.map(b=>b.low));
    out.dist_high_10h_pct=r4((hi/entry-1)*100);
    out.dist_low_10h_pct=r4((entry/lo-1)*100);
    out.range_pos_10h=hi>lo?r4((entry-lo)/(hi-lo)):null;
  }else{out.dist_high_10h_pct=null;out.dist_low_10h_pct=null;out.range_pos_10h=null;}
  // all-ticker radar snapshot (already fetched every ~15 s)
  const radarOk=input.radar&&input.radarAt!=null&&now-input.radarAt<=RADAR_FRESH_MS;
  const me=radarOk?input.radar!.get(t.symbol):undefined;
  out.radar_age_s=input.radarAt!=null?Math.round((now-input.radarAt)/1000):null;
  out.chg_24h_pct=me?r4(me.change24hRate*100):null;
  out.dist_high_24h_pct=me&&entry>0&&me.high24h>0?r4((me.high24h/entry-1)*100):null;
  out.dist_low_24h_pct=me&&entry>0&&me.low24h>0?r4((entry/me.low24h-1)*100):null;
  if(me&&radarOk){
    const all=[...input.radar!.values()].map(row=>row.change24hRate).filter(Number.isFinite);
    out.chg_24h_rank=all.length?r4(all.filter(v=>v<me.change24hRate).length/all.length):null;
  }else out.chg_24h_rank=null;
  out.open_interest=me&&me.openInterest>0?me.openInterest:null;
  const anchorOi=input.oiAnchor?.oi.get(t.symbol);
  out.oi_chg_pct=me&&anchorOi?pct(me.openInterest,anchorOi):null;
  out.oi_anchor_min=me&&anchorOi&&input.oiAnchor?Math.round((now-input.oiAnchor.at)/60_000):null;
  // BTC / ETH context
  try{out.btc_1h_pct=btcChange(input,1);}catch{out.btc_1h_pct=null;}
  try{out.btc_4h_pct=btcChange(input,4);}catch{out.btc_4h_pct=null;}
  const btcRadar=radarOk?input.radar!.get('BTC_USDT'):undefined,ethRadar=radarOk?input.radar!.get('ETH_USDT'):undefined;
  out.btc_24h_pct=btcRadar?r4(btcRadar.change24hRate*100):hourlyChange(input.btcHourly,24,now);
  out.eth_24h_pct=ethRadar?r4(ethRadar.change24hRate*100):hourlyChange(input.ethHourly,24,now);
  // how many coins move the same way (regime ~30-minute moves)
  const moves=(input.moves??[]).filter(row=>Number.isFinite(row.move));
  if(moves.length>=8){
    out.mkt_with_share=r4(moves.filter(row=>dir*row.move>0).length/moves.length);
    out.mkt_with_strong=moves.filter(row=>dir*row.move>=0.01).length;
    const mine=moves.find(row=>row.symbol===t.symbol);
    out.coin_move_rank=mine?r4(moves.filter(row=>dir*row.move<dir*mine.move).length/moves.length):null;
    out.mkt_coins=moves.length;
  }else{out.mkt_with_share=null;out.mkt_with_strong=null;out.coin_move_rank=null;out.mkt_coins=moves.length;}
  return out;
}
