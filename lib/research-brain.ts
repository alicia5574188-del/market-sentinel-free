/** Research reads the market and names an idea. Decision chooses whether and how.
 * Ideas are not orders. A failed solo push, a leader, or a laggard is a sentence
 * with a wrong-if price. Decision fades chase, stacks nothing on one coin, and
 * stops new opens only when margin is already half of equity. */
import {INVERSE_COST} from './shadow-inverse-ledger.ts';
import type {Candle, Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import type {WorkSheet} from './forward-study.ts';

export const BRAIN_POLICY='brain-v1' as const;
export const BRAIN_EPOCH='brain-book-2026-10-09b' as const;
/** Books opened before this, and any needle book, switch once. Live on is left alone. */
export const BRAIN_BEFORE=Date.parse('2026-10-09T12:00:00Z');

const NOTIONAL=400;
const LEVERAGE=10;
const FEE=INVERSE_COST.feeRate;
const MARGIN_CAP=.5;
const SPREAD_MAX=.0012;
const CATCH_SPREAD=.0008;
const WICK_MIN=.002;
const TIP_MIN=.0015;
const TIP_MAX=.007;
const CLOSE_CHASE=.0035;
const LEAD_MIN=.001;
const LEAD_MAX=.005;
const WINNER=.008;
const CATCH_STOP=.0045;
const SAMPLE_MIN=6;
const MOVE=.0015;
const STARTED_MAX=.004;
const DONE_MIN=.008;
const LAST_MIN=.0012;
const CROWD=.00015;
const VOLUME_MIN=1_000_000;
const LEAD_MULT=1.4;
const STALE={FADE:30*60_000,LEAD:45*60_000,CATCH:30*60_000};
const FRESH_1M=2*60_000;
const FRESH_5M=10*60_000;

export type MarketTone='TOGETHER_UP'|'TOGETHER_DOWN'|'SPLIT';
export type MoveAge='STARTED'|'ONGOING'|'DONE'|'QUIET';
export type Crowd='LONG'|'SHORT'|'NONE';
export type IdeaKind='FADE'|'LEAD'|'CATCH';
export type MarketRead={at:number;tone:MarketTone;age:MoveAge;crowd:Crowd;sample:number;move:number;sentence:string;up:number;down:number;flat:number;fund:number;fundN:number};
export type Idea={symbol:string;kind:IdeaKind;side:'LONG'|'SHORT';key:string;bar:number;stop:number;close:number;why:string;wrong:string;tone:MarketTone};
type Meta=Contract&{fundingRate?:number;volume24hUsd?:number};
type Move={ret:number;last:number;high:number;low:number;bar:number;close:number;open:number;highBar:number;lowBar:number};

const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const dirOf=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const fresh=(q:Quote|undefined,now:number)=>!!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;
const median=(xs:number[])=>{const a=[...xs].sort((x,y)=>x-y),n=a.length;if(!n)return 0;return n%2?a[n>>1]!:(a[n/2-1]!+a[n/2]!)/2;};

export function isBrainTrade(t:Trade){return t.exitControl?.policy===BRAIN_POLICY;}

function done(rows:Candle[]|undefined,now:number,sec:number){
  return (rows??[]).filter(r=>r.time>0&&r.high>0&&r.low>0&&r.close>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.low>0&&r.time*1000+sec*1000<=now)
    .sort((a,b)=>a.time-b.time);
}
function moveOf(rows:Candle[]|undefined,now:number):Move|null{
  const bars=done(rows,now,300);
  if(bars.length<8)return null;
  const last=bars.at(-1)!,prior=bars.slice(-7,-1);
  if(prior.length!==6||!(prior[0]!.open>0)||now-(last.time*1000+300_000)>FRESH_5M)return null;
  return {ret:last.close/prior[0]!.open-1,last:last.close/last.open-1,high:Math.max(...prior.map(r=>r.high)),low:Math.min(...prior.map(r=>r.low)),
    bar:last.time,close:last.close,open:last.open,highBar:last.high,lowBar:last.low};
}
function liquid(meta:Meta|undefined){return !(finite(meta?.volume24hUsd)&&meta!.volume24hUsd<VOLUME_MIN);}

export function readMarket(paths:Record<string,Candle[]>|undefined,contracts:Record<string,Meta>|undefined,now:number):MarketRead{
  const ups:number[]=[],downs:number[]=[],lasts:number[]=[],funds:number[]=[];
  let flat=0;
  for(const symbol of Object.keys(paths??{}).sort()){
    if(!liquid(contracts?.[symbol]))continue;
    const m=moveOf(paths?.[symbol],now);if(!m)continue;
    if(m.ret>MOVE)ups.push(m.ret);else if(m.ret<-MOVE)downs.push(-m.ret);else flat++;
    lasts.push(m.last);
    const fund=contracts?.[symbol]?.fundingRate;
    if(finite(fund))funds.push(fund);
  }
  const sample=ups.length+downs.length+flat,up=ups.length,down=downs.length,directional=up+down;
  const tone:MarketTone=directional>=SAMPLE_MIN&&up>=down*2&&up/directional>=.65?'TOGETHER_UP'
    :directional>=SAMPLE_MIN&&down>=up*2&&down/directional>=.65?'TOGETHER_DOWN':'SPLIT';
  const move=median([...(tone==='TOGETHER_DOWN'?downs:ups)]);
  const age:MoveAge=tone==='SPLIT'?(median(lasts.map(Math.abs))<.002?'QUIET':'ONGOING')
    :move>=DONE_MIN?'DONE':move<STARTED_MAX&&median(lasts.map(Math.abs))>=LAST_MIN?'STARTED':'ONGOING';
  const fundMedian=median(funds);
  const crowd:Crowd=funds.length>=4&&fundMedian>=CROWD?'LONG':funds.length>=4&&fundMedian<=-CROWD?'SHORT':'NONE';
  const sentence=sample<SAMPLE_MIN?'能看的币不够，先不给思路。'
    :`整盘${tone==='TOGETHER_UP'?'一起涨':tone==='TOGETHER_DOWN'?'一起跌':'各走各的'}${tone==='SPLIT'?'':age==='STARTED'?'，这波刚开始':age==='DONE'?'，这波已经走得比较远':'，这波还在走'}。${crowd==='LONG'?'资金费率挤在做多一边。':crowd==='SHORT'?'资金费率挤在做空一边。':'资金费率没有挤在一边。'}`;
  return {at:now,tone,age,crowd,sample,move,sentence,up,down,flat,fund:fundMedian,fundN:funds.length};
}

function failed(barHigh:number,barLow:number,close:number,high:number,low:number):'UP'|'DOWN'|null{
  const up=barHigh>high&&close<=high&&close>=low&&(barHigh-high)/close>=WICK_MIN;
  const down=barLow<low&&close>=low&&close<=high&&(low-barLow)/close>=WICK_MIN;
  if(up===down)return null;
  return up?'UP':'DOWN';
}

export function proposeIdeas(paths:Record<string,Candle[]>|undefined,minutePaths:Record<string,Candle[]>|undefined,contracts:Record<string,Meta>|undefined,market:MarketRead,now:number):Idea[]{
  if(market.sample<SAMPLE_MIN)return [];
  const ideas:Idea[]=[];
  const names=[...new Set([...Object.keys(paths??{}),...Object.keys(minutePaths??{})])].sort();
  for(const symbol of names){
    if(!liquid(contracts?.[symbol]))continue;
    const m=moveOf(paths?.[symbol],now);
    const minute=done(minutePaths?.[symbol],now,60);
    let fade:Idea|null=null;
    if(minute.length>=31){
      const bar=minute.at(-1)!,prior=minute.slice(-31,-1);
      if(prior.length===30&&now-(bar.time*1000+60_000)<=FRESH_1M){
        const high=Math.max(...prior.map(r=>r.high)),low=Math.min(...prior.map(r=>r.low)),dir=failed(bar.high,bar.low,bar.close,high,low);
        if(dir&&!(dir==='UP'&&market.tone==='TOGETHER_UP')&&!(dir==='DOWN'&&market.tone==='TOGETHER_DOWN')){
          const side:Trade['side']=dir==='UP'?'SHORT':'LONG';
          fade={symbol,kind:'FADE',side,key:`${symbol}:fade1:${bar.time}`,bar:bar.time+60,stop:dir==='UP'?bar.high:bar.low,close:bar.close,tone:market.tone,
            why:dir==='UP'?`${symbol}自己冲高又收回来，整盘没有一起涨。`:`${symbol}自己打低又收回来，整盘没有一起跌。`,
            wrong:'价格重新站到这根针的外面。'};
        }
      }
    }
    if(!fade&&m){
      const dir=failed(m.highBar,m.lowBar,m.close,m.high,m.low);
      if(dir&&!(dir==='UP'&&market.tone==='TOGETHER_UP')&&!(dir==='DOWN'&&market.tone==='TOGETHER_DOWN')){
        const side:Trade['side']=dir==='UP'?'SHORT':'LONG';
        fade={symbol,kind:'FADE',side,key:`${symbol}:fade5:${m.bar}`,bar:m.bar+300,stop:dir==='UP'?m.highBar:m.lowBar,close:m.close,tone:market.tone,
          why:dir==='UP'?`${symbol}自己冲高又收回来，整盘没有一起涨。`:`${symbol}自己打低又收回来，整盘没有一起跌。`,
          wrong:'价格重新站到这根针的外面。'};
      }
    }
    if(fade){ideas.push(fade);continue;}
    if(!m)continue;
    const upLead=market.tone==='TOGETHER_UP'&&market.age==='STARTED'&&market.crowd!=='LONG'
      &&m.open<=m.high&&m.close>m.high&&(m.close-m.high)/m.close>=LEAD_MIN&&(m.close-m.high)/m.close<=.006
      &&m.ret>=Math.max(.002,market.move*LEAD_MULT);
    const downLead=market.tone==='TOGETHER_DOWN'&&market.age==='STARTED'&&market.crowd!=='SHORT'
      &&m.open>=m.low&&m.close<m.low&&(m.low-m.close)/m.close>=LEAD_MIN&&(m.low-m.close)/m.close<=.006
      &&-m.ret>=Math.max(.002,market.move*LEAD_MULT);
    if(upLead||downLead){
      const side:Trade['side']=upLead?'LONG':'SHORT';
      ideas.push({symbol,kind:'LEAD',side,key:`${symbol}:lead:${m.bar}`,bar:m.bar+300,stop:upLead?m.high:m.low,close:m.close,tone:market.tone,
        why:upLead?`整盘刚转向上，${symbol}先突破并且还站在外面。`:`整盘刚转向下，${symbol}先跌破并且还站在外面。`,
        wrong:'价格掉回突破前的区间。'});
      continue;
    }
    const catchUp=market.tone==='TOGETHER_UP'&&(market.age==='STARTED'||market.age==='ONGOING')&&market.crowd!=='LONG'&&Math.abs(m.ret)<.0012&&Math.abs(m.last)<MOVE;
    const catchDown=market.tone==='TOGETHER_DOWN'&&(market.age==='STARTED'||market.age==='ONGOING')&&market.crowd!=='SHORT'&&Math.abs(m.ret)<.0012&&Math.abs(m.last)<MOVE;
    if(catchUp||catchDown){
      const side:Trade['side']=catchUp?'LONG':'SHORT';
      ideas.push({symbol,kind:'CATCH',side,key:`${symbol}:catch:${m.bar}`,bar:m.bar+300,stop:0,close:m.close,tone:market.tone,
        why:catchUp?`整盘在涨，${symbol}还没动。`:`整盘在跌，${symbol}还没动。`,
        wrong:'整盘这波散了，或者这个币先往反方向走。'});
    }
  }
  const rank={FADE:0,LEAD:1,CATCH:2};
  return ideas.sort((a,b)=>rank[a.kind]-rank[b.kind]||a.symbol.localeCompare(b.symbol));
}

function coin(symbol:string){return symbol.replace(/_USDT$/,'');}
function ageText(age:MoveAge){return age==='STARTED'?'刚开始':age==='DONE'?'已经走远':age==='QUIET'?'安静':'还在走';}
function brainWork(market:MarketRead,ideas:Idea[],skipped:string[],opened:number,blocked:string):WorkSheet{
  const tone=market.tone==='TOGETHER_UP'?'一起涨':market.tone==='TOGETHER_DOWN'?'一起跌':'各走各的';
  const crowd=market.crowd==='LONG'?'挤在做多':market.crowd==='SHORT'?'挤在做空':'没有挤在一边';
  const listed=ideas.slice(0,6).map(idea=>`${coin(idea.symbol)} ${idea.side==='LONG'?'做多':'做空'}·${idea.kind==='FADE'?'失败':idea.kind==='LEAD'?'领头':'掉队'}`).join('、');
  const preparing=ideas.length?ideas.slice(0,4).map(idea=>`${coin(idea.symbol)} ${idea.side==='LONG'?'做多':'做空'}：${idea.why}错了就走：${idea.wrong}`).join(' '):'没有准备开的单。';
  const waiting=market.sample<SAMPLE_MIN?`在等至少 ${SAMPLE_MIN} 个币有完整的 5 分钟。现在只有 ${market.sample} 个。`
    :blocked?blocked
    :ideas.length===0?'在等单币对上一种情况：自己冲出又收回，或者整盘刚开始时有币先破位，或者整盘在走但有币还没动。'
    :opened>0?`这一拍按思路做了 ${opened} 笔。同一条思路不重复做。`
    :skipped.slice(0,3).join(' ')||'思路写出来了，这一拍没有一笔同时过了价差和位置。';
  return {subject:'研究整盘这一小波是不是一起走、走到哪了，再找和整盘不一样的单币。研究只写思路，不开单。',
    method:'用刚收盘的 K 线。5 分钟看整盘、领头和掉队。1 分钟看单币是不是自己冲出去又收回来。不看账户以前赚没赚。',
    lines:[
      {name:'1. 取数',data:'每个币取最近 7 根已收盘的 5 分钟线，再取最近 1 根已收盘的 1 分钟线。24 小时成交额不到 100 万 U 的不看。',said:`这一拍看完 ${market.sample} 个币。`},
      {name:'2. 整盘同不同向',data:'有方向的币至少 6 个，而且一边至少是另一边的 2 倍、占有方向的币至少 65%，才叫一起走。否则是各走各的。',said:`上涨 ${market.up} 个，下跌 ${market.down} 个，几乎没动 ${market.flat} 个。所以是${tone}。`},
      {name:'3. 这波走到哪',data:'一起走时，中位幅度不到 0.40% 且最近一根还在动，算刚开始。到了 0.80% 算走远。各走各的时候，最近一根中位波动不到 0.20% 算安静。',said:`中位幅度 ${(market.move*100).toFixed(2)}%。现在是${ageText(market.age)}。`},
      {name:'4. 资金费率',data:'至少 4 个币有费率，中位数绝对值到 0.015%，才算挤在一边。',said:`有费率 ${market.fundN} 个，中位数 ${(market.fund*100).toFixed(4)}%。${crowd}。`},
      {name:'5. 写出思路',data:'单币冲出至少 0.20% 又收回，而且整盘没有一起往那边走，记成失败。整盘刚开始、费率没挤满、先破位 0.10% 到 0.60%，记成领头。整盘在走、这个币 7 根涨跌不到 0.12%，记成掉队。',said:listed?`写出 ${ideas.length} 条：${listed}。`:'这一拍没有写出来。'},
    ],waiting,preparing};
}
function rule(side:'LONG'|'SHORT',now:number,reason:string):Rule{
  return {id:`brain-${side}`,signature:BRAIN_POLICY,parentId:null,version:1,createdAt:now,expiresAt:now+6*60*60_000,
    status:'EXPERIMENTAL',conditions:[],side,horizon:180,stopRate:TIP_MAX,armRate:WINNER,givebackRate:.5,
    exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,priorResponse:null,recentResponse:0,
    standardError:0,reason,mutation:'CREATE',grammar:BRAIN_POLICY,liveEligible:false};
}
function remember(state:ForwardState,key:string){
  const seen=state.inverseTrial!.brainSeen??[];
  if(!seen.includes(key))seen.push(key);
  state.inverseTrial!.brainSeen=seen.slice(-800);
}
function kindOf(t:Trade):IdeaKind{
  return t.entryContext?.mode==='CONTINUATION'?'LEAD':t.entryContext?.mode==='RELATIVE'?'CATCH':'FADE';
}
function closeBrain(state:ForwardState,t:Trade,price:number,now:number,reason:string){
  const gross=dirOf(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*FEE,net=gross-t.entryFee-exitFee;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=now;
  t.exitFee=exitFee;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;t.fundingAllowance=0;
  state.balance+=gross-exitFee;state.grossPnl+=gross;state.fees+=exitFee;state.turnover+=t.quantity*price;
  state.resolved++;if(net>0)state.wins++;
  state.positions=state.positions.filter(x=>x.id!==t.id);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,240);
  state.revision++;state.events.unshift({id:`b${state.startedAt}-${state.revision}`,at:now,kind:'EXIT',subject:t.id,reason});
  state.events=state.events.slice(0,160);
}

/** Mark, exit, then open what decision accepts. Returns whether the book changed. */
export function applyBrainBook(state:ForwardState,paths:Record<string,Candle[]>|undefined,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Contract>|undefined,now:number){
  const trial=state.inverseTrial;
  if(!trial||trial.paperPolicy!==BRAIN_POLICY)return false;
  const meta=contracts as Record<string,Meta>|undefined;
  let changed=false;
  const market=readMarket(paths,meta,now);
  for(const t of [...state.positions]){
    if(!isBrainTrade(t)||t.status!=='OPEN')continue;
    const q=quotes[t.symbol];if(!fresh(q,now))continue;
    const px=t.side==='LONG'?q!.bestBid:q!.bestAsk,signed=dirOf(t.side)*(px/t.entryPrice-1);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;
    if(signed>t.favorable){t.favorable=signed;t.peakPnlRate=signed;changed=true;}
    t.adverse=Math.max(t.adverse,-signed);
    const wrong=t.side==='LONG'?px<=t.stopPrice:px>=t.stopPrice;
    const since=t.entryContext?.thesisSince??t.openedAt;
    const kind=kindOf(t);
    let reason:string|null=null;
    if(wrong)reason='BRAIN_WRONG_EXIT';
    else if(t.favorable>=WINNER&&signed<=t.favorable/2)reason='BRAIN_GIVEBACK_EXIT';
    else if(kind==='CATCH'&&market.sample>=SAMPLE_MIN&&t.entryContext?.clusterId&&t.entryContext.clusterId!==market.tone)reason='BRAIN_MARKET_EXIT';
    else if(t.favorable<WINNER&&now-since>=STALE[kind])reason='BRAIN_STALE_EXIT';
    if(!reason)continue;
    closeBrain(state,t,px,now,reason);changed=true;
  }
  const ideas=proposeIdeas(paths,minutePaths,meta,market,now);
  const shown=ideas.slice(0,8).map(idea=>({symbol:idea.symbol,side:idea.side,kind:idea.kind,why:idea.why,wrong:idea.wrong}));
  if(trial.brainNote!==market.sentence||JSON.stringify(trial.brainIdeas??[])!==JSON.stringify(shown)){
    trial.brainNote=market.sentence;trial.brainIdeas=shown;changed=true;
  }
  let equity=state.balance;
  for(const t of state.positions){
    if(!isBrainTrade(t))continue;
    const q=quotes[t.symbol],px=fresh(q,now)?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
    if(px>0)equity+=dirOf(t.side)*t.quantity*(px-t.entryPrice);
  }
  let used=state.positions.filter(isBrainTrade).reduce((n,t)=>n+t.margin,0);
  const held=new Set(state.positions.map(t=>t.symbol));
  const skipped:string[]=[];
  let opened=0,blocked='';
  for(const idea of ideas){
    const name=coin(idea.symbol);
    if(held.has(idea.symbol)||trial.brainSeen?.includes(idea.key))continue;
    const q=quotes[idea.symbol],contract=meta?.[idea.symbol];
    if(!fresh(q,now)||!contract||!(contract.quantoMultiplier>0)){skipped.push(`${name} 还没有新鲜的买一卖一，先等报价。`);continue;}
    const spread=(q!.bestAsk-q!.bestBid)/((q!.bestAsk+q!.bestBid)/2);
    if(!(spread>=0)||spread>SPREAD_MAX||(idea.kind==='CATCH'&&spread>CATCH_SPREAD)){remember(state,idea.key);changed=true;skipped.push(`${name} 价差 ${(spread*100).toFixed(3)}%，超过 ${idea.kind==='CATCH'?'0.080':'0.120'}%，不做。`);continue;}
    const side=idea.side,price=side==='LONG'?q!.bestAsk:q!.bestBid;
    let stop=idea.stop;
    if(idea.kind==='CATCH')stop=price*(1-dirOf(side)*CATCH_STOP);
    const gap=side==='LONG'?price-stop:stop-price;
    const dist=gap/price;
    const fromClose=Math.abs(price-idea.close)/price;
    const chase=idea.kind==='CATCH'?fromClose>.002:idea.kind==='LEAD'?(dist<LEAD_MIN||dist>LEAD_MAX):(dist<TIP_MIN||dist>TIP_MAX||fromClose>CLOSE_CHASE);
    if(!(gap>0)||chase){remember(state,idea.key);changed=true;skipped.push(`${name} 现价已经离开写下的位置，不追。`);continue;}
    const leverage=Math.min(LEVERAGE,Math.max(1,contract.leverageMax||LEVERAGE));
    const mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
    const contractsN=Math.floor(NOTIONAL/(price*mult));
    if(contractsN<min){remember(state,idea.key);changed=true;skipped.push(`${name} 按大约 400U 排不下最小张数。`);continue;}
    const quantity=contractsN*mult,notional=quantity*price;
    if(notional<80||notional>480){remember(state,idea.key);changed=true;skipped.push(`${name} 算出来不是大约 400U。`);continue;}
    const margin=notional/leverage;
    if(!(equity>0)||used+margin>equity*MARGIN_CAP){blocked=`保证金已用 ${used.toFixed(0)} U，权益一半是 ${(equity*.5).toFixed(0)} U。${name} 在等仓位腾出来。`;break;}
    const entryFee=notional*FEE,mode=idea.kind==='LEAD'?'CONTINUATION':idea.kind==='CATCH'?'RELATIVE':'REVERSAL';
    const id=`br-${now.toString(36)}-${idea.symbol.replace(/[^A-Z0-9]/g,'').slice(0,24)}-${side[0]}`;
    const t:Trade={id,symbol:idea.symbol,side,rule:rule(side,now,idea.why),openedAt:now,closedAt:null,status:'OPEN',
      entryPrice:price,exitPrice:null,quantity,contracts:contractsN,quantoMultiplier:mult,notional,leverage,margin:notional/leverage,
      plannedRisk:notional*dist,stopPrice:stop,armPrice:price*(1+dirOf(side)*WINNER),
      favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q!.observedAt,entryFee,exitFee:0,fundingAllowance:0,
      grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',
      liveEligible:false,firstProfitAt:null,holdScore:0,profitFloorRate:0,expectedHoldMinutes:idea.kind==='LEAD'?45:30,peakPnlRate:0,
      exitControl:{policy:BRAIN_POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side,mode,reserve:false,reason:idea.why,
        entryScore:0,directionStrength:0,spaceScore:0,positionScore:0,executionScore:0,remainingSpaceRate:WINNER,
        pullbackRiskRate:dist,edgeRatio:0,expectedHoldMinutes:30,marketFit:0,regionId:null,portfolioRiskCharge:notional*dist,
        strategyVersion:BRAIN_POLICY,thesisId:idea.key,thesisSince:idea.bar*1000,clusterId:idea.tone,thesisSummary:idea.why,
        invalidationSummary:idea.wrong}};
    state.balance-=entryFee;state.fees+=entryFee;state.turnover+=notional;
    state.positions.push(t);remember(state,idea.key);held.add(idea.symbol);used+=t.margin;opened++;changed=true;
    state.revision++;state.events.unshift({id:`b${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:id,reason:idea.why});
    state.events=state.events.slice(0,160);
  }
  const work=brainWork(market,ideas,skipped,opened,blocked);
  if(JSON.stringify(trial.work)!==JSON.stringify(work)){trial.work=work;changed=true;}
  return changed;
}
