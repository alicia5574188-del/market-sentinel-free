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

export function forecastCausalPath(feature:PredictiveFeatureVector,quote?:PredictiveQuote):PredictivePathForecast{
  const g=accessor(feature),e=evidence(feature),
    combined=clamp(.31*e.price+.20*e.technical+.18*e.derivatives+.08*e.liquidation+.13*e.multiVenue+.10*e.context,-1,1),
    rawDrift=.36*g("ret_3")/3+.29*g("ret_6")/6+.21*g("ret_12")/12+.14*g("ret_24")/24,
    sigma5=Math.max(e.rv/Math.sqrt(24),g("atr14")*.42,.00045),
    evidenceDrift=sigma5*combined*.62,
    meanReversionPenalty=clamp(-Math.min(0,g("autocorr1"))*.22-Math.min(0,g("variance_ratio3"))*.16,0,.30),
    persistence=clamp(e.persistence-meanReversionPenalty,.12,.92),
    mu5=clamp(rawDrift*(.45+.35*persistence)+evidenceDrift*(.35+.30*persistence),-sigma5*1.8,sigma5*1.8),
    projected=(bars:number)=>{
      const horizonDamp=bars<=3?1:bars<=6?.94:bars<=12?.86:.74,
        continuation=.62+.38*persistence,
        mean=mu5*bars*horizonDamp*continuation,
        sigma=sigma5*Math.sqrt(bars)*e.uncertainty;
      return{mean,sigma,p:impliedUpProbability(mean,sigma)};
    },
    h15=projected(3),h30=projected(6),h60=projected(12),h120=projected(24),
    longMfe=Math.max(0,h60.mean+h60.sigma*.88),
    longMae=Math.max(0,-h60.mean+h60.sigma*.70),
    shortMfe=Math.max(0,-h60.mean+h60.sigma*.88),
    shortMae=Math.max(0,h60.mean+h60.sigma*.70),
    atr=Math.max(g("atr14"),.001),
    targetBarrier=clamp(Math.max(.008,atr*1.15),.008,.02),
    riskBarrier=clamp(Math.max(.0045,atr*.65),.0045,.012),
    longTouch=firstTouchProbability(mu5,sigma5,targetBarrier,riskBarrier,12),
    shortTouch=firstTouchProbability(-mu5,sigma5,targetBarrier,riskBarrier,12),
    overextension=clamp(.32*tanh(g("boll_z"))+.22*tanh(g("vwap20_gap")/Math.max(atr*.8,1e-5))
      +.18*tanh(g("ema21_gap")/Math.max(atr,.0001))+.15*tanh(g("donchian_pos")*2)+.13*tanh(g("rsi14")),-1,1),
    shortPressure=tanh(g("ret_1")/Math.max(atr*.45,1e-5)),
    longRegret=Math.max(0,(Math.max(0,overextension)*.46+Math.max(0,-shortPressure)*.22)*atr),
    shortRegret=Math.max(0,(Math.max(0,-overextension)*.46+Math.max(0,shortPressure)*.22)*atr),
    longNet=h60.mean-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost,
    shortNet=-h60.mean-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost,
    slowLong=.18*h30.p+.47*h60.p+.35*h120.p,
    slowShort=1-slowLong,
    rawSide:PredictiveSide|null=slowLong>=PREDICTIVE_PATH_POLICY.directionAcquire?"LONG"
      :slowShort>=PREDICTIVE_PATH_POLICY.directionAcquire?"SHORT":null,
    selected=rawSide==="LONG"
      ?{p:slowLong,touch:longTouch,regret:longRegret,net:longNet}
      :rawSide==="SHORT"?{p:slowShort,touch:shortTouch,regret:shortRegret,net:shortNet}:null,
    regretMax=clamp(atr*.42,.0012,.0065),
    sourceCount=quote?.sourceCount??e.sourceCount,
    disagreementRate=quote?.disagreementRate??e.sourceDisagreement,
    agreement=quote?.directionalAgreement??e.sourceAgreement,
    breadth=quote?.sourceBreadth??e.sourceBreadth,
    multiReady=sourceCount>=PREDICTIVE_PATH_POLICY.minSources&&disagreementRate<=PREDICTIVE_PATH_POLICY.maxDisagreement,
    directionReady=!!selected&&selected.p>=PREDICTIVE_PATH_POLICY.directionAcquire,
    touchReady=!!selected&&selected.touch>=PREDICTIVE_PATH_POLICY.minTouch,
    regretReady=!!selected&&selected.regret<=regretMax,
    edgeReady=!!selected&&selected.net>=PREDICTIVE_PATH_POLICY.minimumNetEdge,
    entryQuality=selected?clamp(.42*selected.p+.25*selected.touch+.20*(1-selected.regret/Math.max(regretMax,1e-6))
      +.13*(.5+.5*agreement),0,1):0,
    confidence=selected?clamp(.56*selected.p+.20*selected.touch+.14*(.5+.5*agreement)+.10*(1-Math.min(1,disagreementRate/.012)),0,1):.35,
    enterNow=!!rawSide&&directionReady&&touchReady&&regretReady&&edgeReady&&multiReady,
    waitReason=enterNow?null:!rawSide?"60/120分钟方向优势不足"
      :!edgeReady?"成本后剩余路径不足"
      :!touchReady?"目标先于风险的路径优势不足"
      :!regretReady?"当前位置过度延伸，等待更优入场"
      :sourceCount<PREDICTIVE_PATH_POLICY.minSources?"多数据源不足"
      :disagreementRate>PREDICTIVE_PATH_POLICY.maxDisagreement?"多市场分歧过大":"等待确认",
    lastBarTime=0;
  return{version:PREDICTIVE_PATH_VERSION,symbol:feature.symbol,at:feature.decisionAt,lastBarTime,
    upProbability:{m15:h15.p,m30:h30.p,m60:h60.p,m120:h120.p},
    expectedReturn:{m15:h15.mean,m30:h30.mean,m60:h60.mean,m120:h120.mean},
    long:{mfe60:longMfe,mae60:longMae,targetBeforeRisk60:longTouch,entryRegret10:longRegret,
      netEv60:.55*longNet+.30*(longMfe-longMae-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost)+.15*(longTouch-.5)*.01},
    short:{mfe60:shortMfe,mae60:shortMae,targetBeforeRisk60:shortTouch,entryRegret10:shortRegret,
      netEv60:.55*shortNet+.30*(shortMfe-shortMae-PREDICTIVE_PATH_POLICY.estimatedRoundTripCost)+.15*(shortTouch-.5)*.01},
    crossVenue:{sourceCount,agreement,breadth,disagreementRate},
    evidence:{price:e.price,technical:e.technical,derivatives:e.derivatives,liquidation:e.liquidation,
      multiVenue:e.multiVenue,context:e.context,persistence:e.persistence,uncertainty:e.uncertainty},
    rawSide,stableSide:null,directionProbability:selected?.p??.5,entryQuality,enterNow,waitReason,confidence};
}
