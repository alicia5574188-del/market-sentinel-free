/** Fade a completed spike. A 15-minute move must be a new extreme, and the last
 * closed 5-minute bar must be a high-volume sweep that has already started back.
 * Entry is the Gate touch, never a cross. Live stays off. */
import {INVERSE_COST} from './shadow-inverse-ledger.ts';
import type {Candle, Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import type {WorkSheet} from './forward-study.ts';
import {appendRunLog,emptyFunnel,traceOf,type RunEvent} from './run-log.ts';

export const LSR_POLICY='lsr-v1' as const;
export const LSR_EPOCH='lsr-book-2026-10-10' as const;

const FEE=INVERSE_COST.feeRate;
const LEVERAGE=5;
const STOP=.002;
const TP=.003;
const BREAKEVEN=.0012;
const TIME_MS=180_000;
const VOL_Z=3;
const RET_Z=2.5;
const STRONG_VOL=4;
const STRONG_RET=3.5;
const SPREAD_MAX=.0005;
const STALE_MS=2_000;
const WINDOW_MS=8_000;
const MIN_POINTS=4;
/** The book is scanned every two seconds, so a 1.5s order is checked on the next scan. */
const MAKER_MS=2_500;
const DISAGREE=.015;
const MAX_OPEN=5;
const RISK=.001;
const DAILY_LOSS=.02;
const LOSS_PAUSE=5;
const PAUSE_MS=30*60_000;
const BARS=20;
const VOLUME_MIN=1_000_000;

type Meta=Contract&{volume24hUsd?:number};
type Bar={time:number;open:number;high:number;low:number;close:number;volume:number};
type Side='LONG'|'SHORT';
type Row={symbol:string;side:Side|null;strong:boolean;layer:string;ret:number;p95:number;volZ:number;retZ:number;why:string;bar:number;close:number};
type Sample={s:string;at:number;mp:number;bid:number;ask:number};
type Working={s:string;side:Side;price:number;at:number;key:string;why:string;bar:number};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const dirOf=(side:Side)=>side==='LONG'?1:-1;
const coin=(symbol:string)=>symbol.replace(/_USDT$/,'').replace(/_/g,'');
const pct=(n:number)=>`${n>=0?'+':''}${(n*100).toFixed(2)}%`;
const dayKey=(now:number)=>new Date(now+8*3_600_000).toISOString().slice(0,10);

export function isLsrTrade(t:Trade){return t.exitControl?.policy===LSR_POLICY;}

function closed5(rows:Candle[]|undefined,now:number):Bar[]{
  return (rows??[]).filter(row=>row.time>0&&row.open>0&&row.high>0&&row.low>0&&row.close>0&&row.volume>=0
    &&row.high>=Math.max(row.open,row.close)&&row.low<=Math.min(row.open,row.close)
    &&row.time*1000+300_000<=now).sort((a,b)=>a.time-b.time);
}
function fifteens(rows:Bar[]):Bar[]{
  const groups=new Map<number,Bar[]>();
  for(const row of rows){
    const bucket=Math.floor(row.time/900)*900;
    const list=groups.get(bucket)??[];
    list.push(row);groups.set(bucket,list);
  }
  const out:Bar[]=[];
  for(const [bucket,list] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
    const first=list.find(row=>row.time===bucket),last=list.find(row=>row.time===bucket+600);
    if(!first||!last)continue;
    out.push({time:bucket,open:first.open,high:Math.max(...list.map(row=>row.high)),low:Math.min(...list.map(row=>row.low)),
      close:last.close,volume:list.reduce((n,row)=>n+row.volume,0)});
  }
  return out;
}
function zscore(x:number,xs:number[]){
  if(xs.length<BARS)return 0;
  const mean=xs.reduce((n,v)=>n+v,0)/xs.length;
  const sd=Math.sqrt(xs.reduce((n,v)=>n+(v-mean)**2,0)/xs.length);
  if(sd<1e-12)return x>mean?99:x<mean?-99:0;
  return (x-mean)/sd;
}
function p95(xs:number[]){
  const sorted=xs.map(v=>Math.abs(v)).sort((a,b)=>a-b);
  if(!sorted.length)return Number.POSITIVE_INFINITY;
  return sorted[Math.max(0,Math.min(sorted.length-1,Math.ceil(.95*sorted.length)-1))]!;
}
function liquid(meta:Meta|undefined){return !(finite(meta?.volume24hUsd)&&meta!.volume24hUsd<VOLUME_MIN);}
function micro(q:Quote){
  const imbalance=finite(q.bookImbalance)?Math.max(-1,Math.min(1,q.bookImbalance)):0;
  return (q.bestBid*(1-imbalance)+q.bestAsk*(1+imbalance))/2;
}
function bookFresh(q:Quote|undefined,now:number){
  return !!q&&q.fresh&&q.bestBid>0&&q.bestAsk>q.bestBid&&q.observedAt<=now&&now-q.observedAt<=STALE_MS;
}

export function readLsr(paths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Meta>|undefined,samples:Sample[],now:number):Row[]{
  const rows:Row[]=[];
  for(const symbol of Object.keys(paths??{}).sort()){
    if(!liquid(contracts?.[symbol]))continue;
    const fives=closed5(paths?.[symbol],now);
    const bars=fifteens(fives);
    if(bars.length<BARS+1||fives.length<BARS+2){
      rows.push({symbol,side:null,strong:false,layer:'bars',ret:0,p95:0,volZ:0,retZ:0,bar:0,close:0,why:`${coin(symbol)} 已收盘的 15 分钟不够 ${BARS} 根。`});
      continue;
    }
    const history=bars.slice(-BARS-1,-1),current=bars.at(-1)!;
    const rets:number[]=[];
    for(let i=1;i<history.length;i++)rets.push(history[i]!.close/history[i-1]!.close-1);
    const ret=current.close/history.at(-1)!.close-1,band=p95(rets);
    const volHist=fives.slice(-BARS-1,-1),last5=fives.at(-1)!,prev5=fives.at(-2)!;
    const volZ=zscore(last5.volume,volHist.map(row=>row.volume));
    const retBars=fives.slice(-BARS-2,-1);
    const ret5s:number[]=[];
    for(let i=1;i<retBars.length;i++)ret5s.push(retBars[i]!.close/retBars[i-1]!.close-1);
    const ret5=last5.close/prev5.close-1,retZ=zscore(ret5,ret5s);
    const window=samples.filter(row=>row.s===symbol&&now-row.at<=WINDOW_MS).sort((a,b)=>a.at-b.at);
    const trend:Side|null=Math.abs(ret)>=band&&ret<0?'LONG':Math.abs(ret)>=band&&ret>0?'SHORT':null;
    const q=quotes[symbol];
    const spread=q&&q.bestBid>0?(q.bestAsk-q.bestBid)/q.bestBid:1;
    const stale=!bookFresh(q,now);
    const disagree=(q?.sourceCount??0)>=2&&(q?.disagreementRate??0)>DISAGREE;
    const mp=q?micro(q):0;
    const earlier=window.slice(0,-1);
    const ma=earlier.length>=MIN_POINTS-1?earlier.reduce((n,row)=>n+row.mp,0)/earlier.length:null;
    const bounced=ma!=null&&(ret5<0?mp>ma:mp<ma);
    const bids=window.map(row=>row.bid),asks=window.map(row=>row.ask);
    const sweepLong=window.length>=MIN_POINTS&&Math.min(...bids)<window[0]!.bid&&window.at(-1)!.bid>Math.min(...bids);
    const sweepShort=window.length>=MIN_POINTS&&Math.max(...asks)>window[0]!.ask&&window.at(-1)!.ask<Math.max(...asks);
    const strong=volZ>=STRONG_VOL&&Math.abs(retZ)>=STRONG_RET;
    let side:Side|null=null,layer='trend',why=`${coin(symbol)} 这一根 15 分钟 ${pct(ret)}，95% 分位是 ${pct(band)}。`;
    if(!trend)why+=`没有急到分位外面。量 z ${volZ.toFixed(1)}，涨跌 z ${retZ.toFixed(1)}。`;
    else if(volZ<VOL_Z||Math.abs(retZ)<RET_Z){layer='exhaustion';why+=`方向有了，但 5 分钟量 z ${volZ.toFixed(1)}、涨跌 z ${retZ.toFixed(1)}，还没到 3 和 2.5。`;}
    else if(trend==='LONG'&&!sweepLong){layer='sweep';why+=`急跌了，近 8 秒的买一还没有扫出新低再停住。现在 ${window.length} 个点。`;}
    else if(trend==='SHORT'&&!sweepShort){layer='sweep';why+=`急涨了，近 8 秒的卖一还没有扫出新高再停住。现在 ${window.length} 个点。`;}
    else if(stale){layer='stale';why+='Gate 买一卖一超过 2 秒，先跳过。';}
    else if(!(spread<=SPREAD_MAX)){layer='spread';why+=`价差 ${(spread*100).toFixed(3)}%，超过 0.05%。`;}
    else if(disagree){layer='price';why+='外部交易所价格差超过 1.5%，这根不用。';}
    else if(ma==null){layer='micro';why+=`microprice 8 秒里要有 4 个点，现在 ${window.length} 个。`;}
    else if(!bounced){layer='micro';why+='microprice 还没有往回摆。';}
    else if(trend==='LONG'&&!(retZ<=-RET_Z)){layer='exhaustion';why+='15 分钟在跌，5 分钟涨跌 z 不够负。';}
    else if(trend==='SHORT'&&!(retZ>=RET_Z)){layer='exhaustion';why+='15 分钟在涨，5 分钟涨跌 z 不够正。';}
    else {side=trend;layer='signal';why=`${coin(symbol)} 15 分钟 ${pct(ret)}，超过分位 ${pct(band)}。5 分钟量 z ${volZ.toFixed(1)}，涨跌 z ${retZ.toFixed(1)}。${strong?'强信号，这一次就挂。':'弱信号，要连续两次才挂。'}`;}
    rows.push({symbol,side,strong,layer,ret,p95:band,volZ,retZ,why,bar:last5.time,close:last5.close});
  }
  return rows;
}

function rule(side:Side,now:number,reason:string):Rule{
  return {id:`lsr-${side}`,signature:LSR_POLICY,parentId:null,version:1,createdAt:now,expiresAt:now+TIME_MS,
    status:'EXPERIMENTAL',conditions:[],side,horizon:3,stopRate:STOP,armRate:TP,givebackRate:0,
    exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,priorResponse:null,recentResponse:0,
    standardError:0,reason,mutation:'CREATE',grammar:LSR_POLICY,liveEligible:false};
}
function pushLog(state:ForwardState,event:Omit<RunEvent,'trace'>){
  const trial=state.inverseTrial;if(!trial)return;
  trial.lsrLog=appendRunLog(trial.lsrLog,{...event,trace:traceOf(event.ts)});
}
function remember(state:ForwardState,key:string){
  const seen=state.inverseTrial!.lsrSeen??[];
  if(!seen.includes(key))seen.push(key);
  state.inverseTrial!.lsrSeen=seen.slice(-400);
}
function closeLsr(state:ForwardState,t:Trade,price:number,now:number,reason:string){
  const trial=state.inverseTrial!,gross=dirOf(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*FEE,net=gross-t.entryFee-exitFee;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=now;
  t.exitFee=exitFee;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;t.fundingAllowance=0;
  state.balance+=gross-exitFee;state.grossPnl+=gross;state.fees+=exitFee;state.turnover+=t.quantity*price;
  state.resolved++;if(net>0)state.wins++;
  const day=dayKey(now);
  if(trial.lsrDay!==day){trial.lsrDay=day;trial.lsrDayNet=0;}
  trial.lsrDayNet=(trial.lsrDayNet??0)+net;
  trial.lsrLosses=net<0?(trial.lsrLosses??0)+1:0;
  if(trial.lsrFunnel){trial.lsrFunnel.closed++;if(net>0)trial.lsrFunnel.wins++;}
  if((trial.lsrLosses??0)>=LOSS_PAUSE)trial.lsrPauseUntil=now+PAUSE_MS;
  state.positions=state.positions.filter(x=>x.id!==t.id);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,240);
  pushLog(state,{ts:now,level:'INFO',cat:'PNL',symbol:t.symbol,event:'position_closed',reason,
    fields:{side:t.side,net:Number(net.toFixed(4)),holdSec:Math.round((now-t.openedAt)/1000)}});
  state.revision++;state.events.unshift({id:`l${state.startedAt}-${state.revision}`,at:now,kind:'EXIT',subject:t.id,reason});
  state.events=state.events.slice(0,160);
}

/** Mark the book, then fade at most five fresh sweeps. */
export function applyLsrBook(state:ForwardState,paths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Contract>|undefined,now:number){
  const trial=state.inverseTrial;
  if(!trial||trial.paperPolicy!==LSR_POLICY)return false;
  const meta=contracts as Record<string,Meta>|undefined;
  let changed=false;
  const samples=(trial.lsrMp??[]).filter(row=>now-row.at<=15_000);
  for(const [symbol,q] of Object.entries(quotes)){
    if(!bookFresh(q,now))continue;
    const mp=micro(q),last=samples.filter(row=>row.s===symbol).at(-1);
    if(!last||now-last.at>=1_000)samples.push({s:symbol,at:now,mp,bid:q.bestBid,ask:q.bestAsk});
  }
  trial.lsrMp=samples.slice(-240);
  for(const t of [...state.positions]){
    if(!isLsrTrade(t)||t.status!=='OPEN')continue;
    const q=quotes[t.symbol];if(!bookFresh(q,now))continue;
    const px=t.side==='LONG'?q!.bestBid:q!.bestAsk,signed=dirOf(t.side)*(px/t.entryPrice-1);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;
    if(signed>t.favorable){t.favorable=signed;t.peakPnlRate=signed;changed=true;}
    t.adverse=Math.max(t.adverse,-signed);
    if(!t.exitControl?.armedAt&&signed>=BREAKEVEN){
      t.stopPrice=t.entryPrice;t.exitControl!.armedAt=now;changed=true;
    }
    const through=t.side==='LONG'?px<=t.stopPrice:px>=t.stopPrice;
    const target=t.side==='LONG'?px>=t.armPrice:px<=t.armPrice;
    let reason:string|null=null;
    if(target)reason='LSR_TP_EXIT';
    else if(through)reason=t.exitControl?.armedAt?'LSR_BE_EXIT':'LSR_SL_EXIT';
    else if(now-t.openedAt>=TIME_MS&&signed<=0)reason='LSR_TIME_EXIT';
    if(!reason)continue;
    const fill=reason==='LSR_TP_EXIT'?t.armPrice:px;
    closeLsr(state,t,fill,now,reason);changed=true;
  }
  const rows=readLsr(paths,quotes,meta,trial.lsrMp??[],now);
  const signals=rows.filter(row=>row.side);
  for(const row of signals){
    const open=state.positions.find(t=>isLsrTrade(t)&&t.symbol===row.symbol&&t.status==='OPEN');
    if(!open||open.side===row.side)continue;
    const q=quotes[row.symbol];if(!bookFresh(q,now))continue;
    closeLsr(state,open,open.side==='LONG'?q!.bestBid:q!.bestAsk,now,'LSR_REVERSE_EXIT');changed=true;
  }
  let equity=state.balance;
  for(const t of state.positions){
    if(!isLsrTrade(t))continue;
    const q=quotes[t.symbol],px=bookFresh(q,now)?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
    if(px>0)equity+=dirOf(t.side)*t.quantity*(px-t.entryPrice);
  }
  const day=dayKey(now);
  if(trial.lsrDay!==day){trial.lsrDay=day;trial.lsrDayNet=0;changed=true;}
  const paused=(trial.lsrPauseUntil??0)>now;
  const dailyStopped=(trial.lsrDayNet??0)<=-state.initialEquity*DAILY_LOSS;
  const held=new Set(state.positions.filter(isLsrTrade).map(t=>t.symbol));
  let used=state.positions.filter(isLsrTrade).reduce((n,t)=>n+t.margin,0);
  const opened:string[]=[];
  let cancelled=0;
  const blocked=paused?`连亏 ${LOSS_PAUSE} 笔，暂停到 ${new Date((trial.lsrPauseUntil??now)+8*3_600_000).toISOString().slice(11,16)} 北京时间。`
    :dailyStopped?'今天已亏到权益的 2%，不再开新单。':'';
  const resting=(trial.lsrWork??[]).filter(order=>now-order.at<=MAKER_MS);
  const kept:Working[]=[];
  if(blocked&&resting.length){
    pushLog(state,{ts:now,level:'WARN',cat:'RISK',symbol:null,event:'trade_blocked',reason:blocked,fields:{resting:resting.length}});
    cancelled+=resting.length;
  }
  if(!blocked){
    for(const order of resting){
      if(now-order.at<1_000){kept.push(order);continue;}
      const q=quotes[order.s];
      const through=!!q&&bookFresh(q,now)&&(order.side==='LONG'?q.bestBid<order.price:q.bestAsk>order.price);
      if(!through){cancelled++;pushLog(state,{ts:now,level:'WARN',cat:'EXEC',symbol:order.s,event:'order_timeout_cancelled',reason:'下一次扫描没打到挂单价',fields:{price:order.price,waitMs:now-order.at}});continue;}
      if(held.has(order.s)||state.positions.filter(isLsrTrade).length>=MAX_OPEN)continue;
      const contract=meta?.[order.s];
      if(!contract||!(contract.quantoMultiplier>0))continue;
      const side=order.side,price=order.price;
      const leverage=Math.min(LEVERAGE,Math.max(1,contract.leverageMax||LEVERAGE));
      const target=equity*RISK/STOP,mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
      const contractsN=Math.floor(target/(price*mult));
      if(contractsN<min){remember(state,order.key);changed=true;continue;}
      const quantity=contractsN*mult,notional=quantity*price,margin=notional/leverage;
      if(notional<target*.7||used+margin>equity*.9)continue;
      const stop=price*(1-dirOf(side)*STOP),tp=price*(1+dirOf(side)*TP),name=coin(order.s);
      const why=`${order.why} ${side==='LONG'?'买一':'卖一'}被打到，按挂单价 ${price.toFixed(6)} 成交，名义 ${notional.toFixed(0)} U。`;
      const id=`ls-${now.toString(36)}-${order.s.replace(/[^A-Z0-9]/g,'').slice(0,24)}-${side[0]}`;
      const t:Trade={id,symbol:order.s,side,rule:rule(side,now,why),openedAt:now,closedAt:null,status:'OPEN',
        entryPrice:price,exitPrice:null,quantity,contracts:contractsN,quantoMultiplier:mult,notional,leverage,margin,
        plannedRisk:notional*STOP,stopPrice:stop,armPrice:tp,
        favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q!.observedAt,entryFee:notional*FEE,exitFee:0,fundingAllowance:0,
        grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',
        liveEligible:false,firstProfitAt:null,holdScore:0,profitFloorRate:0,expectedHoldMinutes:3,peakPnlRate:0,
        exitControl:{policy:LSR_POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:STALE_MS},
        entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side,mode:'REVERSAL',reserve:false,reason:why,
          entryScore:0,directionStrength:0,spaceScore:0,positionScore:0,executionScore:0,remainingSpaceRate:TP,
          pullbackRiskRate:STOP,edgeRatio:TP/STOP,expectedHoldMinutes:3,marketFit:0,regionId:null,portfolioRiskCharge:notional*STOP,
          strategyVersion:LSR_POLICY,thesisId:order.key,thesisSince:order.bar*1000,thesisSummary:why,
          invalidationSummary:`止盈 ${tp.toFixed(6)}（0.30%）。止损 ${stop.toFixed(6)}（0.20%），到了按对手价走。浮盈 0.12% 把止损改到成本。满 3 分钟还不赚就走。出现反向信号也走。`}};
      state.balance-=t.entryFee;state.fees+=t.entryFee;state.turnover+=notional;
      state.positions.push(t);remember(state,order.key);held.add(order.s);used+=margin;equity-=t.entryFee;opened.push(`${name} ${side==='LONG'?'多':'空'} ${notional.toFixed(0)}U`);changed=true;
      pushLog(state,{ts:now,level:'INFO',cat:'EXEC',symbol:order.s,event:'order_filled',reason:'挂单价被打到',fields:{side,price,notional:Number(notional.toFixed(2))}});
      pushLog(state,{ts:now,level:'INFO',cat:'PNL',symbol:order.s,event:'position_opened',reason:why,fields:{side,entry:price,stop:Number(stop.toFixed(6)),tp:Number(tp.toFixed(6))}});
      state.revision++;state.events.unshift({id:`l${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:id,reason:why});
      state.events=state.events.slice(0,160);
    }
  }
  const prior=new Map((trial.lsrLast??[]).filter(row=>now-row.at<=4_000).map(row=>[row.s,row]));
  const fresh:Working[]=[...kept];
  if(!blocked){
    for(const row of [...signals].sort((a,b)=>Math.abs(b.retZ)-Math.abs(a.retZ))){
      if(fresh.length+state.positions.filter(isLsrTrade).length>=MAX_OPEN)break;
      const side=row.side!,key=`${row.symbol}:${row.bar}:${side}`;
      if(held.has(row.symbol)||fresh.some(order=>order.s===row.symbol)||trial.lsrSeen?.includes(key))continue;
      const again=prior.get(row.symbol)?.side===side;
      if(!row.strong&&!again)continue;
      const q=quotes[row.symbol];
      if(!bookFresh(q,now))continue;
      fresh.push({s:row.symbol,side,price:side==='LONG'?q!.bestBid:q!.bestAsk,at:now,key,why:row.why,bar:row.bar});
      pushLog(state,{ts:now,level:'INFO',cat:'EXEC',symbol:row.symbol,event:'order_placing',reason:row.strong?'强信号，挂买一或卖一':'弱信号连续两次，挂买一或卖一',fields:{side,price:side==='LONG'?q!.bestBid:q!.bestAsk,volZ:Number(row.volZ.toFixed(2)),retZ:Number(row.retZ.toFixed(2))}});
      changed=true;
    }
  }
  trial.lsrWork=fresh.slice(0,MAX_OPEN);
  trial.lsrLast=signals.map(row=>({s:row.symbol,side:row.side!,at:now}));
  const funnel=trial.lsrFunnel?.day===day?trial.lsrFunnel:emptyFunnel(day);
  funnel.scans++;funnel.universe=rows.length;
  for(const row of rows){if(row.layer==='stale')funnel.stale++;else if(row.layer==='spread')funnel.spread++;else if(row.layer==='price')funnel.priceCheck++;
    else if(row.layer==='trend')funnel.trend++;else if(row.layer==='exhaustion')funnel.exhaustion++;else if(row.layer==='sweep')funnel.sweep++;else if(row.layer==='micro')funnel.micro++;}
  funnel.signals+=signals.length;funnel.rested+=fresh.filter(order=>order.at===now).length;funnel.filled+=opened.length;funnel.cancelled+=cancelled;
  trial.lsrFunnel=funnel;
  const lastScan=[...(trial.lsrLog??[])].reverse().find(event=>event.event==='scan_done');
  if(!lastScan||now-lastScan.ts>=60_000)pushLog(state,{ts:now,level:'INFO',cat:'STRAT',symbol:null,event:'scan_done',reason:rows[0]?.why??'这一拍没有币',
    fields:{universe:rows.length,signals:signals.length,stale:funnel.stale,spread:funnel.spread,trend:funnel.trend,exhaustion:funnel.exhaustion,sweep:funnel.sweep,micro:funnel.micro}});
  if(blocked){const lastRisk=[...(trial.lsrLog??[])].reverse().find(event=>event.event==='trade_blocked');if(!lastRisk||now-lastRisk.ts>=60_000)pushLog(state,{ts:now,level:'WARN',cat:'RISK',symbol:null,event:'trade_blocked',reason:blocked,fields:{paused,dailyStopped}});}
  const ranked=[...rows].sort((a,b)=>Math.abs(b.retZ)-Math.abs(a.retZ)).slice(0,4);
  const work:WorkSheet={subject:'找刚走极端、又开始收回来的币，逆着这一下做。',
    method:'每 2 秒看一次。15 分钟这一根要到近 20 根绝对涨跌的 95% 分位外面。5 分钟量 z 至少 3、涨跌 z 绝对值至少 2.5。近 8 秒的买一或卖一要先扫出去再停住，microprice 用这 8 秒至少 4 个点，并且已经往回摆。量 z 到 4 且涨跌 z 到 3.5 是强信号，这一次就挂。弱信号要连续两次。挂在买一或卖一，下一次扫描打到挂单价才成交，没打到就撤。不跨价。',
    lines:[
      {name:'1. 趋势',data:'最近 20 根已收盘 15 分钟。这一根的涨跌幅要大于等于前面这些涨跌幅绝对值的 95% 分位。',said:ranked[0]?ranked.map(row=>`${coin(row.symbol)} ${pct(row.ret)} / 分位 ${pct(row.p95)}`).join('；'):'还没有足够的 15 分钟线。'},
      {name:'2. 衰竭',data:'最近一根已收盘 5 分钟，成交量 z 至少 3，涨跌 z 绝对值至少 2.5。近 8 秒要扫出新低或新高，然后停住。',said:ranked[0]?ranked.map(row=>`${coin(row.symbol)} 量 z ${row.volZ.toFixed(1)}，涨跌 z ${row.retZ.toFixed(1)}${row.strong?'，强':''}`).join('；'):'5 分钟样本不够。'},
      {name:'3. 盘口',data:'只认 Gate 买一卖一。超过 2 秒、价差超过 0.05%，或两家以上外部价格差超过 1.5%，不做。microprice 看 8 秒。',said:signals.length?signals.map(row=>row.why).join(' '):(trial.lsrWork?.length?`挂着 ${trial.lsrWork.map(order=>coin(order.s)).join('，')}，等价格打到挂单价。`:ranked[0]?.why??'这一拍没有信号。')},
      {name:'4. 风控',data:'同时最多 5 笔。每笔亏损按权益的 0.1% 算，止损 0.20%，名义大约是权益的一半。今天亏到 2% 停新单。连亏 5 笔停 30 分钟。止盈 0.30%，浮盈 0.12% 改到成本，满 3 分钟还不赚就走。',said:blocked||`今天 ${((trial.lsrDayNet??0)).toFixed(2)} U。连亏 ${trial.lsrLosses??0} 笔。挂单 ${trial.lsrWork?.length??0} 笔。`}],
    waiting:blocked||(trial.lsrWork?.length?'挂单还在，下一次扫描价格打到才成交。':signals.length?'有信号。弱的要再确认一次，强的这一次就挂。':'在等 15 分钟走出极端，并且 8 秒内扫完又停住。'),
    preparing:opened.length?`这一拍开了 ${opened.join('，')}。`:'这一拍没有开仓。'};
  const note=opened.length?`开了 ${opened.length} 笔。`:(signals[0]?.why??ranked[0]?.why??'这一拍没有信号。');
  if(trial.lsrNote!==note||JSON.stringify(trial.work)!==JSON.stringify(work)||trial.lsrLog?.at(-1)?.ts===now||funnel.scans%15===0){trial.lsrNote=note;trial.work=work;changed=true;}
  return changed;
}
