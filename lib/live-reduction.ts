/** Reduce-only synchronization of a committed source size. No entry authority.
 * Reserve before sending; resolve unknown submissions, never blindly replay. */
import type {Trade} from './forward-relations.ts';
import type {MirrorReceipt} from './live-parity.ts';
import type {GateLiveOrder} from './gate-live.ts';
import {liveExitTag} from './gate-live.ts';
import {quantizeMirrorNotional,type GateSizeRules} from './gate-quantity.ts';
export type SourceReduction={version:'source-reduction-v1';sourceSequence:number;targetContracts:number;contractsText:string;
  tag:string;attempt:number;submittedAt:number;orderId:string|null;state:'SUBMITTED'|'CONFIRMED'|'UNRESOLVED'|'SHORTFALL';};
export function sourceReductionTarget(source:Trade,receipt:MirrorReceipt,actualContracts:number,spec:GateSizeRules){
  const sequence=source.sourceReductionIntent?.sequence??source.realization?.sequence??0;
  if(source.status!=='OPEN'||source.id!==receipt.sourceId||sequence<1)return null;
  const sourceAtCopy=receipt.sourceContractsAtCopy;
  if(!sourceAtCopy||!Number.isFinite(sourceAtCopy)||sourceAtCopy<=0||source.contracts>sourceAtCopy+1e-9)return null;
  const desired=receipt.roundedContracts*Math.min(1,source.contracts/sourceAtCopy),
    // Remaining target is rounded upward by choosing the REDUCTION downward;
    // this avoids taking extra live risk away solely because of lot rounding.
    delta=Math.max(0,actualContracts-desired),quantity=quantizeMirrorNotional(delta,1,1,spec);
  if(quantity.quantity<quantity.minimum)return null;
  return{targetContracts:actualContracts-quantity.quantity,contractsText:quantity.quantityText,sequence};
}
export async function reconcileSourceReduction(input:{source:Trade;receipt:MirrorReceipt;actualContracts:number;observedAt:number;
  now:number;spec:GateSizeRules;prior?:SourceReduction;stillOpen:()=>boolean;
  inspect:(tag:string,id:string|null)=>Promise<GateLiveOrder|null>;
  persist:(state:SourceReduction)=>Promise<void>;submit:(text:string,tag:string,guard:()=>boolean)=>Promise<string>}){
  const target=sourceReductionTarget(input.source,input.receipt,input.actualContracts,input.spec),p=input.prior;
  if(!input.stillOpen())return p;
  if(p&&(p.state==='SUBMITTED'||p.state==='UNRESOLVED')){
    if(input.observedAt<=p.submittedAt)return p;
    if(input.actualContracts<=p.targetContracts+1e-9){const done={...p,state:'CONFIRMED' as const};await input.persist(done);return done;}
    const order=await input.inspect(p.tag,p.orderId);
    if(!order){if(p.state!=='UNRESOLVED'){const unknown={...p,state:'UNRESOLVED' as const};await input.persist(unknown);return unknown;}return p;}
    const finish=Number(order.finish_time??0)*1000;
    if(order.status!=='finished'||!Number.isFinite(finish)||finish<=0||input.observedAt<finish||input.now-p.submittedAt<6000)return p;
    // A terminal order and a later position snapshot are both required before
    // computing any residual. A returned order ID is not proof of a fill.
    const settled={...p,state:'SHORTFALL' as const};await input.persist(settled);return settled;
  }
  if(!target)return p;
  const attempt=p&&p.sourceSequence===target.sequence?p.attempt+1:1;
  if(attempt>3)return p;
  if(p&&input.now-p.submittedAt<6000)return p;
  const request:SourceReduction={version:'source-reduction-v1',sourceSequence:target.sequence,targetContracts:target.targetContracts,
    contractsText:target.contractsText,tag:liveExitTag(`${input.source.id}:reduce:${target.sequence}:${attempt}`),attempt,
    submittedAt:input.now,orderId:null,state:'SUBMITTED'};
  await input.persist(request);
  if(!input.stillOpen())return request;
  const orderId=await input.submit(request.contractsText,request.tag,input.stillOpen),sent={...request,orderId};
  await input.persist(sent);return sent;
}
