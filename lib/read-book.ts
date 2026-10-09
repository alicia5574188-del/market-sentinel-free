/** Read the recent path once, then update it when a new 5m bar closes.
 * The output is where this stretch is and what the next part should be.
 * It is not a score of past trades. Decision opens one wave and holds it
 * until that reading ends. Live is never eligible. */
import type {Candle, Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import {INVERSE_COST} from './shadow-inverse-ledger.ts';

export const READ_POLICY='read-v1' as const;
export const READ_EPOCH='read-book-2026-10-09' as const;
export const READ_BEFORE=Date.parse('2026-10-10T00:00:00Z');

const NOTIONAL=400;
const LEVERAGE=10;
const FEE=INVERSE_COST.feeRate;
const SPREAD_MAX=.0004;
const CHASE=.003;
const STOP=.012;
const MAX_NAMES=4;
const VOLUME_MIN=1_000_000;
const MIN_NAMES=8;
const FLAT=.0015;
const MOVE_MIN=.006;
const AGREE_MIN=.62;
const AGREE_GAIN=.08;
const ROTATE_KEEP=.45;
const EFF_PUSH=.35;
const EFF_CHOP=.25;
const BREAK_PAD=.0015;
const SPIKE=.008;
const FILL_WINDOW=10*60_000;
const BAR=300_000;

type Meta=Contract&{volume24hUsd?:number};
type Side='LONG'|'SHORT';
type Call='CONTINUE'|'BACK'|'NONE'|'WAIT';
type Row={symbol:string;newer:number;older:number;eff:number;close:number;brokeUp:boolean;brokeDown:boolean;inside:boolean;spike:Side|null;excess:number};
export type ReadName={symbol:string;side:Side;close:number;why:string};
export type ReadView={call:Call;side:Side|null;episode:string;note:string;names:ReadName[];bar:number;chop:boolean};

const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const dirOf=(side:Side)=>side==='LONG'?1:-1;
const flip=(side:Side):Side=>side==='LONG'?'SHORT':'LONG';
const fresh=(q:Quote|undefined,now:number)=>!!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;
const liquid=(meta:Meta|undefined)=>!(finite(meta?.volume24hUsd)&&meta!.volume24hUsd<VOLUME_MIN);
function median(xs:number[]){
  if(!xs.length)return 0;
  const a=[...xs].sort((x,y)=>x-y),n=a.length;
  return n%2?a[n>>1]!:(a[n/2-1]!+a[n/2]!)/2;
}
function closedBars(rows:Candle[]|undefined,now:number,sec:number){
  return (rows??[]).filter(r=>r.time>0&&r.high>0&&r.low>0&&r.close>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.time*1000+sec*1000<=now).sort((a,b)=>a.time-b.time);
}
function halfOf(rows:Candle[]){
  const use=rows.slice(-48);
  if(use.length<24)return null;
  const cut=use.length>=48?use.length-24:Math.floor(use.length/2);
  const older=use.slice(0,cut),newer=use.slice(cut);
  if(older.length<12||newer.length<12)return null;
  return {older,newer};
}
function retOf(rows:Candle[]){
  const a=rows[0]!,b=rows.at(-1)!;
  return a.open>0?b.close/a.open-1:0;
}
function effOf(rows:Candle[]){
  let path=0;
  for(let i=1;i<rows.length;i++)path+=Math.abs(rows[i]!.close-rows[i-1]!.close);
  const net=Math.abs(rows.at(-1)!.close-rows[0]!.open);
  return path>0?net/path:0;
}
function spikeOf(newer:Candle[]):{side:Side;excess:number}|null{
  const start=newer[0]!.open;
  if(!(start>0))return null;
  let hi=0,lo=0,hiAt=0,loAt=0;
  newer.forEach((bar,i)=>{
    const up=bar.high/start-1,dn=bar.low/start-1;
    if(up>=hi){hi=up;hiAt=i;}
    if(dn<=lo){lo=dn;loAt=i;}
  });
  const end=newer.at(-1)!.close/start-1,last=newer.length-1;
  const upOk=hiAt<last&&hi>=SPIKE&&end<=hi-0.5*hi;
  const dnOk=loAt<last&&-lo>=SPIKE&&end>=lo+0.5*(-lo);
  if(upOk===dnOk)return null;
  return upOk?{side:'SHORT',excess:hi}:{side:'LONG',excess:-lo};
}
function leaders(rows:Row[],side:Side){
  return rows.filter(r=>(side==='LONG'?r.newer>FLAT:r.newer<-FLAT)).sort((a,b)=>Math.abs(b.newer)-Math.abs(a.newer)).slice(0,3).map(r=>r.symbol);
}
function agree(rows:Row[],key:'newer'|'older'){
  const live=rows.filter(r=>Math.abs(r[key])>=FLAT);
  if(live.length<6)return {agree:0,side:null as Side|null,n:live.length};
  const up=live.filter(r=>r[key]>0).length/live.length;
  const side:Side=up>=.5?'LONG':'SHORT';
  return {agree:Math.max(up,1-up),side,n:live.length};
}

export function readMarket(paths:Record<string,Candle[]>|undefined,contracts:Record<string,Contract>|undefined,now:number):ReadView{
  const meta=contracts as Record<string,Meta>|undefined;
  const rows:Row[]=[];
  let bar=0;
  for(const symbol of Object.keys(paths??{}).sort()){
    if(!liquid(meta?.[symbol]))continue;
    const bars=closedBars(paths?.[symbol],now,300);
    const parts=halfOf(bars);
    if(!parts)continue;
    const last=parts.newer.at(-1)!;
    bar=Math.max(bar,last.time);
    if(now-(last.time*1000+BAR)>15*60_000)continue;
    const olderHigh=Math.max(...parts.older.map(b=>b.high)),olderLow=Math.min(...parts.older.map(b=>b.low));
    const spike=spikeOf(parts.newer);
    rows.push({symbol,newer:retOf(parts.newer),older:retOf(parts.older),eff:effOf(parts.newer),close:last.close,
      brokeUp:last.close>olderHigh*(1+BREAK_PAD),brokeDown:last.close<olderLow*(1-BREAK_PAD),
      inside:last.close<=olderHigh&&last.close>=olderLow,spike:spike?.side??null,excess:spike?.excess??0});
  }
  const empty=(note:string):ReadView=>({call:'WAIT',side:null,episode:`W:${bar}`,note,names:[],bar,chop:false});
  if(rows.length<MIN_NAMES)return empty('最近这段能看完的币不够，先不判断。');
  const nowAgree=agree(rows,'newer'),thenAgree=agree(rows,'older');
  const oldSide=thenAgree.side;
  const oldLead=oldSide?rows.filter(r=>(oldSide==='LONG'?r.older>FLAT:r.older<-FLAT)).sort((a,b)=>Math.abs(b.older)-Math.abs(a.older)).slice(0,3).map(r=>r.symbol):[];
  const nowLead=nowAgree.side?leaders(rows,nowAgree.side):[];
  const keep=oldLead.length?nowLead.filter(s=>oldLead.includes(s)).length/oldLead.length:1;
  const aligning=!!nowAgree.side&&nowAgree.agree>=AGREE_MIN&&nowAgree.n/rows.length>=.5&&nowAgree.agree>=thenAgree.agree+AGREE_GAIN;
  const rotating=keep<ROTATE_KEEP||(nowAgree.n>=6&&nowAgree.agree<.55);
  const eff=median(rows.map(r=>r.eff)),move=median(rows.map(r=>r.newer));
  const upShare=rows.filter(r=>r.brokeUp).length/rows.length,dnShare=rows.filter(r=>r.brokeDown).length/rows.length;
  const insideShare=rows.filter(r=>r.inside).length/rows.length;
  const newUp=upShare>=.5&&eff>=EFF_PUSH&&move>=MOVE_MIN;
  const newDown=dnShare>=.5&&eff>=EFF_PUSH&&move<=-MOVE_MIN;
  const overlap=insideShare>=.6||eff<EFF_CHOP;
  const side:Side|null=newUp?'LONG':newDown?'SHORT':null;
  if(aligning&&side&&side===nowAgree.side){
    const followers=rows.filter(r=>(side==='LONG'?r.newer>=FLAT:r.newer<=-FLAT));
    const drop=Math.max(1,Math.ceil(followers.length*.3));
    const ranked=[...followers].sort((a,b)=>Math.abs(a.newer)-Math.abs(b.newer)||a.symbol.localeCompare(b.symbol));
    const room=ranked.slice(0,Math.max(0,ranked.length-drop));
    const names=room.filter(r=>side==='LONG'?r.older<r.newer*0.6:r.older>r.newer*0.6).slice(0,MAX_NAMES).map(r=>({
      symbol:r.symbol,side,close:r.close,
      why:`${r.symbol.replace(/_USDT$/,'')}刚跟上，还没冲到最前面。`}));
    const way=side==='LONG'?'做多':'做空';
    const note=names.length
      ?`最近这截比前一截更齐，价格还在走出新位置。接下来顺着${way}，做刚跟上的，不追已经冲远的。`
      :`最近这截更齐，也在走出新位置。刚跟上的币不够，不追已经冲远的。`;
    return {call:'CONTINUE',side,episode:`C:${side}:${bar}`,note,names,bar,chop:false};
  }
  const fades=rows.filter(r=>r.spike).sort((a,b)=>b.excess-a.excess||a.symbol.localeCompare(b.symbol)).slice(0,MAX_NAMES);
  if(fades.length){
    const names=fades.map(r=>({symbol:r.symbol,side:r.spike!,close:r.close,why:`${r.symbol.replace(/_USDT$/,'')}冲出去又收回来，看它回到大家那边。`}));
    return {call:'BACK',side:null,episode:`B:${names.map(n=>n.symbol).join(',')}`,note:`${names.map(n=>n.symbol.replace(/_USDT$/,'')).join('、')}冲出去又收回来。接下来看它们回到大家那边，不拿整盘做方向。`,names,bar,chop:false};
  }
  if(rotating&&overlap)return {call:'NONE',side:null,episode:`N:${bar}`,note:'领头在换，价格还在原来的区间里重复。接下来没有整盘方向。',names:[],bar,chop:true};
  return {call:'WAIT',side:null,episode:`W:${bar}`,note:'这一段还对不上。没有越走越齐，也不是在原地换人。先不判断。',names:[],bar,chop:overlap};
}

function rule(side:Side,now:number,reason:string):Rule{
  return {id:`read-${side}`,signature:READ_POLICY,parentId:null,version:1,createdAt:now,expiresAt:now+6*60*60_000,
    status:'EXPERIMENTAL',conditions:[],side,horizon:120,stopRate:STOP,armRate:0,givebackRate:0,
    exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,priorResponse:null,recentResponse:0,
    standardError:0,reason,mutation:'CREATE',grammar:READ_POLICY,liveEligible:false};
}
function modeOf(state:ForwardState){
  const t=state.inverseTrial!,n=t.readClosed??0,g=t.readGross??0,f=t.readFee??0;
  if(t.readMode==='STOP'||t.readMode==='REVERSE')return t.readMode;
  if(n<4||!(f>0))return 'FOLLOW' as const;
  if(Math.abs(g)<2*f)return 'STOP' as const;
  if(g<=-5*f)return 'REVERSE' as const;
  return 'FOLLOW' as const;
}
function ownOpen(state:ForwardState){return state.positions.filter(t=>t.exitControl?.policy===READ_POLICY&&t.status==='OPEN');}
function closeRead(state:ForwardState,t:Trade,price:number,now:number,reason:string){
  const gross=dirOf(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*FEE,net=gross-t.entryFee-exitFee;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=now;
  t.exitFee=exitFee;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;t.fundingAllowance=0;
  state.balance+=gross-exitFee;state.grossPnl+=gross;state.fees+=exitFee;state.turnover+=t.quantity*price;
  state.resolved++;if(net>0)state.wins++;
  state.positions=state.positions.filter(x=>x.id!==t.id);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,240);
  state.revision++;state.events.unshift({id:`c${state.startedAt}-${state.revision}`,at:now,kind:'EXIT',subject:t.id,reason});
  state.events=state.events.slice(0,160);
  const trial=state.inverseTrial!;
  trial.readGross=(trial.readGross??0)+gross;
  trial.readFee=(trial.readFee??0)+t.entryFee+exitFee;
  trial.readClosed=(trial.readClosed??0)+1;
  const mode=modeOf(state);
  if(mode==='STOP'||mode==='REVERSE')trial.readMode=mode;
}
function stopped(bars:Candle[],side:Side,stop:number){
  for(const bar of bars){
    if(side==='LONG'?bar.low<=stop:bar.high>=stop)return bar.time;
  }
  return 0;
}
function exitNow(state:ForwardState,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,view:ReadView,now:number){
  let changed=false;
  for(const t of [...ownOpen(state)]){
    const q=quotes[t.symbol];if(!fresh(q,now))continue;
    const quotePx=t.side==='LONG'?q!.bestBid:q!.bestAsk;
    t.lastPrice=quotePx;t.lastQuoteAt=q!.observedAt;
    const signed=dirOf(t.side)*(quotePx/t.entryPrice-1);
    if(signed>t.favorable){t.favorable=signed;t.peakPnlRate=signed;changed=true;}
    t.adverse=Math.max(t.adverse,-signed);
    const bars=closedBars(minutePaths?.[t.symbol],now,60).filter(bar=>bar.time*1000+60_000>=t.openedAt);
    const through=t.side==='LONG'?quotePx<=t.stopPrice:quotePx>=t.stopPrice;
    const hit=stopped(bars,t.side,t.stopPrice);
    if(hit||through){
      const price=t.side==='LONG'?Math.min(quotePx,t.stopPrice):Math.max(quotePx,t.stopPrice);
      closeRead(state,t,price,now,'READ_STOP_EXIT');changed=true;continue;
    }
    const researchSide=(t.entryContext?.thesisId??'').split(':')[1] as Side|undefined;
    const fade=(t.entryContext?.thesisId??'').startsWith('B:');
    const ended=fade
      ?view.call==='NONE'||(view.call==='CONTINUE'&&!!view.side&&view.side!==researchSide)
      :view.chop||(view.call==='CONTINUE'&&!!view.side&&view.side!==researchSide);
    if(!ended||!(view.bar*1000>t.openedAt))continue;
    closeRead(state,t,quotePx,now,'READ_THESIS_EXIT');changed=true;
  }
  return changed;
}
function waveKey(view:ReadView){
  if(view.call==='CONTINUE'&&view.side)return `C:${view.side}`;
  if(view.call==='BACK'&&view.names.length)return `B:${view.names.map(n=>n.symbol).sort().join(',')}`;
  return '';
}
function openWave(state:ForwardState,view:ReadView,quotes:Record<string,Quote>,contracts:Record<string,Meta>|undefined,now:number){
  const trial=state.inverseTrial!;
  const key=waveKey(view);
  const open=ownOpen(state);
  if(!key||view.names.length===0)return false;
  if(open.length){
    const started=Math.min(...open.map(t=>t.openedAt));
    if(trial.readWave!==key||open.length>=MAX_NAMES||now-started>FILL_WINDOW)return false;
  }else if(trial.readWave===key)return false;
  const mode=modeOf(state);
  if(mode==='STOP'){trial.readMode='STOP';return false;}
  let changed=false,equity=state.balance;
  for(const t of state.positions){
    if(t.exitControl?.policy!==READ_POLICY)continue;
    const q=quotes[t.symbol],px=fresh(q,now)?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
    if(px>0)equity+=dirOf(t.side)*t.quantity*(px-t.entryPrice);
  }
  let used=state.positions.filter(t=>t.exitControl?.policy===READ_POLICY).reduce((n,t)=>n+t.margin,0);
  const held=new Set(state.positions.map(t=>t.symbol));
  let opened=0;
  for(const name of view.names){
    if(held.has(name.symbol)||(trial.readSpent??[]).includes(name.symbol)||opened>=MAX_NAMES)continue;
    const q=quotes[name.symbol],contract=contracts?.[name.symbol];
    if(!fresh(q,now)||!contract||!(contract.quantoMultiplier>0))continue;
    const mid=(q!.bestBid+q!.bestAsk)/2,spread=(q!.bestAsk-q!.bestBid)/mid;
    if(!(spread>=0)||spread>SPREAD_MAX)continue;
    const side:Side=mode==='REVERSE'?flip(name.side):name.side;
    const price=side==='LONG'?q!.bestAsk:q!.bestBid;
    const worse=side==='LONG'?(price-name.close)/name.close:(name.close-price)/name.close;
    if(worse>CHASE)continue;
    const leverage=Math.min(LEVERAGE,Math.max(1,contract.leverageMax||LEVERAGE));
    const mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
    const contractsN=Math.floor(NOTIONAL/(price*mult));
    if(contractsN<min)continue;
    const quantity=contractsN*mult,notional=quantity*price;
    if(notional<80||notional>480)continue;
    const margin=notional/leverage;
    if(!(equity>0)||used+margin>equity*.5)break;
    const stop=price*(1-dirOf(side)*STOP);
    const why=mode==='REVERSE'?`${name.why}账上亏的是方向，这笔反过来。`:name.why;
    const id=`rd-${now.toString(36)}-${name.symbol.replace(/[^A-Z0-9]/g,'').slice(0,24)}-${side[0]}`;
    const t:Trade={id,symbol:name.symbol,side,rule:rule(side,now,why),openedAt:now,closedAt:null,status:'OPEN',
      entryPrice:price,exitPrice:null,quantity,contracts:contractsN,quantoMultiplier:mult,notional,leverage,margin,plannedRisk:notional*STOP,
      stopPrice:stop,armPrice:price,favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q!.observedAt,entryFee:notional*FEE,exitFee:0,fundingAllowance:0,
      grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
      firstProfitAt:null,holdScore:0,profitFloorRate:0,expectedHoldMinutes:120,peakPnlRate:0,
      exitControl:{policy:READ_POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side,mode:view.call==='BACK'?'REVERSAL':'CONTINUATION',reserve:false,reason:why,
        entryScore:0,directionStrength:0,spaceScore:0,positionScore:0,executionScore:0,remainingSpaceRate:0,pullbackRiskRate:STOP,
        edgeRatio:0,expectedHoldMinutes:120,marketFit:0,regionId:null,portfolioRiskCharge:notional*STOP,strategyVersion:READ_POLICY,
        thesisId:view.call==='BACK'?`B:${name.side}:${name.symbol}`:`C:${name.side}`,thesisSince:now,entryResidual:0,thesisSummary:why,invalidationSummary:'这段判断结束就走。价格打到1.2%也走。小波动不平。'}};
    state.balance-=t.entryFee;state.fees+=t.entryFee;state.turnover+=notional;
    state.positions.push(t);held.add(name.symbol);used+=margin;opened++;changed=true;
    state.revision++;state.events.unshift({id:`c${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:id,reason:why});
    state.events=state.events.slice(0,160);
  }
  if(opened){
    trial.readWave=key;
    trial.readSpent=[...new Set([...(trial.readSpent??[]),...view.names.filter(n=>held.has(n.symbol)).map(n=>n.symbol)])];
    if(mode==='REVERSE')trial.readMode='REVERSE';
  }
  return changed;
}

export function applyReadBook(state:ForwardState,paths:Record<string,Candle[]>|undefined,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Contract>|undefined,now:number){
  const trial=state.inverseTrial;
  if(!trial||trial.paperPolicy!==READ_POLICY)return false;
  const view=readMarket(paths,contracts,now);
  let changed=exitNow(state,minutePaths,quotes,view,now);
  if(!ownOpen(state).length&&view.call!=='CONTINUE'&&view.call!=='BACK'&&(trial.readWave||trial.readSpent?.length)){
    trial.readWave=undefined;trial.readSpent=undefined;changed=true;
  }
  if(openWave(state,view,quotes,contracts as Record<string,Meta>|undefined,now))changed=true;
  const mode=modeOf(state);
  const tail=mode==='STOP'
    ?'账上的亏和手续费差不多，先停，不反。'
    :mode==='REVERSE'
    ?'整本亏的是方向，手续费很小，这一判断反过来做。'
    :ownOpen(state).length?`这一拨拿着，直到判断结束。现在 ${ownOpen(state).length} 笔。`:'有判断才做一拨，不拆成小碎单。';
  const note=`${view.note}${tail}`;
  if(trial.readNote!==note){trial.readNote=note;changed=true;}
  return changed;
}
