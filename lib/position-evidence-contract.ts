import type {MarketSymbolState} from "./market-intelligence-engine.ts";

/** One score scale from fill to exit. These records are bounded per position. */
export const POSITION_EVIDENCE_CONTRACT="position-evidence-v2";
const BAR_MS=300_000;
const clip=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export type PositionBaseline={
  version:typeof POSITION_EVIDENCE_CONTRACT;
  source:"ENTRY"|"RECOVERED";
  at:number;
  score:number;
};
export type PositionReviewMemory={
  version:typeof POSITION_EVIDENCE_CONTRACT;
  since:number|null;
  confirmations:number;
  lastBarAt:number;
  recoverySince:number|null;
};

export function positionAdvantage(side:"LONG"|"SHORT",state?:MarketSymbolState){
  if(!state)return null;
  const d=side==="LONG"?1:-1,same=side==="LONG"?state.longScore:state.shortScore,
    path=side==="LONG"?state.pathLong:state.pathShort,z=d*state.residualZ,pressure=d*state.venuePressure;
  if(![same,path,z,pressure].every(Number.isFinite))return null;
  return clip(same*.55+(50+z*14)*.20+path*100*.15+(50+pressure*25)*.10,0,100);
}
export function capturePositionBaseline(side:"LONG"|"SHORT",state:MarketSymbolState|undefined,now:number,
  source:PositionBaseline["source"]="ENTRY"):PositionBaseline|undefined{
  const score=positionAdvantage(side,state);
  if(score==null||!Number.isFinite(now)||now<=0)return undefined;
  return{version:POSITION_EVIDENCE_CONTRACT,source,at:now,score};
}
export function validPositionBaseline(value:PositionBaseline|undefined,now:number):value is PositionBaseline{
  return !!value&&value.version===POSITION_EVIDENCE_CONTRACT&&(value.source==="ENTRY"||value.source==="RECOVERED")
    &&Number.isFinite(value.at)&&value.at>0&&value.at<=now&&Number.isFinite(value.score)&&value.score>=0&&value.score<=100;
}

/**
 * The first concern starts an episode, not a completed candle. A later count
 * requires a distinct completed 5m candle that closed AFTER the concern began
 * and was formed entirely after entry. Receiving an already-closed candle late
 * (the ENA 00:00:08 -> 00:00:10 case) is never a second confirmation.
 * Neutral ticks retain memory. Clearing requires positive recovery evidence
 * surviving a subsequently completed candle, never just missing data.
 */
export function advancePositionReview(input:{now:number;openedAt:number;barAt:number;concern:boolean;
  recovering:boolean;dataReady:boolean;previous?:PositionReviewMemory}):PositionReviewMemory{
  const {now,openedAt}=input,p=input.previous,
    validPrior=p?.version===POSITION_EVIDENCE_CONTRACT&&Number.isFinite(p.lastBarAt)&&p.lastBarAt>=0&&p.lastBarAt<=now
      &&Number.isInteger(p.confirmations)&&p.confirmations>=0&&p.confirmations<=2
      &&(p.since==null||(Number.isFinite(p.since)&&p.since>=openedAt&&p.since<=now))
      &&(p.since==null?p.confirmations===0:p.confirmations>=1)
      &&(p.recoverySince==null||(p.since!=null&&Number.isFinite(p.recoverySince)&&p.recoverySince>=p.since&&p.recoverySince<=now)),
    prior=validPrior?p!:undefined,
    bar=Number.isFinite(input.barAt)&&input.barAt>0&&input.barAt<=now?input.barAt:0,
    next:PositionReviewMemory={version:POSITION_EVIDENCE_CONTRACT,since:prior?.since??null,
      confirmations:prior?.confirmations??0,lastBarAt:Math.max(prior?.lastBarAt??0,bar),recoverySince:prior?.recoverySince??null};
  if(!Number.isFinite(now)||!Number.isFinite(openedAt)||openedAt<=0||openedAt>now)return next;
  const newBar=bar>0&&bar>(prior?.lastBarAt??0),fullPostEntryBar=bar-BAR_MS>=openedAt;
  if(!input.dataReady){next.recoverySince=null;return next;}
  if(input.concern){
    next.recoverySince=null;
    if(next.since==null){next.since=now;next.confirmations=1;}
    else if(newBar&&fullPostEntryBar&&bar>next.since)next.confirmations=Math.min(2,next.confirmations+1);
  }else if(next.since!=null){
    if(!input.recovering)next.recoverySince=null;
    else if(next.recoverySince==null)next.recoverySince=now;
    else if(newBar&&fullPostEntryBar&&bar>next.recoverySince){
      next.since=null;next.confirmations=0;next.recoverySince=null;
    }
  }
  return next;
}
