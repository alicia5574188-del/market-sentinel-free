/** Current open quantities describe remaining exposure. Original money/size and
 * every (bounded) realization stay under the same parent identity. */
import type {Trade} from './forward-relations.ts';
export type TradeRealization={version:'partial-realization-v1';initialQuantity:number;initialContracts:number;
  initialNotional:number;initialMargin:number;initialRisk:number;initialEntryFee:number;
  gross:number;fees:number;funding:number;sequence:number;
  fills:{sequence:number;at:number;quoteAt:number;price:number;contracts:number;quantity:number;gross:number;fee:number;funding:number;reason:string}[]};
export function realizedContribution(t:Pick<Trade,'realization'>){const r=t.realization;return r?r.gross-r.fees-r.funding:0;}
export function initialTradeNotional(t:Pick<Trade,'notional'|'realization'>){return t.realization?.initialNotional??t.notional;}
export function remainingTradeFraction(t:Pick<Trade,'contracts'|'realization'>){return t.realization?t.contracts/t.realization.initialContracts:1;}
/** Presentation split: paid entry fees are allocated once, not charged again
 * to the smaller remainder. Realized profit is not floating profit. */
export function realizedNetPnl(t:Pick<Trade,'realization'|'entryFee'>){const r=t.realization;
  return r?realizedContribution(t)-t.entryFee*r.fills.reduce((n,f)=>n+f.quantity,0)/r.initialQuantity:0;}
export function remainingOpenNetPnl(t:Pick<Trade,'side'|'quantity'|'lastPrice'|'entryPrice'|'notional'|'entryFee'|'realization'>,price=t.lastPrice){
  const original=initialTradeNotional(t),feeRate=original>0?t.entryFee/original:0,
    entryShare=t.realization?t.quantity/t.realization.initialQuantity:1;
  return (t.side==='LONG'?1:-1)*t.quantity*(price-t.entryPrice)-t.entryFee*entryShare-t.quantity*price*feeRate;
}
export function realizeTradeSlice(input:{trade:Trade;price:number;now:number;quoteAt:number;fraction:number;feeRate:number;fundingPerDay:number;minContracts:number;reason:string}){
  const t=input.trade;
  if(t.status!=='OPEN'||![input.price,input.fraction,input.now,input.quoteAt,t.quantity,t.contracts,t.notional,input.minContracts].every(Number.isFinite)
    ||input.price<=0||input.minContracts<=0||input.fraction<=0||input.fraction>=1||input.quoteAt>input.now||input.now-input.quoteAt>10000
    ||(t.realization?.sequence??0)>=2)return null;
  const units=Math.floor((t.contracts*input.fraction+1e-10)/input.minContracts),contracts=units*input.minContracts;
  if(contracts<input.minContracts||t.contracts-contracts<input.minContracts-1e-9)return null;
  const initial=t.realization??{version:'partial-realization-v1' as const,initialQuantity:t.quantity,initialContracts:t.contracts,
    initialNotional:t.notional,initialMargin:t.margin,initialRisk:t.plannedRisk,initialEntryFee:t.entryFee,gross:0,fees:0,funding:0,sequence:0,fills:[]};
  if((t.contracts-contracts)/initial.initialContracts<.35-1e-9)return null;
  const ratio=contracts/t.contracts,quantity=t.quantity*ratio,notional=t.notional*ratio,
    gross=(t.side==='LONG'?1:-1)*quantity*(input.price-t.entryPrice),fee=quantity*input.price*input.feeRate,
    funding=notional*input.fundingPerDay*Math.max(0,input.now-t.openedAt)/86400000;
  if(![gross,fee,funding].every(Number.isFinite)||gross-fee-funding-initial.initialEntryFee*quantity/initial.initialQuantity<=0)return null;
  const realization:TradeRealization={...initial,gross:initial.gross+gross,fees:initial.fees+fee,funding:initial.funding+funding,
    sequence:initial.sequence+1,fills:[...initial.fills,{sequence:initial.sequence+1,at:input.now,quoteAt:input.quoteAt,price:input.price,
      contracts,quantity,gross,fee,funding,reason:input.reason}]};
  t.realization=realization;t.contracts-=contracts;t.quantity-=quantity;t.notional=t.quantity*t.entryPrice;t.margin=t.notional/t.leverage;
  t.plannedRisk=initial.initialRisk*t.contracts/initial.initialContracts;
  // Original entry fee stays on the parent; it was debited only once at entry.
  return{gross,fee,funding,notional,exitNotional:quantity*input.price,credit:gross-fee-funding,contracts};
}

/** Reject corrupted financial sizes rather than silently rebuilding a parent. */
export function assertTradeRealization(t:Trade){
  const r=t.realization;if(!r)return;
  const close=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
  if(r.version!=='partial-realization-v1'||![r.initialQuantity,r.initialContracts,r.initialNotional,r.initialMargin,r.initialRisk,r.initialEntryFee,r.gross,r.fees,r.funding].every(Number.isFinite)
    ||r.initialQuantity<=0||r.initialContracts<=0||r.initialNotional<=0||!Array.isArray(r.fills)||r.fills.length<1||r.fills.length>2||r.sequence!==r.fills.length
    ||r.fills.some((f,i)=>f.sequence!==i+1||![f.at,f.quoteAt,f.price,f.contracts,f.quantity,f.gross,f.fee,f.funding].every(Number.isFinite)
      ||f.contracts<=0||f.quantity<=0||f.price<=0||f.fee<0||f.funding<0||f.quoteAt>f.at))throw new Error('部分兑现记录损坏；拒绝恢复错误资金或仓位');
  const quantities=r.fills.reduce((n,f)=>n+f.quantity,0),contracts=r.fills.reduce((n,f)=>n+f.contracts,0);
  if(!close(r.fills.reduce((n,f)=>n+f.gross,0),r.gross)||!close(r.fills.reduce((n,f)=>n+f.fee,0),r.fees)
    ||!close(r.fills.reduce((n,f)=>n+f.funding,0),r.funding)||!close(t.entryFee,r.initialEntryFee)
    ||!close(t.quantity,t.status==='OPEN'?r.initialQuantity-quantities:r.initialQuantity)
    ||!close(t.contracts,t.status==='OPEN'?r.initialContracts-contracts:r.initialContracts)
    ||!close(t.notional,t.quantity*t.entryPrice)||contracts>r.initialContracts*.65+1e-8)throw new Error('部分兑现账本与剩余仓位不一致；保留原账户');
}
