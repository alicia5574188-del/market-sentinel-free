/** Fade the last sharp move. A weak spike is a smaller order. A large spike is full size.
 * After 800 labeled outcomes, a small model has to agree the move still pays its cost.
 * Paper and the live switch share this book. Live is not turned on here. */
import type {Candle, Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import type {WorkSheet} from './forward-study.ts';
import {appendRunLog,emptyFunnel,traceOf,type RunEvent} from './run-log.ts';

export const LSR_POLICY='lsr-v1' as const;
export const LSR_EPOCH='lsr-flow-2026-10-10' as const;

const FEE=.0002;
const COST=.0004;
const LEVERAGE=5;
const STOP=.002;
const TP=.003;
const HOLD_MS=900_000;
const WEAK_VOL=1.2;
const WEAK_RET=1;
const LARGE_VOL=3;
const LARGE_RET=2.5;
const SPREAD_MAX=8;
const STALE_MS=2_000;
const COOL_MS=45_000;
const MAKER_MS=3_000;
const MIN_N=30;
const NOTIONAL=100;
const SMALL_NOTIONAL=70;
const MAX_OPEN=10;
const MAX_EXPOSURE=800;
const MAX_ONE=150;
const DAILY_LOSS=100;
const VOLUME_CAP=400_000;
const TRAIN_MIN=800;
const TRAIN_EVERY=900_000;
const LABEL_MS=300_000;
const VOLUME_MIN=1_000_000;

type Meta=Contract&{volume24hUsd?:number};
type Side='LONG'|'SHORT';
type Row={symbol:string;side:Side|null;tier:'large'|'small'|null;layer:string;volZ:number;retZ:number;why:string;x:number[]};
type Working={s:string;side:Side;price:number;at:number;key:string;why:string;bar:number};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const dirOf=(side:Side)=>side==='LONG'?1:-1;
const coin=(symbol:string)=>symbol.replace(/_USDT$/,'').replace(/_/g,'');
const dayKey=(now:number)=>new Date(now+8*3_600_000).toISOString().slice(0,10);

export function isLsrTrade(t:Trade){return t.exitControl?.policy===LSR_POLICY;}

function mean(xs:number[]){return xs.reduce((n,v)=>n+v,0)/xs.length;}
function std(xs:number[]){const m=mean(xs);return Math.sqrt(xs.reduce((n,v)=>n+(v-m)**2,0)/xs.length);}
function zLast(xs:number[]){
  if(xs.length<MIN_N)return null;
  const m=mean(xs),s=std(xs),x=xs.at(-1)!;
  return (x-m)/(s+1e-9);
}
function liquid(meta:Meta|undefined){return !(finite(meta?.volume24hUsd)&&meta!.volume24hUsd<VOLUME_MIN);}
function bookFresh(q:Quote|undefined,now:number){
  return !!q&&q.fresh&&q.bestBid>0&&q.bestAsk>q.bestBid&&q.observedAt<=now&&now-q.observedAt<=STALE_MS;
}
function closed5(rows:Candle[]|undefined,now:number){
  return (rows??[]).filter(row=>row.close>0&&row.volume>=0&&(row.time+300)*1000<=now).slice(-40);
}
function features(rets:number[],volZ:number,retZ:number){
  const sum=(n:number)=>rets.slice(-n).reduce((a,v)=>a+v,0);
  const vol=std(rets);
  const near=std(rets.slice(-15));
  return [sum(3),sum(5),sum(15),vol,volZ,retZ,vol>0?Math.abs(sum(5))/vol:0,near/(vol+1e-9)];
}
function sigmoid(z:number){const x=Math.max(-20,Math.min(20,z));return 1/(1+Math.exp(-x));}

function fitModel(rows:{x:number[];y:number}[]){
  const p=rows[0]!.x.length,meanX=Array(p).fill(0),stdX=Array(p).fill(0);
  for(const row of rows)row.x.forEach((v,i)=>{meanX[i]+=v;});
  meanX.forEach((_,i)=>{meanX[i]/=rows.length;});
  for(const row of rows)row.x.forEach((v,i)=>{stdX[i]+=(v-meanX[i])**2;});
  stdX.forEach((_,i)=>{stdX[i]=Math.sqrt(stdX[i]/rows.length)||1;});
  const w=Array(p+1).fill(0);
  for(let step=0;step<40;step++){
    const g=Array(p+1).fill(0);
    for(const row of rows){
      let z=w[0]!;
      const nx=row.x.map((v,i)=>(v-meanX[i]!) / stdX[i]!);
      nx.forEach((v,i)=>{z+=w[i+1]!*v;});
      const err=sigmoid(z)-row.y;
      g[0]+=err;nx.forEach((v,i)=>{g[i+1]+=err*v;});
    }
    w.forEach((_,i)=>{w[i]-=.15*g[i]!/rows.length;});
  }
  return {w,mean:meanX,std:stdX};
}
function modelPass(state:ForwardState,x:number[]){
  const trial=state.inverseTrial!,n=trial.lsrLearn?.length??0;
  if(n<TRAIN_MIN||!trial.lsrW||!trial.lsrMean||!trial.lsrStd)return {ok:true,p:null as number|null};
  let z=trial.lsrW[0]??0;
  x.forEach((v,i)=>{z+=(trial.lsrW![i+1]??0)*((v-(trial.lsrMean![i]??0))/(trial.lsrStd![i]||1));});
  const p=sigmoid(z);
  return {ok:p>=.5,p};
}

export function readLsr(paths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Meta>|undefined,samples:{s:string;at:number;mp:number}[],cool:Record<string,number>,now:number,pass:(x:number[])=>{ok:boolean;p:number|null}):Row[]{
  const rows:Row[]=[];
  const btc=samples.filter(row=>row.s==='BTC_USDT').map(row=>row.mp);
  const btcRet:number[]=[];
  for(let i=1;i<btc.length;i++)btcRet.push(btc[i]!/btc[i-1]!-1);
  const btcZ=zLast(btcRet)??0;
  for(const symbol of Object.keys(paths??{}).sort()){
    if(!liquid(contracts?.[symbol]))continue;
    const mids=samples.filter(row=>row.s===symbol).map(row=>row.mp);
    const rets:number[]=[];
    for(let i=1;i<mids.length;i++)rets.push(mids[i]!/mids[i-1]!-1);
    const bars=closed5(paths?.[symbol],now);
    const retZ=zLast(rets),volZ=zLast(bars.map(row=>row.volume));
    if(retZ==null||volZ==null){
      rows.push({symbol,side:null,tier:null,layer:'bars',volZ:volZ??0,retZ:retZ??0,x:[],why:`${coin(symbol)} 涨跌样本 ${rets.length}/${MIN_N}，5 分钟量样本 ${bars.length}/${MIN_N}。`});
      continue;
    }
    const q=quotes[symbol];
    const spread=q&&q.bestBid>0?(q.bestAsk-q.bestBid)/q.bestBid*10_000:99;
    const side:Side=retZ<0?'LONG':'SHORT';
    const x=features(rets,volZ,retZ);
    const vz=Math.abs(volZ),rz=Math.abs(retZ);
    let tier:Row['tier']=null,layer='trend',why=`${coin(symbol)} 涨跌 z ${retZ.toFixed(1)}，量 z ${volZ.toFixed(1)}。`;
    if(!(spread<=SPREAD_MAX)){layer='spread';why+=`价差 ${spread.toFixed(2)} bps，超过 8。`;}
    else if(!bookFresh(q,now)){layer='stale';why+='买一卖一超过 2 秒。';}
    else if(now-(cool[symbol]??0)<COOL_MS){layer='trend';why+='这个币 45 秒内刚看过。';}
    else if((side==='LONG'&&btcZ<-2)||(side==='SHORT'&&btcZ>2)){layer='sweep';why+=`大盘 z ${btcZ.toFixed(1)}，这方向先不做。`;}
    else if(vz>=LARGE_VOL&&rz>=LARGE_RET)tier='large';
    else if(vz>=WEAK_VOL&&rz>=WEAK_RET)tier='small';
    else {layer='exhaustion';why+='还没到弱信号，量 z 要 1.2、涨跌 z 要 1。';}
    if(tier){
      const model=pass(x);
      if(!model.ok){tier=null;layer='micro';why+=`模型概率 ${((model.p??0)*100).toFixed(0)}%，不到 50%，不做。`;}
      else {layer='signal';why+=`${tier==='large'?'强信号，100U':'弱信号，70U'}。${side==='LONG'?'急跌做多':'急涨做空'}。${model.p==null?'研究样本还不够 800，先按规则。':`模型 ${(model.p*100).toFixed(0)}%。`}`;}
    }
    rows.push({symbol,side:tier?side:null,tier,layer,volZ,retZ,why,x});
  }
  return rows;
}

function rule(side:Side,now:number,reason:string):Rule{
  return {id:`lsr-${side}`,signature:LSR_POLICY,parentId:null,version:1,createdAt:now,expiresAt:now+HOLD_MS,
    status:'EXPERIMENTAL',conditions:[],side,horizon:15,stopRate:STOP,armRate:TP,givebackRate:0,
    exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,priorResponse:null,recentResponse:0,
    standardError:0,reason,mutation:'CREATE',grammar:LSR_POLICY,liveEligible:false};
}
function pushLog(state:ForwardState,event:Omit<RunEvent,'trace'>){
  const trial=state.inverseTrial;if(!trial)return;
  trial.lsrLog=appendRunLog(trial.lsrLog,{...event,trace:traceOf(event.ts)});
}
function closeLsr(state:ForwardState,t:Trade,price:number,now:number,reason:string){
  const trial=state.inverseTrial!,gross=dirOf(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*FEE,net=gross-t.entryFee-exitFee;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=now;
  t.exitFee=exitFee;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;t.fundingAllowance=0;
  state.balance+=gross-exitFee;state.grossPnl+=gross;state.fees+=exitFee;state.turnover+=t.quantity*price;
  state.resolved++;if(net>0)state.wins++;
  const day=dayKey(now);
  if(trial.lsrDay!==day){trial.lsrDay=day;trial.lsrDayNet=0;trial.lsrDayVol=0;}
  trial.lsrDayNet=(trial.lsrDayNet??0)+net;
  trial.lsrDayVol=(trial.lsrDayVol??0)+t.quantity*price;
  if(trial.lsrFunnel){trial.lsrFunnel.closed++;if(net>0)trial.lsrFunnel.wins++;}
  state.positions=state.positions.filter(x=>x.id!==t.id);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,240);
  pushLog(state,{ts:now,level:'INFO',cat:'PNL',symbol:t.symbol,event:'position_closed',reason,
    fields:{side:t.side,net:Number(net.toFixed(4)),holdSec:Math.round((now-t.openedAt)/1000)}});
  state.revision++;state.events.unshift({id:`l${state.startedAt}-${state.revision}`,at:now,kind:'EXIT',subject:t.id,reason});
  state.events=state.events.slice(0,160);
}

function learn(state:ForwardState,samples:{s:string;mp:number}[],now:number){
  const trial=state.inverseTrial!;
  const pend=trial.lsrPend??[];
  const learned=trial.lsrLearn??[];
  const left:NonNullable<typeof trial.lsrPend>=[];
  for(const row of pend){
    if(now-row.at<LABEL_MS){left.push(row);continue;}
    const mid=samples.filter(sample=>sample.s===row.s).at(-1)?.mp;
    if(!(mid&&row.mid>0))continue;
    learned.push({x:row.x,y:(mid/row.mid-1)>COST?1:0});
  }
  trial.lsrPend=left.slice(-400);
  trial.lsrLearn=learned.slice(-1200);
  if((trial.lsrLearn?.length??0)>=TRAIN_MIN&&now-(trial.lsrFitAt??0)>=TRAIN_EVERY){
    const fit=fitModel(trial.lsrLearn!);
    trial.lsrW=fit.w;trial.lsrMean=fit.mean;trial.lsrStd=fit.std;trial.lsrFitAt=now;
  }
}

/** One path for paper. Live is a switch outside this book, not a second strategy. */
export function applyLsrBook(state:ForwardState,paths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Contract>|undefined,now:number){
  const trial=state.inverseTrial;
  if(!trial||trial.paperPolicy!==LSR_POLICY)return false;
  const meta=contracts as Record<string,Meta>|undefined;
  let changed=false;
  const samples=(trial.lsrMp??[]).filter(row=>now-row.at<=20*60_000);
  for(const [symbol,q] of Object.entries(quotes)){
    if(!bookFresh(q,now))continue;
    const mid=(q.bestBid+q.bestAsk)/2;
    const last=samples.filter(row=>row.s===symbol).at(-1);
    if(last&&now-last.at<1_500&&Math.abs(last.mp-mid)<1e-12)continue;
    samples.push({s:symbol,at:now,mp:mid,bid:q.bestBid,ask:q.bestAsk});
  }
  const capped:typeof samples=[];
  for(const symbol of new Set(samples.map(row=>row.s)))capped.push(...samples.filter(row=>row.s===symbol).slice(-40));
  trial.lsrMp=capped;
  learn(state,capped,now);
  const day=dayKey(now);
  if(trial.lsrDay!==day){trial.lsrDay=day;trial.lsrDayNet=0;trial.lsrDayVol=0;}
  const open=state.positions.filter(isLsrTrade);
  let equity=state.balance;
  for(const t of open){
    const q=quotes[t.symbol];
    if(!bookFresh(q,now))continue;
    const mid=(q!.bestBid+q!.bestAsk)/2;
    const move=dirOf(t.side)*(mid-t.entryPrice)/t.entryPrice;
    t.favorable=Math.max(t.favorable,move);t.adverse=Math.max(t.adverse,-move);t.lastPrice=mid;t.lastQuoteAt=q!.observedAt;
    equity+=dirOf(t.side)*t.quantity*(mid-t.entryPrice)-t.entryFee;
  }
  for(const t of [...open]){
    const q=quotes[t.symbol];
    if(!bookFresh(q,now))continue;
    const hitStop=t.side==='LONG'?q!.bestBid<=t.stopPrice:q!.bestAsk>=t.stopPrice;
    const hitTp=t.side==='LONG'?q!.bestBid>=(t.armPrice??Infinity):q!.bestAsk<=(t.armPrice??0);
    const tooOld=now-t.openedAt>=HOLD_MS;
    if(!hitStop&&!hitTp&&!tooOld)continue;
    const price=t.side==='LONG'?q!.bestBid:q!.bestAsk;
    closeLsr(state,t,price,now,hitStop?'LSR_SL_EXIT':hitTp?'LSR_TP_EXIT':'LSR_TIME_EXIT');
    changed=true;
  }
  const opened:string[]=[];
  let cancelled=0;
  const dailyStopped=(trial.lsrDayNet??0)<=-DAILY_LOSS;
  const blocked=dailyStopped?'今天已亏到 100U，不再开新单。':'';
  const resting=(trial.lsrWork??[]).filter(order=>now-order.at<=MAKER_MS+2_500);
  const kept:Working[]=[];
  const held=new Set(state.positions.filter(isLsrTrade).map(t=>t.symbol));
  if(blocked&&resting.length){
    cancelled+=resting.length;
    pushLog(state,{ts:now,level:'WARN',cat:'RISK',symbol:null,event:'trade_blocked',reason:blocked,fields:{resting:resting.length}});
  }else{
    for(const order of resting){
      if(now-order.at<MAKER_MS){kept.push(order);continue;}
      const q=quotes[order.s];
      const through=!!q&&bookFresh(q,now)&&(order.side==='LONG'?q.bestAsk<=order.price:q.bestBid>=order.price);
      if(!through){cancelled++;pushLog(state,{ts:now,level:'WARN',cat:'EXEC',symbol:order.s,event:'order_timeout_cancelled',reason:'3 秒没打到挂单价',fields:{price:order.price,waitMs:now-order.at}});continue;}
      if(held.has(order.s))continue;
      const contract=meta?.[order.s];
      if(!contract||!(contract.quantoMultiplier>0))continue;
      const notionalWanted=order.why.includes('70U')?SMALL_NOTIONAL:NOTIONAL;
      const price=order.price,mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
      const contractsN=Math.max(min,Math.floor(notionalWanted/(price*mult)));
      const quantity=contractsN*mult,notional=quantity*price;
      const exposure=state.positions.filter(isLsrTrade).reduce((n,t)=>n+t.notional,0);
      if(notional>MAX_ONE||exposure+notional>MAX_EXPOSURE||state.positions.filter(isLsrTrade).length>=MAX_OPEN){
        pushLog(state,{ts:now,level:'WARN',cat:'RISK',symbol:order.s,event:'trade_blocked',reason:'金额或持仓数到顶',fields:{notional:Number(notional.toFixed(2))}});
        continue;
      }
      if((trial.lsrDayVol??0)+notional*2>VOLUME_CAP)continue;
      const side=order.side,stop=price*(1-dirOf(side)*STOP),tp=price*(1+dirOf(side)*TP),name=coin(order.s);
      const why=`${order.why} 挂单价 ${price.toFixed(6)} 成交，名义 ${notional.toFixed(0)} U。`;
      const id=`ls-${now.toString(36)}-${order.s.replace(/[^A-Z0-9]/g,'').slice(0,24)}-${side[0]}`;
      const leverage=Math.min(LEVERAGE,Math.max(1,contract.leverageMax||LEVERAGE));
      const t:Trade={id,symbol:order.s,side,rule:rule(side,now,why),openedAt:now,closedAt:null,status:'OPEN',
        entryPrice:price,exitPrice:null,quantity,contracts:contractsN,quantoMultiplier:mult,notional,leverage,margin:notional/leverage,
        plannedRisk:notional*STOP,stopPrice:stop,armPrice:tp,
        favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q!.observedAt,entryFee:notional*FEE,exitFee:0,fundingAllowance:0,
        grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',
        liveEligible:false,firstProfitAt:null,holdScore:0,profitFloorRate:0,expectedHoldMinutes:15,peakPnlRate:0,
        exitControl:{policy:LSR_POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:STALE_MS},
        entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side,mode:'REVERSAL',reserve:false,reason:why,
          entryScore:0,directionStrength:0,spaceScore:0,positionScore:0,executionScore:0,remainingSpaceRate:TP,
          pullbackRiskRate:STOP,edgeRatio:TP/STOP,expectedHoldMinutes:15,marketFit:0,regionId:null,portfolioRiskCharge:notional*STOP,
          strategyVersion:LSR_POLICY,thesisId:order.key,thesisSince:now,thesisSummary:why,
          invalidationSummary:`止盈 ${tp.toFixed(6)}（0.30%）。止损 ${stop.toFixed(6)}（0.20%）。最长 15 分钟。`}};
      state.balance-=t.entryFee;state.fees+=t.entryFee;state.turnover+=notional;
      trial.lsrDayVol=(trial.lsrDayVol??0)+notional;
      state.positions.push(t);held.add(order.s);equity-=t.entryFee;opened.push(`${name} ${side==='LONG'?'多':'空'} ${notional.toFixed(0)}U`);changed=true;
      pushLog(state,{ts:now,level:'INFO',cat:'EXEC',symbol:order.s,event:'order_filled',reason:'挂单价被打到',fields:{side,price,notional:Number(notional.toFixed(2))}});
      pushLog(state,{ts:now,level:'INFO',cat:'PNL',symbol:order.s,event:'position_opened',reason:why,fields:{side,entry:price,stop:Number(stop.toFixed(6)),tp:Number(tp.toFixed(6))}});
      state.revision++;state.events.unshift({id:`l${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:id,reason:why});
      state.events=state.events.slice(0,160);
    }
  }
  const rows=readLsr(paths,quotes,meta,samples,trial.lsrCool??{},now,x=>modelPass(state,x));
  const signals=rows.filter(row=>row.side);
  const fresh:Working[]=[...kept];
  if(!blocked){
    for(const row of signals.sort((a,b)=>Math.abs(b.retZ)-Math.abs(a.retZ))){
      if(fresh.length+state.positions.filter(isLsrTrade).length>=MAX_OPEN)break;
      const side=row.side!;
      if(held.has(row.symbol)||fresh.some(order=>order.s===row.symbol))continue;
      const q=quotes[row.symbol];
      if(!bookFresh(q,now))continue;
      const exposure=state.positions.filter(isLsrTrade).reduce((n,t)=>n+t.notional,0);
      const want=row.tier==='small'?SMALL_NOTIONAL:NOTIONAL;
      if(exposure+want>MAX_EXPOSURE||(trial.lsrDayVol??0)+want*2>VOLUME_CAP){
        pushLog(state,{ts:now,level:'WARN',cat:'RISK',symbol:row.symbol,event:'trade_blocked',reason:'总仓或今天的成交额到顶',fields:{exposure:Number(exposure.toFixed(0))}});
        continue;
      }
      fresh.push({s:row.symbol,side,price:side==='LONG'?q!.bestBid:q!.bestAsk,at:now,key:`${row.symbol}:${now}:${side}`,why:row.why,bar:0});
      trial.lsrCool={...trial.lsrCool,[row.symbol]:now};
      const pend=trial.lsrPend??[];
      if(!pend.some(item=>item.s===row.symbol&&now-item.at<LABEL_MS))pend.push({s:row.symbol,at:now,mid:(q!.bestBid+q!.bestAsk)/2,x:row.x});
      trial.lsrPend=pend.slice(-400);
      pushLog(state,{ts:now,level:'INFO',cat:'EXEC',symbol:row.symbol,event:'order_placing',reason:row.tier==='large'?'强信号，挂 100U':'弱信号，挂 70U',fields:{side,price:side==='LONG'?q!.bestBid:q!.bestAsk,volZ:Number(row.volZ.toFixed(2)),retZ:Number(row.retZ.toFixed(2))}});
      changed=true;
    }
  }
  trial.lsrWork=fresh.slice(0,MAX_OPEN);
  const funnel=trial.lsrFunnel?.day===day?trial.lsrFunnel:emptyFunnel(day);
  funnel.scans++;funnel.universe=rows.length;
  for(const row of rows){if(row.layer==='stale')funnel.stale++;else if(row.layer==='spread')funnel.spread++;
    else if(row.layer==='trend'||row.layer==='bars')funnel.trend++;else if(row.layer==='exhaustion')funnel.exhaustion++;
    else if(row.layer==='sweep')funnel.sweep++;else if(row.layer==='micro')funnel.micro++;}
  funnel.signals+=signals.length;funnel.rested+=fresh.filter(order=>order.at===now).length;funnel.filled+=opened.length;funnel.cancelled+=cancelled;
  trial.lsrFunnel=funnel;
  const lastScan=[...(trial.lsrLog??[])].reverse().find(event=>event.event==='scan_done');
  if(!lastScan||now-lastScan.ts>=60_000)pushLog(state,{ts:now,level:'INFO',cat:'STRAT',symbol:null,event:'scan_done',reason:rows[0]?.why??'这一拍没有币',
    fields:{universe:rows.length,signals:signals.length,learn:trial.lsrLearn?.length??0,model:(trial.lsrLearn?.length??0)>=TRAIN_MIN}});
  const ranked=[...rows].sort((a,b)=>Math.abs(b.retZ)-Math.abs(a.retZ)).slice(0,4);
  const learned=trial.lsrLearn?.length??0;
  const work:WorkSheet={subject:'急跌做多，急涨做空。规则先选，研究模型后决定做不做。',
    method:'每 2 秒看一次真实行情。最近 30 下的涨跌 z、最近 30 根 5 分钟的成交量 z。弱信号 z 到 1 和 1.2，下 70U。强信号 z 到 2.5 和 3，下 100U。价差超过 8 bps 不做。同一币 45 秒内不重复。挂买一或卖一，3 秒没打到就撤。止盈 0.30%，止损 0.20%，最长 15 分钟。样本够 800 条后，模型概率不到 50% 不做。',
    lines:[
      {name:'1. 涨跌',data:'最近 30 下报价。最后一下偏跌就准备做多，偏涨就准备做空。',said:ranked[0]?ranked.map(row=>`${coin(row.symbol)} 涨跌 z ${row.retZ.toFixed(1)}`).join('；'):'报价还不够 30 下。'},
      {name:'2. 放量',data:'最近 30 根已收盘 5 分钟。这一根成交量 z 弱信号要到 1.2，强信号要到 3。',said:ranked[0]?ranked.map(row=>`${coin(row.symbol)} 量 z ${row.volZ.toFixed(1)}${row.tier==='large'?'，强':row.tier==='small'?'，弱':''}`).join('；'):'5 分钟还不够 30 根。'},
      {name:'3. 研究',data:'每笔信号记下当时的特征。5 分钟后看价格有没有走出手续费。够 800 条才训练，之后概率不到 50% 不做。',said:learned<TRAIN_MIN?`已有 ${learned} / 800 条。现在先按规则做。`:`模型已在用。不够的概率记在「模型拦住」。`},
      {name:'4. 风控',data:'同时最多 10 笔。总名义 800U。今天亏到 100U 停。今天成交额 40 万 U 停。手续费按挂单 0.02% 算。',said:blocked||`今天盈亏 ${((trial.lsrDayNet??0)).toFixed(2)} U。成交额 ${((trial.lsrDayVol??0)).toFixed(0)} U。挂单 ${trial.lsrWork?.length??0} 笔。`}],
    waiting:blocked||(trial.lsrWork?.length?'挂单还在，3 秒内价格打到才成交。':signals.length?'有信号，正在挂买一或卖一。':'在等涨跌和放量同时极端。'),
    preparing:opened.length?`这一拍开了 ${opened.join('，')}。`:'这一拍没有开仓。'};
  const note=opened.length?`开了 ${opened.length} 笔。`:(signals[0]?.why??ranked[0]?.why??'这一拍没有信号。');
  if(trial.lsrNote!==note||JSON.stringify(trial.work)!==JSON.stringify(work)||trial.lsrLog?.at(-1)?.ts===now||funnel.scans%15===0){trial.lsrNote=note;trial.work=work;changed=true;}
  return changed;
}
