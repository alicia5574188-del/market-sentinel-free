/** Raw market prints the engine already computes and then discards.
 * Stored for research. Never scored, never used to place or exit an order. */
import type {MarketIntelligenceState} from './market-intelligence-engine.ts';

export const OBSERVATION_TAPE_VERSION='observation-tape-v1' as const;
const n=(v:number|null|undefined)=>typeof v==='number'&&Number.isFinite(v)?Math.round(v*1e6)/1e6:null;
const pct=(v:number|null)=>v==null?'—':`${v>=0?'+':''}${(v*100).toFixed(0)}`;
const bp=(v:number|null)=>v==null?'—':`${(v*10000).toFixed(1)}bp`;
const num=(v:number|null)=>v==null?'—':`${v>=0?'+':''}${v.toFixed(0)}`;

export type ObservationTape={
  version:typeof OBSERVATION_TAPE_VERSION;at:number;
  breadth3:number|null;breadth12:number|null;breadthSlope:number|null;
  dispersion:number|null;synchrony:number|null;
  bookImbalance:number|null;bidLiquidity:number|null;askLiquidity:number|null;spread:number|null;
  venuePressure:number|null;leaderPersistence:number|null;
  macroScore:number|null;majorScore:number|null;shortScore:number|null;
  transitionPressure:number|null;
  migration:number|null;accepted:number|null;rejected:number|null;inside:number|null;testing:number|null;
  upMigration:number|null;downMigration:number|null;oneSidedDepletion:number|null;
  drivers:string[];
};
export type ObservationReading={
  version:typeof OBSERVATION_TAPE_VERSION;ordersAffected:false;
  now:ObservationTape;previousAt:number|null;lines:string[];sentence:string;
};

export function observationTape(s:MarketIntelligenceState):ObservationTape{
  const i=s.internals,liq=s.liquidity?.market,ready=!!liq?.ready;
  return{version:OBSERVATION_TAPE_VERSION,at:s.updatedAt,
    breadth3:n(i?.breadth3),breadth12:n(i?.breadth12),breadthSlope:n(i?.breadthSlope),
    dispersion:n(i?.dispersion),synchrony:n(i?.synchrony),
    bookImbalance:n(i?.bookImbalance),bidLiquidity:n(i?.bidLiquidityChange),askLiquidity:n(i?.askLiquidityChange),
    spread:n(i?.spreadRate),venuePressure:n(i?.venuePressure),leaderPersistence:n(i?.leaderPersistence),
    macroScore:n(s.narrative?.macro?.score),majorScore:n(s.narrative?.major?.score),shortScore:n(s.narrative?.short?.score),
    transitionPressure:n(s.narrative?.transition?.pressure),
    migration:ready?n(liq?.migrationBreadth):null,accepted:ready?n(liq?.acceptedShare):null,
    rejected:ready?n(liq?.rejectedShare):null,inside:ready?n(liq?.insideShare):null,testing:ready?n(liq?.testingShare):null,
    upMigration:ready?n(liq?.upMigrationShare):null,downMigration:ready?n(liq?.downMigrationShare):null,
    oneSidedDepletion:ready?n(liq?.oneSidedDepletionShare):null,
    drivers:(s.narrative?.transition?.drivers??[]).filter(x=>typeof x==='string'&&x.length>0).slice(0,6)};
}

function moved(now:number|null,then:number|null,min:number){
  if(now==null||then==null)return null;
  const d=now-then;return Math.abs(d)>=min?d:null;
}

export function observationReading(s:MarketIntelligenceState,history:ObservationTape[]=[]):ObservationReading{
  const now=observationTape(s);
  const previous=history.filter(x=>x&&x.at<now.at).sort((a,b)=>b.at-a.at)[0]??null;
  const lines=[
    `广度：近3根 ${pct(now.breadth3)}，近12根 ${pct(now.breadth12)}，变化 ${pct(now.breadthSlope)}，分化 ${pct(now.dispersion)}，一起走 ${pct(now.synchrony)}`,
    `盘口：失衡 ${pct(now.bookImbalance)}，买盘变化 ${pct(now.bidLiquidity)}，卖盘变化 ${pct(now.askLiquidity)}，价差 ${bp(now.spread)}，跨所压力 ${pct(now.venuePressure)}`,
    `方向原数：大周期 ${num(now.macroScore==null?null:now.macroScore*100)}，大方向 ${num(now.majorScore==null?null:now.majorScore*100)}，短期 ${num(now.shortScore==null?null:now.shortScore*100)}，转变压力 ${now.transitionPressure==null?'—':now.transitionPressure.toFixed(0)}`,
    `流动性：迁移 ${pct(now.migration)}，被接受 ${pct(now.accepted)}，被退回 ${pct(now.rejected)}，还在原区 ${pct(now.inside)}，正在试 ${pct(now.testing)}，向上 ${pct(now.upMigration)}，向下 ${pct(now.downMigration)}`,
  ];
  const changes:string[]=[];
  if(previous){
    const bits:[string,number|null][]=[
      ['3根广度',moved(now.breadth3,previous.breadth3,.05)],
      ['盘口失衡',moved(now.bookImbalance,previous.bookImbalance,.08)],
      ['买盘',moved(now.bidLiquidity,previous.bidLiquidity,.08)],
      ['卖盘',moved(now.askLiquidity,previous.askLiquidity,.08)],
      ['价差',moved(now.spread,previous.spread,.0002)],
      ['流动性迁移',moved(now.migration,previous.migration,.06)],
      ['大方向',moved(now.majorScore,previous.majorScore,.05)],
      ['短期',moved(now.shortScore,previous.shortScore,.05)],
    ];
    for(const [name,delta] of bits)if(delta!=null)changes.push(`${name}${delta>0?'上升':'下降'}`);
  }
  if(now.drivers.length)lines.push(`这一拍带着的变化：${now.drivers.join('、')}`);
  const sentence=changes.length
    ?`和上一拍比，${changes.join('，')}。下面是这一拍的原数，没有打分，也不下单。`
    :'这一拍的原数如下。还没有和上一拍拉开的变化。没有打分，也不下单。';
  return{version:OBSERVATION_TAPE_VERSION,ordersAffected:false,now,previousAt:previous?.at??null,lines,sentence};
}
