import { REGION_BAR_MS, REGION_LIFECYCLE_VERSION, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState } from "./region-lifecycle.ts";
import { type MultiTurnState, type TurnFrameState } from "./multi-turn-engine.ts";

export const ANCHOR_FLOW_VERSION="anchor-flow-v1";
export const ANCHOR_FLOW_TTL_BARS=12;

export function anchorFlowExecutableProofRate(modeledCostRate:number){
  const cost=Number.isFinite(modeledCostRate)?Math.max(0,modeledCostRate):0;
  return Math.max(.001,Math.min(.0015,cost*.45));
}

// New orders use the latest observed pullback, including quotes received while
// READY waits for a rebound. Existing positions never pass through this helper.
export function anchorFlowStopPrice(side:"LONG"|"SHORT",support:number,regionWidth:number,regionCenter:number,costRate:number){
  const buffer=Math.max(regionWidth*.08,regionCenter*Math.max(.001,costRate*.50));
  return support+(side==="LONG"?-buffer:buffer);
}

export type AnchorFlowPhase="EXTENSION"|"WAIT_RETEST"|"RETEST"|"READY"|"FIRED"|"CONSUMED"|"FAILED";
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
  readyAt?:number|null;
  reacceptBars?:number;
  retryCount?:number;
  confirmationExtreme?:number|null;
  firedAt:number|null;
  consumedAt?:number|null;
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
  // Higher timeframes are veto-only context. Missing/neutral/same-side states
  // cannot invalidate a good 5m location, and a WATCH/TURNING opposite state is
  // still only a warning. Block only an established, confident opposite flow.
  if(!frame?.ready||frame.direction==="NEUTRAL"||frame.direction===side)return true;
  const minConfidence=timeframe==="1h"?.55:.52;
  const minContinuation=timeframe==="1h"?.40:.36;
  const established=frame.phase==="FLOW"||frame.phase==="CONFIRMED";
  return !(established&&frame.directionConfidence>=minConfidence&&frame.continuationScore>=minContinuation);
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
    readyAt:null,reacceptBars:0,retryCount:0,confirmationExtreme:null,firedAt:null,consumedAt:null,failedAt:null,
    reason:"区域外连续收盘已确认；不追突破，只等边界附近出现可执行的5m顺向反应。"
  };
}

function fail(state:AnchorFlowState,at:number,reason:string){
  state.phase="FAILED";state.failedAt=at;state.reason=reason;
}
function signalFromReady(input:{state:AnchorFlowState;signalPrice:number;at:number;frames?:MultiTurnState["frames"];costRate:number}){
  const s=input.state,{signalPrice,at}=input;
  const by=input.frames?.[s.symbol],f15=by?.["15m"],f1h=by?.["1h"];
  if(!f15?.ready||!f1h?.ready||s.retestAt==null||s.pullbackExtreme==null||s.restartLevel==null)return null;
  const stopPrice=anchorFlowStopPrice(s.side,s.pullbackExtreme,s.regionWidth,s.regionCenter,input.costRate);
  if((s.side==="LONG"&&stopPrice>=signalPrice)||(s.side==="SHORT"&&stopPrice<=signalPrice))return null;
  return {
    version:REGION_LIFECYCLE_VERSION,
    id:`af-${s.regionId}-${s.side}-READY`,symbol:s.symbol,kind:"MIGRATION",side:s.side,boundary:s.boundary,
    completedAt:at,expiresAt:s.expiresAt,signalPrice,stopPrice,targetPrice:null,
    regionId:s.regionId,regionConfirmedAt:s.regionConfirmedAt,regionLower:s.regionLower,regionUpper:s.regionUpper,
    regionCenter:s.regionCenter,regionWidth:s.regionWidth,regionWidthRate:s.regionWidthRate,
    reason:"AnchorFlow：高周期没有有置信度的明确反向否决；5m区域外确认后回到边界附近并重新出现顺向反应。",
    entryModel:"ANCHOR_FLOW",contextTimeframe:"15m",directionFrameAt:f15.completedAt,trendFrameAt:f1h.completedAt,
    retestAt:s.retestAt,restartLevel:s.restartLevel,pullbackExtreme:s.pullbackExtreme,
    anchorExpectedMoveRate:Math.max(0,f15.expectedMoveRate),
  } as AnchorFlowEntrySignal;
}
function fakeoutRejection(input:{state:AnchorFlowState;row:RegionCandle;at:number;costRate:number}):RegionEntrySignal|null{
  const s=input.state,{row,at}=input,side=s.side==="LONG"?"SHORT":"LONG";
  // Once the close has already reached/passed the center, the mean-reversion
  // target is gone. Fail the trend route without manufacturing a late reversal.
  if((side==="SHORT"&&row.close<=s.regionCenter)||(side==="LONG"&&row.close>=s.regionCenter))return null;
  const stopBuffer=Math.max(s.regionWidth*.08,s.regionCenter*input.costRate*.25);
  const stopPrice=side==="SHORT"?s.excursionExtreme+stopBuffer:s.excursionExtreme-stopBuffer;
  if((side==="SHORT"&&stopPrice<=row.close)||(side==="LONG"&&stopPrice>=row.close))return null;
  return{
    version:REGION_LIFECYCLE_VERSION,
    id:`af-${s.regionId}-R-${s.boundary}-${at}`,symbol:s.symbol,kind:"REJECTION",side,boundary:s.boundary,
    completedAt:at,expiresAt:at+2*REGION_BAR_MS,signalPrice:row.close,stopPrice,targetPrice:s.regionCenter,
    regionId:s.regionId,regionConfirmedAt:s.regionConfirmedAt,regionLower:s.regionLower,regionUpper:s.regionUpper,
    regionCenter:s.regionCenter,regionWidth:s.regionWidth,regionWidthRate:s.regionWidthRate,
    reason:"AnchorFlow假突破：突破后连续确认重新接受旧区域，顺势路线失效并转换为反向回归区域中心。"
  };
}
function updateOne(input:{
  state:AnchorFlowState;rows:RegionCandle[];lifecycle?:RegionLifecycleState;frames?:MultiTurnState["frames"];
  consumed?:Record<string,number>;now:number;costRate:number;
}):{signals:AnchorFlowEntrySignal[];rejections:RegionEntrySignal[]}{
  const s=input.state;
  let readySignal:AnchorFlowEntrySignal|null=null;
  const rejections:RegionEntrySignal[]=[];
  s.readyAt=s.readyAt??null;s.reacceptBars=Number.isFinite(s.reacceptBars??NaN)?Math.max(0,s.reacceptBars??0):0;
  s.retryCount=Number.isFinite(s.retryCount??NaN)?Math.max(0,Math.floor(s.retryCount??0)):0;
  s.confirmationExtreme=Number.isFinite(s.confirmationExtreme??NaN)?s.confirmationExtreme!:null;s.consumedAt=s.consumedAt??null;

  const consumedAt=input.consumed?.[keyOf(s.regionId,s.side)];
  if(consumedAt){
    s.phase="CONSUMED";s.consumedAt=consumedAt;
    s.reason="该区域方向已经完成真实模拟开仓；机会已消费，等待新成熟区域。";
    return{signals:[],rejections};
  }
  // v1 used FIRED for "signal emitted", even when no order was opened. Recover
  // those persisted candidates as READY instead of silently losing the region.
  if(s.phase==="FIRED"){
    s.phase="READY";s.readyAt=s.readyAt??s.firedAt??s.lastProcessedAt;
    s.reason="兼容旧FIRED状态：仅代表曾产生信号，未确认成交；恢复为READY继续等待可执行位置。";
  }
  if(s.phase==="CONSUMED"||s.phase==="FAILED")return{signals:[],rejections};
  if(input.now>s.expiresAt){fail(s,input.now,"本次区域机会超过一小时仍没有形成可成交的边界优势位置；放弃，不追远。");return{signals:[],rejections};}
  if(input.lifecycle?.zone?.id!==s.regionId){fail(s,input.now,"市场已经形成新的成熟区域；旧区域机会失效。");return{signals:[],rejections};}
  if(!anchorFlowDirectionAllowed(input.frames,s.symbol,s.side)){
    fail(s,input.now,"15m/1h已经形成有置信度的明确反向状态；取消本次5m顺势机会。");return{signals:[],rejections};
  }

  const d=s.side==="LONG"?1:-1,boundary=s.side==="LONG"?s.regionUpper:s.regionLower;
  const outerDepth=s.regionWidth*.30,confirmDepth=s.regionWidth*.25;
  const rows=input.rows.filter(row=>completeAt(row)>s.lastProcessedAt&&completeAt(row)<=input.now)
    .sort((a,b)=>a.time-b.time);
  for(const row of rows){
    const at=completeAt(row),close=row.close;
    if(![row.open,row.high,row.low,row.close,row.volume].every(finite)){s.lastProcessedAt=at;continue;}

    s.excursionExtreme=s.side==="LONG"?Math.max(s.excursionExtreme,row.high):Math.min(s.excursionExtreme,row.low);
    const deepToCenter=s.side==="LONG"?close<=s.regionCenter:close>=s.regionCenter;
    const confirmedInside=s.side==="LONG"?close<=s.regionUpper-confirmDepth:close>=s.regionLower+confirmDepth;
    s.reacceptBars=confirmedInside?(s.reacceptBars??0)+1:0;
    if(deepToCenter||(s.reacceptBars??0)>=2){
      readySignal=null;
      const rejection=deepToCenter?null:fakeoutRejection({state:s,row,at,costRate:input.costRate});
      if(rejection)rejections.push(rejection);
      fail(s,at,rejection
        ?"突破后连续两根5m确认重新接受旧区域；顺势失效，已转换为反向REJECTION回归中心。"
        :"价格已明显深入或到达旧区域中心；顺势路线失效，中心回归空间也已不足。");
      s.lastProcessedAt=at;break;
    }

    // Kept only for seamless recovery from an older in-memory state.
    if(s.phase==="EXTENSION")s.phase="WAIT_RETEST";

    if(s.phase==="WAIT_RETEST"){
      const near=s.side==="LONG"?row.low<=boundary+s.regionWidth*.35:row.high>=boundary-s.regionWidth*.35;
      // A normal first retest may close inside the outer 30% of the old region.
      // One shallow re-entry is not proof that the breakout failed.
      const held=s.side==="LONG"?close>=boundary-outerDepth:close<=boundary+outerDepth;
      if(near&&held){
        s.phase="RETEST";s.retestAt=at;s.pullbackExtreme=s.side==="LONG"?row.low:row.high;
        s.restartLevel=close;
        const span=Math.max(row.high-row.low,s.regionWidth*.01),body=d*(close-row.open);
        const closeLocation=s.side==="LONG"?(close-row.low)/span:(row.high-close)/span;
        const reacted=body>=s.regionWidth*.025&&closeLocation>=.58;
        s.reason=reacted?"第一次回测允许浅入旧区域，并在同一根5m出现明确顺向反应。":"第一次回测仍处旧区域外侧；等待价格从回测位置重新向主方向移动。";
        if(reacted){
          const signal=signalFromReady({state:s,signalPrice:row.close,at,frames:input.frames,costRate:input.costRate});
          if(signal){
            readySignal=signal;s.phase="READY";s.readyAt=s.readyAt??at;s.firedAt=s.firedAt??at;s.confirmationExtreme=null;
            s.reason="边界回测已产生可执行信号；状态保持READY，只有真实开仓后才CONSUMED。";
          }
        }
      }
    }else if(s.phase==="RETEST"&&s.retestAt!=null&&s.restartLevel!=null&&s.pullbackExtreme!=null){
      s.pullbackExtreme=s.side==="LONG"?Math.min(s.pullbackExtreme,row.low):Math.max(s.pullbackExtreme,row.high);
      const buffer=s.regionWidth*.025;
      const restarted=d*(close-s.restartLevel)>=buffer&&d*(close-row.open)>0;
      if(restarted){
        const signal=signalFromReady({state:s,signalPrice:row.close,at,frames:input.frames,costRate:input.costRate});
        if(signal){
          readySignal=signal;s.phase="READY";s.readyAt=s.readyAt??at;s.firedAt=s.firedAt??at;s.confirmationExtreme=null;
          s.reason="回测守住后5m重新向主方向移动；状态保持READY，只有真实开仓后才CONSUMED。";
        }
      }
    }else if(s.phase==="READY"&&s.retestAt!=null&&s.restartLevel!=null&&s.pullbackExtreme!=null){
      // If an earlier READY event expired or failed economics, keep observing the
      // same location. Re-issue only near the boundary on a fresh same-side
      // reaction; never chase a price already far away from the region.
      s.pullbackExtreme=s.side==="LONG"?Math.min(s.pullbackExtreme,row.low):Math.max(s.pullbackExtreme,row.high);
      const location=d*(close-boundary),inBand=location>=-outerDepth&&location<=s.regionWidth*.45;
      const reacted=d*(close-row.open)>0;
      readySignal=null;
      if(inBand&&reacted){
        const signal=signalFromReady({state:s,signalPrice:row.close,at,frames:input.frames,costRate:input.costRate});
        if(signal){readySignal=signal;s.reason="READY机会仍在边界优势区出现新鲜顺向反应；重新提交订单经济性检查，尚未消费。";}
      }else s.reason="READY机会尚未成交；继续保留区域，等待边界优势位置重新出现，不追远。";
    }
    s.lastProcessedAt=at;
  }
  if(!readySignal&&s.phase==="READY"&&s.readyAt!=null&&s.restartLevel!=null&&s.retestAt!=null&&s.pullbackExtreme!=null){
    const signal=signalFromReady({state:s,signalPrice:s.restartLevel,at:s.readyAt,frames:input.frames,costRate:input.costRate});
    if(signal){
      readySignal=signal;
      s.reason=s.retryCount
        ?"READY重试机会持续保留；等待边界附近真实盘口再次给出顺向反馈，不追价。"
        :"READY机会持续保留；不要求再等一根新的5m反应，等待真实盘口顺向确认后成交。";
    }
  }
  return{signals:readySignal?[readySignal]:[],rejections};
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
    if(!prior||prior.regionId!==signal.regionId||prior.side!==signal.side||prior.phase==="FAILED"||prior.phase==="CONSUMED")
      states[signal.symbol]=startState(signal);
  }
  const signals:AnchorFlowEntrySignal[]=[],rejections:RegionEntrySignal[]=[];
  for(const [symbol,state] of Object.entries(states)){
    const next=updateOne({state,rows:input.paths[symbol]??[],lifecycle:input.lifecycles[symbol],frames:input.frames,
      consumed:input.consumed,now:input.now,costRate:input.costRate});
    signals.push(...next.signals);rejections.push(...next.rejections);
  }
  for(const [symbol,state] of Object.entries(states))
    if((state.phase==="FAILED"||state.phase==="CONSUMED")&&input.now-state.createdAt>24*60*60_000)delete states[symbol];
  return{states,signals,rejections};
}
