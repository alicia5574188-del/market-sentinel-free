"use client";
/** One order card for PAPER and LIVE. Display only: it never changes or drops order data, it only decides
 * what is visible at first glance, what opens on tap, and what sits behind "详细依据". */
import type {ReactNode} from "react";
import "./order-card.css";

export type OrderFact={label:string;value:ReactNode;tone?:number|null;wide?:boolean};
type Props={
  symbol:string;side:"LONG"|"SHORT";leverage?:number|null;live?:boolean;
  /** Closed by isolated-margin liquidation: shows a 爆仓 tag next to the side. */
  liquidated?:boolean;
  /** Small rule tag next to the side, e.g. 顺势 / 反向 空→多 (S1 trades). */
  tag?:string|null;tagTitle?:string;
  pnl:number|null;pnlText?:string;rate:number|null;
  /** Short state shown under the symbol: the plain exit label, or 持仓中. */
  state:string;held:string;extra?:ReactNode;
  facts:OrderFact[];why?:string|null;out?:string|null;notes?:ReactNode;
  detail?:ReactNode;detailTitle?:string;className?:string;
};
const num=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
/** Prices keep about five significant digits, so 0.2966 and 61,234.5 both read cleanly. */
export const priceText=(v:number|null|undefined)=>{
  if(typeof v!=="number"||!Number.isFinite(v))return "—";
  const a=Math.abs(v),d=a>=1000?2:a>0?Math.min(8,Math.max(2,4-Math.floor(Math.log10(a)))):2;
  return num(v,d);
};
export const signedNum=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${num(v,d)}`:"—";
const tone=(v:number|null|undefined)=>typeof v!=="number"||!Number.isFinite(v)||v===0?"":v>0?" fr-positive":" fr-negative";

/** Plain one-to-four word exit labels for the collapsed card. The full wording stays in the fold. */
const EXIT_SHORT:Record<string,string>={
  WINNER_STRUCTURE_EXIT:"碰到保护位",WINNER_THESIS_EXIT:"推不动了",PEAK_GIVEBACK:"浮盈回吐",AFTER_PROFIT_LOSS:"浮盈后转亏",
  RHYTHM_BREAK:"节奏断了",EXPECTANCY_EXIT:"到预期幅度",STRUCTURE_STOP:"止损",PROFIT_GIVEBACK:"利润保护",THESIS_INVALIDATED:"判断失效",
  RELATIVE_EDGE_GONE:"优势消失",NO_POSITIVE_FEEDBACK:"久无进展",MAX_HOLD:"到时间",RANGE_CENTER_EXIT:"目标到了",ACCOUNT_RESET:"手动重置",
  SHADOW_SOURCE_EXIT:"跟随提案",INVERSE_SOFT_LOSS_EXIT:"浮亏到线",OPPORTUNITY_REPLACED:"换更好的",
  PAPER_SOURCE_EXIT:"跟随模拟平仓",PAPER_PORTFOLIO_EXIT:"跟随模拟调仓",EXCHANGE_FLAT:"交易所已平",RISK_CAP_AFTER_FILL:"超出风险上限",
  PROTECTIVE_STOP_CREATE_FAILED:"止损没挂上",PROTECTIVE_STOP_CREATE_UNCONFIRMED:"止损未确认",LIQUIDATION:"爆仓",
  S1_TP:"止盈 6%",S1_SL:"止损",S1_TIME_6H:"满 6 小时",S1_TIME_24H:"满 24 小时",
  LIVING_STOP:"止损",LIVING_FALLBACK_TIMEOUT:"兜底到时间",LIVING_GUARD_STOP:"碰到收紧保护",LIVING_FAST_EXHAUST:"异动力竭",LIVING_FAST_FAKE:"假动作",
  LIVING_FAST_TIME:"10分钟没走出",LIVING_FAST_GIVEBACK:"利润回吐",LIVING_FAST_CONFIRM_EXIT:"异动确认平",LIVING_FAST_LIQ_GUARD:"离爆仓太近",
  LIVING_INTENT_GONE:"资金反了",LIVING_INTENT_MARKET_FLIP:"市场转向",LIVING_INTENT_DONE:"目标兑现",LIVING_INTENT_CLIMAX_TAKE:"利润交给追进的人",LIVING_DYN_LOCK:"动态锁利",LIVING_DYN_REVERSED:"资金反转离场",LIVING_DYN_LOSS_REPAIR:"反弹减亏离场",LIVING_DYN_EXTEND_END:"延长持有到期",LIVING_DYN_EXTEND:"延长持有",LIVING_THESIS_TIMEOUT:"到计划时长",
  LIVING_THESIS_FLIP:"判断反了",LIVING_THESIS_STRUCTURE:"结构破了",LIVING_THESIS_UNREWARDED:"不再给钱",
};
/** One plain sentence for "为什么平". Unknown codes fall back to the caller's existing label. */
const EXIT_PLAIN:Record<string,string>={
  WINNER_STRUCTURE_EXIT:"价格回到开仓后设好的保护位，按计划平仓。",
  WINNER_THESIS_EXIT:"这个币自己的推动停了，判断不再成立，平仓。",
  PEAK_GIVEBACK:"浮盈从最高点吐回到设定的线，平仓留住利润。",
  AFTER_PROFIT_LOSS:"浮盈过后又转成亏损，及时离场。",
  STRUCTURE_STOP:"价格打到止损位，平仓。",
  PROFIT_GIVEBACK:"利润回吐到保护线，平仓。",
  THESIS_INVALIDATED:"开仓时的判断已经不成立，平仓。",
  MAX_HOLD:"拿到了最长持仓时间，平仓。",
  ACCOUNT_RESET:"手动重置账户时平仓。",
  PAPER_SOURCE_EXIT:"对应的模拟单平仓，实盘跟着平。",
  PAPER_PORTFOLIO_EXIT:"模拟账户调整仓位，实盘跟着平。",
  EXCHANGE_FLAT:"Gate 上这笔仓位已经归零。",
  RISK_CAP_AFTER_FILL:"成交后超过单笔风险上限，立即平掉。",
  PROTECTIVE_STOP_CREATE_FAILED:"止损单没能挂上，为安全直接平仓。",
  PROTECTIVE_STOP_CREATE_UNCONFIRMED:"止损单没得到确认，为安全直接平仓。",
  LIQUIDATION:"价格越过逐仓强平价，止损没来得及成交，按爆仓平掉，这笔保证金全部亏掉。",
  S1_TP:"S1 顺势单涨跌到 6% 目标，止盈平仓。",
  S1_SL:"价格打到 S1 止损位，平仓。",
  S1_TIME_6H:"S1 反向单拿满 6 小时，到点平仓。",
  S1_TIME_24H:"S1 顺势单拿满 24 小时还没碰到止盈止损，到点平仓。",
  LIVING_STOP:"价格打到这笔单的止损价（开仓时定的，或大脑收紧过的），平仓。",
  LIVING_FALLBACK_TIMEOUT:"大脑暂停（出错、数据不新鲜或关闭）期间，这笔单拿满计划时长的 1.5 倍，按兜底规则平仓。",
};
/** Living-layer playbook names (same text as lib/living/thesis.ts PLAYBOOK_LABEL; a test keeps them in sync). */
export const LIVING_PLAYBOOK_LABEL:Record<string,string>={"trend-pullback":"趋势回调","breakout":"突破延续","range-revert":"区间回归",
  "extension-fade":"过度延伸反转","crowding-fade":"拥挤反转",leaders:"领涨延续",laggards:"落后补涨","btc-lead":"BTC 带动",momentum:"动量",
  follow:"顺着真资金（回调跟进）","squeeze-fade":"逼空衰竭反做","flush-rebound":"恐慌出尽抄反弹","crowd-fade":"贪婪拥挤失败反做",
  "crowd-break":"安逸拥挤破位反做","absorb-revert":"区间边缘被吸收回归",
  "sweep-reclaim":"震荡假突破收回（做回区间中部）","impulse-retest":"第一根快速冲击回踩跟进",fast:"集体异动快速跟进"};
export const livingPlaybookLabel=(pb:string|null|undefined)=>pb?LIVING_PLAYBOOK_LABEL[pb]??pb:null;
export const exitShort=(code:string|null|undefined,fallback?:string)=>code?EXIT_SHORT[code]??fallback??code:"—";
export const exitPlain=(code:string|null|undefined,fallback?:string)=>code?EXIT_PLAIN[code]??fallback??code:null;

export function OrderCard({symbol,side,leverage,live,liquidated,tag,tagTitle,pnl,pnlText,rate,state,held,extra,facts,why,out,notes,detail,detailTitle="详细依据",className}:Props){
  const [base,quote]=symbol.split("_");
  return <details className={`oc-card${live?" is-live":""}${liquidated?" is-liquidated":""}${className?` ${className}`:""}`}>
    <summary>
      <span className="oc-line">
        <span className="oc-name"><b>{base}</b>{quote&&<small>/{quote}</small>}
          <i className={`oc-side ${side==="LONG"?"is-long":"is-short"}`}>{side==="LONG"?"多":"空"}</i>
          {leverage!=null&&<small className="oc-lev">{num(leverage,0)}×</small>}
          {tag&&<i className="oc-tag" title={tagTitle}>{tag}</i>}
          {live&&<i className="oc-live">实盘</i>}
          {liquidated&&<i className="oc-liq">爆仓</i>}</span>
        <b className={`oc-pnl${tone(pnl)}`}>{pnlText??`${signedNum(pnl)} U`}</b>
      </span>
      <span className="oc-line oc-sub">
        <span>{state} · {held}</span>
        <span className={`oc-rate${tone(rate)}`}>{rate==null?"":`${signedNum(rate*100)}%`}</span>
      </span>
      {extra&&<span className="oc-line oc-sub">{extra}</span>}
    </summary>
    <div className="oc-body">
      <dl className="oc-grid">{facts.map(f=><div key={f.label} className={f.wide?"is-wide":undefined}><dt>{f.label}</dt><dd className={tone(f.tone).trim()||undefined}>{f.value}</dd></div>)}</dl>
      {(why||out)&&<div className="oc-why">
        {why&&<p><span>为什么开</span>{why}</p>}
        {out&&<p><span>为什么平</span>{out}</p>}
      </div>}
      {notes}
      {detail&&<details className="oc-more"><summary>{detailTitle}</summary><div className="oc-more-body">{detail}</div></details>}
    </div>
  </details>;
}
