import { REGION_BAR_MS, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState } from "./region-lifecycle.ts";
import { type MultiTurnState, type TurnFrameState } from "./multi-turn-engine.ts";

export const ANCHOR_FLOW_VERSION="anchor-flow-v1";
export const ANCHOR_FLOW_TTL_BARS=12;

export type AnchorFlowPhase="EXTENSION"|"WAIT_RETEST"|"RETEST"|"FIRED"|"FAILED";
export type AnchorFlowState={
  version:typeof ANCHOR_FLOW_VERSION;
  symbol:string;
  regionId:string;
  side:"LONG"|"SHORT";
  boundary:"UPPER"|"LOWER";
  phase:AnchorFlowPhase;
  createdAt:number;
  expiresAt:number;
  lastProcessedAt:number;
  breakoutCompletedAt:number;
  regionConfirmedAt:number;
  regionLower:number;
  regionUpper:number;
  regionCenter:number;
  regionWidth:number;
  regionWidthRate:number;
  excursionExtreme:number;
  retestAt:number|null;
  pullbackExtreme:number|null;
  restartLevel:number|null;
  firedAt:number|null;
  failedAt:number|null;
  reason:string;
};
export type AnchorFlowEntrySignal=RegionEntrySignal&{
  entryModel:"ANCHOR_FLOW";
  contextTimeframe:"15m";
  directionFrameAt:number;
  trendFrameAt:number;
  retestAt:number;
  restartLevel:number;
  pullbackExtreme:number;
  anchorExpectedMoveRate:number;
};

const completeAt=(row:RegionCandle)=>row.time*1000+REGION_BAR_MS;
const finite=(v:number)=>Number.isFinite(v);

function higherFrameAllows(frame:TurnFrameState|undefined,side:"LONG"|"SHORT",timeframe:"15m"|"1h"){
  if(!frame?.ready)return false;
  if(frame.direction===side){
    // A higher frame is context, not an entry trigger. A temporary WATCH or a
    // newly CONFIRMED same-side state must not cancel a valid 5m location.
    return !(frame.phase==="TURNING"&&frame.turnProbability>=.68);
  }
  // Opposite higher-timeframe direction is only a veto when it is actually
  // established. A weak WATCH state can coexist with an earlier 5m turn.
  const weakOpposite=frame.phase==="WATCH"
    &&frame.directionConfidence<(timeframe==="1h"?.45:.35)
    &&frame.turnProbability<.55;
  return weakOpposite;
}
export function anchorFlowDirectionAllowed(frames:MultiTurnState["frames"]|undefined,symbol:string,side:"LONG"|"SHORT"){
  const by=frames?.[symbol];
  return higherFrameAllows(by?.["1h"],side,"1h")&&higherFrameAllows(by?.["15m"],side,"15m");
}
const keyOf=(regionId:string,side:"LONG"|"SHORT")=>`${regionId}:${side}`;

function startState(signal:RegionEntrySignal):AnchorFlowState{
  return{
    version:ANCHOR_FLOW_VERSION,symbol:signal.symbol,regionId:signal.regionId,side:signal.side,boundary:signal.boundary,
    // Two completed closes outside the region already prove displacement.
    // Do not demand another 0.3-width extension before allowing a good retest.
    phase:"WAIT_RETEST",createdAt:signal.completedAt,expiresAt:signal.completedAt+ANCHOR_FLOW_TTL_BARS*REGION_BAR_MS,
    lastProcessedAt:signal.completedAt,breakoutCompletedAt:signal.completedAt,regionConfirmedAt:signal.regionConfirmedAt,
    regionLower:signal.regionLower,regionUpper:signal.regionUpper,regionCenter:signal.regionCenter,
    regionWidth:signal.regionWidth,regionWidthRate:signal.regionWidthRate,
    excursionExtreme:signal.signalPrice,retestAt:null,pullbackExtreme:null,restartLevel:null,
    firedAt:null,failedAt:null,reason:"区域外连续收盘已确认；不追突破，只等边界附近出现可执行的5m顺向反应。"
  };
}

function fail(state:AnchorFlowState,at:number,reason:string){
  state.phase="FAILED";state.failedAt=at;state.reason=reason;
}
function signalFromRetest(input:{state:AnchorFlowState;row:RegionCandle;at:number;frames?:MultiTurnState["frames"];costRate:number}){
  const s=input.state,{row,at}=input,d=s.side==="LONG"?1:-1;
  const by=input.frames?.[s.symbol],f15=by?.["15m"],f1h=by?.["1h"];
  if(!f15||!f1h||s.retestAt==null||s.pullbackExtreme==null||s.restartLevel==null)return null;
  const stopBuffer=Math.max(s.regionWidth*.08,s.regionCenter*input.costRate*.25);
  const stopPrice=s.side==="LONG"?s.pullbackExtreme-stopBuffer:s.pullbackExtreme+stopBuffer;
  if((s.side==="LONG"&&stopPrice>=row.close)||(s.side==="SHORT"&&stopPrice<=row.close))return null;
  return {
    version:"region-lifecycle-v1",
    id:`af-${s.regionId}-${s.side}-${at}`,symbol:s.symbol,kind:"MIGRATION",side:s.side,boundary:s.boundary,
    completedAt:at,expiresAt:at+2*REGION_BAR_MS,signalPrice:row.close,stopPrice,targetPrice:null,
    regionId:s.regionId,regionConfirmedAt:s.regionConfirmedAt,regionLower:s.regionLower,regionUpper:s.regionUpper,
    regionCenter:s.regionCenter,regionWidth:s.regionWidth,regionWidthRate:s.regionWidthRate,
    reason:"AnchorFlow：高周期没有明确反向否决；5m区域外确认后回到边界附近并重新出现顺向反应。",
    entryModel:"ANCHOR_FLOW",contextTimeframe:"15m",directionFrameAt:f15.completedAt,trendFrameAt:f1h.completedAt,
    retestAt:s.retestAt,restartLevel:s.restartLevel,pullbackExtreme:s.pullbackExtreme,
    // 15m owns the executable move horizon. 1h is only a directional veto and
    // must not artificially shrink a valid 15m trade's remaining-space estimate.
    anchorExpectedMoveRate:Math.max(0,f15.expectedMoveRate),
  } as AnchorFlowEntrySignal;
}
function updateOne(input:{
  state:AnchorFlowState;rows:RegionCandle[];lifecycle?:RegionLifecycleState;frames?:MultiTurnState["frames"];
  consumed?:Record<string,number>;now:number;costRate:number;
}):AnchorFlowEntrySignal[]{
  const s=input.state,out:AnchorFlowEntrySignal[]=[];
  if(s.phase==="FIRED"||s.phase==="FAILED")return out;
  if(input.now>s.expiresAt){fail(s,input.now,"本次区域机会超过一小时仍没有形成边界优势位置；放弃，不追远。");return out;}
  if(input.consumed?.[keyOf(s.regionId,s.side)]){fail(s,input.now,"同一区域同方向已真实执行过一次；等待新成熟区域。");return out;}
  if(input.lifecycle?.zone?.id!==s.regionId){fail(s,input.now,"市场已经形成新的成熟区域；旧区域机会失效。");return out;}
  if(!anchorFlowDirectionAllowed(input.frames,s.symbol,s.side)){
    fail(s,input.now,"15m/1h已经形成明确反向状态；取消本次5m顺势机会。");return out;
  }

  const d=s.side==="LONG"?1:-1,boundary=s.side==="LONG"?s.regionUpper:s.regionLower;
  const reaccept=s.side==="LONG"?s.regionUpper-s.regionWidth*.10:s.regionLower+s.regionWidth*.10;
  const rows=input.rows.filter(row=>completeAt(row)>s.lastProcessedAt&&completeAt(row)<=input.now)
    .sort((a,b)=>a.time-b.time);
  for(const row of rows){
    const at=completeAt(row),close=row.close;
    if(![row.open,row.high,row.low,row.close,row.volume].every(finite)){s.lastProcessedAt=at;continue;}
    const reaccepted=s.side==="LONG"?close<reaccept:close>reaccept;
    if(reaccepted){fail(s,at,"价格重新被旧区域接受；顺势机会失效。");s.lastProcessedAt=at;break;}

    s.excursionExtreme=s.side==="LONG"?Math.max(s.excursionExtreme,row.high):Math.min(s.excursionExtreme,row.low);
    // Kept only for seamless recovery from a v1 in-memory state.
    if(s.phase==="EXTENSION")s.phase="WAIT_RETEST";

    if(s.phase==="WAIT_RETEST"){
      const near=s.side==="LONG"?row.low<=boundary+s.regionWidth*.35:row.high>=boundary-s.regionWidth*.35;
      const held=s.side==="LONG"?close>=boundary-s.regionWidth*.05:close<=boundary+s.regionWidth*.05;
      if(near&&held){
        s.phase="RETEST";s.retestAt=at;s.pullbackExtreme=s.side==="LONG"?row.low:row.high;
        s.restartLevel=close;
        const span=Math.max(row.high-row.low,s.regionWidth*.01),body=d*(close-row.open);
        const closeLocation=s.side==="LONG"?(close-row.low)/span:(row.high-close)/span;
        const reacted=body>=s.regionWidth*.025&&closeLocation>=.58;
        s.reason=reacted?"第一次回测已在同一根5m出现明确顺向反应。":"第一次回测已守住；等待价格从回测位置重新向主方向移动。";
        if(reacted){
          const signal=signalFromRetest({state:s,row,at,frames:input.frames,costRate:input.costRate});
          if(signal){out.push(signal);s.phase="FIRED";s.firedAt=at;s.reason="边界回测当根即出现顺向反应；已产生一次性真实交易事件。";s.lastProcessedAt=at;break;}
        }
      }
    }else if(s.phase==="RETEST"&&s.retestAt!=null&&s.restartLevel!=null&&s.pullbackExtreme!=null){
      s.pullbackExtreme=s.side==="LONG"?Math.min(s.pullbackExtreme,row.low):Math.max(s.pullbackExtreme,row.high);
      const buffer=s.regionWidth*.025;
      const restarted=d*(close-s.restartLevel)>=buffer&&d*(close-row.open)>0;
      if(restarted){
        const signal=signalFromRetest({state:s,row,at,frames:input.frames,costRate:input.costRate});
        if(signal){out.push(signal);s.phase="FIRED";s.firedAt=at;s.reason="回测守住后5m重新向主方向移动；已产生一次性真实交易事件。";s.lastProcessedAt=at;break;}
      }
    }
    s.lastProcessedAt=at;
  }
  return out;
}

export function advanceAnchorFlowUniverse(input:{
  paths:Record<string,RegionCandle[]>;lifecycles:Record<string,RegionLifecycleState>;
  frames?:MultiTurnState["frames"];prior?:Record<string,AnchorFlowState>;migrationSignals:RegionEntrySignal[];
  consumed?:Record<string,number>;now:number;costRate:number;
}){
  const states:Record<string,AnchorFlowState>={...(input.prior??{})};
  for(const signal of input.migrationSignals.filter(x=>x.kind==="MIGRATION")){
    if(input.consumed?.[keyOf(signal.regionId,signal.side)])continue;
    if(!anchorFlowDirectionAllowed(input.frames,signal.symbol,signal.side))continue;
    const prior=states[signal.symbol];
    if(!prior||prior.regionId!==signal.regionId||prior.side!==signal.side||prior.phase==="FAILED")
      states[signal.symbol]=startState(signal);
  }
  const signals:AnchorFlowEntrySignal[]=[];
  for(const [symbol,state] of Object.entries(states)){
    signals.push(...updateOne({state,rows:input.paths[symbol]??[],lifecycle:input.lifecycles[symbol],frames:input.frames,
      consumed:input.consumed,now:input.now,costRate:input.costRate}));
  }
  for(const [symbol,state] of Object.entries(states))
    if((state.phase==="FAILED"||state.phase==="FIRED")&&input.now-state.createdAt>24*60*60_000)delete states[symbol];
  return{states,signals};
}
