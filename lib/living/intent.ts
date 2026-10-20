/**
 * v2 intent layer: what capital and the crowd are doing right now, per coin and market-wide, from live evidence only.
 * Inputs: the price tape (2s mids → 1m/5m bars) and the flow book (open interest, funding, basis, aggressor proxy,
 * traded volume — all from payloads the program already receives). No sample-count gate: a read is made the moment the
 * evidence is there. Rolling live probe statistics may only scale size (0.7–1.2x) and rank, never block (sizeModulator).
 *
 * Two readings, kept separate on purpose:
 *  - capital (price × OI quadrant): DEMAND (up, OI up: new longs), SUPPLY (down, OI up: new shorts), SQUEEZE_UP (up, OI
 *    down: shorts forced out), FLUSH_DOWN (down, OI down: longs forced out), ABSORB_BID / ABSORB_ASK (heavy one-sided flow,
 *    price does not give), DRIFT (price moves, nobody adds or leaves), UNVERIFIED (no OI yet), NONE.
 *  - human nature: FOMO (extension + funding/basis heating + OI build), PANIC (flush + volume + funding cooling),
 *    CAPITULATION (panic that stops: no new low, liquidations stop, buyers return), EXHAUSTION (a squeeze that stops),
 *    BLOWOFF (FOMO that fails), COMPLACENCY (quiet market, crowd quietly built on one side), CONVICTION (real money, not
 *    crowded, not extended), CALM.
 * Every read carries a short Chinese narrative and the evidence numbers it was made from (price moves are price %, not ROE).
 */
import type {LivingTape,MidBar} from "./tape.ts";
import type {FlowBook} from "./flow.ts";
import type {IntentPlaybook,Side} from "./thesis.ts";
import {median,clamp,r4,r6,pct} from "./util.ts";

export type CapitalState="DEMAND"|"SUPPLY"|"SQUEEZE_UP"|"FLUSH_DOWN"|"ABSORB_BID"|"ABSORB_ASK"|"DRIFT"|"UNVERIFIED"|"NONE";
export type Emotion="FOMO"|"PANIC"|"CAPITULATION"|"EXHAUSTION"|"BLOWOFF"|"COMPLACENCY"|"CONVICTION"|"CALM"|"NONE";
export type CoinFeatures={p5:number|null;p15:number|null;p60:number|null;p240:number|null;z15:number|null;z60:number|null;ext:number|null;
  oi5:number|null;oi15:number|null;oi60:number|null;funding:number|null;dFunding60:number|null;basis:number|null;
  taker5:number|null;taker15:number|null;vol5:number|null;vol15:number|null;vol60:number|null;imbalance:number;
  rangePos:number|null;rangeHi:number|null;rangeLo:number|null;stallMin:number|null;last:number|null;atr5:number|null};
export type CoinIntent={symbol:string;at:number;capital:CapitalState;emotion:Emotion;crowd:Side|null;
  /** who is acting in the capital read (DEMAND → LONG, FLUSH_DOWN → LONG crowd being forced out → side LONG) */
  actor:Side|null;strength:number;action:IntentAction|null;why:string;f:CoinFeatures};
export type IntentAction={pb:IntentPlaybook;side:Side;strength:number;why:string};
export type MarketState="RISK_ON"|"RISK_OFF"|"SQUEEZE"|"PANIC"|"CAPITULATION"|"FOMO"|"COMPLACENT"|"CALM"|"MIXED"|"WARMING";
export type MarketIntent={at:number;state:MarketState;side:Side|null;confidence:number;sentence:string;
  allowed:{pb:IntentPlaybook;side:Side|null}[];
  ev:{p15:number|null;p60:number|null;breadth:number|null;oi15:number|null;oi60:number|null;funding:number|null;taker15:number|null;
    vol15:number|null;btc15:number|null;eth15:number|null;n:number;nOi:number;shares:Record<string,number>};lead:string|null};

/** Initial thresholds (price %, OI %, funding per interval as received). */
export const INTENT={
  moveZ:1.5,moveMin:.004,oiMove15:.005,oiStrong15:.015,oiBuild60:.02,oiDrop60:-.02,oiCascade5:-.01,
  fundingHot:.0003,fundingCold:-.0002,fundingRise60:.0001,basisHot:.0005,takerNotable:.25,volSurge:1.8,volClimax:3,
  extended:2.5,stallMin:3,stallMax:30,capMove60:.012,blowoffStall:5,edgeLo:.2,edgeHi:.8,sigmaFloor5:.0015,
  marketMove15:.003,marketPanic15:-.006,marketSqueeze15:.006,marketFomo60:.01,breadth:.6,calmMove60:.005,
} as const;
const d=(s:Side)=>s==="LONG"?1:-1;

/** Close of the last 1m bar that ended at or before `at`. */
function close1(tape:LivingTape,s:string,at:number){
  const rows=tape.m1.get(s);if(!rows?.length)return null;const t=Math.floor(at/60_000)*60;// bar [t-60,t) ended at t
  for(let k=rows.length-1;k>=0;k--){const r=rows[k]!;if(r.time+60<=t){return t-(r.time+60)>300?null:r.close;}}
  return null;
}
export function features(tape:LivingTape,flow:FlowBook,s:string,now:number):CoinFeatures{
  const last=tape.last(s),px=last&&now-last.at<=15_000?last.mid:null;
  const ret=(min:number)=>{if(px==null)return null;const b=close1(tape,s,now-min*60_000);return b&&b>0?px/b-1:null;};
  const m5=tape.closed5(s,now).slice(-49),rs:number[]=[];
  for(let i=1;i<m5.length;i++)rs.push(m5[i]!.close/m5[i-1]!.close-1);
  const sd5=rs.length>=12?Math.max(INTENT.sigmaFloor5,Math.sqrt(rs.reduce((a,x)=>a+x*x,0)/rs.length)):null;
  const p5=ret(5),p15=ret(15),p60=ret(60),p240=m5.length>=48&&px!=null?px/m5[m5.length-48]!.open-1:null;
  const w=m5.slice(-48),hi=w.length>=12?Math.max(...w.map(r=>r.high)):null,lo=w.length>=12?Math.min(...w.map(r=>r.low)):null;
  const atr5=w.length>=12?median(w.slice(-14).map(r=>r.high-r.low)):null;
  // minutes since the 60m extreme in the direction of the 30m move
  let stall:number|null=null;const m1=tape.m1.get(s)??[];
  if(m1.length>=10&&px!=null){
    const win=m1.slice(-60),p30=ret(30)??0,up=p30>=0;let ext=up?-Infinity:Infinity,at=0;
    for(const r of win){const v=up?r.high:r.low;if(up?v>=ext:v<=ext){ext=v;at=r.time;}}
    stall=Math.max(0,(now/1000-(at+60))/60);
  }
  const sd=(min:number)=>sd5==null?null:sd5*Math.sqrt(min/5);
  return {p5,p15,p60,p240,z15:p15!=null&&sd(15)?p15/sd(15)!:null,z60:p60!=null&&sd(60)?p60/sd(60)!:null,
    ext:p240!=null&&sd(240)?p240/sd(240)!:null,
    oi5:flow.oiChange(s,now,5),oi15:flow.oiChange(s,now,15),oi60:flow.oiChange(s,now,60),funding:flow.funding(s,now),
    dFunding60:flow.fundingChange(s,now,60),basis:flow.basis(s,now),taker5:flow.taker(s,now,5),taker15:flow.taker(s,now,15),
    vol5:flow.volRatio(s,now,5),vol15:flow.volRatio(s,now,15),vol60:flow.volRatio(s,now,60),imbalance:tape.meta.get(s)?.imbalance??0,
    rangePos:hi!=null&&lo!=null&&hi>lo&&px!=null?clamp((px-lo)/(hi-lo),0,1):null,rangeHi:hi,rangeLo:lo,stallMin:stall,last:px,atr5};
}
const f2=(v:number|null,k=2)=>v==null?"—":pct(v,k);
export function evidenceLine(f:CoinFeatures){
  return `15分钟价格 ${f2(f.p15)}，持仓量 ${f2(f.oi15)}（1小时 ${f2(f.oi60)}），资金费 ${f.funding==null?"—":(f.funding*100).toFixed(3)+"%"}，`+
    `主动买卖 ${f.taker15==null?"—":(f.taker15>0?"+":"")+f.taker15.toFixed(2)}，成交量 ${f.vol15==null?"—":f.vol15.toFixed(1)+"倍"}`;
}
/** Per-coin read. `recent` = this coin's reads over the last hour (oldest first) for the "it stopped" emotions. */
export function readCoin(symbol:string,f:CoinFeatures,now:number,recent:CoinIntent[]=[]):CoinIntent{
  const I=INTENT;
  const moving=f.z15!=null&&f.p15!=null&&Math.abs(f.z15)>=I.moveZ&&Math.abs(f.p15)>=I.moveMin;
  const dir=f.p15==null?0:Math.sign(f.p15);
  let capital:CapitalState="NONE",actor:Side|null=null;
  if(moving){
    if(f.oi15==null){capital="UNVERIFIED";}
    else if(f.oi15>=I.oiMove15){capital=dir>0?"DEMAND":"SUPPLY";actor=dir>0?"LONG":"SHORT";}
    else if(f.oi15<=-I.oiMove15){capital=dir>0?"SQUEEZE_UP":"FLUSH_DOWN";actor=dir>0?"SHORT":"LONG";}
    else capital="DRIFT";
  }else if(f.vol15!=null&&f.vol15>=I.volSurge&&f.taker15!=null&&Math.abs(f.taker15)>=I.takerNotable&&f.z15!=null&&Math.abs(f.z15)<.7){
    capital=f.taker15<0?"ABSORB_BID":"ABSORB_ASK";actor=f.taker15<0?"SHORT":"LONG";
  }
  // crowd: who is paying to hold, who piled in
  const crowdLong=(f.funding!=null&&f.funding>=I.fundingHot)||(f.basis!=null&&f.basis>=I.basisHot)||(f.oi60!=null&&f.oi60>=I.oiBuild60*1.5&&(f.p60??0)>=0&&(f.funding??0)>0);
  const crowdShort=(f.funding!=null&&f.funding<=I.fundingCold)||(f.basis!=null&&f.basis<=-I.basisHot)||(f.oi60!=null&&f.oi60>=I.oiBuild60*1.5&&(f.p60??0)<0&&(f.funding??0)<0);
  const crowd:Side|null=crowdLong&&!crowdShort?"LONG":crowdShort&&!crowdLong?"SHORT":null;
  const extendedUp=(f.z60??0)>=I.extended||(f.ext??0)>=I.extended,extendedDn=(f.z60??0)<=-I.extended||(f.ext??0)<=-I.extended;
  const heatUp=(f.dFunding60??0)>=I.fundingRise60||crowdLong,heatDn=(f.dFunding60??0)<=-I.fundingRise60||crowdShort;
  const built=(f.oi60??0)>=I.oiBuild60;
  const stalled=(f.stallMin??0)>=I.stallMin;
  const had=(e:Emotion,side?:Side)=>recent.some(r=>now-r.at<=60*60_000&&r.emotion===e&&(!side||r.crowd===side||r.actor===side));
  let emotion:Emotion="NONE",why="";
  // order matters: "it stopped" first, then the live emotions
  // "it stopped" needs a real leg first: a ≥1.2% / 2σ hour move that forced one side out (OI fell), and the stop is fresh (≤30 min)
  const fresh=stalled&&(f.stallMin??0)<=I.stallMax,oiOut=f.oi60!=null&&f.oi60<=I.oiDrop60/2;
  const bigDrop=f.p60!=null&&f.p60<=-I.capMove60&&(f.z60??0)<=-2,bigRise=f.p60!=null&&f.p60>=I.capMove60&&(f.z60??0)>=2;
  if(bigDrop&&(had("PANIC","LONG")||oiOut)&&(f.oi60??0)<0&&fresh&&(f.oi5??-1)>=-.002&&(f.taker5??0)>=(f.taker15??0)&&(f.p5??0)>=-.001){
    emotion="CAPITULATION";why=`恐慌出尽：1小时跌 ${f2(f.p60)}、持仓量掉 ${f2(f.oi60)}，${(f.stallMin??0).toFixed(0)} 分钟没再创新低，强平停了，买盘回来`;
  }else if(bigRise&&(had("PANIC","SHORT")||oiOut)&&(f.oi60??0)<0&&fresh&&(f.oi5??-1)>=-.002&&(f.taker5??0)<=(f.taker15??0)&&(f.p5??0)<=.001){
    emotion="EXHAUSTION";why=`逼空衰竭：1小时涨 ${f2(f.p60)} 靠空头回补（持仓量 ${f2(f.oi60)}），${(f.stallMin??0).toFixed(0)} 分钟没新高，回补停了`;
  }else if((had("FOMO","LONG")||(extendedUp&&heatUp&&built))&&(f.stallMin??0)>=I.blowoffStall&&((f.taker5??0)<0||(f.oi5??0)<=0)){
    emotion="BLOWOFF";why=`贪婪见顶：追多的人还在（资金费 ${f.funding==null?"—":(f.funding*100).toFixed(3)+"%"}、持仓量1小时 ${f2(f.oi60)}），但 ${(f.stallMin??0).toFixed(0)} 分钟没新高、新多不再进`;
  }else if((had("FOMO","SHORT")||(extendedDn&&heatDn&&built))&&(f.stallMin??0)>=I.blowoffStall&&((f.taker5??0)>0||(f.oi5??0)<=0)){
    emotion="BLOWOFF";why=`追空见底：空头挤在一边（资金费 ${f.funding==null?"—":(f.funding*100).toFixed(3)+"%"}），但 ${(f.stallMin??0).toFixed(0)} 分钟没新低、新空不再进`;
  }else if((capital==="FLUSH_DOWN"||(f.oi5!=null&&f.oi5<=I.oiCascade5&&(f.p5??0)<0))&&((f.vol5??0)>=I.volSurge||(f.dFunding60??0)<0||(f.funding??0)<0)){
    emotion="PANIC";actor="LONG";why=`恐慌：价格 15分钟 ${f2(f.p15)}，持仓量 ${f2(f.oi15)}，多头在被迫离场${(f.vol5??0)>=I.volClimax?"，成交放到 "+(f.vol5??0).toFixed(1)+" 倍":""}`;
  }else if((capital==="SQUEEZE_UP"||(f.oi5!=null&&f.oi5<=I.oiCascade5&&(f.p5??0)>0))&&((f.vol5??0)>=I.volSurge||(f.dFunding60??0)>0||(f.funding??0)<0)){
    emotion="PANIC";actor="SHORT";why=`逼空：价格 15分钟 ${f2(f.p15)}，持仓量 ${f2(f.oi15)}，空头在被迫回补，不是新买盘`;
  }else if(capital==="DEMAND"&&extendedUp&&heatUp){
    emotion="FOMO";why=`追涨情绪：已经涨 ${f2(f.p60)}（1小时），新多还在进（持仓量 ${f2(f.oi15)}），资金费/溢价在升温`;
  }else if(capital==="SUPPLY"&&extendedDn&&heatDn){
    emotion="FOMO";why=`追空情绪：已经跌 ${f2(f.p60)}（1小时），新空还在进（持仓量 ${f2(f.oi15)}），资金费在变负`;
  }else if((capital==="DEMAND"&&crowd!=="LONG")||(capital==="SUPPLY"&&crowd!=="SHORT")){
    emotion="CONVICTION";why=`${capital==="DEMAND"?"真买盘":"真卖盘"}：价格 ${f2(f.p15)}，持仓量同步 ${f2(f.oi15)}，${capital==="DEMAND"?"多":"空"}头没挤在一边`;
  }else if(!moving&&crowd&&built&&Math.abs(f.z60??0)<1&&(f.vol60??1)<=1.1){
    emotion="COMPLACENCY";why=`安逸：价格没怎么动，${crowd==="LONG"?"多":"空"}头却在悄悄加仓（持仓量1小时 ${f2(f.oi60)}，资金费 ${f.funding==null?"—":(f.funding*100).toFixed(3)+"%"}）`;
  }else if(!moving&&(f.vol15==null||f.vol15<1.3)){
    emotion="CALM";why="平静：没人推，也没人逃";
  }
  if(!why)why=capital==="UNVERIFIED"?"价格在动，但持仓量数据还没到，判断不了是谁在推":capital==="DRIFT"?`价格在动（${f2(f.p15)}），但持仓量几乎没变：没人加仓也没人认输，靠薄盘口漂`:
    capital==="ABSORB_BID"?"大量主动卖单砸下来，价格却不跌：有人在接":capital==="ABSORB_ASK"?"大量主动买单，价格却不涨：有人在压":"没有明确的资金意图";
  // FOMO / PANIC carry the side of the emotional crowd
  const emoCrowd:Side|null=emotion==="FOMO"?(capital==="DEMAND"?"LONG":"SHORT"):emotion==="BLOWOFF"?(why.startsWith("追空")?"SHORT":"LONG"):crowd;
  const strength=strengthOf(capital,emotion,f);
  const ci:CoinIntent={symbol,at:now,capital,emotion,crowd:emoCrowd,actor,strength,action:null,why,f};
  ci.action=coinAction(ci);
  return ci;
}
function strengthOf(capital:CapitalState,emotion:Emotion,f:CoinFeatures){
  const z=Math.min(1,Math.abs(f.z15??0)/3),oi=Math.min(1,Math.abs(f.oi15??0)/INTENT.oiStrong15),vol=Math.min(1,Math.max(0,((f.vol15??1)-1)/2)),
    tk=Math.min(1,Math.abs(f.taker15??0)/.5);
  switch(emotion){
    case "CONVICTION":return r4(.35*z+.35*oi+.15*vol+.15*tk*(Math.sign(f.taker15??0)===Math.sign(f.p15??0)?1:0));
    case "CAPITULATION":case "EXHAUSTION":return r4(clamp(.3+.3*Math.min(1,Math.abs(f.oi60??0)/.04)+.2*Math.min(1,(f.stallMin??0)/10)+.2*vol,0,1));
    case "BLOWOFF":return r4(clamp(.3+.3*Math.min(1,Math.abs(f.z60??0)/4)+.2*Math.min(1,(f.stallMin??0)/15)+.2*Math.min(1,Math.abs(f.funding??0)/.001),0,1));
    case "COMPLACENCY":return r4(clamp(.3+.4*Math.min(1,(f.oi60??0)/.05)+.3*Math.min(1,Math.abs(f.funding??0)/.0006),0,1));
    default:return capital==="ABSORB_BID"||capital==="ABSORB_ASK"?r4(.4*vol+.4*tk+.2):r4(.5*z+.5*oi);
  }
}
/** Coin read → the trade that expresses it (or none, with the reason in `why`). */
export function coinAction(ci:CoinIntent):IntentAction|null{
  const f=ci.f;
  switch(ci.emotion){
    case "CONVICTION":return{pb:"follow",side:ci.capital==="DEMAND"?"LONG":"SHORT",strength:ci.strength,why:`${ci.why} → 等回调跟进，不追高`};
    case "CAPITULATION":return{pb:"flush-rebound",side:"LONG",strength:ci.strength,why:`${ci.why} → 抄反弹，失效价放在恐慌低点下面`};
    case "EXHAUSTION":return{pb:"squeeze-fade",side:"SHORT",strength:ci.strength,why:`${ci.why} → 反做，失效价放在逼空高点上面`};
    case "BLOWOFF":return{pb:"crowd-fade",side:ci.crowd==="SHORT"?"LONG":"SHORT",strength:ci.strength,why:`${ci.why} → 反着拥挤的一边做`};
    case "COMPLACENCY":{
      if(!ci.crowd||f.last==null||f.rangeHi==null||f.rangeLo==null)return null;
      const broke=ci.crowd==="LONG"?f.last<f.rangeLo*(1+.001)&&(f.p15??0)<0:f.last>f.rangeHi*(1-.001)&&(f.p15??0)>0;
      return broke?{pb:"crowd-break",side:ci.crowd==="LONG"?"SHORT":"LONG",strength:ci.strength,why:`${ci.why}，现在价格破了 4 小时${ci.crowd==="LONG"?"下沿":"上沿"} → 拥挤的一边要被迫离场，顺着破位做`}:null;
    }
    default:break;
  }
  if(ci.capital==="ABSORB_BID"&&(f.rangePos??.5)<=INTENT.edgeLo)return{pb:"absorb-revert",side:"LONG",strength:ci.strength,why:`${ci.why}，而且在 4 小时区间下沿 → 回归做多`};
  if(ci.capital==="ABSORB_ASK"&&(f.rangePos??.5)>=INTENT.edgeHi)return{pb:"absorb-revert",side:"SHORT",strength:ci.strength,why:`${ci.why}，而且在 4 小时区间上沿 → 回归做空`};
  return null;
}
/** Why a strong-looking coin is NOT traded (shown on the board). */
export function noTradeReason(ci:CoinIntent){
  if(ci.action)return null;
  if(ci.emotion==="FOMO")return ci.crowd==="LONG"?"追涨的人太多：不追，等它失败再反做":"追空的人太多：不追空，等它失败再反做";
  if(ci.emotion==="PANIC")return ci.actor==="LONG"?"多头在踩踏：不在恐慌里卖，也不接飞刀，等出尽":"空头在被逼：不追逼空，等回补停了再反做";
  if(ci.capital==="UNVERIFIED")return"持仓量数据还没到";
  if(ci.capital==="DRIFT")return"价格在漂，没有资金在推";
  return"没有明确的资金意图";
}

/** Market-wide read from the basket coin reads. `prev` = earlier market reads (for "panic → capitulation"). */
export function readMarket(coins:CoinIntent[],btc:CoinIntent|null,eth:CoinIntent|null,now:number,prev:MarketIntent[]=[]):MarketIntent{
  const I=INTENT,n=coins.length;
  const med=(g:(c:CoinIntent)=>number|null,minN=8)=>{const xs=coins.map(g).filter((v):v is number=>v!=null&&Number.isFinite(v));return xs.length>=minN?median(xs):null;};
  const p15=med(c=>c.f.p15),p60=med(c=>c.f.p60),oi15=med(c=>c.f.oi15,6),oi60=med(c=>c.f.oi60,6),funding=med(c=>c.f.funding,6),
    taker15=med(c=>c.f.taker15,6),vol15=med(c=>c.f.vol15,6);
  const sgn=Math.sign(p15??0),moved=coins.filter(c=>c.f.p15!=null&&Math.abs(c.f.p15)>=.001);
  const breadth=moved.length?moved.filter(c=>Math.sign(c.f.p15!)===sgn).length/Math.max(1,coins.filter(c=>c.f.p15!=null).length):null;
  const share=(pred:(c:CoinIntent)=>boolean)=>n?coins.filter(pred).length/n:0;
  const shares={demand:share(c=>c.capital==="DEMAND"),supply:share(c=>c.capital==="SUPPLY"),squeeze:share(c=>c.capital==="SQUEEZE_UP"),
    flush:share(c=>c.capital==="FLUSH_DOWN"),fomo:share(c=>c.emotion==="FOMO"),panic:share(c=>c.emotion==="PANIC"),
    capitulation:share(c=>c.emotion==="CAPITULATION"),exhaustion:share(c=>c.emotion==="EXHAUSTION"),blowoff:share(c=>c.emotion==="BLOWOFF"),
    complacency:share(c=>c.emotion==="COMPLACENCY"),unverified:share(c=>c.capital==="UNVERIFIED")};
  const nOi=coins.filter(c=>c.f.oi15!=null).length;
  const ev={p15:p15==null?null:r6(p15),p60:p60==null?null:r6(p60),breadth:breadth==null?null:r4(breadth),oi15:oi15==null?null:r6(oi15),
    oi60:oi60==null?null:r6(oi60),funding:funding==null?null:r6(funding),taker15:taker15==null?null:r4(taker15),vol15:vol15==null?null:r4(vol15),
    btc15:btc?.f.p15==null?null:r6(btc.f.p15),eth15:eth?.f.p15==null?null:r6(eth.f.p15),n,nOi,
    shares:Object.fromEntries(Object.entries(shares).map(([k,v])=>[k,r4(v)]))};
  const lead=btc?.f.p15!=null&&p15!=null&&Math.abs(p15)>=.002?(Math.abs(btc.f.p15)>=1.3*Math.abs(p15)&&Math.sign(btc.f.p15)===Math.sign(p15)?"BTC 领着走":
    Math.abs(p15)>=1.3*Math.abs(btc.f.p15)?"山寨自己在走，BTC 没带":"BTC 和山寨同步"):null;
  const recentPanic=prev.some(m=>now-m.at<=60*60_000&&m.state==="PANIC"),recentSqueeze=prev.some(m=>now-m.at<=60*60_000&&m.state==="SQUEEZE");
  const mk=(state:MarketState,side:Side|null,confidence:number,sentence:string,allowed:MarketIntent["allowed"]):MarketIntent=>
    ({at:now,state,side,confidence:r4(clamp(confidence,0,1)),sentence:`${sentence}${lead?`；${lead}`:""}`,allowed,ev,lead});
  if(n<20||p15==null)return mk("WARMING",null,0,"数据还在暖机（价格点不足）",[]);
  if(nOi<n*.4)return mk("WARMING",null,0,`持仓量数据只覆盖 ${nOi}/${n} 个币，还读不出资金在干什么`,[]);
  const f3=(v:number|null)=>v==null?"—":pct(v);
  if(p15<=I.marketPanic15&&(shares.flush+shares.panic>=.3)&&(oi15??0)<=-.002)
    return mk("PANIC","LONG",.5+shares.panic,`恐慌踩踏：一篮子 15 分钟 ${f3(p15)}，持仓量 ${f3(oi15)}，多头在被迫离场。不卖在恐慌里，也不接飞刀`,[]);
  if(recentPanic&&shares.capitulation+shares.blowoff>=.12&&(p15??0)>-.003)
    return mk("CAPITULATION","LONG",.5+shares.capitulation,`恐慌出尽：刚才的踩踏停了（${Math.round(shares.capitulation*100)}% 的币不再创新低、强平停止），可以抄反弹`,[{pb:"flush-rebound",side:"LONG"}]);
  if(p15>=I.marketSqueeze15&&shares.squeeze+shares.panic>=.3&&(oi15??0)<=-.002)
    return mk("SQUEEZE","SHORT",.5+shares.squeeze,`逼空：一篮子 15 分钟 ${f3(p15)}，但持仓量 ${f3(oi15)}，是空头在回补，不是新买盘。不追，等衰竭反做`,[{pb:"squeeze-fade",side:"SHORT"}]);
  if(recentSqueeze&&shares.exhaustion>=.12)
    return mk("SQUEEZE","SHORT",.5+shares.exhaustion,"逼空在衰竭：回补停了，开始反做",[{pb:"squeeze-fade",side:"SHORT"}]);
  if((p60??0)>=I.marketFomo60&&shares.fomo+shares.blowoff>=.2&&(funding??0)>=I.fundingHot*.6)
    return mk("FOMO","LONG",.4+shares.fomo+shares.blowoff,`贪婪：一篮子 1 小时 ${f3(p60)}，资金费 ${funding==null?"—":(funding*100).toFixed(3)+"%"}，追多的人越来越多。不追多，等失败反做`,[{pb:"crowd-fade",side:"SHORT"}]);
  if((p60??0)<=-I.marketFomo60&&shares.fomo+shares.blowoff>=.2&&(funding??0)<=I.fundingCold*.6)
    return mk("FOMO","SHORT",.4+shares.fomo+shares.blowoff,`追空：一篮子 1 小时 ${f3(p60)}，资金费转负，空头越挤越多。不追空，等失败反做`,[{pb:"crowd-fade",side:"LONG"}]);
  if(p15>=I.marketMove15&&(breadth??0)>=I.breadth&&shares.demand>=.25&&(oi15??0)>=.002)
    return mk("RISK_ON","LONG",.3+shares.demand+(breadth??0)*.3,`真资金在做多：一篮子 15 分钟 ${f3(p15)}，${Math.round((breadth??0)*100)}% 同涨，持仓量 ${f3(oi15)}（新多进场）。回调跟进`,
      [{pb:"follow",side:"LONG"},{pb:"absorb-revert",side:"LONG"},{pb:"flush-rebound",side:"LONG"}]);
  if(p15<=-I.marketMove15&&(breadth??0)>=I.breadth&&shares.supply>=.25&&(oi15??0)>=.002)
    return mk("RISK_OFF","SHORT",.3+shares.supply+(breadth??0)*.3,`真资金在做空：一篮子 15 分钟 ${f3(p15)}，${Math.round((breadth??0)*100)}% 同跌，持仓量 ${f3(oi15)}（新空进场）。反弹跟空`,
      [{pb:"follow",side:"SHORT"},{pb:"absorb-revert",side:"SHORT"},{pb:"squeeze-fade",side:"SHORT"}]);
  if(Math.abs(p60??0)<I.calmMove60&&(oi60??0)>=.01&&Math.abs(funding??0)>=I.fundingHot*.5)
    return mk("COMPLACENT",(funding??0)>0?"LONG":"SHORT",.5,`安逸：一篮子没怎么动，${(funding??0)>0?"多":"空"}头却在悄悄堆仓（持仓量 1 小时 ${f3(oi60)}）。等破位反着做，区间边缘被吸收也可以做`,
      [{pb:"crowd-break",side:null},{pb:"absorb-revert",side:null},{pb:"crowd-fade",side:null}]);
  if(Math.abs(p60??0)<I.calmMove60&&(vol15??1)<1.4)
    return mk("CALM",null,.5,`平静：一篮子 1 小时 ${f3(p60)}，没人推也没人逃。只做个别币自己的信号（被吸收、拥挤破位、出尽反转）`,
      [{pb:"absorb-revert",side:null},{pb:"crowd-break",side:null},{pb:"crowd-fade",side:null},{pb:"flush-rebound",side:null},{pb:"squeeze-fade",side:null}]);
  return mk("MIXED",null,.2,`方向不清：一篮子 15 分钟 ${f3(p15)}、持仓量 ${f3(oi15)}，资金没有一致的意图。不交易`,[]);
}
/** Layer 1: the market intent is clear and allows this playbook / side. */
export function marketAllows(m:MarketIntent|null,pb:IntentPlaybook,side:Side){
  if(!m)return{ok:false,why:"第一层：还没有市场意图"};
  if(m.state==="MIXED"||m.state==="WARMING"||m.state==="PANIC")return{ok:false,why:`第一层：${m.sentence}`};
  const a=m.allowed.find(x=>x.pb===pb&&(x.side==null||x.side===side));
  return a?{ok:true,why:`第一层：${m.sentence}`}:{ok:false,why:`第一层：当前市场（${m.state}）不支持「${pb} ${side==="LONG"?"多":"空"}」`};
}
/** Size modulator from the rolling live probe stats: 0.7–1.2x, never a gate. */
export function sizeModulator(score:{t:number;n:number;score:number}|undefined){
  if(!score||score.n<10)return 1;
  if(score.t>=2&&score.score>0)return 1.2;
  if(score.t<=-1)return .7;
  return score.score>0?1.1:.9;
}
/** Evidence factor from the strength of the live read: 0.3 / 0.6 / 1.0 (parent sizing). */
export function intentEvidence(strength:number,marketConfidence:number){
  const s=Math.min(strength,.5+marketConfidence/2);
  return s>=.75?{factor:1,label:"strong" as const}:s>=.5?{factor:.6,label:"normal" as const}:{factor:.3,label:"probe" as const};
}
/** Burst flow verdict for the fast lane: is the whole-market move carried by real flow? */
export type BurstFlow={real:boolean|null;kind:"NEW_POSITIONS"|"SQUEEZE"|"FLUSH"|"VOLUME"|"THIN"|"UNKNOWN";vol:number|null;taker:number|null;oi:number|null;why:string};
export function burstFlow(flow:FlowBook,members:string[],side:Side,now:number):BurstFlow{
  const vol=flow.aggregate(members,s=>flow.volRatio(s,now,2),8).v,taker=flow.aggregate(members,s=>flow.taker(s,now,2),8).v,
    oi=flow.aggregate(members,s=>flow.oiChange(s,now,5),8).v;
  if(vol==null&&oi==null&&taker==null)return{real:null,kind:"UNKNOWN",vol,taker,oi,why:"资金数据还没到，只看价格"};
  const volOk=vol!=null&&vol>=INTENT.volSurge,takerOk=taker!=null&&d(side)*taker>=.1,oiMove=oi!=null&&Math.abs(oi)>=.002;
  const real=(volOk&&(takerOk||oiMove))||(vol!=null&&vol>=INTENT.volClimax);
  const kind=!real?"THIN":oi!=null&&oi>=.002?"NEW_POSITIONS":oi!=null&&oi<=-.002?(side==="LONG"?"SQUEEZE":"FLUSH"):"VOLUME";
  const why=`成交 ${vol==null?"—":vol.toFixed(1)+"倍"}，主动${side==="LONG"?"买":"卖"} ${taker==null?"—":(d(side)*taker).toFixed(2)}，持仓量 5分钟 ${oi==null?"—":pct(oi)}`;
  return{real,kind,vol,taker,oi,why:real?`${kind==="NEW_POSITIONS"?"新开仓推动":kind==="SQUEEZE"?"空头被逼回补":kind==="FLUSH"?"多头踩踏":"放量推动"}（${why}）`:`价格齐动但资金没跟（${why}）`};
}
/** Hold / exit decision for an open v2 trade from the live read of its coin and the market. */
export type HoldVerdict={act:"HOLD"|"EXIT"|"GUARD";code:string;why:string;stop?:number};
export function holdCheck(input:{pb:IntentPlaybook;side:Side;entry:number;price:number;stop:number;coin:CoinIntent|null;market:MarketIntent|null;
  ageMin:number;holdMin:number;cost:number}):HoldVerdict{
  const {pb,side,coin,market}=input,s=d(side),gain=s*(input.price/input.entry-1),f=coin?.f;
  const lock=(frac:number)=>{const st=input.entry*(1+s*Math.max(input.cost,gain*frac));return s*(st-input.stop)>0?st:null;};
  const against=market&&market.side&&market.side!==side&&market.confidence>=.6&&["RISK_ON","RISK_OFF","PANIC","SQUEEZE"].includes(market.state)&&
    !(pb==="flush-rebound"&&market.state==="CAPITULATION");
  if(against){
    if(gain>input.cost){const st=lock(.5);if(st)return{act:"GUARD",code:"LIVING_INTENT_MARKET_LOCK",why:`市场意图转向（${market!.sentence.slice(0,50)}），浮盈单锁一半利润`,stop:st};}
    else return{act:"EXIT",code:"LIVING_INTENT_MARKET_FLIP",why:`市场意图转向（${market!.sentence.slice(0,60)}），持有理由没了`};
  }
  if(!coin||!f)return{act:"HOLD",code:"",why:"这个币暂时读不到（没有新鲜数据），先按失效价拿"};
  switch(pb){
    case "follow":{
      const leaving=side==="LONG"?(coin.capital==="FLUSH_DOWN"||coin.capital==="SUPPLY"):(coin.capital==="SQUEEZE_UP"||coin.capital==="DEMAND");
      if(leaving&&coin.strength>=.4)return gain>input.cost&&lock(.5)?{act:"GUARD",code:"LIVING_INTENT_LOCK",why:`资金方向反了（${coin.why.slice(0,50)}），锁一半利润`,stop:lock(.5)!}
        :{act:"EXIT",code:"LIVING_INTENT_GONE",why:`跟进的理由没了：${coin.why.slice(0,70)}`};
      if((coin.emotion==="FOMO"||coin.emotion==="BLOWOFF")&&coin.crowd===side&&gain>2*input.cost){const st=lock(.6);if(st)return{act:"GUARD",code:"LIVING_INTENT_GREED_LOCK",why:"大家开始追了（贪婪），把止损抬到锁住六成利润",stop:st};}
      const fresh=(f.oi15??0)>=-.003;
      return{act:"HOLD",code:"",why:fresh?`持有：${side==="LONG"?"多":"空"}头资金还在（持仓量 15分钟 ${f.oi15==null?"—":pct(f.oi15)}），没有人反向砸`:"持有：资金在休息，没有反向证据"};
    }
    case "flush-rebound":{
      if(coin.capital==="SUPPLY"&&coin.strength>=.4)return{act:"EXIT",code:"LIVING_INTENT_GONE",why:`又有新空在进（持仓量 ${pct(f.oi15??0)}，价格 ${pct(f.p15??0)}），反弹理由没了`};
      if((coin.emotion==="PANIC"&&coin.actor==="SHORT")||(coin.emotion==="FOMO"&&coin.crowd==="LONG")){const st=lock(.6);if(st)return{act:"GUARD",code:"LIVING_INTENT_GREED_LOCK",why:"反弹已经变成逼空/追涨，锁住六成利润",stop:st};}
      return{act:"HOLD",code:"",why:"持有：恐慌后的修复还在，没出现新的空头"};
    }
    case "squeeze-fade":{
      if(coin.capital==="DEMAND"&&coin.strength>=.4)return{act:"EXIT",code:"LIVING_INTENT_GONE",why:`出现了真买盘（持仓量 ${pct(f.oi15??0)} 跟着涨），逼空不只是回补，平掉`};
      if(coin.emotion==="PANIC"&&coin.actor==="LONG"){const st=lock(.6);if(st)return{act:"GUARD",code:"LIVING_INTENT_FEAR_LOCK",why:"回落已经变成多头踩踏，锁住六成利润",stop:st};}
      return{act:"HOLD",code:"",why:"持有：回补停了以后没有新买盘接"};
    }
    case "crowd-fade":case "crowd-break":{
      const crowdSide:Side=side==="LONG"?"SHORT":"LONG";
      const crowdWinning=crowdSide==="LONG"?coin.capital==="DEMAND"&&(f.p15??0)>0:coin.capital==="SUPPLY"&&(f.p15??0)<0;
      if(crowdWinning&&coin.strength>=.5)return{act:"EXIT",code:"LIVING_INTENT_GONE",why:"拥挤的一边又赢回来了（新仓跟着价格走），平掉"};
      const unwound=(f.oi60??0)<=-.03&&Math.abs(f.funding??0)<INTENT.fundingHot*.5;
      if(unwound&&gain>input.cost)return{act:"EXIT",code:"LIVING_INTENT_DONE",why:`拥挤已经解开（持仓量 1小时 ${pct(f.oi60??0)}，资金费回到正常），落袋`};
      return{act:"HOLD",code:"",why:`持有：${crowdSide==="LONG"?"多":"空"}头还挤着没走完（持仓量 1小时 ${f.oi60==null?"—":pct(f.oi60)}）`};
    }
    case "absorb-revert":{
      if(f.rangePos!=null&&(side==="LONG"?f.rangePos>=.5:f.rangePos<=.5)&&gain>input.cost)return{act:"EXIT",code:"LIVING_INTENT_DONE",why:"回到区间中部，被吸收的那一边已经回归，落袋"};
      const pushOn=side==="LONG"?(f.taker5??0)<=-.3&&(f.p5??0)<-.002:(f.taker5??0)>=.3&&(f.p5??0)>.002;
      if(pushOn)return{act:"EXIT",code:"LIVING_INTENT_GONE",why:"接盘的人撤了：主动单还在砸，价格开始让步"};
      return{act:"HOLD",code:"",why:"持有：边缘还有人接，价格在回归"};
    }
  }
  if(input.ageMin>=1.5*input.holdMin)return{act:"EXIT",code:"LIVING_THESIS_TIMEOUT",why:`拿到计划时长 ${input.holdMin} 分钟的 1.5 倍`};
  return{act:"HOLD",code:"",why:"持有"};
}
/** Zone + invalidation for a v2 trade (location step). Null = no sensible position. */
export function planIntent(pb:IntentPlaybook,side:Side,ci:CoinIntent,rows5:MidBar[],rows1:MidBar[]):{lo:number;hi:number;inv:number;target:number|null;ref:number|null;hold:number}|null{
  const f=ci.f,A=f.atr5,last=f.last;if(!A||!(A>0)||last==null||rows5.length<12)return null;
  const s=d(side),w1=rows1.slice(-60),hi60=w1.length?Math.max(...w1.map(r=>r.high)):last,lo60=w1.length?Math.min(...w1.map(r=>r.low)):last;
  switch(pb){
    case "follow":{
      const w=rows5.slice(-24),up=side==="LONG",ext=up?Math.max(...w.map(x=>x.high)):Math.min(...w.map(x=>x.low)),ei=w.findIndex(x=>(up?x.high:x.low)===ext);
      const before=w.slice(0,ei+1),start=up?Math.min(...before.map(x=>x.low)):Math.max(...before.map(x=>x.high)),leg=Math.abs(ext-start);if(!(leg>0))return null;
      const a=ext-s*.5*leg,b=ext-s*.25*leg;// shallow pullback in a real-money move
      return{lo:Math.min(a,b),hi:Math.max(a,b),inv:(up?Math.min(a,b):Math.max(a,b))-s*.6*A,target:ext,ref:start,hold:120};
    }
    case "flush-rebound":return{lo:lo60,hi:lo60+.8*A,inv:lo60-.4*A,target:null,ref:lo60,hold:90};
    case "squeeze-fade":return{lo:hi60-.8*A,hi:hi60,inv:hi60+.4*A,target:null,ref:hi60,hold:90};
    case "crowd-fade":return side==="SHORT"?{lo:hi60-1*A,hi:hi60,inv:hi60+.4*A,target:null,ref:hi60,hold:180}:{lo:lo60,hi:lo60+1*A,inv:lo60-.4*A,target:null,ref:lo60,hold:180};
    case "crowd-break":{
      const lvl=side==="SHORT"?f.rangeLo:f.rangeHi;if(lvl==null)return null;
      return{lo:lvl-.4*A,hi:lvl+.4*A,inv:lvl+s*-.8*A,target:null,ref:lvl,hold:180};
    }
    case "absorb-revert":{
      const edge=side==="LONG"?f.rangeLo:f.rangeHi;if(edge==null||f.rangeHi==null||f.rangeLo==null)return null;
      return{lo:side==="LONG"?edge-.3*A:edge-.4*A,hi:side==="LONG"?edge+.4*A:edge+.3*A,inv:edge-s*.6*A,target:(f.rangeHi+f.rangeLo)/2,ref:edge,hold:120};
    }
  }
}
export {r6};
