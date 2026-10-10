/** One book. BTC's last eight closed 15-minute bars decide the direction.
 * A coin is taken only when it moved the same way by at least 1%. At most two
 * orders, each about twice current equity. No proposal is copied. */
import {INVERSE_COST} from './shadow-inverse-ledger.ts';
import type {Candle, Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import type {WorkSheet} from './forward-study.ts';

export const STRETCH_POLICY='stretch-v1' as const;
export const STRETCH_EPOCH='stretch-book-2026-10-10' as const;

const BTC='BTC_USDT';
const FEE=INVERSE_COST.feeRate;
const LEVERAGE=5;
const NOTIONAL_MULT=2;
const MARKET_MOVE=.0025;
const COIN_MIN=.008;
const COIN_MAX=.025;
const SPREAD_MAX=.0008;
const CHASE=.004;
const STOP=.005;
const WINNER=.008;
const HOLD_MS=2*60*60_000;
const FRESH_MS=20*60_000;
const VOLUME_MIN=1_000_000;
const MAX_OPEN=2;
const MARGIN_CAP=.9;

type Meta=Contract&{volume24hUsd?:number};
type Bar={time:number;open:number;high:number;low:number;close:number};
type Dir='UP'|'DOWN';
export type StretchRead={
  at:number;dir:Dir|null;btc:number|null;bar:number|null;bars:number;close:number|null;
  names:{symbol:string;ret:number;close:number}[];
  skipped:string[];
};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const dirOf=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const fresh=(q:Quote|undefined,now:number)=>!!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;
const coin=(symbol:string)=>symbol.replace(/_USDT$/,'').replace(/_/g,'');
const pct=(n:number)=>`${n>=0?'+':''}${(n*100).toFixed(2)}%`;

export function isStretchTrade(t:Trade){return t.exitControl?.policy===STRETCH_POLICY;}

function fifteens(rows:Candle[]|undefined,now:number):Bar[]{
  const groups=new Map<number,Candle[]>();
  for(const row of rows??[]){
    if(!(row.time>0)||!(row.high>0)||!(row.low>0)||!(row.close>0)||!(row.open>0))continue;
    if(row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close))continue;
    if(row.time*1000+300_000>now)continue;
    const bucket=Math.floor(row.time/900)*900;
    const list=groups.get(bucket)??[];
    list.push(row);groups.set(bucket,list);
  }
  const out:Bar[]=[];
  for(const [bucket,list] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
    const first=list.find(row=>row.time===bucket),last=list.find(row=>row.time===bucket+600);
    if(!first||!last||last.time*1000+300_000>now)continue;
    out.push({time:bucket,open:first.open,high:Math.max(...list.map(row=>row.high)),low:Math.min(...list.map(row=>row.low)),close:last.close});
  }
  return out;
}
function windowOf(rows:Candle[]|undefined,now:number){
  const bars=fifteens(rows,now);
  if(bars.length<8)return null;
  const last=bars.slice(-8);
  if(now-(last[7]!.time*1000+900_000)>FRESH_MS)return null;
  return last;
}
function liquid(meta:Meta|undefined){return !(finite(meta?.volume24hUsd)&&meta!.volume24hUsd<VOLUME_MIN);}

export function readStretch(paths:Record<string,Candle[]>|undefined,contracts:Record<string,Meta>|undefined,now:number):StretchRead{
  const window=windowOf(paths?.[BTC],now);
  const skipped:string[]=[];
  if(!window)return {at:now,dir:null,btc:null,bar:null,bars:fifteens(paths?.[BTC],now).length,close:null,names:[],skipped:['BTC 最近 8 根 15 分钟还没齐，这一拍不做。']};
  const start=window[0]!.open,close=window[7]!.close,ret=close/start-1;
  const recent=window.slice(-2);
  const dir:Dir|null=ret>=MARKET_MOVE&&recent.every(bar=>bar.close>start)?'UP'
    :ret<=-MARKET_MOVE&&recent.every(bar=>bar.close<start)?'DOWN':null;
  const found:{symbol:string;ret:number;close:number;dir:Dir}[]=[];
  for(const symbol of Object.keys(paths??{}).sort()){
    if(!liquid(contracts?.[symbol]))continue;
    const own=windowOf(paths?.[symbol],now);if(!own)continue;
    const move=own[7]!.close/own[0]!.open-1;
    const tail=own.slice(-2),open=own[0]!.open;
    const up=move>=COIN_MIN&&move<=COIN_MAX&&tail.every(bar=>bar.close>open);
    const down=move<=-COIN_MIN&&move>=-COIN_MAX&&tail.every(bar=>bar.close<open);
    if(!up&&!down)continue;
    const way:Dir=up?'UP':'DOWN';
    if(dir&&way!==dir)continue;
    found.push({symbol,ret:move,close:own[7]!.close,dir:way});
  }
  found.sort((a,b)=>Math.abs(b.ret)-Math.abs(a.ret));
  const lead=found[0];
  const names=dir||!lead?found:found.filter(row=>row.dir===lead.dir);
  const trade:Dir|null=dir??lead?.dir??null;
  if(!trade)skipped.push(`BTC 这两小时 ${pct(ret)}。没有币走出 0.8% 到 2.5%。`);
  else if(!names.length)skipped.push(dir?'没有币跟着走出 0.8% 到 2.5%。':'走出来的币已经超过 2.5%，不追。');
  return {at:now,dir:trade,btc:ret,bar:window[7]!.time,bars:8,close,names,skipped};
}

function rule(side:'LONG'|'SHORT',now:number,reason:string):Rule{
  return {id:`stretch-${side}`,signature:STRETCH_POLICY,parentId:null,version:1,createdAt:now,expiresAt:now+HOLD_MS,
    status:'EXPERIMENTAL',conditions:[],side,horizon:120,stopRate:STOP,armRate:WINNER,givebackRate:.5,
    exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,priorResponse:null,recentResponse:0,
    standardError:0,reason,mutation:'CREATE',grammar:STRETCH_POLICY,liveEligible:false};
}
function remember(state:ForwardState,key:string){
  const seen=state.inverseTrial!.stretchSeen??[];
  if(!seen.includes(key))seen.push(key);
  state.inverseTrial!.stretchSeen=seen.slice(-400);
}
function closeStretch(state:ForwardState,t:Trade,price:number,now:number,reason:string){
  const gross=dirOf(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*FEE,net=gross-t.entryFee-exitFee;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=now;
  t.exitFee=exitFee;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;t.fundingAllowance=0;
  state.balance+=gross-exitFee;state.grossPnl+=gross;state.fees+=exitFee;state.turnover+=t.quantity*price;
  state.resolved++;if(net>0)state.wins++;
  state.positions=state.positions.filter(x=>x.id!==t.id);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,240);
  state.revision++;state.events.unshift({id:`s${state.startedAt}-${state.revision}`,at:now,kind:'EXIT',subject:t.id,reason});
  state.events=state.events.slice(0,160);
}
function sheet(read:StretchRead,waiting:string,preparing:string):WorkSheet{
  const listed=read.names.slice(0,6).map(row=>`${coin(row.symbol)} ${pct(row.ret)}`).join('，');
  return {subject:'看大盘这两小时走出没有，再看哪个币跟着走。',
    method:'用已经收盘的 5 分钟线合成 15 分钟。BTC 最近 8 根涨跌到 0.25%，最后两根没收回去，就算有方向。币要同一个方向，并且自己走出 0.8% 到 2.5%。大盘没有方向时，币自己走出这一段也可以做。已经超过 2.5% 的不追。价差超过 0.08% 不做，现价又跑出信号收盘价 0.4% 不追。同时最多两笔，每笔名义是当时权益的 2 倍。',
    lines:[
      {name:'1. 大盘',data:'BTC 最近 8 根已收盘的 15 分钟。涨跌到 0.25% 才叫有方向。不到就看币自己。',said:read.btc==null?`15 分钟只有 ${read.bars} 根，不够。`:`BTC ${pct(read.btc)}。${Math.abs(read.btc)>=MARKET_MOVE?'大盘有方向。':'大盘这阵没有方向。'}`},
      {name:'2. 跟着走的币',data:'同一个方向时，币自己要走出 0.8% 到 2.5%。大盘没方向时，谁走出这一段就用谁的方向，只跟一边。按走出多少从大到小，最多拿两个。',said:listed?`够格 ${read.names.length} 个：${listed}。`:'这一拍没有够格的币。'},
      {name:'3. 这一拍不做的',data:'价差大于 0.08%，或者现价比信号收盘价又顺向跑了 0.4%，就跳过。',said:read.skipped[0]??'没有因为价差或追价跳过。'},
    ],waiting,preparing};
}

/** Mark, exit, then open at most two followers. */
export function applyStretchBook(state:ForwardState,paths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Contract>|undefined,now:number){
  const trial=state.inverseTrial;
  if(!trial||trial.paperPolicy!==STRETCH_POLICY)return false;
  const meta=contracts as Record<string,Meta>|undefined;
  let changed=false;
  for(const t of [...state.positions]){
    if(!isStretchTrade(t)||t.status!=='OPEN')continue;
    const q=quotes[t.symbol];if(!fresh(q,now))continue;
    const px=t.side==='LONG'?q!.bestBid:q!.bestAsk,signed=dirOf(t.side)*(px/t.entryPrice-1);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;
    if(signed>t.favorable){t.favorable=signed;t.peakPnlRate=signed;changed=true;}
    t.adverse=Math.max(t.adverse,-signed);
    const through=t.side==='LONG'?px<=t.stopPrice:px>=t.stopPrice;
    let reason:string|null=null;
    if(through)reason='STRETCH_WRONG_EXIT';
    else if(t.favorable>=WINNER&&signed<=t.favorable/2)reason='STRETCH_GIVEBACK_EXIT';
    else if(t.favorable<WINNER&&now-t.openedAt>=HOLD_MS)reason='STRETCH_TIME_EXIT';
    if(!reason)continue;
    closeStretch(state,t,px,now,reason);changed=true;
  }
  const read=readStretch(paths,meta,now);
  let equity=state.balance;
  for(const t of state.positions){
    if(!isStretchTrade(t))continue;
    const q=quotes[t.symbol],px=fresh(q,now)?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
    if(px>0)equity+=dirOf(t.side)*t.quantity*(px-t.entryPrice);
  }
  const held=new Set(state.positions.filter(isStretchTrade).map(t=>t.symbol));
  let used=state.positions.filter(isStretchTrade).reduce((n,t)=>n+t.margin,0);
  const side:Trade['side']|null=read.dir==='UP'?'LONG':read.dir==='DOWN'?'SHORT':null;
  const opened:string[]=[];
  const skipped=[...read.skipped];
  if(side){
    for(const row of read.names){
      if(state.positions.filter(isStretchTrade).length>=MAX_OPEN){skipped.push('已经有两笔，这一拍不再开。');break;}
      const name=coin(row.symbol),key=`${row.symbol}:${read.bar}:${side}`;
      if(held.has(row.symbol)||trial.stretchSeen?.includes(key))continue;
      const q=quotes[row.symbol],contract=meta?.[row.symbol];
      if(!fresh(q,now)||!contract||!(contract.quantoMultiplier>0)){skipped.push(`${name} 还没有新鲜报价。`);continue;}
      const spread=(q!.bestAsk-q!.bestBid)/((q!.bestAsk+q!.bestBid)/2);
      if(!(spread>=0)||spread>SPREAD_MAX){skipped.push(`${name} 价差 ${(spread*100).toFixed(3)}%，超过 0.08%。`);continue;}
      const price=side==='LONG'?q!.bestAsk:q!.bestBid;
      const ran=side==='LONG'?(price-row.close)/row.close:(row.close-price)/row.close;
      if(ran>CHASE){remember(state,key);skipped.push(`${name} 现价比信号收盘又跑了 ${(ran*100).toFixed(2)}%，不追。`);changed=true;continue;}
      const leverage=Math.min(LEVERAGE,Math.max(1,contract.leverageMax||LEVERAGE));
      const target=equity*NOTIONAL_MULT,mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
      const contractsN=Math.floor(target/(price*mult));
      if(contractsN<min){skipped.push(`${name} 排不下最小张数。`);continue;}
      const quantity=contractsN*mult,notional=quantity*price,margin=notional/leverage;
      if(notional<target*.7){skipped.push(`${name} 算出来不到目标名义的七成。`);continue;}
      if(!(equity>0)||used+margin>equity*MARGIN_CAP){skipped.push(`保证金再加 ${name} 会超过权益的 90%。`);break;}
      const stop=price*(1-dirOf(side)*STOP);
      const why=`BTC 这两小时 ${pct(read.btc??0)}，${name} 跟着走出 ${pct(row.ret)}。名义 ${notional.toFixed(0)} U。`;
      const id=`st-${now.toString(36)}-${row.symbol.replace(/[^A-Z0-9]/g,'').slice(0,24)}-${side[0]}`;
      const t:Trade={id,symbol:row.symbol,side,rule:rule(side,now,why),openedAt:now,closedAt:null,status:'OPEN',
        entryPrice:price,exitPrice:null,quantity,contracts:contractsN,quantoMultiplier:mult,notional,leverage,margin,
        plannedRisk:notional*STOP,stopPrice:stop,armPrice:price*(1+dirOf(side)*WINNER),
        favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q!.observedAt,entryFee:notional*FEE,exitFee:0,fundingAllowance:0,
        grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',
        liveEligible:false,firstProfitAt:null,holdScore:0,profitFloorRate:0,expectedHoldMinutes:120,peakPnlRate:0,
        exitControl:{policy:STRETCH_POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
        entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side,mode:'CONTINUATION',reserve:false,reason:why,
          entryScore:0,directionStrength:0,spaceScore:0,positionScore:0,executionScore:0,remainingSpaceRate:WINNER,
          pullbackRiskRate:STOP,edgeRatio:WINNER/STOP,expectedHoldMinutes:120,marketFit:0,regionId:null,portfolioRiskCharge:notional*STOP,
          strategyVersion:STRETCH_POLICY,thesisId:key,thesisSince:now,thesisSummary:why,
          invalidationSummary:`错了：价格${side==='LONG'?'落到':'涨到'} ${stop.toFixed(6)} 就走。对了：顺向到过 0.8% 之后，从最高利润吐回一半再走。两小时还没到 0.8%，也走。`}};
      state.balance-=t.entryFee;state.fees+=t.entryFee;state.turnover+=notional;
      state.positions.push(t);remember(state,key);held.add(row.symbol);used+=margin;equity-=t.entryFee;opened.push(`${name} ${notional.toFixed(0)}U`);changed=true;
      state.revision++;state.events.unshift({id:`s${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:id,reason:why});
      state.events=state.events.slice(0,160);
    }
  }
  const openCount=state.positions.filter(isStretchTrade).length;
  const waiting=!read.dir?'在等有币走出 0.8% 到 2.5%。大盘只要 0.25% 就算有方向，没有方向也可以做币自己的这段。'
    :openCount>=MAX_OPEN?'两笔都在。等其中一笔走了，下一根 15 分钟才看新的。'
    :'这一根 15 分钟已经看过。下一根收盘再看还有没有新的币。';
  const preparing=opened.length?`这一拍开了 ${opened.join('，')}。`
    :!read.dir?'这一拍不做。'
    :openCount?`还拿着 ${openCount} 笔。够格的新币这一拍没有开成。`
    :'这一拍没有开仓。';
  const work=sheet(read,waiting,preparing);
  const note=read.dir?`大盘在${read.dir==='UP'?'涨':'跌'} ${pct(read.btc??0)}。够格 ${read.names.length} 个。现在 ${openCount} 笔。`
    :read.skipped[0]??'这一拍不做。';
  if(trial.stretchNote!==note||JSON.stringify(trial.work)!==JSON.stringify(work)){trial.stretchNote=note;trial.work=work;changed=true;}
  return changed;
}
