/** Private export projection only. No network, writes, strategy or execution authority. */
export const LIVE_REVIEW_VERSION='live-review-v1';
export const LIVE_REVIEW_PAGE_ROWS=48;
const PREFIX='live-parity:v1:closed:';
type Row=Record<string,unknown>;
const obj=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
const rows=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const values=(v:unknown)=>Object.values(obj(v)).filter(Boolean);
const pick=(v:unknown,keys:string[])=>{const r=obj(v);return Object.fromEntries(keys.map(k=>[k,r[k]??null]));};
const accountNumber=(v:unknown)=>v!=null&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
export function liveReviewPosition(value:unknown,cached:unknown[]=[]){
  const p=obj(value),decorated=obj(cached.find(v=>obj(v).id===p.id)),settlement=obj(decorated.settlement),parity=obj(p.parity);
  return {id:p.id,...pick(p,['symbol','side','status','entryAt','entryPrice','exitAt','exchangeSize','size','notional','margin','leverage',
    'exchangeUnrealisedPnl','exchangePnlAt','exchangeUpdatedAt','exitRequestedAt','exitOrderId']),
    sourceId:p.mirrorSourceId??parity.sourceId??p.id,
    activationAt:parity.activationAt??null,copiedAt:parity.copiedAt??null,
    sourceOpenedAt:parity.sourceOpenedAt??null,sourceEntryPrice:parity.sourceEntryPrice??null,
    sourceContracts:parity.sourceContractsAtCopy??null,sourceNotional:parity.sourceNotional??null,
    requestedRatio:parity.ratio??null,targetNotional:parity.targetNotional??null,
    leveragePolicy:parity.leveragePolicy??null,executionLeverage:parity.executionLeverage??null,
    leverageAdjustAt:parity.leverageAdjustAt??null,leverageAdjustError:parity.leverageAdjustError??null,
    originalContracts:obj(p.sourceExit).initialContracts??parity.filledContracts??p.exchangeSize??null,
    hasReductions:!!obj(p.sourceReduction).version,
    submittedAt:parity.submittedAt??null,submitDelayMs:parity.submitDelayMs??null,
    sourceClosedAt:parity.sourceClosedAt??null,
    exitPrice:settlement.exitPrice??(p.actualExitPriceVerified===true?p.exitPrice??null:null),
    actualExitPriceVerified:!!settlement.version||p.actualExitPriceVerified===true,
    settlement:settlement.version?pick(settlement,['version','checkedAt','openedAt','closedAt','pnl','pricePnl','fees','funding','entryPrice','exitPrice','match']):null};
}
export function inLiveReviewSession(value:unknown,sessionAt:number){
  const p=obj(value),parity=obj(p.parity);
  return sessionAt>0&&(num(parity.activationAt)!==null?parity.activationAt===sessionAt:
    (num(parity.copiedAt)??num(p.entryAt)??0)>=sessionAt);
}
export function buildLiveReview(input:{live:unknown;account?:unknown;accountAt?:number|null;cached?:unknown[];at:number}){
  const live=obj(input.live),activation=obj(live.activation),sessionAt=num(activation.enabledAt)??0,
    rawMark=obj(live.accountMark),mark=rawMark.sessionAt===sessionAt?rawMark:{},
    account=obj(input.account),history=obj(account.history),cached=input.cached??[],
    allPositions=values(live.positions),positions=allPositions.filter(p=>inLiveReviewSession(p,sessionAt));
  const nativeCurrent=input.accountAt===mark.at&&String(account.user??'')===String(mark.accountUser??'');
  const components=nativeCurrent?{
    pricePnl:accountNumber(history.pnl??account.history_pnl),fees:accountNumber(history.fee??account.history_fee),
    funding:accountNumber(history.fund??account.history_fund)}:{pricePnl:null,fees:null,funding:null};
  return {version:LIVE_REVIEW_VERSION,context:{sessionAt,asOf:input.at,accountUser:mark.accountUser??null},
    session:{...pick(live,['requestedEnabled','operational','lastSyncAt','lastError']),
      ...pick(activation,['enabledAt','sourceStartedAt','sourcePolicy','sourcePolicyAt']),
      excludedSourceIds:rows(activation.excludedSourceIds)},
    account:{...pick(mark,['policy','at','startedAt','initialEquity','initialFloating','initialTradingCash','equity','balance','floating',
      'margin','positionCount','tradingPnl','capitalChange','maxDrawdown']),
      equityChange:num(mark.equity)!==null&&num(mark.initialEquity)!==null?Number(mark.equity)-Number(mark.initialEquity):null,
      capitalMovementResidual:num(mark.capitalChange)!==null&&num(mark.tradingPnl)!==null?Number(mark.capitalChange)-Number(mark.tradingPnl):null,
      realizedTradingCash:num(mark.tradingPnl)!==null&&num(mark.floating)!==null&&num(mark.initialFloating)!==null?
        Number(mark.tradingPnl)-Number(mark.floating)+Number(mark.initialFloating):null,
      floatingChange:num(mark.floating)!==null&&num(mark.initialFloating)!==null?Number(mark.floating)-Number(mark.initialFloating):null,
      baselineDelayMs:num(mark.startedAt)!==null&&sessionAt>0?Number(mark.startedAt)-sessionAt:null,
      cumulativeNativeCashComponents:components,sessionCashComponents:null,
      componentScope:'EXCHANGE_LIFETIME_CUMULATIVE_NOT_SESSION_DELTAS',
      baselineScope:'FIRST_NATIVE_OBSERVATION_IN_SESSION_NOT_RECONSTRUCTED_ENABLE_EQUITY'},
    entries:values(live.entries).filter(e=>(num(obj(e).createdAt)??0)>=sessionAt&&sessionAt>0).slice(-160).map(e=>({
      ...pick(e,['symbol','side','status','createdAt','marketSubmittedAt','contracts','size','notional','margin','leverage','exchangeOrderId','lastError']),
      sourceId:obj(e).mirrorSourceId??obj(e).planId})),
    positions:positions.slice(-160).map(p=>liveReviewPosition(p,cached)),
    audit:rows(live.auditEvents).filter(e=>(num(obj(e).observedAt)??0)>=sessionAt&&sessionAt>0).slice(-100)
      .map(e=>pick(e,['observedAt','symbol','planId','stage','level','reason'])),
    retainedCoverage:{entriesScope:'BOUNDED_CURRENT_ENTRY_MAP_NOT_ALL_SESSION_ENTRIES',
      positionsScope:'CURRENT_MAP_PLUS_PAGED_DURABLE_CLOSES',excludedCarryoverPositions:allPositions.length-positions.length,
      omittedHotPositions:Math.max(0,positions.length-160),cachedSettlementRows:cached.length},
    coverage:{pagesRead:0,recordsRead:0,nextCursor:null as string|null,exhausted:false,limitReached:false,error:null as string|null},
    limits:['Unknown fills or costs remain null; no simulated money is presented as actual money.',
      'Account results include manual trades; program settlement totals have a narrower scope.',
      'Cached native settlements are bounded; older unmatched closes remain pending.']};
}
export type LiveReview=ReturnType<typeof buildLiveReview>;
export function compareLiveReview(review:LiveReview,trades:unknown[],paperComplete:boolean,paperStartedAt?:number){
  const session=obj(review.session),enabledAt=num(session.enabledAt)??0,cutoff=Math.max(enabledAt,num(session.sourcePolicyAt)??0),
    excluded=new Set(rows(session.excludedSourceIds)),sourceAccountMatches=paperStartedAt===undefined||session.sourceStartedAt===paperStartedAt,
    eligible=sourceAccountMatches?trades.map(obj).filter(t=>(num(t.openedAt)??0)>cutoff&&!excluded.has(t.id)):[],
    bySource=new Map(review.positions.map(p=>[p.sourceId,p])),entries=new Map(review.entries.map(e=>[e.sourceId,e]));
  const paired=eligible.map(t=>{
    const p=obj(bySource.get(t.id)),e=obj(entries.get(t.id)),settlement=obj(p.settlement),
      sourceContracts=num(p.sourceContracts),actualContracts=num(p.originalContracts),
      ratio=sourceContracts!==null&&sourceContracts>0&&actualContracts!==null?actualContracts/sourceContracts:null,
      comparable=p.hasReductions!==true&&!(Number(obj(t.realization).sequence)>0),
      modelNet=num(t.netPnl),actualNet=num(settlement.pnl),entry=num(p.entryPrice),sourceEntry=num(t.entryPrice),
      sourceExit=num(t.exitPrice),actualExit=num(p.exitPrice),side=t.side==='LONG'?1:-1;
    return {sourceId:t.id,symbol:t.symbol,paperStatus:t.status,liveStatus:p.status??e.status??'NO_RETAINED_RECEIPT',
      paperEntryPrice:sourceEntry,liveEntryPrice:entry,paperExitPrice:sourceExit,liveExitPrice:actualExit,
      sourceContracts,actualContracts,quantityRatio:ratio,requestedRatio:p.requestedRatio??null,
      paperExitReason:t.exitReason??null,
      lifecycleComparable:comparable,paperNetPnl:modelNet,scaledPaperNetPnl:comparable&&ratio!==null&&modelNet!==null?ratio*modelNet:null,
      liveNetPnl:actualNet,liveFees:settlement.fees??null,liveFunding:settlement.funding??null,
      netDifference:comparable&&actualNet!==null&&ratio!==null&&modelNet!==null?actualNet-ratio*modelNet:null,
      adverseEntryRate:entry!==null&&sourceEntry!==null&&sourceEntry>0?side*(entry-sourceEntry)/sourceEntry:null,
      adverseExitRate:actualExit!==null&&sourceExit!==null&&sourceExit>0?side*(sourceExit-actualExit)/sourceExit:null,
      submitDelayMs:p.submitDelayMs??null,
      fillDelayMs:num(p.entryAt)!==null&&num(t.openedAt)!==null?Number(p.entryAt)-Number(t.openedAt):null,
      exitDelayMs:num(p.exitAt)!==null&&num(t.closedAt)!==null?Number(p.exitAt)-Number(t.closedAt):null};
  });
  const settled=paired.filter(p=>p.liveNetPnl!==null),comparable=settled.filter(p=>p.netDifference!==null);
  const median=(xs:(number|null)[])=>{const v=xs.filter((x):x is number=>x!==null).sort((a,b)=>a-b);
    return v.length?v[Math.floor(v.length/2)]!:null;};
  const adverseShare=(xs:(number|null)[])=>{const v=xs.filter((x):x is number=>x!==null);
    return v.length?v.filter(x=>x>0).length/v.length:null;};
  const softLoss=paired.filter(p=>p.paperExitReason==='INVERSE_SOFT_LOSS_EXIT');
  const executionGap={medianAdverseEntryRate:median(paired.map(p=>p.adverseEntryRate)),
    adverseEntryShare:adverseShare(paired.map(p=>p.adverseEntryRate)),
    medianAdverseExitRate:median(paired.map(p=>p.adverseExitRate)),
    adverseExitShare:adverseShare(paired.map(p=>p.adverseExitRate)),
    medianSubmitDelayMs:median(paired.map(p=>p.submitDelayMs as number|null)),
    medianExitDelayMs:median(paired.map(p=>p.exitDelayMs)),
    softLossExits:{paper:softLoss.length,liveFollowedExit:softLoss.filter(p=>p.liveStatus==='CLOSED').length}};
  return {scope:'POST_ENABLE_INCLUDED_PAPER_ORDERS_NOT_WHOLE_ACCOUNT_RECONCILIATION',paperHistoryComplete:paperComplete,sourceAccountMatches,
    eligibleIncluded:eligible.length,withRetainedReceipt:paired.filter(p=>p.liveStatus!=='NO_RETAINED_RECEIPT').length,
    withoutRetainedReceipt:paired.filter(p=>p.liveStatus==='NO_RETAINED_RECEIPT').length,
    nativeSettledIncluded:settled.length,comparableClosed:comparable.length,
    comparableNetDifference:comparable.length?comparable.reduce((n,p)=>n+p.netDifference!,0):null,
    quantityScaling:'ACTUAL_ORIGINAL_CONTRACTS_OVER_SOURCE_CONTRACTS_AT_COPY; REDUCTIONS_CAN_LIMIT_COMPARABILITY',executionGap,paired};
}
export async function readLiveReviewPage(storage:{list<T>(options:{prefix:string;start:string;end:string;reverse:boolean;limit:number}):Promise<Map<string,T>>},
  context:LiveReview['context'],cursor:string|null,cached:unknown[]=[]){
  const {sessionAt,asOf}=context;
  if(!Number.isSafeInteger(sessionAt)||sessionAt<=0||!Number.isSafeInteger(asOf)||asOf<sessionAt)throw new Error('INVALID_LIVE_REVIEW_RANGE');
  const start=PREFIX+String(sessionAt).padStart(16,'0'),end=PREFIX+String(asOf+1).padStart(16,'0');
  if(cursor&&(!/^live-parity:v1:closed:\d{16}:.+$/.test(cursor)||cursor<start||cursor>=end))throw new Error('INVALID_LIVE_REVIEW_CURSOR');
  const packets=await storage.list<{position:unknown}>({prefix:PREFIX,start,end:cursor??end,reverse:true,limit:LIVE_REVIEW_PAGE_ROWS});
  return {context,positions:[...packets.values()].map(r=>r.position).filter(p=>inLiveReviewSession(p,sessionAt))
    .map(p=>liveReviewPosition(p,cached)),recordsRead:packets.size,
    nextCursor:packets.size===LIVE_REVIEW_PAGE_ROWS?[...packets.keys()].at(-1)!:null,exhausted:packets.size<LIVE_REVIEW_PAGE_ROWS};
}
