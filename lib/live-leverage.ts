/** Idempotent isolated-margin adjustment, only for confirmed program exposure. */
import type {GateLivePosition} from './gate-live.ts';
import type {MirrorReceipt} from './live-parity.ts';
import {isInverseLiveReceipt,inverseLiveLeverage,INVERSE_LIVE_LEVERAGE_POLICY} from './live-source-policy.ts';
type Position={symbol:string;side:'LONG'|'SHORT';status:string;notional:number;exchangeSize:number;
  leverage:number;margin:number;exitRequestedAt:number|null;parity?:MirrorReceipt};
export async function adjustInverseLeverage(input:{position:Position;actual:GateLivePosition;available:number;
  now:number;enabled:boolean;sourceOpen:boolean;setLeverage:(symbol:string,target:number)=>Promise<GateLivePosition|void>;
  persist:()=>Promise<void>;stillAllowed?:()=>boolean}){
  const p=input.position,r=p.parity,target=r?(r.sourceRole==='UNIFIED_PAPER'?r.sourceLeverage:inverseLiveLeverage(r.sourceLeverage)):0,
    actualSize=Number(input.actual.size),current=Number(input.actual.leverage);
  const result={attempted:false,confirmed:false,reservedMargin:0,error:null as string|null};
  if(!input.enabled||!input.sourceOpen||p.status!=='OPEN'||p.exitRequestedAt!=null||!isInverseLiveReceipt(r)
    ||!r||input.actual.contract!==p.symbol||!Number.isFinite(actualSize)||Math.abs(actualSize)!==p.exchangeSize
    ||Math.sign(actualSize)!==(p.side==='LONG'?1:-1)||!Number.isFinite(current)||current<=0||target<1)return result;
  // Never increase the leverage of an already safer/manual lower-leverage holding.
  if(current<=target){
    r.leveragePolicy=r.sourceRole==='UNIFIED_PAPER'?'actual-intent-isolated-v1':INVERSE_LIVE_LEVERAGE_POLICY;r.executionLeverage=current;r.leverageAdjustError=null;
    return result;
  }
  if(r.leverageAdjustAt!=null&&input.now-r.leverageAdjustAt<30_000)return result;
  const value=Math.max(p.notional,Math.abs(Number(input.actual.value)||0)),delta=value*(1/target-1/current);
  if(!Number.isFinite(delta)||delta<=0||!Number.isFinite(input.available)||input.available<delta){
    r.leverageAdjustError='降低杠杆所需的额外可用保证金不足，保留仓位和原杠杆';return {...result,error:r.leverageAdjustError};
  }
  r.leveragePolicy=r.sourceRole==='UNIFIED_PAPER'?'actual-intent-isolated-v1':INVERSE_LIVE_LEVERAGE_POLICY;r.executionLeverage=target;
  r.leverageAdjustAt=input.now;r.leverageAdjustError=null;
  // Commit the target/cooldown BEFORE the idempotent exchange request. A restart
  // reads actual leverage first; it never halves the last observed leverage again.
  await input.persist();
  if(input.stillAllowed&&!input.stillAllowed())return result;
  result.attempted=true;result.reservedMargin=delta;
  try{
    const actual=await input.setLeverage(p.symbol,target);
    if(actual&&actual.contract===p.symbol&&Number(actual.size)===actualSize&&Number(actual.leverage)===target){
      const margin=Number(actual.margin??actual.initial_margin);
      p.leverage=target;if(Number.isFinite(margin)&&margin>0)p.margin=margin;
      result.confirmed=true;
    }else r.leverageAdjustError='杠杆调整请求已发送，等待下一次原生持仓快照确认';
  }catch(error){r.leverageAdjustError=error instanceof Error?error.message.slice(0,300):'交易所暂未确认杠杆调整，保留原仓位';}
  result.error=r.leverageAdjustError??null;
  await input.persist();return result;
}
