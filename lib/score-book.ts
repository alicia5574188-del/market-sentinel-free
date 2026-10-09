/** One half-hour window, one score. Coins that already diverged are not extra proof.
 * The side and the exit pair come from the previous windows, never from this one.
 * Decision trades that crowd only after the next twenty windows still clear cost.
 * Live is never eligible. */
import type {Candle, Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import {INVERSE_COST, type ScoreCoin, type ScoreSample, type ScoreWindow} from './shadow-inverse-ledger.ts';

export const SCORE_POLICY='score-v1' as const;
export const SCORE_EPOCH='score-book-2026-10-09' as const;
export const SCORE_BEFORE=Date.parse('2026-10-10T00:00:00Z');

const WINDOW=30*60_000;
const OPEN_GRACE=90_000;
const NOTIONAL=400;
const LEVERAGE=10;
const FEE=INVERSE_COST.feeRate;
const COST=.0014;
const SPREAD_MAX=.0004;
const CHASE=.0015;
const RESIDUAL_MIN=.005;
const MIN_NAMES=8;
const MIN_CROWD=6;
const TRAIN=20;
const NEED=TRAIN*2;
const VOLUME_MIN=1_000_000;
const LEVELS=[.0035,.005,.009,.012] as const;
const PAIRS=[{stop:.0035,target:.009,stopAt:0,targetAt:2},{stop:.005,target:.012,stopAt:1,targetAt:3}] as const;
const PAIR_TEXT=[['0.35%','0.90%'],['0.50%','1.20%']] as const;

type Meta=Contract&{volume24hUsd?:number};
type Side='LONG'|'SHORT';

const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const dirOf=(side:Side)=>side==='LONG'?1:-1;
const fresh=(q:Quote|undefined,now:number)=>!!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;
export function scoreMedian(xs:number[]){
  if(!xs.length)return 0;
  const a=[...xs].sort((x,y)=>x-y),n=a.length;
  return n%2?a[n>>1]!:(a[n/2-1]!+a[n/2]!)/2;
}
const done=(rows:Candle[]|undefined,now:number,sec:number)=>(rows??[]).filter(r=>r.time>0&&r.high>0&&r.low>0&&r.close>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.time*1000+sec*1000<=now).sort((a,b)=>a.time-b.time);
const liquid=(meta:Meta|undefined)=>!(finite(meta?.volume24hUsd)&&meta!.volume24hUsd<VOLUME_MIN);

export function scoreCoinNet(coin:ScoreCoin,index:number){
  const pair=PAIRS[index>>1]!,revert=index%2===1,d=revert?-coin.dir:coin.dir;
  const stopT=d>0?coin.dn[pair.stopAt]:coin.up[pair.stopAt];
  const targetT=d>0?coin.up[pair.targetAt]:coin.dn[pair.targetAt];
  if(stopT&&targetT&&stopT===targetT)return -(pair.stop+COST);
  if(stopT&&(!targetT||stopT<targetT))return -(pair.stop+COST);
  if(targetT&&(!stopT||targetT<stopT))return pair.target-COST;
  return -COST;
}

/** Train picks one pair and one side. Confirm must still be that one. No runner-up. */
export function chooseScore(samples:ScoreSample[]){
  if(samples.length<NEED)return null;
  const train=samples.slice(-NEED,-TRAIN),confirm=samples.slice(-TRAIN);
  if(scoreMedian(train.map(s=>s.n))<MIN_CROWD||scoreMedian(confirm.map(s=>s.n))<MIN_CROWD)return null;
  let best=-1,bestMed=0;
  for(let i=0;i<4;i++){
    const med=scoreMedian(train.map(s=>s.med[i]!));
    if(med>bestMed){bestMed=med;best=i;}
  }
  if(best<0||!(scoreMedian(confirm.map(s=>s.med[best]!))>0))return null;
  return best;
}

function retOf(rows:Candle[]|undefined,now:number){
  const bars=done(rows,now,300);
  if(bars.length<6)return null;
  const last=bars.at(-1)!,first=bars.at(-6)!;
  if(!(first.open>0)||now-(last.time*1000+300_000)>10*60_000)return null;
  return last.close/first.open-1;
}
function rule(side:Side,now:number,reason:string,stop:number,target:number):Rule{
  return {id:`score-${side}`,signature:SCORE_POLICY,parentId:null,version:1,createdAt:now,expiresAt:now+WINDOW,
    status:'EXPERIMENTAL',conditions:[],side,horizon:30,stopRate:stop,armRate:target,givebackRate:0,
    exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,priorResponse:null,recentResponse:0,
    standardError:0,reason,mutation:'CREATE',grammar:SCORE_POLICY,liveEligible:false};
}
function absorb(coin:ScoreCoin,rows:Candle[]|undefined,start:number,due:number,now:number){
  let changed=false;
  for(const bar of done(rows,now,60)){
    const closeAt=bar.time*1000+60_000;
    if(closeAt<=start||closeAt>due)continue;
    for(let i=0;i<LEVELS.length;i++){
      const level=LEVELS[i]!;
      if(!coin.up[i]&&bar.high>=coin.ref*(1+level)){coin.up[i]=bar.time;changed=true;}
      if(!coin.dn[i]&&bar.low<=coin.ref*(1-level)){coin.dn[i]=bar.time;changed=true;}
    }
  }
  return changed;
}
function sampleOf(window:ScoreWindow):ScoreSample{
  const med=[0,1,2,3].map(index=>scoreMedian(window.coins.map(coin=>scoreCoinNet(coin,index)))) as ScoreSample['med'];
  return {start:window.start,n:window.coins.length,med};
}
function textOf(samples:ScoreSample[],pick:number|null,crowd:number){
  if(samples.length<NEED)return `已经记下 ${samples.length} 窗，还差 ${NEED-samples.length} 窗。每一窗只记一个结果。记满并核对通过才下单。`;
  if(pick==null)return '最近四十窗没有通过核对，或者够格的币不够多。这一窗只记分，不下单。';
  const pair=PAIR_TEXT[pick>>1]!,side=pick%2===0?'顺着这些币相对大多数的方向':'反着这些币相对大多数的方向';
  return `核对通过。止损 ${pair[0]}，目标 ${pair[1]}，${side}。这一窗 ${crowd} 个币够格。`;
}
function closeScore(state:ForwardState,t:Trade,price:number,now:number,reason:string){
  const gross=dirOf(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*FEE,net=gross-t.entryFee-exitFee;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=now;
  t.exitFee=exitFee;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;t.fundingAllowance=0;
  state.balance+=gross-exitFee;state.grossPnl+=gross;state.fees+=exitFee;state.turnover+=t.quantity*price;
  state.resolved++;if(net>0)state.wins++;
  state.positions=state.positions.filter(x=>x.id!==t.id);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,240);
  state.revision++;state.events.unshift({id:`c${state.startedAt}-${state.revision}`,at:now,kind:'EXIT',subject:t.id,reason});
  state.events=state.events.slice(0,160);
}
function pathCall(bars:Candle[],side:Side,stop:number,target:number){
  let stopAt=0,targetAt=0;
  for(const bar of bars){
    const hitStop=side==='LONG'?bar.low<=stop:bar.high>=stop;
    const hitTarget=side==='LONG'?bar.high>=target:bar.low<=target;
    if(hitStop&&!stopAt)stopAt=bar.time;
    if(hitTarget&&!targetAt)targetAt=bar.time;
    if(stopAt&&targetAt)break;
  }
  if(stopAt&&targetAt&&stopAt===targetAt)return 'STOP' as const;
  if(stopAt&&(!targetAt||stopAt<targetAt))return 'STOP' as const;
  if(targetAt&&(!stopAt||targetAt<stopAt))return 'TARGET' as const;
  return null;
}
function exitNow(state:ForwardState,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,now:number){
  let changed=false;
  for(const t of [...state.positions]){
    if(t.exitControl?.policy!==SCORE_POLICY||t.status!=='OPEN')continue;
    const q=quotes[t.symbol];if(!fresh(q,now))continue;
    const quotePx=t.side==='LONG'?q!.bestBid:q!.bestAsk;
    t.lastPrice=quotePx;t.lastQuoteAt=q!.observedAt;
    const signed=dirOf(t.side)*(quotePx/t.entryPrice-1);
    if(signed>t.favorable){t.favorable=signed;t.peakPnlRate=signed;changed=true;}
    t.adverse=Math.max(t.adverse,-signed);
    const bars=done(minutePaths?.[t.symbol],now,60).filter(bar=>bar.time*1000>=t.openedAt);
    const throughStop=t.side==='LONG'?quotePx<=t.stopPrice:quotePx>=t.stopPrice;
    const throughTarget=t.side==='LONG'?quotePx>=t.armPrice:quotePx<=t.armPrice;
    const call=pathCall(bars,t.side,t.stopPrice,t.armPrice)
      ??(throughStop?'STOP':throughTarget?'TARGET':now>=(t.entryContext?.thesisSince??t.openedAt)+WINDOW?'TIME':null);
    if(!call)continue;
    const price=call==='TARGET'?t.armPrice
      :call==='TIME'?quotePx
      :t.side==='LONG'?Math.min(quotePx,t.stopPrice):Math.max(quotePx,t.stopPrice);
    closeScore(state,t,price,now,call==='TARGET'?'SCORE_TARGET_EXIT':call==='TIME'?'SCORE_TIME_EXIT':'SCORE_STOP_EXIT');
    changed=true;
  }
  return changed;
}

function crowd(state:ForwardState,paths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Meta>|undefined,now:number,index:number|null){
  const rets:number[]=[];
  const rows:{symbol:string;residual:number;ret:number}[]=[];
  for(const symbol of Object.keys(paths??{}).sort()){
    if(!liquid(contracts?.[symbol]))continue;
    const ret=retOf(paths?.[symbol],now);if(ret==null)continue;
    rets.push(ret);rows.push({symbol,residual:0,ret});
  }
  if(rets.length<MIN_NAMES)return [];
  const mid=scoreMedian(rets);
  const ranked=rows.map(row=>({...row,residual:row.ret-mid})).filter(row=>Math.abs(row.residual)>=RESIDUAL_MIN)
    .sort((a,b)=>Math.abs(b.residual)-Math.abs(a.residual)||a.symbol.localeCompare(b.symbol));
  let equity=state.balance;
  for(const t of state.positions){
    if(t.exitControl?.policy!==SCORE_POLICY)continue;
    const q=quotes[t.symbol],px=fresh(q,now)?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
    if(px>0)equity+=dirOf(t.side)*t.quantity*(px-t.entryPrice);
  }
  let used=state.positions.filter(t=>t.exitControl?.policy===SCORE_POLICY).reduce((n,t)=>n+t.margin,0);
  const held=new Set(state.positions.map(t=>t.symbol));
  const coins:ScoreCoin[]=[];
  for(const row of ranked){
    if(held.has(row.symbol))continue;
    const q=quotes[row.symbol],contract=contracts?.[row.symbol];
    if(!fresh(q,now)||!contract||!(contract.quantoMultiplier>0))continue;
    const ref=(q!.bestBid+q!.bestAsk)/2,spread=(q!.bestAsk-q!.bestBid)/ref;
    if(!(spread>=0)||spread>SPREAD_MAX)continue;
    const revert=index!=null&&index%2===1;
    const side:Side=(row.residual>0)!==revert?'LONG':'SHORT';
    const price=side==='LONG'?q!.bestAsk:q!.bestBid;
    const worse=side==='LONG'?(price-ref)/ref:(ref-price)/ref;
    if(worse>CHASE)continue;
    const leverage=Math.min(LEVERAGE,Math.max(1,contract.leverageMax||LEVERAGE));
    const mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
    const contractsN=Math.floor(NOTIONAL/(price*mult));
    if(contractsN<min)continue;
    const quantity=contractsN*mult,notional=quantity*price;
    if(notional<80||notional>480)continue;
    const margin=notional/leverage;
    if(!(equity>0)||used+margin>equity*.5)break;
    used+=margin;
    coins.push({symbol:row.symbol,residual:row.residual,ref,dir:row.residual>0?1:-1,up:[0,0,0,0],dn:[0,0,0,0]});
  }
  return coins;
}

function openTrades(state:ForwardState,coins:ScoreCoin[],quotes:Record<string,Quote>,contracts:Record<string,Meta>|undefined,index:number,now:number){
  let changed=false;
  let equity=state.balance;
  for(const t of state.positions){
    if(t.exitControl?.policy!==SCORE_POLICY)continue;
    const q=quotes[t.symbol],px=fresh(q,now)?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
    if(px>0)equity+=dirOf(t.side)*t.quantity*(px-t.entryPrice);
  }
  let used=state.positions.filter(t=>t.exitControl?.policy===SCORE_POLICY).reduce((n,t)=>n+t.margin,0);
  const held=new Set(state.positions.map(t=>t.symbol));
  const pair=PAIRS[index>>1]!,revert=index%2===1;
  for(const coin of coins){
    if(held.has(coin.symbol))continue;
    const q=quotes[coin.symbol],contract=contracts?.[coin.symbol];
    if(!fresh(q,now)||!contract)continue;
    const side:Side=(coin.residual>0)!==revert?'LONG':'SHORT';
    const price=side==='LONG'?q!.bestAsk:q!.bestBid;
    const worse=side==='LONG'?(price-coin.ref)/coin.ref:(coin.ref-price)/coin.ref;
    if(worse>CHASE)continue;
    const leverage=Math.min(LEVERAGE,Math.max(1,contract.leverageMax||LEVERAGE));
    const mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
    const contractsN=Math.floor(NOTIONAL/(price*mult));
    if(contractsN<min)continue;
    const quantity=contractsN*mult,notional=quantity*price;
    if(notional<80||notional>480)continue;
    const margin=notional/leverage;
    if(!(equity>0)||used+margin>equity*.5)break;
    const stop=price*(1-dirOf(side)*pair.stop),target=price*(1+dirOf(side)*pair.target);
    const why=`${coin.symbol}比大多数币${coin.residual>0?'多走':'少走'}了${(Math.abs(coin.residual)*100).toFixed(2)}%。${revert?'反着做。':'顺着做。'}`;
    const id=`sc-${now.toString(36)}-${coin.symbol.replace(/[^A-Z0-9]/g,'').slice(0,24)}-${side[0]}`;
    const t:Trade={id,symbol:coin.symbol,side,rule:rule(side,now,why,pair.stop,pair.target),openedAt:now,closedAt:null,status:'OPEN',
      entryPrice:price,exitPrice:null,quantity,contracts:contractsN,quantoMultiplier:mult,notional,leverage,margin,plannedRisk:notional*pair.stop,
      stopPrice:stop,armPrice:target,favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q!.observedAt,entryFee:notional*FEE,exitFee:0,fundingAllowance:0,
      grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
      firstProfitAt:null,holdScore:0,profitFloorRate:0,expectedHoldMinutes:30,peakPnlRate:0,
      exitControl:{policy:SCORE_POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side,mode:revert?'REVERSAL':'CONTINUATION',reserve:false,reason:why,
        entryScore:0,directionStrength:0,spaceScore:0,positionScore:0,executionScore:0,remainingSpaceRate:pair.target,pullbackRiskRate:pair.stop,
        edgeRatio:0,expectedHoldMinutes:30,marketFit:0,regionId:null,portfolioRiskCharge:notional*pair.stop,strategyVersion:SCORE_POLICY,
        thesisId:`${coin.symbol}:${state.inverseTrial!.scoreOpen?.start??now}`,thesisSince:state.inverseTrial!.scoreOpen?.start??now,entryResidual:coin.residual,
        thesisSummary:why,invalidationSummary:'碰到止损，或者三十分钟两边都没碰到。'}};
    state.balance-=t.entryFee;state.fees+=t.entryFee;state.turnover+=notional;
    state.positions.push(t);held.add(coin.symbol);used+=margin;changed=true;
    state.revision++;state.events.unshift({id:`c${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:id,reason:why});
    state.events=state.events.slice(0,160);
  }
  return changed;
}

export function applyScoreBook(state:ForwardState,paths:Record<string,Candle[]>|undefined,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Contract>|undefined,now:number){
  const trial=state.inverseTrial;
  if(!trial||trial.paperPolicy!==SCORE_POLICY)return false;
  const meta=contracts as Record<string,Meta>|undefined;
  let changed=false;
  const open=trial.scoreOpen??null;
  if(open){
    for(const coin of open.coins)if(absorb(coin,minutePaths?.[coin.symbol],open.start,open.start+WINDOW,now))changed=true;
  }
  if(exitNow(state,minutePaths,quotes,now))changed=true;
  if(open&&now>=open.start+WINDOW){
    if(open.coins.length){
      const samples=trial.scoreSamples??[];
      samples.push(sampleOf(open));
      trial.scoreSamples=samples.slice(-80);
    }
    trial.scoreOpen=null;changed=true;
  }
  const grid=Math.floor(now/WINDOW)*WINDOW;
  if(!trial.scoreOpen&&now-grid<=OPEN_GRACE&&trial.scoreSkip!==grid&&trial.scoreSamples?.at(-1)?.start!==grid){
    const pick=chooseScore(trial.scoreSamples??[]);
    const coins=crowd(state,paths,quotes,meta,now,pick);
    if(!coins.length)trial.scoreSkip=grid;
    else{
      trial.scoreOpen={start:grid,coins};
      if(pick!=null&&openTrades(state,coins,quotes,meta,pick,now))changed=true;
    }
    changed=true;
  }
  const note=textOf(trial.scoreSamples??[],chooseScore(trial.scoreSamples??[]),trial.scoreOpen?.coins.length??0);
  if(trial.scoreNote!==note){trial.scoreNote=note;changed=true;}
  return changed;
}
