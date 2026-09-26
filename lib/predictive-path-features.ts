import {PREDICTIVE_PATH_VERSION,type PredictiveAncillary,type PredictiveBar,type PredictiveFeatureVector,type PredictiveQuote} from "./predictive-path-types.ts";

const EPS=1e-12;
const clamp=(v:number,a=-10,b=10)=>Math.max(a,Math.min(b,Number.isFinite(v)?v:0));
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const std=(v:number[])=>{if(v.length<2)return 0;const m=mean(v);return Math.sqrt(mean(v.map(x=>(x-m)**2)));};
const tail=<T>(v:T[],n:number)=>v.slice(Math.max(0,v.length-n));
function ema(v:number[],period:number){if(!v.length)return 0;const a=2/(period+1);let x=v[0]!;for(let i=1;i<v.length;i++)x=a*v[i]!+(1-a)*x;return x;}
function slope(v:number[]){if(v.length<3)return 0;const n=v.length,mx=(n-1)/2,my=mean(v);let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-mx)*(v[i]!-my);den+=(i-mx)**2;}return den?num/den:0;}
function rsi(v:number[],period:number){const d=tail(v,period+1);if(d.length<2)return 50;let up=0,down=0;
  for(let i=1;i<d.length;i++){const x=d[i]!-d[i-1]!;if(x>0)up+=x;else down-=x;}if(down<=EPS)return up>0?100:50;const rs=up/down;return 100-100/(1+rs);}
function atr(rows:PredictiveBar[],period:number){const r=tail(rows,period+1);if(r.length<2)return 0;const tr:number[]=[];
  for(let i=1;i<r.length;i++){const p=r[i-1]!,x=r[i]!;tr.push(Math.max(x.high-x.low,Math.abs(x.high-p.close),Math.abs(x.low-p.close)));}return mean(tr);}
function pathEfficiency(v:number[],period:number){const r=tail(v,period+1);if(r.length<2)return 0;const net=Math.abs(r.at(-1)!-r[0]!),
  path=r.slice(1).reduce((n,x,i)=>n+Math.abs(x-r[i]!),0);return path>EPS?net/path:0;}
function cci(rows:PredictiveBar[],period=20){const r=tail(rows,period),tp=r.map(x=>(x.high+x.low+x.close)/3),m=mean(tp),md=mean(tp.map(x=>Math.abs(x-m)));
  return md>EPS?(tp.at(-1)!-m)/(.015*md):0;}
function mfi(rows:PredictiveBar[],period=14){const r=tail(rows,period+1);if(r.length<2)return 50;let pos=0,neg=0;
  for(let i=1;i<r.length;i++){const a=(r[i-1]!.high+r[i-1]!.low+r[i-1]!.close)/3,b=(r[i]!.high+r[i]!.low+r[i]!.close)/3,flow=b*r[i]!.volume;
    if(b>a)pos+=flow;else if(b<a)neg+=flow;}if(neg<=EPS)return pos>0?100:50;return 100-100/(1+pos/neg);}
function cmf(rows:PredictiveBar[],period=20){const r=tail(rows,period);let num=0,den=0;for(const x of r){const range=Math.max(x.high-x.low,EPS);
  num+=(((x.close-x.low)-(x.high-x.close))/range)*x.volume;den+=x.volume;}return den?num/den:0;}
function obvSlope(rows:PredictiveBar[],period=20){const r=tail(rows,period+1);if(r.length<2)return 0;let obv=0;const a=[0];
  for(let i=1;i<r.length;i++){obv+=Math.sign(r[i]!.close-r[i-1]!.close)*r[i]!.volume;a.push(obv);}const denom=Math.max(mean(r.map(x=>x.volume)),EPS);return slope(a)/denom;}
function dmiAdx(rows:PredictiveBar[],period=14){const r=tail(rows,period+1);if(r.length<3)return{plus:0,minus:0,adx:0};let tr=0,plus=0,minus=0;
  const dx:number[]=[];for(let i=1;i<r.length;i++){const a=r[i-1]!,b=r[i]!,t=Math.max(b.high-b.low,Math.abs(b.high-a.close),Math.abs(b.low-a.close)),
    up=b.high-a.high,down=a.low-b.low,p=up>down&&up>0?up:0,m=down>up&&down>0?down:0;tr+=t;plus+=p;minus+=m;
    const pdi=tr>EPS?plus/tr:0,mdi=tr>EPS?minus/tr:0;dx.push((pdi+mdi)>EPS?Math.abs(pdi-mdi)/(pdi+mdi):0);}
  const pdi=tr>EPS?plus/tr:0,mdi=tr>EPS?minus/tr:0;return{plus:pdi,minus:mdi,adx:mean(tail(dx,period))};}
function autocorr(v:number[],lag=1){if(v.length<=lag+2)return 0;const a=v.slice(lag),b=v.slice(0,-lag),ma=mean(a),mb=mean(b),
  num=a.reduce((s,x,i)=>s+(x-ma)*(b[i]!-mb),0),da=Math.sqrt(a.reduce((s,x)=>s+(x-ma)**2,0)),db=Math.sqrt(b.reduce((s,x)=>s+(x-mb)**2,0));
  return da*db>EPS?num/(da*db):0;}
function signEntropy(v:number[]){if(!v.length)return 0;const p=v.filter(x=>x>0).length/v.length,n=v.filter(x=>x<0).length/v.length,z=Math.max(0,1-p-n);
  return-[p,n,z].filter(x=>x>0).reduce((s,x)=>s+x*Math.log(x),0)/Math.log(3);}
function weightedPrice(rows:PredictiveBar[]){let num=0,den=0;for(const x of rows){const tp=(x.high+x.low+x.close)/3,w=Math.max(0,x.volume);num+=tp*w;den+=w;}return den>EPS?num/den:(rows.at(-1)?.close??0);}
function varianceRatio(returns:number[],k=3){if(returns.length<k*4)return 1;const one=std(returns)**2;if(one<EPS)return 1;const agg:number[]=[];
  for(let i=k-1;i<returns.length;i++)agg.push(returns.slice(i-k+1,i+1).reduce((a,b)=>a+b,0));return (std(agg)**2)/(k*one);}
function add(names:string[],values:number[],groups:Record<string,number[]>,group:string,name:string,value:number){
  names.push(name);values.push(clamp(value));(groups[group]??=[]).push(names.length-1);
}

export function buildPredictiveFeatures(input:{symbol:string;decisionAt:number;bars5m:PredictiveBar[];quote?:PredictiveQuote;ancillary?:PredictiveAncillary}):PredictiveFeatureVector|null{
  const rows=input.bars5m.filter(x=>x.time>0&&x.open>0&&x.close>0&&x.low>0&&x.high>=Math.max(x.open,x.close)&&x.low<=Math.min(x.open,x.close)
    &&x.volume>=0&&[x.time,x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)).sort((a,b)=>a.time-b.time);
  if(rows.length<60)return null;
  const closes=rows.map(x=>x.close),volumes=rows.map(x=>x.volume),last=rows.at(-1)!,price=last.close,
    names:string[]=[],values:number[]=[],groups:Record<string,number[]>={};
  const ret=(n:number)=>closes.length>n?closes.at(-1)!/closes.at(-1-n)!-1:0;
  for(const n of [1,3,6,12,24,48])add(names,values,groups,"price","ret_"+n,ret(n));
  for(const n of [6,12,24,48])add(names,values,groups,"price","eff_"+n,pathEfficiency(closes,n));
  for(const n of [12,24,48]){const r=tail(closes,n);add(names,values,groups,"price","slope_"+n,slope(r)/Math.max(price,EPS)*n);
    add(names,values,groups,"price","rv_"+n,std(r.slice(1).map((x,i)=>x/r[i]!-1))*Math.sqrt(n));}
  const atr14=atr(rows,14)/price,atr28=atr(rows,28)/price;add(names,values,groups,"technical","atr14",atr14);add(names,values,groups,"technical","atr28",atr28);
  const ema8=ema(closes,8),ema21=ema(closes,21),ema55=ema(closes,55),macd=ema(closes,12)-ema(closes,26),
    histSeries=tail(closes,35).map((_,i,a)=>{const prefix=closes.slice(0,closes.length-a.length+i+1);return ema(prefix,12)-ema(prefix,26);}),
    macdSignal=ema(histSeries,9);
  add(names,values,groups,"technical","ema8_gap",price/ema8-1);add(names,values,groups,"technical","ema21_gap",price/ema21-1);
  add(names,values,groups,"technical","ema55_gap",price/ema55-1);add(names,values,groups,"technical","ema8_21",ema8/ema21-1);
  add(names,values,groups,"technical","ema21_55",ema21/ema55-1);add(names,values,groups,"technical","macd_norm",macd/price);
  add(names,values,groups,"technical","macd_hist_norm",(macd-macdSignal)/price);
  add(names,values,groups,"technical","rsi7",(rsi(closes,7)-50)/50);add(names,values,groups,"technical","rsi14",(rsi(closes,14)-50)/50);
  add(names,values,groups,"technical","rsi21",(rsi(closes,21)-50)/50);add(names,values,groups,"technical","cci20",cci(rows,20)/200);
  const r20=tail(rows,20),hi20=Math.max(...r20.map(x=>x.high)),lo20=Math.min(...r20.map(x=>x.low)),sd20=std(r20.map(x=>x.close)),ma20=mean(r20.map(x=>x.close));
  add(names,values,groups,"technical","boll_z",sd20>EPS?(price-ma20)/(2*sd20):0);
  add(names,values,groups,"technical","donchian_pos",(price-lo20)/Math.max(hi20-lo20,EPS)-.5);
  add(names,values,groups,"technical","williams_r",(hi20-price)/Math.max(hi20-lo20,EPS)-.5);
  const r14=tail(rows,14),hi14=Math.max(...r14.map(x=>x.high)),lo14=Math.min(...r14.map(x=>x.low));
  add(names,values,groups,"technical","stoch14",(price-lo14)/Math.max(hi14-lo14,EPS)-.5);
  const dmi=dmiAdx(rows,14);add(names,values,groups,"technical","dmi_plus",dmi.plus);add(names,values,groups,"technical","dmi_minus",dmi.minus);
  add(names,values,groups,"technical","adx14",dmi.adx);add(names,values,groups,"technical","dmi_spread",dmi.plus-dmi.minus);
  add(names,values,groups,"technical","boll_width",ma20>EPS?4*sd20/ma20:0);
  add(names,values,groups,"technical","keltner_pos",(price-ema(closes,20))/Math.max(2*atr(rows,20),EPS));
  const tenkanRows=tail(rows,9),kijunRows=tail(rows,26),spanBRows=tail(rows,52),
    tenkan=(Math.max(...tenkanRows.map(x=>x.high))+Math.min(...tenkanRows.map(x=>x.low)))/2,
    kijun=(Math.max(...kijunRows.map(x=>x.high))+Math.min(...kijunRows.map(x=>x.low)))/2,
    spanA=(tenkan+kijun)/2,spanB=(Math.max(...spanBRows.map(x=>x.high))+Math.min(...spanBRows.map(x=>x.low)))/2;
  add(names,values,groups,"technical","ichimoku_tenkan_gap",price/Math.max(tenkan,EPS)-1);
  add(names,values,groups,"technical","ichimoku_kijun_gap",price/Math.max(kijun,EPS)-1);
  add(names,values,groups,"technical","ichimoku_cloud_gap",price/Math.max((spanA+spanB)/2,EPS)-1);
  const vwap20=weightedPrice(r20),vwap48=weightedPrice(tail(rows,48));
  add(names,values,groups,"technical","vwap20_gap",price/Math.max(vwap20,EPS)-1);add(names,values,groups,"technical","vwap48_gap",price/Math.max(vwap48,EPS)-1);
  const vpStd=std(r20.map(x=>(x.high+x.low+x.close)/3));add(names,values,groups,"technical","volume_profile_z",vpStd>EPS?(price-vwap20)/vpStd:0);
  const rangeMid=(hi20+lo20)/2,superUpper=rangeMid+3*atr(rows,10),superLower=rangeMid-3*atr(rows,10);
  add(names,values,groups,"technical","supertrend_position",price>superUpper?1:price<superLower?-1:(price-rangeMid)/Math.max(superUpper-superLower,EPS)*2);
  const rets=tail(closes,49).slice(1).map((x,i)=>x/tail(closes,49)[i]!-1);
  add(names,values,groups,"state","autocorr1",autocorr(rets,1));add(names,values,groups,"state","autocorr3",autocorr(rets,3));
  add(names,values,groups,"state","sign_entropy",signEntropy(rets));add(names,values,groups,"state","variance_ratio3",varianceRatio(rets,3)-1);
  add(names,values,groups,"state","atr_ratio",atr28>EPS?atr14/atr28-1:0);
  add(names,values,groups,"state","range_expansion",(last.high-last.low)/Math.max(atr(rows,28),EPS)-1);
  add(names,values,groups,"flow","mfi14",(mfi(rows,14)-50)/50);add(names,values,groups,"flow","cmf20",cmf(rows,20));
  add(names,values,groups,"flow","obv_slope20",obvSlope(rows,20));
  const v20=tail(volumes,20),vm=mean(v20),vs=std(v20);add(names,values,groups,"flow","volume_z20",vs>EPS?(volumes.at(-1)!-vm)/vs:0);
  add(names,values,groups,"flow","body_atr",Math.abs(last.close-last.open)/Math.max(atr14*price,EPS));
  add(names,values,groups,"flow","close_location",(last.close-last.low)/Math.max(last.high-last.low,EPS)-.5);
  const q=input.quote,a=input.ancillary??{},mid=q?(q.bestBid+q.bestAsk)/2:price;
  add(names,values,groups,"execution","spread_rate",q?(q.bestAsk-q.bestBid)/Math.max(mid,EPS):0);
  add(names,values,groups,"multisource","source_count",(q?.sourceCount??0)/5);
  add(names,values,groups,"multisource","source_disagreement",q?.disagreementRate??0);
  add(names,values,groups,"multisource","source_breadth",q?.sourceBreadth??0);
  add(names,values,groups,"multisource","source_agreement",(q?.directionalAgreement??.5)-.5);
  add(names,values,groups,"multisource","source_short_move",q?.medianShortMove??0);
  add(names,values,groups,"derivatives","funding_rate",a.fundingRate??0);
  add(names,values,groups,"derivatives","basis_rate",a.basisRate??0);
  add(names,values,groups,"derivatives","oi_change",a.openInterestChangeRate??0);
  add(names,values,groups,"derivatives","taker_lsr_log",a.takerLongShortLog??0);
  add(names,values,groups,"derivatives","account_lsr_log",a.accountLongShortLog??0);
  add(names,values,groups,"derivatives","top_lsr_log",a.topLongShortLog??0);
  add(names,values,groups,"interaction","ret12_x_oi",ret(12)*(a.openInterestChangeRate??0));
  add(names,values,groups,"interaction","ret12_x_funding",ret(12)*(a.fundingRate??0)*100);
  add(names,values,groups,"interaction","ret12_x_basis",ret(12)*(a.basisRate??0));
  add(names,values,groups,"liquidation","liq_imbalance",a.liquidationImbalance??0);
  add(names,values,groups,"liquidation","liq_long_rate",a.liquidationLongNotionalRate??0);
  add(names,values,groups,"liquidation","liq_short_rate",a.liquidationShortNotionalRate??0);
  add(names,values,groups,"context","btc_15m",a.btcReturn15m??0);add(names,values,groups,"context","btc_60m",a.btcReturn60m??0);
  add(names,values,groups,"context","eth_15m",a.ethReturn15m??0);add(names,values,groups,"context","eth_60m",a.ethReturn60m??0);
  add(names,values,groups,"context","market_breadth",a.marketBreadth??0);
  return{version:PREDICTIVE_PATH_VERSION,symbol:input.symbol,decisionAt:input.decisionAt,names,values,groups};
}
