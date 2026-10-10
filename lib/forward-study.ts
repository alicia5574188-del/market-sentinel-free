/** Durable record of the research book's own closes.
 * Hot history is trimmed; these aggregates are not. Nothing here places a trade. */
import type {ForwardState,Quote,Trade} from './forward-relations.ts';
import {forwardEquity} from './forward-relations.ts';
import {inverseTrialSummary,type InverseTrial} from './shadow-inverse-ledger.ts';
import {researchDeskView,type DeskResearchView,type DeskStance} from './research-decision.ts';

export const FORWARD_STUDY_VERSION='forward-study-v1' as const;
const ROW_CAP=160;
const BOOKED_CAP=800;
const BJ=8*3_600_000;

export type ForwardStudyCell={n:number;wins:number;net:number};
export type ForwardStudyRow={
  id:string;symbol:string;side:'LONG'|'SHORT';openedAt:number;closedAt:number|null;hour:number;
  persistence:number|null;expansion:'HIGH'|'NORMAL'|'LOW'|null;environment:string|null;plan:string|null;
  net:number|null;win:boolean|null;exit:string|null;
};
export type ForwardStudy={
  version:typeof FORWARD_STUDY_VERSION;stance:'FORWARD';startedAt:number;updatedAt:number;
  booked:string[];rows:ForwardStudyRow[];hours:ForwardStudyCell[];
  persistence:{high:ForwardStudyCell;mid:ForwardStudyCell;low:ForwardStudyCell;unknown:ForwardStudyCell};
  expansions:Record<string,ForwardStudyCell>;environments:Record<string,ForwardStudyCell>;
  total:ForwardStudyCell;
};
export type WorkLine={name:string;data:string;said:string};
export type WorkSheet={subject:string;method:string;lines:WorkLine[];waiting:string;preparing:string};
export type ForwardOrder={
  id:string;symbol:string;side:'LONG'|'SHORT';status:'OPEN'|'CLOSED';entryPrice:number;price:number|null;
  openedAt:number;closedAt:number|null;net:number|null;leverage:number;margin:number;plan:string|null;waiting:string|null;
  stop:number|null;target:number|null;exit:string|null;
};
export type LsrBoard={
  scans:number;signals:number;filled:number;cancelled:number;closed:number;wins:number;closedNet:number;priorNet:number;
  trend:number;exhaustion:number;sweep:number;micro:number;stale:number;spread:number;price:number;
  resting:{symbol:string;side:'LONG'|'SHORT';price:number}[];
  verdict:string;
};
export type ForwardStudyView={
  recorded:number;recordedWins:number;recordedNet:number;sourceResolved:number;startedAt:number;ready:boolean;
  note:string;coverage:string;groups:{label:string;n:number;wins:number;net:number}[];
  recent:{id:string;symbol:string;side:'LONG'|'SHORT';closedAt:number;net:number;hour:number;tag:string}[];
};
export type ForwardDesk={
  stance:DeskStance;book?:'needle-v1'|'brain-v1'|'score-v1'|'read-v1'|'reverse-v1'|'stretch-v1'|'lsr-v1';equity:number|null;initialEquity:number;netPnl:number|null;maxDrawdown:number|null;
  fees:number;floating:number|null;stale:boolean;openCount:number;resolved:number;wins:number;
  open:ForwardOrder[];recent:ForwardOrder[];curve:{at:number;equity:number}[];study:ForwardStudyView;
  research:DeskResearchView;brainNote?:string;scoreNote?:string;readNote?:string;stretchNote?:string;lsrNote?:string;work?:WorkSheet;lsrBoard?:LsrBoard;
  brainIdeas?:{symbol:string;side:'LONG'|'SHORT';kind:'FADE'|'LEAD'|'CATCH';why:string;wrong:string}[];
};

const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const cell=():ForwardStudyCell=>({n:0,wins:0,net:0});
const add=(bucket:ForwardStudyCell,net:number)=>{bucket.n++;if(net>0)bucket.wins++;bucket.net+=net;};
const empty=(now:number):ForwardStudy=>({
  version:FORWARD_STUDY_VERSION,stance:'FORWARD',startedAt:now,updatedAt:now,booked:[],rows:[],
  hours:Array.from({length:24},cell),
  persistence:{high:cell(),mid:cell(),low:cell(),unknown:cell()},
  expansions:{},environments:{},total:cell(),
});
function usable(study:ForwardStudy|undefined):study is ForwardStudy{
  return !!study&&study.version===FORWARD_STUDY_VERSION&&study.stance==='FORWARD'&&Array.isArray(study.booked)
    &&Array.isArray(study.rows)&&Array.isArray(study.hours)&&study.hours.length===24
    &&!!study.persistence?.high&&!!study.persistence.mid&&!!study.persistence.low&&!!study.persistence.unknown
    &&!!study.expansions&&!!study.environments&&finite(study.total?.n)&&finite(study.total?.wins)&&finite(study.total?.net);
}
function band(score:number|null):keyof ForwardStudy['persistence']{
  if(score==null)return 'unknown';
  if(score>=0.70)return 'high';
  if(score>=0.45)return 'mid';
  return 'low';
}
function expansionOf(v:unknown):ForwardStudyRow['expansion']{
  return v==='HIGH'||v==='NORMAL'||v==='LOW'?v:null;
}
function snapshot(t:Trade):ForwardStudyRow{
  const ctx=t.entryContext,persistence=finite(ctx?.environmentPersistenceScore)?ctx.environmentPersistenceScore:null;
  return {id:t.id,symbol:String(t.symbol??'').slice(0,32),side:t.side==='SHORT'?'SHORT':'LONG',
    openedAt:t.openedAt,closedAt:finite(t.closedAt)?t.closedAt:null,hour:new Date(t.openedAt+BJ).getUTCHours(),
    persistence,expansion:expansionOf(ctx?.environmentProfitExpansion),
    environment:typeof ctx?.environment==='string'?ctx.environment.slice(0,24):null,
    plan:typeof ctx?.tradePlan==='string'?ctx.tradePlan.slice(0,32):null,
    net:null,win:null,exit:null};
}
function bucket(map:Record<string,ForwardStudyCell>,key:string){
  return map[key]??(map[key]=cell());
}

/** Fold source closes into aggregates once. Dropping a receipt later must not count it again. */
export function noteForwardStudy(trial:InverseTrial,now:number){
  const source=trial.source;
  if(!source||!Array.isArray(source.positions)||!Array.isArray(source.history))return;
  const study=usable(trial.forwardStudy)?trial.forwardStudy:empty(now);
  const seen=new Set(study.booked);
  const byId=new Map(study.rows.map(row=>[row.id,row]));
  const trades=[...source.positions,...source.history.filter(t=>!source.positions.some(p=>p.id===t.id))];
  for(const t of trades){
    if(!t?.id||!finite(t.openedAt)||t.exitReason==='ACCOUNT_RESET')continue;
    if(t.status==='CLOSED'&&finite(t.closedAt)&&finite(t.netPnl)){
      const net=t.netPnl,closedAt=t.closedAt;
      const kept=byId.get(t.id);
      if(seen.has(t.id)){
        if(kept){kept.closedAt=closedAt;kept.net=net;kept.win=net>0;kept.exit=(t.exitReason??'').slice(0,40)||null;}
        continue;
      }
      const row=kept??snapshot(t);
      if(!kept)byId.set(t.id,row);
      row.closedAt=closedAt;row.net=net;row.win=net>0;row.exit=(t.exitReason??'').slice(0,40)||null;
      add(study.total,net);
      add(study.hours[row.hour]??(study.hours[row.hour]=cell()),net);
      add(study.persistence[band(row.persistence)],net);
      add(bucket(study.expansions,row.expansion??'unknown'),net);
      add(bucket(study.environments,row.environment??'unknown'),net);
      seen.add(t.id);study.booked.push(t.id);
      continue;
    }
    if(seen.has(t.id)||byId.has(t.id))continue;
    byId.set(t.id,snapshot(t));
  }
  const present=new Set(trades.map(t=>t.id));
  const open=[...byId.values()].filter(row=>row.net==null&&present.has(row.id));
  const closed=[...byId.values()].filter(row=>row.net!=null).sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,ROW_CAP);
  study.rows=[...open,...closed];
  const must=study.booked.filter(id=>present.has(id)),old=study.booked.filter(id=>!present.has(id));
  study.booked=[...old.slice(-(BOOKED_CAP-must.length)),...must];
  study.updatedAt=now;
  trial.forwardStudy=study;
}

const ENV:Record<string,string>={TREND:'趋势',TRANSITION:'过渡',ROTATION:'轮动',SHOCK:'爆发',unknown:'未标环境'};
const EXP:Record<string,string>={HIGH:'扩张高',NORMAL:'扩张中',LOW:'扩张低',unknown:'扩张未标'};
const PLAN:Record<string,string>={WINNER_TREND:'独立趋势',RANGE_REVERSION:'边缘回归',LIQUIDITY_MIGRATION:'流动性迁移',LIQUIDITY_REJECTION:'离开失败',FAMILY_TURN:'家族转折',OBSERVE_ONLY:'只观察'};
function pushGroup(groups:ForwardStudyView['groups'],label:string,bucket?:ForwardStudyCell){
  if(bucket&&bucket.n>0)groups.push({label,n:bucket.n,wins:bucket.wins,net:bucket.net});
}
export function describeForwardStudy(study:ForwardStudy,sourceResolved:number):ForwardStudyView{
  const recorded=study.total.n,ready=recorded>=40;
  const groups:ForwardStudyView['groups']=[];
  pushGroup(groups,'高持续',study.persistence.high);
  pushGroup(groups,'中持续',study.persistence.mid);
  pushGroup(groups,'低持续',study.persistence.low);
  for(const key of ['HIGH','NORMAL','LOW','unknown'])pushGroup(groups,EXP[key]??key,study.expansions[key]);
  for(const [key,bucket] of Object.entries(study.environments))pushGroup(groups,ENV[key]??'其他环境',bucket);
  study.hours.forEach((bucket,hour)=>{if(bucket.n>0)groups.push({label:`北京${hour}点`,n:bucket.n,wins:bucket.wins,net:bucket.net});});
  const recent=study.rows.filter((row):row is ForwardStudyRow&{net:number;closedAt:number}=>row.net!=null&&row.closedAt!=null)
    .sort((a,b)=>b.closedAt-a.closedAt).slice(0,8)
    .map(row=>({id:row.id,symbol:row.symbol,side:row.side,closedAt:row.closedAt,net:row.net,hour:row.hour,
      tag:[band(row.persistence)==='high'?'高持续':band(row.persistence)==='mid'?'中持续':band(row.persistence)==='low'?'低持续':null,
        row.expansion?EXP[row.expansion]:null,row.environment?ENV[row.environment]??null:null].filter(Boolean).join(' · ')}));
  return {recorded,recordedWins:study.total.wins,recordedNet:study.total.net,sourceResolved,startedAt:study.startedAt,ready,
    note:ready?'这些分组留给以后定正反切换。现在仍然只做正向，不自动切。':'样本还不够定正反切换，继续只做正向。',
    coverage:sourceResolved>recorded
      ?`研究层累计平仓 ${sourceResolved} 笔。这次能核对并记下 ${recorded} 笔，更早被裁掉的不补。`
      :'记下的平仓，就是现在还能核对到的全部。',
    groups,recent};
}

function orderOf(t:Trade,status:'OPEN'|'CLOSED'):ForwardOrder{
  const px=status==='OPEN'?t.lastPrice:t.exitPrice??t.lastPrice;
  const price=finite(px)&&px>0?px:null;
  let net:number|null=status==='CLOSED'&&finite(t.netPnl)?t.netPnl:null;
  if(status==='OPEN'&&price!=null&&t.entryPrice>0&&t.quantity>0){
    const dir=t.side==='LONG'?1:-1,gross=dir*t.quantity*(price-t.entryPrice);
    const base=t.realization?.initialQuantity??t.quantity;
    net=gross-(finite(t.entryFee)?t.entryFee*(base>0?t.quantity/base:1):0)+(t.realization?t.realization.gross-t.realization.fees-t.realization.funding:0);
  }
  const plan=t.entryContext?.strategyVersion==='read-v1'
    ?t.entryContext.mode==='REVERSAL'?'回来':'跟上'
    :t.entryContext?.strategyVersion==='score-v1'
    ?t.entryContext.mode==='REVERSAL'?'收回':'顺着'
    :t.entryContext?.strategyVersion==='lsr-v1'
    ?'衰竭'
    :t.entryContext?.strategyVersion==='stretch-v1'
    ?'跟着大盘'
    :t.entryContext?.strategyVersion==='brain-v1'
    ?t.entryContext.mode==='CONTINUATION'?'领头':t.entryContext.mode==='RELATIVE'?'掉队':'单币失败'
    :t.entryContext?.tradePlan?(PLAN[t.entryContext.tradePlan]??null):null;
  return {id:t.id,symbol:t.symbol,side:t.side,status,entryPrice:t.entryPrice,price,openedAt:t.openedAt,
    closedAt:status==='CLOSED'?t.closedAt:null,net,leverage:t.leverage,margin:t.margin,
    plan:plan?(PLAN[plan]??plan):null,waiting:status==='OPEN'?exitWait(t):null,
    stop:finite(t.stopPrice)?t.stopPrice:null,
    target:t.entryContext?.strategyVersion==='lsr-v1'&&t.entryPrice>0?t.entryPrice*(t.side==='LONG'?1.003:0.997):null,
    exit:t.exitReason??null};
}
function money(n:number){
  if(!(n>0))return '—';
  return n>=100?n.toFixed(2):n>=1?n.toFixed(4):n.toFixed(6);
}
function exitWait(t:Trade){
  const version=t.entryContext?.strategyVersion,stop=money(t.stopPrice);
  if(version==='lsr-v1')return t.entryContext?.invalidationSummary??'止盈 0.30%。止损 0.20%，触发后按对手价再让 0.05% 走。最长拿 15 分钟。';
  if(version==='brain-v1'){
    const lead=t.entryContext?.mode==='CONTINUATION',lag=t.entryContext?.mode==='RELATIVE';
    return `${lead?'领头':lag?'掉队':'单币失败'}。想错了就走：价格${t.side==='LONG'?'落到':'涨到'} ${stop}。想对了：浮盈到过 0.8% 再吐回一半才走。还没到 0.8%，满 ${lead?45:30} 分钟走。${lag?'整盘不再是进场时那一边，也走。':''}`;
  }
  if(version==='read-v1')return `这一拨的方向还在就拿着。整盘没方向了，或者改成反方向，就走。价格${t.side==='LONG'?'落到':'涨到'} ${stop}（入场的 1.2%）也走。`;
  if(version==='score-v1')return `到止损 ${stop}、到目标，或者满 30 分钟，谁先到谁走。`;
  if(version==='needle-v1')return `打穿针尖 ${stop} 就走。5 分钟没走出 0.15%，或浮亏到 4U，也走。到过 0.8% 再吐回一半走。最长 90 分钟。`;
  return t.entryContext?.invalidationSummary??null;
}
function lsrBoardOf(trial:InverseTrial):LsrBoard{
  const f=trial.lsrFunnel;
  const board:LsrBoard={scans:f?.scans??0,signals:f?.signals??0,filled:f?.filled??0,cancelled:f?.cancelled??0,
    closed:f?.closed??0,wins:f?.wins??0,closedNet:trial.lsrClosedNet??0,priorNet:trial.lsrPriorNet??0,trend:f?.trend??0,exhaustion:f?.exhaustion??0,sweep:f?.sweep??0,
    micro:f?.micro??0,stale:f?.stale??0,spread:f?.spread??0,price:f?.priceCheck??0,
    resting:(trial.lsrWork??[]).map(order=>({symbol:order.s,side:order.side,price:order.price})),verdict:''};
  const stuck=[['趋势',board.trend],['放量',board.exhaustion],['扫单',board.sweep],['往回摆',board.micro],['价差',board.spread],['行情过期',board.stale],['价格对不上',board.price]]
    .sort((a,b)=>Number(b[1])-Number(a[1]));
  board.verdict=board.scans===0?'还没有记下一拍。'
    :board.signals===0?`还没出信号。最多卡在${stuck[0]?.[0]??'趋势'}。`
    :board.filled===0&&board.cancelled>0?`出过信号。挂单没被打到，撤了 ${board.cancelled} 次。`
    :board.filled>0?`成交 ${board.filled} 笔，已平 ${board.closed} 笔，赢 ${board.wins} 笔。`
    :`出过 ${board.signals} 个信号，还在等价格打到挂单价。`;
  return board;
}
export function forwardDeskView(state:ForwardState,quotes:Record<string,Quote>,now:number):ForwardDesk|null{
  const trial=state.inverseTrial;if(!trial?.source)return null;
  const summary=inverseTrialSummary(state,quotes,now);if(!summary)return null;
  const own=trial.paperPolicy==='needle-v1'||trial.paperPolicy==='brain-v1'||trial.paperPolicy==='score-v1'||trial.paperPolicy==='read-v1'||trial.paperPolicy==='stretch-v1'||trial.paperPolicy==='lsr-v1';
  const ownTrade=(t:Trade)=>t.exitControl?.policy===trial.paperPolicy;
  const summaryStale=(summary.stalePositions??0)>0;
  const mark=own?forwardEquity(state,quotes,now):null;
  const stale=own?(mark!.stalePositions??0)>0:summaryStale;
  const stance:DeskStance=trial.researchDesk?.stance??'FORWARD';
  const last=trial.curve?.at(-1)?.inverse;
  const equity=stale?(finite(last)?last:null):own?mark!.equity:summary.inverseEquity;
  const initial=own?state.initialEquity:summary.initialEquity;
  const netPnl=equity==null?null:equity-initial;
  const floating=stale?null:own?mark!.floating:summary.paidCost?.inverse.floatingGross??null;
  let peak=initial,dd=0;
  for(const point of trial.curve??[]){
    if(!(point.inverse>0))continue;
    if(point.inverse>peak)peak=point.inverse;
    dd=Math.max(dd,1-point.inverse/peak);
  }
  if(equity!=null&&equity>0){if(equity>peak)peak=equity;dd=Math.max(dd,1-equity/peak);}
  const curve=(trial.curve??[]).map(point=>({at:point.at,equity:point.inverse}));
  if(!stale&&equity!=null&&(curve.at(-1)?.at??0)<now)curve.push({at:now,equity});
  const study=usable(trial.forwardStudy)?trial.forwardStudy:empty(now);
  const closed=(own?state.history.filter(ownTrade):state.history.filter(t=>t.inverseCopy&&t.status==='CLOSED'&&t.exitReason!=='ACCOUNT_RESET'))
    .filter(t=>t.status==='CLOSED').sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,8);
  const openRows=own?state.positions.filter(ownTrade):state.positions.filter(t=>t.inverseCopy);
  return {stance,book:trial.paperPolicy==='lsr-v1'?'lsr-v1':trial.paperPolicy==='stretch-v1'?'stretch-v1':trial.paperPolicy==='reverse-v1'?'reverse-v1':trial.paperPolicy==='read-v1'?'read-v1':trial.paperPolicy==='score-v1'?'score-v1':trial.paperPolicy==='brain-v1'?'brain-v1':trial.paperPolicy==='needle-v1'?'needle-v1':undefined,equity,initialEquity:initial,netPnl,maxDrawdown:peak>0?dd:null,
    fees:own?state.fees:summary.inverseFees,floating,stale,openCount:openRows.length,
    resolved:own?state.resolved:state.resolved,wins:state.wins,
    open:openRows.map(t=>orderOf(t,'OPEN')).sort((a,b)=>b.openedAt-a.openedAt),
    recent:closed.map(t=>orderOf(t,'CLOSED')),
    curve:curve.length>240?curve.slice(-240):curve,
    study:describeForwardStudy(study,trial.source.resolved??study.total.n),
    research:researchDeskView(trial.researchDesk,now),
    brainNote:trial.paperPolicy==='brain-v1'?trial.brainNote:undefined,
    scoreNote:trial.paperPolicy==='score-v1'?trial.scoreNote:undefined,
    readNote:trial.paperPolicy==='read-v1'?trial.readNote:undefined,
    stretchNote:trial.paperPolicy==='stretch-v1'?trial.stretchNote:undefined,
    lsrNote:trial.paperPolicy==='lsr-v1'?trial.lsrNote:undefined,
    lsrBoard:trial.paperPolicy==='lsr-v1'?lsrBoardOf(trial):undefined,
    work:trial.paperPolicy==='brain-v1'||trial.paperPolicy==='read-v1'||trial.paperPolicy==='stretch-v1'||trial.paperPolicy==='lsr-v1'?trial.work:undefined,
    brainIdeas:trial.paperPolicy==='brain-v1'?trial.brainIdeas??[]:undefined};
}
