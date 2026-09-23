import { REGION_BAR_MS, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState } from "./region-lifecycle.ts";
import { type MultiTurnState, type TurnFrameState } from "./multi-turn-engine.ts";

export const ANCHOR_FLOW_VERSION="anchor-flow-v1";
export const ANCHOR_FLOW_TTL_BARS=8;

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
};

const completeAt=(row:RegionCandle)=>row.time*1000+REGION_BAR_MS;
const finite=(v:number)=>Number.isFinite(v);

function directionalFrameOk(frame:TurnFrameState|undefined,side:"LONG"|"SHORT"){
  return !!frame&&frame.ready&&frame.direction===side&&frame.phase==="FLOW"
    &&frame.continuationScore>=.32&&frame.turnProbability<=.40&&frame.directionConfidence>=.30;
}
export function anchorFlowDirectionAllowed(frames:MultiTurnState["frames"]|undefined,symbol:string,side:"LONG"|"SHORT"){
  const by=frames?.[symbol];
  return directionalFrameOk(by?.["15m"],side)&&directionalFrameOk(by?.["1h"],side);
}
const keyOf=(regionId:string,side:"LONG"|"SHORT")=>`${regionId}:${side}`;

function startState(signal:RegionEntrySignal):AnchorFlowState{
  return{
    version:ANCHOR_FLOW_VERSION,symbol:signal.symbol,regionId:signal.regionId,side:signal.side,boundary:signal.boundary,
    phase:"EXTENSION",createdAt:signal.completedAt,expiresAt:signal.completedAt+ANCHOR_FLOW_TTL_BARS*REGION_BAR_MS,
    lastProcessedAt:signal.completedAt,breakoutCompletedAt:signal.completedAt,regionConfirmedAt:signal.regionConfirmedAt,
    regionLower:signal.regionLower,regionUpper:signal.regionUpper,regionCenter:signal.regionCenter,
    regionWidth:signal.regionWidth,regionWidthRate:signal.regionWidthRate,
    excursionExtreme:signal.signalPrice,retestAt:null,pullbackExtreme:null,restartLevel:null,
    firedAt:null,failedAt:null,reason:"区域外接受已确认；等待真实推进后第一次回测，不追突破。"
  };
}

function fail(state:AnchorFlowState,at:number,reason:string){
  state.phase="FAILED";state.failedAt=at;state.reason=reason;
}
function updateOne(input:{
  state:AnchorFlowState;rows:RegionCandle[];lifecycle?:RegionLifecycleState;frames?:MultiTurnState["frames"];
  consumed?:Record<string,number>;now:number;costRate:number;
}):AnchorFlowEntrySignal[]{
  const s=input.state,out:AnchorFlowEntrySignal[]=[];
  if(s.phase==="FIRED"||s.phase==="FAILED")return out;
  if(input.now>s.expiresAt){fail(s,input.now,"首次回测窗口已结束；放弃本次迁移，不追远。");return out;}
  if(input.consumed?.[keyOf(s.regionId,s.side)]){fail(s,input.now,"同一区域同方向已真实执行过一次；等待新成熟区域。");return out;}
  if(input.lifecycle?.zone?.id!==s.regionId){fail(s,input.now,"市场已经形成新的成熟区域；旧区域迁移失效。");return out;}
  if(!anchorFlowDirectionAllowed(input.frames,s.symbol,s.side)){
    fail(s,input.now,"1h 与 15m 不再同时保持同方向 FLOW；取消本次顺势迁移。");return out;
  }

  const d=s.side==="LONG"?1:-1,boundary=s.side==="LONG"?s.regionUpper:s.regionLower;
  const reaccept=s.side==="LONG"?s.regionUpper-s.regionWidth*.10:s.regionLower+s.regionWidth*.10;
  const rows=input.rows.filter(row=>completeAt(row)>s.lastProcessedAt&&completeAt(row)<=input.now)
    .sort((a,b)=>a.time-b.time);
  for(const row of rows){
    const at=completeAt(row),close=row.close;
    if(![row.open,row.high,row.low,row.close,row.volume].every(finite)){s.lastProcessedAt=at;continue;}
    const reaccepted=s.side==="LONG"?close<reaccept:close>reaccept;
    if(reaccepted){fail(s,at,"价格重新被旧区域接受；顺势迁移失败，交回区域生命周期处理。");s.lastProcessedAt=at;break;}

    s.excursionExtreme=s.side==="LONG"?Math.max(s.excursionExtreme,row.high):Math.min(s.excursionExtreme,row.low);
    const extensionWidths=d*(s.excursionExtreme-boundary)/Math.max(s.regionWidth,1e-12);
    if(s.phase==="EXTENSION"&&extensionWidths>=.30){
      s.phase="WAIT_RETEST";s.reason="已完成真实区域外推进；只等待第一次边界回测。";
    }

    if(s.phase==="WAIT_RETEST"){
      const near=s.side==="LONG"?row.low<=boundary+s.regionWidth*.28:row.high>=boundary-s.regionWidth*.28;
      const held=s.side==="LONG"?close>=boundary-s.regionWidth*.05:close<=boundary+s.regionWidth*.05;
      if(near&&held){
        s.phase="RETEST";s.retestAt=at;s.pullbackExtreme=s.side==="LONG"?row.low:row.high;
        s.restartLevel=s.side==="LONG"?row.high:row.low;
        s.reason="第一次回测已触及旧边界并守住；等待5m重新向主方向启动。";
      }
    }else if(s.phase==="RETEST"&&s.retestAt!=null&&s.restartLevel!=null&&s.pullbackExtreme!=null){
      s.pullbackExtreme=s.side==="LONG"?Math.min(s.pullbackExtreme,row.low):Math.max(s.pullbackExtreme,row.high);
      const buffer=s.regionWidth*.02;
      const restarted=at>s.retestAt&&(s.side==="LONG"?close>s.restartLevel+buffer:close<s.restartLevel-buffer);
      if(restarted){
        const stopBuffer=Math.max(s.regionWidth*.08,s.regionCenter*input.costRate*.25);
        const stopPrice=s.side==="LONG"?s.pullbackExtreme-stopBuffer:s.pullbackExtreme+stopBuffer;
        if((s.side==="LONG"&&stopPrice>=close)||(s.side==="SHORT"&&stopPrice<=close)){
          fail(s,at,"回测止损结构无效；取消本次交易。");s.lastProcessedAt=at;break;
        }
        const by=input.frames?.[s.symbol],f15=by?.["15m"],f1h=by?.["1h"];
        if(!f15||!f1h){fail(s,at,"方向帧缺失；取消本次交易。");s.lastProcessedAt=at;break;}
        out.push({
          version:"region-lifecycle-v1",
          id:`af-${s.regionId}-${s.side}-${at}`,symbol:s.symbol,kind:"MIGRATION",side:s.side,boundary:s.boundary,
          completedAt:at,expiresAt:at+2*REGION_BAR_MS,signalPrice:close,stopPrice,targetPrice:null,
          regionId:s.regionId,regionConfirmedAt:s.regionConfirmedAt,regionLower:s.regionLower,regionUpper:s.regionUpper,
          regionCenter:s.regionCenter,regionWidth:s.regionWidth,regionWidthRate:s.regionWidthRate,
          reason:`AnchorFlow：1h/15m同向FLOW；区域外已真实推进，第一次回测守住后5m重新启动。`,
          entryModel:"ANCHOR_FLOW",contextTimeframe:"15m",directionFrameAt:f15.completedAt,trendFrameAt:f1h.completedAt,
          retestAt:s.retestAt,restartLevel:s.restartLevel,pullbackExtreme:s.pullbackExtreme,
        });
        s.phase="FIRED";s.firedAt=at;s.reason="第一次回测守住并重新启动；已产生一次性 AnchorFlow 真实交易事件。";
        s.lastProcessedAt=at;break;
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
