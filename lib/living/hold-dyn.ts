/**
 * Dynamic holding rules for living v2 trades (2026-10-21). Pure; uses only the price, the trade's own peak/trough
 * (Trade.favorable/adverse, persisted) and the minute holding read (health h). The trade's stop and isolated liquidation
 * stay checked every tick elsewhere; the brain's own exits (intent gone, market flip, climax take, targets) run first.
 *   1. a = max(0.15%, 3 × mean |1-min close change| over the last 15 min)   (price-move %, per coin)
 *   2. profit protection from peak ≥ max(0.6%, 2a): giveback g = max(0.5×peak (0.35× from a 2% peak), 1.5a);
 *      STRONG (h ≥ .3) g ×1.3; FADING (h ≤ -.2) g = max(a, 0.5 × current profit); exit when current ≤ peak − g
 *   3. 1.5× planned hold, extended up to 3× while current ≥ 0.7×peak and peak ≥ 1.5%
 *   4. REVERSED (h ≤ -.5 two minutes running) → exit; loss repair: trough ≤ -0.5%, bounce to 0 (or trough/2 when the
 *      trough was ≤ -1%), h not STRONG, protection not started → exit. No pure time cut on losers.
 */
export const DYN={aFloor:.0015,aMult:3,aWin:15,protectMin:.006,protectA:2,gbFrac:.5,gbFracBig:.35,bigPeak:.02,gbA:1.5,strongMul:1.3,
  fadeA:1,fadeLock:.5,lateHold:1.5,extendMax:3,extendKeep:.7,extendPeak:.015,lossTrough:.005,lossDeep:.01,strong:.3,fading:-.2,reversed:-.5} as const;
/** Volatility unit a from 1-minute closes (oldest first); null with fewer than 6 closes. */
export function volUnit(closes:number[]):number|null{
  const xs=closes.slice(-(DYN.aWin+1)).filter(x=>x>0);if(xs.length<6)return null;
  let s=0;for(let i=1;i<xs.length;i++)s+=Math.abs(xs[i]!/xs[i-1]!-1);
  return Math.max(DYN.aFloor,DYN.aMult*s/(xs.length-1));
}
export type DynState={revN:number;lastMin:number};
export type DynVerdict={act:"HOLD"|"EXIT";code:string;why:string;protecting:boolean;extended:boolean;giveback:number|null};
const p2=(x:number)=>`${(x*100).toFixed(2)}%`;
export function dynHold(i:{side:"LONG"|"SHORT";entry:number;price:number;peak:number;trough:number;ageMin:number;holdMin:number;a:number|null;h:number|null;now:number},st:DynState):DynVerdict{
  const s=i.side==="LONG"?1:-1,cur=s*(i.price/i.entry-1),peak=Math.max(0,i.peak,cur),trough=Math.max(0,i.trough,-cur),a=i.a??DYN.aFloor*2,h=i.h;
  const minute=Math.floor(i.now/60_000);
  if(minute!==st.lastMin){st.lastMin=minute;st.revN=h!=null&&h<=DYN.reversed?st.revN+1:0;}
  const protecting=peak>=Math.max(DYN.protectMin,DYN.protectA*a);
  const hold=(extended=false,giveback:number|null=null):DynVerdict=>({act:"HOLD",code:extended?"LIVING_DYN_EXTEND":"",why:extended?"延长持有：利润还在高位，资金没走":"",protecting,extended,giveback});
  const exit=(code:string,why:string,giveback:number|null=null):DynVerdict=>({act:"EXIT",code,why,protecting,extended:false,giveback});
  if(st.revN>=2)return exit("LIVING_DYN_REVERSED",`资金反转离场：持有理由健康度连续两分钟 ≤ ${DYN.reversed}（${h?.toFixed(2)}）`);
  let g:number|null=null;
  if(protecting){
    g=Math.max((peak>=DYN.bigPeak?DYN.gbFracBig:DYN.gbFrac)*peak,DYN.gbA*a);
    if(h!=null&&h>=DYN.strong)g*=DYN.strongMul;
    else if(h!=null&&h<=DYN.fading)g=Math.max(DYN.fadeA*a,DYN.fadeLock*Math.max(0,cur));
    if(cur<=peak-g+1e-9)return exit("LIVING_DYN_LOCK",`动态锁利：最高浮盈 ${p2(peak)}，允许回吐 ${p2(g)}，现在 ${p2(cur)}`,g);
  }
  let extended=false;
  if(i.holdMin>0&&i.ageMin>=DYN.lateHold*i.holdMin){
    const end=i.ageMin>=DYN.extendMax*i.holdMin,keep=cur>=DYN.extendKeep*peak&&peak>=DYN.extendPeak;
    if(end||!keep)return exit(end?"LIVING_DYN_EXTEND_END":"LIVING_THESIS_TIMEOUT",
      end?`延长持有到计划时长的 ${DYN.extendMax} 倍，离场`:`拿到计划时长 ${i.holdMin} 分钟的 1.5 倍，利润不在高位（现在 ${p2(cur)}，最高 ${p2(peak)}）`,g);
    extended=true;
  }
  if(!protecting&&trough>=DYN.lossTrough&&!(h!=null&&h>=DYN.strong)){
    const target=trough>=DYN.lossDeep?-trough/2:0;
    if(cur>=target-1e-9)return exit("LIVING_DYN_LOSS_REPAIR",`反弹减亏离场：最深 ${p2(-trough)}，反弹到 ${p2(cur)}（目标 ${p2(target)}）`,g);
  }
  return hold(extended,g);
}
