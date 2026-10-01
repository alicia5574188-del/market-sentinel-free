/** Execute a committed source CLOSE. No independent exit timing or entry authority. */
import {liveExitTag,GateEntryCancelledError,type GateLiveOrder} from './gate-live.ts';
export const SOURCE_EXIT_EXECUTION_POLICY='priority-bounded-exit-v1';
export type SourceExit={version:typeof SOURCE_EXIT_EXECUTION_POLICY;sourceClosedAt:number;sourceExitPrice:number|null;
  observedAt:number;initialContracts:number;attempt:number;knownFilled:number;knownValue:number;
  last:{tag:string;kind:'LIMIT'|'MARKET';price:string;submittedAt:number;orderId:string|null;terminal:boolean;accounted:boolean};
  confirmedAt?:number;lastError?:string};
function terminal(o:GateLiveOrder|null){return o?.status==='finished';}
function account(s:SourceExit,o:GateLiveOrder){
  const size=Math.abs(Number(o.size)),left=Math.abs(Number(o.left)),price=Number(o.fill_price);
  if(terminal(o)&&!s.last.accounted&&Number.isFinite(size)&&Number.isFinite(left)&&size>=left&&price>0){
    s.knownFilled+=size-left;s.knownValue+=(size-left)*price;s.last.accounted=true;
  }
}
export function sourceExitFillPrice(s:SourceExit|undefined){
  return s&&s.knownFilled>0&&Math.abs(s.knownFilled-s.initialContracts)<=Math.max(1e-9,s.initialContracts*1e-8)
    ?s.knownValue/s.knownFilled:null;
}
/** One bounded IOC, then reduce-only market completion after a terminal result
 * and a fresh position read. Unknown outcomes retain the exact tag across restart. */
export async function reconcileSourceClose(input:{id:string;sourceClosedAt:number;sourceExitPrice:number|null;
  actualContracts:number;observedAt:number;now:number;limit?:{price:string;contractsText:string}|null;prior?:SourceExit;
  stillClosed:()=>boolean;persist:(s:SourceExit)=>Promise<void>;definitiveRejection?:(error:unknown)=>boolean;
  inspect:(tag:string,id:string|null)=>Promise<GateLiveOrder|null>;
  remaining:()=>Promise<{contracts:number;observedAt:number}>;
  submit:(tag:string,limit:{price:string;contractsText:string}|null,guard:()=>boolean)=>Promise<{orderId:string;order:GateLiveOrder}>}){
  if(!input.stillClosed())return input.prior;
  let state=input.prior?structuredClone(input.prior):undefined;
  if(state?.confirmedAt)return state;
  if(state&&input.actualContracts===0&&input.observedAt>=state.last.submittedAt){
    state.confirmedAt=input.observedAt;await input.persist(state);return state;
  }
  let remaining=input.actualContracts;
  if(state){
    if(!state.last.terminal){
      const order=await input.inspect(state.last.tag,state.last.orderId);
      if(!terminal(order))return state; // no blind repeat or fallback on a timeout
      state.last.terminal=true;account(state,order!);await input.persist(state);
    }
    if(state.last.kind==='MARKET'&&input.now-state.last.submittedAt<6000)return state;
    const current=await input.remaining();
    if(current.observedAt<state.last.submittedAt)return state;
    remaining=current.contracts;
    if(remaining===0){state.confirmedAt=current.observedAt;await input.persist(state);return state;}
  }
  const attempt=(state?.attempt??0)+1,limit=!state?input.limit??null:null;
  state={...(state??{version:SOURCE_EXIT_EXECUTION_POLICY,sourceClosedAt:input.sourceClosedAt,
    sourceExitPrice:input.sourceExitPrice,observedAt:input.now,initialContracts:remaining,knownFilled:0,knownValue:0}),
    attempt,last:{tag:attempt===1?liveExitTag(input.id):liveExitTag(`${input.id}:exit:${attempt}`),
      kind:limit?'LIMIT':'MARKET',price:limit?.price??'0',submittedAt:input.now,orderId:null,terminal:false,accounted:false}};
  await input.persist(state); // reservation survives unknown send/results
  if(!input.stillClosed()){state.last.terminal=true;await input.persist(state);return state;}
  try{
    const response=await input.submit(state.last.tag,limit,input.stillClosed);
    state.last.orderId=response.orderId;state.last.terminal=terminal(response.order);account(state,response.order);
    await input.persist(state);
  }catch(error){
    state.lastError=error instanceof Error?error.message:String(error);
    if(error instanceof GateEntryCancelledError||input.definitiveRejection?.(error))state.last.terminal=true;
    await input.persist(state);throw error;
  }
  // A known terminal limit is completed in the SAME pass, not the next polling
  // interval. No waiting for the old PAPER price or any resting order.
  if(limit&&state.last.terminal){
    const current=await input.remaining();
    return reconcileSourceClose({...input,prior:state,actualContracts:current.contracts,remaining:async()=>current,
      observedAt:current.observedAt,now:Math.max(input.now,current.observedAt)});
  }
  return state;
}
