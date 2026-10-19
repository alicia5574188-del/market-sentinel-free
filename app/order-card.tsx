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
};
export const exitShort=(code:string|null|undefined,fallback?:string)=>code?EXIT_SHORT[code]??fallback??code:"—";
export const exitPlain=(code:string|null|undefined,fallback?:string)=>code?EXIT_PLAIN[code]??fallback??code:null;

export function OrderCard({symbol,side,leverage,live,liquidated,pnl,pnlText,rate,state,held,extra,facts,why,out,notes,detail,detailTitle="详细依据",className}:Props){
  const [base,quote]=symbol.split("_");
  return <details className={`oc-card${live?" is-live":""}${liquidated?" is-liquidated":""}${className?` ${className}`:""}`}>
    <summary>
      <span className="oc-line">
        <span className="oc-name"><b>{base}</b>{quote&&<small>/{quote}</small>}
          <i className={`oc-side ${side==="LONG"?"is-long":"is-short"}`}>{side==="LONG"?"多":"空"}</i>
          {leverage!=null&&<small className="oc-lev">{num(leverage,0)}×</small>}
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
