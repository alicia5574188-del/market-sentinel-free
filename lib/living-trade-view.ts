/**
 * Order-card text for trades opened by the living research layer (entryContext.living). Pure, no imports: the page
 * test harness loads it as is. The old system's fields that openLivingTrade still fills for compatibility (stage
 * stamp, entry score, hold score, size multiple wording, 5%/10% extra exits) are never shown for these trades.
 * Every number here is a price move (%), never ROE.
 */
export type LivingNoteView={v?:string;k?:string;pb?:string;ev?:string;mult?:number;sc?:number|null;t?:number|null;n?:number|null;per?:string|null;
  rk?:number|null;inv?:number;ref?:number|null;hold?:number;why?:string;in?:string;mk?:string;nar?:string;evd?:string;ep?:string|null;ho?:number;mx?:number;lm?:number};
export type LivingTradeLike={side:"LONG"|"SHORT";entryPrice:number;stopPrice?:number|null;liquidationPrice?:number|null;plannedRisk:number;leverage:number;
  notional:number;expectedHoldMinutes?:number|null;entryContext?:{living?:LivingNoteView|null;reason?:string|null}|null};

// Same words as the 大脑 page (lib/brain-view.ts); a test keeps them equal.
export const LIVING_STATE_LABEL:Record<string,string>={RISK_ON:"资金在进攻",RISK_OFF:"资金在撤退",SQUEEZE:"逼空中",PANIC:"恐慌踩踏",CAPITULATION:"投降式出清",FOMO:"追涨情绪",
  COMPLACENT:"安逸拥挤",CALM:"平静",MIXED:"分歧",WARMING:"数据刚接上"};
export const LIVING_CAPITAL_LABEL:Record<string,string>={DEMAND:"新多进场",SUPPLY:"新空进场",SQUEEZE_UP:"空头被逼平",FLUSH_DOWN:"多头被洗出",ABSORB_BID:"下方有人接",
  ABSORB_ASK:"上方有人压",DRIFT:"无量漂移",UNVERIFIED:"资金未核实",NONE:"无动作"};
export const LIVING_EMOTION_LABEL:Record<string,string>={FOMO:"追涨",PANIC:"恐慌",CAPITULATION:"投降",EXHAUSTION:"力竭",BLOWOFF:"冲顶",COMPLACENCY:"安逸",CONVICTION:"坚定",CALM:"平静",NONE:"—"};
const EVIDENCE_LABEL:Record<string,string>={strong:"强",normal:"普通",probe:"试探",fast:"集体异动"};
const EVIDENCE_FACTOR:Record<string,number>={strong:1,normal:.6,probe:.3};
const NORMAL_MULTIPLE=5,RISK_RATE=.0055,PREMIUM_RISK_RATE=.0065,FAST_RISK_RATE=.0055;

const num=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toFixed(d):"—";
const price=(v:number|null|undefined)=>typeof v==="number"&&Number.isFinite(v)&&v>0?Number(v.toPrecision(6)).toString():"—";
const away=(from:number,to:number|null|undefined)=>typeof to==="number"&&to>0&&from>0?`${(Math.abs(to/from-1)*100).toFixed(2)}%`:"—";

export const isLivingTrade=(t:{entryContext?:{living?:unknown}|null}|null|undefined)=>!!t?.entryContext?.living;

/** "SUPPLY/CONVICTION" → "新空进场（坚定）". */
export function livingIntentText(raw:string|null|undefined){
  if(!raw)return null;
  const [capital,emotion]=raw.split("/");
  const c=LIVING_CAPITAL_LABEL[capital??""]??capital,e=emotion&&emotion!=="NONE"?LIVING_EMOTION_LABEL[emotion]??emotion:null;
  return e?`${c}（${e}）`:c??null;
}
/** The 开仓盘面 fact for a living trade: the market intent the layer read, not the old stage name. */
export function livingBoard(n:LivingNoteView){
  if(n.k==="F")return"集体异动";
  return n.mk?LIVING_STATE_LABEL[n.mk]??n.mk:"研究层判断";
}
/** The one-line 为什么开 for a living trade. */
export function livingWhy(t:LivingTradeLike,playbook:string|null){
  const n=t.entryContext!.living!,bits=[`${t.side==="LONG"?"做多":"做空"}，${playbook??n.pb??"研究层"}`];
  const coin=livingIntentText(n.in);if(coin)bits.push(`这个币${coin}`);
  if(typeof n.lm==="number"&&n.lm<1)bits.push(`市场方向不清，半仓（${n.lm}×）`);
  else if(n.mx)bits.push("市场分歧，强证据顺势试探（0.3 倍仓位）");
  else if(n.mk&&n.k!=="F")bits.push(`市场${LIVING_STATE_LABEL[n.mk]??n.mk}`);
  else if(n.k==="F")bits.push("全市场集体异动");
  return `${bits.join("；")}。`;
}

/** The 详细依据 lines ("标签：内容") for a living trade. */
export function livingDetail(t:LivingTradeLike,playbook:string|null):string[]{
  const n=t.entryContext!.living!,fast=n.k==="F",lines:string[]=[];
  const hold=Math.round(n.hold??t.expectedHoldMinutes??0),late=Math.round(hold*1.5);
  lines.push(`打法：${playbook??n.pb??"—"}（${fast?"集体异动快速跟进":"研究层五步闭环"}，${n.v==="living-v1"?"living-v1":"living-v2"}）`);
  const coin=livingIntentText(n.in);
  if(coin)lines.push(`资金意图：这个币${coin}${n.mk&&!fast?`；全市场${LIVING_STATE_LABEL[n.mk]??n.mk}`:""}`);
  const [marketSentence]=(n.nar??"").split("｜");
  if(marketSentence&&!fast)lines.push(`市场判断：${marketSentence}`);
  const why=n.why??t.entryContext?.reason??null;if(why)lines.push(`依据：${why}`);
  if(n.evd)lines.push(`证据数字：${n.evd}（价格和持仓量都是涨跌 %，主动买卖 >0 买方多）`);
  if(fast){
    lines.push(`三层确认：全市场同时异动并被确认，资金跟上了才跟进；这一段异动所有单子合计最多冒权益的 2% 风险。`);
  }else if(typeof n.lm==="number"&&n.lm<1){
    lines.push(`三层确认：第一层 市场方向不清（分歧），不拦截，按 ${n.lm}× 仓位放行（只放行顺势、逼空衰竭反做、贪婪拥挤失败反做）；第二层 这个币的证据强度 ${num(n.sc,2)}（≥0.35 才往下走，≥0.75 算强）→ 证据档「${EVIDENCE_LABEL[n.ev??""]??n.ev??"—"}」；第三层 价格回到计划位置并复核通过才开（选币第 ${n.rk??"—"}）。`);
  }else if(n.mx){
    lines.push(`三层确认：第一层 市场「分歧」本来不开单，只放行强证据的顺势试探；第二层 这个币的证据强度 ${num(n.sc,2)}（分歧市场要求 ≥0.6）；第三层 价格回到计划位置时复核，证据仍 ≥0.6 才开，仓位固定按「试探」0.3。`);
  }else if(n.v==="living-v1"){
    lines.push(`三层确认：第一层 研究层判断支持这个打法；第二层 探针分数 ${num(n.sc,3)}（t ${num(n.t,1)} · 样本 ${n.n??"—"}）；第三层 价格回到计划位置并复核通过才开（选币第 ${n.rk??"—"}）。`);
  }else{
    lines.push(`三层确认：第一层 市场意图${n.mk?`「${LIVING_STATE_LABEL[n.mk]??n.mk}」`:""}允许这个打法和方向；第二层 这个币的证据强度 ${num(n.sc,2)}（≥0.35 才往下走，≥0.75 算强）→ 证据档「${EVIDENCE_LABEL[n.ev??""]??n.ev??"—"}」；第三层 价格回到计划位置并复核通过才开（选币第 ${n.rk??"—"}）。`);
  }
  // sizing
  if(fast){
    lines.push(`仓位：按账户权益的 ${(FAST_RISK_RATE*100).toFixed(2)}% 作风险基数 × ${num(n.mult,2)} 倍（集体异动 1–3 倍，试探再除以 3）；打到止损最多亏 ${num(t.plannedRisk)} U（含来回手续费）；杠杆 ${num(t.leverage,0)}× 逐仓，名义 ${num(t.notional)} U。`);
  }else{
    const premium=n.ev==="strong"&&n.rk===1,factor=EVIDENCE_FACTOR[n.ev??""];
    const parts=[`${NORMAL_MULTIPLE} 倍`];if(factor!=null)parts.push(`证据档「${EVIDENCE_LABEL[n.ev!]}」${factor}`);if(typeof n.lm==="number"&&n.lm<1)parts.push(`市场方向不清 ${n.lm}`);if(n.per)parts.push(`打法近况 ${n.per}`);
    lines.push(`仓位：按账户权益的 ${((premium?PREMIUM_RISK_RATE:RISK_RATE)*100).toFixed(2)}% 作风险基数 × ${num(n.mult,2)} 倍（${parts.join(" × ")}）；打到止损最多亏 ${num(t.plannedRisk)} U（含来回手续费，风险额度不够时会更少）；杠杆 ${num(t.leverage,0)}× 逐仓，名义 ${num(t.notional)} U。`);
  }
  // protection
  const inv=n.inv,stop=t.stopPrice;
  const moved=typeof inv==="number"&&typeof stop==="number"&&Math.abs(stop-inv)>1e-12;
  lines.push(`止损：${price(stop)}，离开仓价 ${away(t.entryPrice,stop)}（价格涨跌，不是收益率）${moved?`；开仓时的失效价是 ${price(inv)}，后来被研究层收紧`:"，就是开仓时研究层定的失效价"}；每一轮都检查，打到就平。`);
  if(typeof t.liquidationPrice==="number"&&t.liquidationPrice>0)lines.push(`强平：逐仓强平价 ${price(t.liquidationPrice)}，离开仓价 ${away(t.entryPrice,t.liquidationPrice)}；爆仓安全开关开着时，开仓要求止损距离不超过爆仓距离的 40%。`);
  // exits
  if(fast)lines.push(`出场计划：由大脑决定——异动是假动作、力竭或反转就平；10 分钟没走出来就平；离爆仓太近先平；确认后亏着的单平掉；赚了以后拉到保本、利润回吐就走。`);
  else lines.push(`出场计划：由大脑决定——资金反了、市场意图转向、目标兑现就平；后来的人追涨/恐慌杀跌冲进利润（浮盈 ≥ 止损距离 1.5 倍）就把利润交给他们；动态锁利：最高浮盈到 max(0.6%, 2 倍波动) 后，允许回吐 max(最高浮盈的一半（2% 以上是 35%）, 1.5 倍波动)，资金强时放宽 1.3 倍、资金变弱时收紧到 max(1 倍波动, 现在利润的一半)，回吐超过就走；持有理由连续两分钟反过来就走（资金反转离场）；亏过 0.5% 以上又反弹到 0（亏过 1% 以上是反弹到一半）且资金不强就走（反弹减亏离场）；拿到计划时长的 1.5 倍（${late} 分钟）就平，利润仍在最高的七成以上且最高 ≥1.5% 时延长持有，最多 3 倍。波动 = 3 × 最近 15 分钟每分钟涨跌的平均（至少 0.15%），都是价格涨跌 %。`);
  lines.push(`计划持有：${hold} 分钟。大脑停下（降级、只计算或关掉）超过 2 分钟时，这笔只按止损和强平管，持有满 ${late} 分钟就兜底平掉。`);
  lines.push("不适用：旧系统的持仓评分、入场评分/同组、盘面阶段门槛（同步爆发/趋势/过渡）、5% 和 10% 额外出场、同步爆发仓位倍数，这笔都不用。");
  return lines;
}
