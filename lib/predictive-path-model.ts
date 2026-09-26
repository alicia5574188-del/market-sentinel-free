import {PREDICTIVE_PATH_POLICY,PREDICTIVE_PATH_VERSION,
  type PredictiveFeatureVector,type PredictivePathForecast,type PredictiveQuote,type PredictiveSide} from "./predictive-path-types.ts";

const EPS=1e-12;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,Number.isFinite(v)?v:0));
const sigmoid=(x:number)=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
const tanh=(x:number)=>Math.tanh(clamp(x,-8,8));

function accessor(feature:PredictiveFeatureVector){
  const index=new Map(feature.names.map((name,i)=>[name,i]));
  return(name:string,fallback=0)=>{const i=index.get(name);return i==null?fallback:(feature.values[i]??fallback);};
}
function impliedUpProbability(mean:number,sigma:number){
  if(sigma<=EPS)return mean>0?.99:mean<0?.01:.5;
  return clamp(sigmoid(1.702*mean/sigma),.01,.99);
}
function firstTouchProbability(muPerBar:number,sigmaPerBar:number,target:number,risk:number,bars:number){
  const a=Math.max(target,1e-6),b=Math.max(risk,1e-6),variance=Math.max(sigmaPerBar*sigmaPerBar,1e-10);
  let eventual:number;
  if(Math.abs(muPerBar)<1e-8)eventual=b/(a+b);
  else{
    const n=1-Math.exp(clamp(-2*muPerBar*b/variance,-40,40)),
      d=1-Math.exp(clamp(-2*muPerBar*(a+b)/variance,-40,40));
    eventual=Math.abs(d)>1e-9?n/d:b/(a+b);
  }
  eventual=clamp(eventual,.02,.98);
  const sigma=Math.max(sigmaPerBar*Math.sqrt(Math.max(1,bars)),1e-6),
    directionalReach=impliedUpProbability(muPerBar*bars-a,sigma),
    neutralReach=clamp(.25+.75*sigmoid((sigma-a)*160),.15,.95),
    reach=clamp(.55*directionalReach+.45*neutralReach,.1,.95);
  return clamp(.5+(eventual-.5)*reach,.05,.95);
}
function evidence(feature:PredictiveFeatureVector){
  const g=accessor(feature),rv=Math.max(Math.abs(g("rv_24")),Math.abs(g("atr14"))*.75,.001),
    ret3=g("ret_3"),ret6=g("ret_6"),ret12=g("ret_12"),ret24=g("ret_24"),
    eff12=clamp(g("eff_12"),0,1),eff24=clamp(g("eff_24"),0,1),
    slope12=g("slope_12"),slope24=g("slope_24"),slope48=g("slope_48"),
    price=clamp(.28*tanh(ret3/(rv*.7))+.28*tanh(ret6/(rv*1.1))+.24*tanh(ret12/(rv*1.5))
      +.20*tanh(ret24/(rv*2.1)),-1,1),
    trend=clamp(.28*tanh(slope12/(rv*.8))+.32*tanh(slope24/(rv*.9))+.20*tanh(slope48/(rv))
      +.10*tanh(g("dmi_spread")*3)+.10*tanh(g("macd_hist_norm")/Math.max(rv*.35,1e-5)),-1,1),
    location=clamp(.25*tanh(g("ema21_gap")/Math.max(rv*.8,1e-5))+.20*tanh(g("ema55_gap")/Math.max(rv,1e-5))
      +.15*tanh(g("vwap20_gap")/Math.max(rv*.8,1e-5))+.15*tanh(g("ichimoku_cloud_gap")/Math.max(rv,1e-5))
      +.15*tanh(g("donchian_pos")*2)+.10*tanh(g("cci20")),-1,1),
    technical=clamp(.55*trend+.45*location,-1,1),
    oi=g("oi_change"),funding=g("funding_rate"),basis=g("basis_rate"),
    taker=tanh(g("taker_lsr_log")),account=tanh(g("account_lsr_log")),top=tanh(g("top_lsr_log")),
    priceOi=tanh(g("ret12_x_oi")/Math.max(rv*.03,1e-6)),
    crowding=clamp(.55*tanh(funding/.001)+.45*tanh(basis/.006),-1,1),
    derivatives=clamp(.42*priceOi+.22*taker+.10*account+.10*top-.16*crowding,-1,1),
    liq=clamp(.70*tanh(g("liq_imbalance")*1.5)+.15*tanh(g("liq_short_rate")/.01)-.15*tanh(g("liq_long_rate")/.01),-1,1),
    sourceBreadth=clamp(g("source_breadth"),-1,1),sourceAgreement=clamp(g("source_agreement")+.5,0,1),
    shortMove=tanh(g("source_short_move")/.0015),sourceDisagreement=Math.max(0,g("source_disagreement")),
    multiVenue=clamp((.65*sourceBreadth+.35*shortMove)*(.55+.45*sourceAgreement),-1,1),
    context=clamp(.32*tanh(g("market_breadth")*1.5)+.23*tanh(g("btc_60m")/.015)+.18*tanh(g("eth_60m")/.018)
      +.15*tanh(g("btc_15m")/.007)+.12*tanh(g("eth_15m")/.009),-1,1),
    autocorr=clamp(.65*g("autocorr1")+.35*g("autocorr3"),-1,1),
    varianceRatio=clamp(g("variance_ratio3"),-1,1),entropy=clamp(g("sign_entropy"),0,1),
    persistence=clamp(.38+.25*(eff12+eff24)/2+.18*Math.max(0,autocorr)+.12*Math.max(0,varianceRatio)-.18*entropy,.15,.92),
    sourceCount=Math.round(clamp(g("source_count"),0,1)*5),
    uncertainty=clamp(1.15+.35*entropy+.35*Math.min(1,sourceDisagreement/.006)+.20*(sourceCount<2?1:0)
      -.25*(eff12+eff24)/2,0.65,2.1);
  return{price,technical,derivatives,liquidation:liq,multiVenue,context,persistence,uncertainty,rv,sourceCount,
    sourceBreadth,sourceAgreement,sourceDisagreement,shortMove};
}

function signWithBand(value:number,band:number){return value>band?1:value<-band?-1:0;}
function robustMedian(values:number[]){const rows=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!rows.length)return 0;
  const m=Math.floor(rows.length/2);return rows.length%2?rows[m]!:(rows[m-1]!+rows[m]!)/2;}
function causalDirectionSpine(g:(name:string,fallback?:number)=>number,e:ReturnType<typeof evidence>){
  const rv=Math.max(e.rv,.001),components=[
    {v:g("ret_12"),band:Math.max(.0022,rv*.32)},
    {v:g("ret_24"),band:Math.max(.0035,rv*.46)},
    {v:g("ret_48"),band:Math.max(.0050,rv*.62)},
    {v:g("slope_24"),band:Math.max(.0030,rv*.40)},
    {v:g("slope_48"),band:Math.max(.0042,rv*.52)},
    {v:g("ema21_55"),band:Math.max(.0012,rv*.16)},
    {v:g("vwap48_gap"),band:Math.max(.0025,rv*.32)},
    {v:g("dmi_spread"),band:.035},
  ],votes=components.map(x=>signWithBand(x.v,x.band)),positive=votes.filter(x=>x>0).length,negative=votes.filter(x=>x<0).length,
    side:PredictiveSide|null=positive>=6&&negative<=1?"LONG":negative>=6&&positive<=1?"SHORT":null;
  if(!side)return null;
  const d=side==="LONG"?1:-1,eff24=clamp(g("eff_24"),0,1),eff48=clamp(g("eff_48"),0,1),adx=clamp(g("adx14"),0,1),
    entropy=clamp(g("sign_entropy"),0,1),continuity=clamp(.42*eff24+.34*eff48+.16*adx+.08*(1-entropy),0,1),
    aligned=side==="LONG"?positive:negative,
    normalized=components.map(x=>clamp(d*x.v/Math.max(x.band,1e-9),0,3)),
    magnitude=clamp(robustMedian(normalized)/2,0,1),
    technicalSupport=d*e.technical,multiSupport=d*e.multiVenue,derivativeSupport=d*e.derivatives,contextSupport=d*e.context,
    hardVeto=continuity<.23||technicalSupport<.02||multiSupport<-.22||derivativeSupport<-.72||contextSupport<-.72;
  if(hardVeto)return null;
  const weakestIndependent=Math.min(clamp((technicalSupport+.2)/1.2,0,1),clamp((multiSupport+.3)/1.3,0,1)),
    confidence=clamp(.50+.16*((aligned-6)/2)+.14*continuity+.10*magnitude+.06*weakestIndependent
      +.04*clamp((derivativeSupport+.5)/1.5,0,1),.50,.88),
    slowPerBar=robustMedian([
      g("ret_12")/12,g("ret_24")/24,g("ret_48")/48,g("slope_24")/24,g("slope_48")/48,
    ]);
  return{side,d,aligned,continuity,magnitude,confidence,slowPerBar,technicalSupport,multiSupport,derivativeSupport,contextSupport};
}

export function forecastCausalPath(feature:PredictiveFeatureVector,quote?:PredictiveQuote):PredictivePathForecast{
  const g=accessor(feature),e=evidence(feature),spine=causalDirectionSpine(g,e),
    sigma5=Math.max(e.rv/Math.sqrt(24),g("atr14")*.42,.00045),
    persistence=spine?.continuity??clamp(e.persistence*.55,0,.5),
    mu5=spine?clamp(spine.slowPerBar*(.48+.62*persistence),-sigma5*1.25,sigma5*1.25):0,
    projected=(bars:number)=>{
      const horizonDamp=bars<=3?.76:bars<=6?.84:bars<=12?.92:.86,
        mean=mu5*bars*horizonDamp,sigma=sigma5*Math.sqrt(bars)*e.uncertainty,
        statistical=impliedUpProbability(mean,sigma),
        confidence=spine?.confidence??.5,
        p=spine?.side==="LONG"?Math.max(statistical,.5+Math.max(0,confidence-.5)*.72)
          :spine?.side==="SHORT"?Math.min(statistical,.5-Math.max(0,confidence-.5)*.72):.5;
      return{mean,sigma,p:clamp(p,.05,.95)};
    },
    h15=projected(3),h30=projected(6),h60=projected(12),h120=projected(24),
    longMfe=Math.max(0,h60.mean+h60.sigma*.82),longMae=Math.max(0,-h60.mean+h60.sigma*.72),
    shortMfe=Math.max(0,-h60.mean+h60.sigma*.82),shortMae=Math.max(0,h60.mean+h60.sigma*.72),
    atr=Math.max(g("atr14"),.001),atrSlow=Math.max(g("atr28"),.001),normalAtr=Math.max(.001,Math.min(atr,atrSlow*1.12)),
    targetBarrier=clamp(Math.max(.008,normalAtr*1.15),.008,.02),riskBarrier=clamp(Math.max(.0045,normalAtr*.65),.0045,.012),
    longTouch=firstTouchProbability(mu5,sigma5,targetBarrier,riskBarrier,12),
    shortTouch=firstTouchProbability(-mu5,sigma5,targetBarrier,riskBarrier,12),
    overextension=clamp(.30*tanh(g("boll_z"))+.22*tanh(g("vwap20_gap")/Math.max(normalAtr*.75,1e-5))
      +.18*tanh(g("ema21_gap")/Math.max(normalAtr,.0001))+.16*tanh(g("donchian_pos")*2)+.14*tanh(g("rsi14")),-1,1),
    fastRet1=g("ret_1"),fastRet3=g("ret_3"),fastRet6=g("ret_6"),
    shortPressure=tanh(fastRet1/Math.max(normalAtr*.45,1e-5)),
    chaseUp=Math.max(0,fastRet3-normalAtr*1.15),chaseDown=Math.max(0,-fastRet3-normalAtr*1.15),
    longRegret=Math.max(0,(Math.max(0,overextension)*.58+Math.max(0,-shortPressure)*.18)*normalAtr+chaseUp*.85),
    shortRegret=Math.max(0,(Math.max(0,-overextension)*.58+Math.max(0,shortPressure)*.18)*normalAtr+chaseDown*.85),
    longNet=h60.mean-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost,shortNet=-h60.mean-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost,
    rawSide=spine?.side??null,sideSign=rawSide==="LONG"?1:rawSide==="SHORT"?-1:0,
    selected=rawSide==="LONG"?{p:spine!.confidence,touch:longTouch,regret:longRegret,net:longNet,mfe:longMfe,mae:longMae}
      :rawSide==="SHORT"?{p:spine!.confidence,touch:shortTouch,regret:shortRegret,net:shortNet,mfe:shortMfe,mae:shortMae}:null,
    sourceCount=quote?.sourceCount??e.sourceCount,disagreementRate=quote?.disagreementRate??e.sourceDisagreement,
    agreement=quote?.directionalAgreement??e.sourceAgreement,breadth=quote?.sourceBreadth??e.sourceBreadth,
    signedRet1=sideSign*fastRet1,signedRet3=sideSign*fastRet3,signedRet6=sideSign*fastRet6,
    signedEma8=sideSign*g("ema8_gap"),signedBreadth=sideSign*breadth,
    pathSpace=selected?sideSign*h60.mean:0,
    minimumGrossPath=Math.max(.0065,PREDICTIVE_PATH_POLICY.estimatedRoundTripCost*3.2,normalAtr*.90),
    regretMax=clamp(normalAtr*.30,.0010,.0042),
    timingReady=!!selected&&signedRet1>=-normalAtr*.12&&signedRet1<=normalAtr*.72
      &&signedRet3<=normalAtr*1.15&&signedRet6<=normalAtr*1.90&&signedEma8<=normalAtr*.90,
    independentReady=!!spine&&spine.technicalSupport>=.08&&spine.multiSupport>=-.04&&spine.derivativeSupport>=-.40
      &&spine.contextSupport>=-.48,
    multiReady=sourceCount>=PREDICTIVE_PATH_POLICY.minSources&&disagreementRate<=PREDICTIVE_PATH_POLICY.maxDisagreement
      &&signedBreadth>=0&&agreement>=.50,
    directionReady=!!spine&&spine.confidence>=PREDICTIVE_PATH_POLICY.directionAcquire&&spine.continuity>=.26,
    touchReady=!!selected&&selected.touch>=PREDICTIVE_PATH_POLICY.minTouch,
    regretReady=!!selected&&selected.regret<=regretMax,
    edgeReady=!!selected&&selected.net>=PREDICTIVE_PATH_POLICY.minimumNetEdge&&pathSpace>=minimumGrossPath
      &&selected.mfe>=Math.max(.008,selected.mae*1.45),
    enterNow=!!rawSide&&directionReady&&independentReady&&multiReady&&timingReady&&touchReady&&regretReady&&edgeReady,
    entryQuality=selected?Math.min(
      clamp((selected.p-.5)/.28,0,1),clamp(selected.touch-.50,.0,.24)/.24,
      clamp(pathSpace/Math.max(minimumGrossPath,1e-6),0,1),clamp(1-selected.regret/Math.max(regretMax,1e-6),0,1),
      clamp((spine!.continuity-.20)/.45,0,1)
    ):0,
    confidence=spine?.confidence??.35,
    waitReason=enterNow?null:!spine?"长期方向证据未形成一致脊柱"
      :!directionReady?"长期方向持续性不足":!independentReady?"独立证据与主方向不一致"
      :!multiReady?"多市场没有同步接受该方向":!edgeReady?"未来60分钟成本后空间不足"
      :!timingReady?"方向成立但当前5分钟位置不适合追入":!touchReady?"目标先于风险的路径优势不足"
      :!regretReady?"当前位置过度延伸，等待更优入场":"等待确认",
    spinePersistence=spine?.continuity??0;
  return{version:PREDICTIVE_PATH_VERSION,symbol:feature.symbol,at:feature.decisionAt,lastBarTime:0,
    upProbability:{m15:h15.p,m30:h30.p,m60:h60.p,m120:h120.p},
    expectedReturn:{m15:h15.mean,m30:h30.mean,m60:h60.mean,m120:h120.mean},
    long:{mfe60:longMfe,mae60:longMae,targetBeforeRisk60:longTouch,entryRegret10:longRegret,
      netEv60:.62*longNet+.25*(longMfe-longMae-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost)+.13*(longTouch-.5)*.01},
    short:{mfe60:shortMfe,mae60:shortMae,targetBeforeRisk60:shortTouch,entryRegret10:shortRegret,
      netEv60:.62*shortNet+.25*(shortMfe-shortMae-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost)+.13*(shortTouch-.5)*.01},
    crossVenue:{sourceCount,agreement,breadth,disagreementRate},
    evidence:{price:e.price,technical:e.technical,derivatives:e.derivatives,liquidation:e.liquidation,
      multiVenue:e.multiVenue,context:e.context,persistence:spinePersistence,uncertainty:e.uncertainty},
    rawSide,stableSide:null,directionProbability:spine?.confidence??.5,entryQuality,enterNow,waitReason,confidence};
}
