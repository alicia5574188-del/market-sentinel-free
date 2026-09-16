from pathlib import Path
import hashlib

def edit(path, before, after, edits):
    p=Path(path)
    data=p.read_bytes()
    assert hashlib.sha256(data).hexdigest()==before, f"Unexpected base: {path}"
    lines=data.decode().splitlines(keepends=True)
    for a,b,text in reversed(edits): lines[a:b]=[text]
    result=''.join(lines).encode()
    assert hashlib.sha256(result).hexdigest()==after, f"Unexpected result: {path}"
    p.write_bytes(result)
    print('verified',path,after)

edit('lib/forward-relations.ts', '4cf790a0f40cceeea7a92293181b08017503d26e140eeac6ac32157cfcaf0d47', '91d751571695e1c9a003c90b15b8e7dba015c0bf0a62f97d68c3bd0e6c84011e', [
(4,4,r'''import { EVIDENCE_POLICY, blankDiagnostics, collectFeedback, entryEconomics, executionCalibration, familyKey, inspectCondition,
  ruleApplies, type Feedback, type Evidence, type Candidate, type EvidenceDiagnostics } from "./forward-evidence.ts";
// The storage schema stays v1.0 so an algorithm upgrade cannot reset the ledger.
'''),
(24,25,r'''  grammar: string; liveEligible: false; evidence?: Evidence };
'''),
(30,32,r'''  relationFailureBars: number; lastRelationBar: number; execution: "REAL_QUOTE_PAPER_MODEL"; liveEligible: false;
  forecast?: { policy:string; family:string; signalAt:number; signalPrice:number; baseNetRate:number;
    calibratedNetRate:number; remainingNetRate:number; quality:number } };
export type AuditEvent = { id: string; at: number; kind: "START" | "RULE" | "DORMANT" | "ENTRY" | "EXIT" | "PROTECTION" | "DATA_GAP" | "FIT" | "UPGRADE";
'''),
(41,42,r'''  selectedSymbols: string[]; storage: { persistedAt: number; error: string | null }; liveEligible: false;
  policyVersion?:string; feedback?:Feedback[]; evidenceDiagnostics?:EvidenceDiagnostics;
  entryDiagnostics?:{at:number;matched:number;opened:number;reasons:Record<string,number>};
  relationEntries?:Record<string,number>;
  policyUpgrade?:{at:number;from:string;to:string;equity:number;stalePositions:number;balance:number;resolved:number;positionIds:string[]} };
'''),
(57,58,r'''    lastBars:{},lastEntryBars:{},policyVersion:EVIDENCE_POLICY,feedback:[],relationEntries:{},latestReason:"启动真实行情前向实验；旧K线只计算特征，不回填学习收益或模拟订单。",
'''),
(65,65,r'''  if(v.policyVersion&&v.policyVersion!==EVIDENCE_POLICY)throw new Error("未知前向算法版本，拒绝降级或重置");
'''),
(82,101,r''''''),
(102,103,r'''  const candidates:Candidate[]=[],diagnostics=blankDiagnostics();let trainGroups=0,checkGroups=0;
  s.feedback=collectFeedback(s.feedback??[],s.history,now);
  const rank=(a:Candidate,b:Candidate)=>b.estimatedNetRate/(b.stopRate+b.evidence.costRate)-a.estimatedNetRate/(a.stopRate+a.evidence.costRate);
'''),
(104,111,r'''    const rows=s.samples.filter(r=>r.horizon===h&&r.availableAt<=now&&r.endAt<=now&&r.at>=s.startedAt);
    if(rows.length<8||Math.max(...rows.map(r=>r.endAt))<now-h*60_000-BAR_MS)continue;
    const generate=(pool:Measurement[],symbol?:string)=>{
      const ordered=[...pool].sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
      const split=ordered[Math.floor(ordered.length*.6)]?.at??0,discovery=ordered.filter(r=>r.endAt<=split);
      trainGroups=Math.max(trainGroups,new Set(discovery.map(r=>Math.floor(r.at/(h*60000)))).size);
      checkGroups=Math.max(checkGroups,new Set(ordered.filter(r=>r.at>=split).map(r=>Math.floor(r.at/(h*60000)))).size);
      if(discovery.length<(symbol?3:12))return [];
      const stumps:Candidate[]=[],seen=new Set<string>();
      const assess=(conditions:Condition[])=>inspectCondition({rows:ordered,conditions,horizon:h,now,feedback:s.feedback??[],scopeSymbol:symbol},diagnostics);
      for(let f=0;f<FEATURES.length;f++)for(const p of[1/3,2/3])for(const op of["GE","LE"] as const){
        const threshold=Math.round(quantile(discovery.map(r=>r.x[f]),p)*100)/100,key=`${f}:${op}:${threshold}`;
        if(seen.has(key))continue;seen.add(key);
        const c=assess([{feature:f,op,threshold}]);if(c)stumps.push(c);
      }
      const top=[...stumps].sort(rank).slice(0,3),combined=[...stumps];
      for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
        if(top[i].conditions[0].feature===top[j].conditions[0].feature)continue;
        const c=assess([...top[i].conditions,...top[j].conditions].sort((a,b)=>a.feature-b.feature));if(c)combined.push(c);
      }
      return combined.sort(rank);
    };
    const shared=generate(rows),kept=new Set<string>();
    for(const c of shared){if(kept.has(c.evidence.family))continue;kept.add(c.evidence.family);candidates.push(c);if(kept.size>=2)break;}
    // Single-coin evidence is not banned and is never exported to other coins.
    // Scope uses that coin's own chronological discovery/check split.
    const local:Candidate[]=[];
    const ordered=[...rows].sort((a,b)=>a.at-b.at),discoveryEnd=ordered[Math.floor(rows.length*.6)]?.at??0;
    // Nominate at most TWO local markets using only earlier observations. Do
    // not test all 30 and keep whichever happens to win the later check set.
    // This trades some opportunity coverage for bounded search/CPU variance.
    const nominees=[...new Set(rows.map(r=>r.symbol))].map(symbol=>{
      const early=rows.filter(r=>r.symbol===symbol&&r.endAt<=discoveryEnd);
      return {symbol,count:early.length,score:Math.abs(quantile(early.map(r=>r.response),.5))};
    }).filter(a=>a.count>=3).sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol)).slice(0,2);
    for(const {symbol:sym} of nominees){
      const own=rows.filter(r=>r.symbol===sym);if(own.length<8)continue;
      const best=generate(own,sym)[0];if(best)local.push(best);
'''),
(112,120,r'''    if(local.length)candidates.push(local.sort(rank)[0]);
'''),
(121,122,r'''  s.lastFitAt=now;
'''),
(124,129,r'''    const signature=hash(JSON.stringify([c.conditions,c.side,c.horizon,c.exitMode,c.evidence.scope,c.evidence.scope==="SINGLE_ASSET"?c.evidence.symbols[0]:null]));
    const exact=s.rules.find(r=>r.signature===signature&&r.evidence?.policy===EVIDENCE_POLICY);
    // Unchanged measurements and executions are not a new revision or a fresh
    // lease. Otherwise a stale signal could be kept alive indefinitely.
    if(exact?.evidence?.sourceKey===c.evidence.sourceKey){
      if(exact.expiresAt>now)exact.status="EXPERIMENTAL";else diagnostics.expired++;
      continue;
    }
    const parent=exact??previous.find(r=>familyKey(r)===c.evidence.family&&r.evidence?.scope===c.evidence.scope
      &&(c.evidence.scope!=="SINGLE_ASSET"||r.evidence.symbols[0]===c.evidence.symbols[0]));
    const mutation=parent?(exact&&!previous.includes(parent)?"RECALL":"REVISE"):"CREATE";
    const text=c.conditions.map(k=>`${FEATURES[k.feature]}${k.op==="GE"?"≥":"≤"}${k.threshold}`).join(" 且 ");
    const scope=c.evidence.scope==="SINGLE_ASSET"?`仅${c.evidence.symbols[0]}`:`适用${c.evidence.symbols.length}币，逐币剔除复核通过`;
    const reason=`${text} 后${c.horizon}分钟${scope}；${c.side==="LONG"?"多":"空"}向净反应估计${(c.estimatedNetRate*100).toFixed(3)}%，已含${c.evidence.calibration.groups}个成交时间组的偏差校准。退出采用${c.exitMode==="REACTION_DECAY"?"回吐保护":"反应期限"}；不是胜率或盈利保证。`;
'''),
(131,132,r'''    s.rules.unshift(r);event(s,now,"RULE",r.id,reason,{mutation,rawNet:c.evidence.rawNet,penalty:c.evidence.calibration.penalty,
      netEstimate:r.estimatedNetRate,samples:r.samples,scope:c.evidence.scope});
'''),
(133,138,r'''  for(const r of previous)if(r.status==="DORMANT"&&!candidates.some(c=>c.evidence.family===familyKey(r)))
    event(s,now,"DORMANT",r.id,"当前适用性、集中度或成交偏差校准不再支持该规则；继续观察市场，不把失败直接反向。");
  s.rules=s.rules.slice(0,48);const active=s.rules.filter(r=>r.status==="EXPERIMENTAL").length;
  s.fitDiagnostics={tested:diagnostics.tested,qualified:active,trainGroups,checkGroups,latestAt:now};s.evidenceDiagnostics=diagnostics;
  s.latestReason=active?`${active}条适用范围明确的实验规则，按当前可成交价格、成交偏差和同关系风险筛选。`
    :`当前无可执行净优势：集中度拒绝${diagnostics.concentrationRejected}，成本/不确定性拒绝${diagnostics.costRejected}，成交校准拒绝${diagnostics.calibrationRejected}；数据观测继续，不强制开单。`;
  event(s,now,"FIT",EVIDENCE_POLICY,s.latestReason,{tested:diagnostics.tested,qualified:active,trainGroups,checkGroups});
'''),
(189,190,r'''    if(f&&f.at>t.lastRelationBar){const contrary=s.rules.some(a=>a.status==="EXPERIMENTAL"&&a.expiresAt>now&&a.side!==t.side&&a.horizon===t.rule.horizon&&ruleApplies(a,t.symbol)&&conditionMatches(f.x,a.conditions));
'''),
(200,202,r'''    &&f.at>=s.startedAt&&now-f.at<=11*60_000&&conditionMatches(f.x,r.conditions)).map(r=>({f,r}))).sort((a,b)=>
      b.r.estimatedNetRate/(b.r.stopRate+COST_FLOOR)-a.r.estimatedNetRate/(a.r.stopRate+COST_FLOOR)||a.f.symbol.localeCompare(b.f.symbol));
  let blocker="";const diagnostics={at:now,matched:candidates.length,opened:0,reasons:{} as Record<string,number>};
  s.entryDiagnostics=diagnostics;s.relationEntries??={};
  const reject=(reason:string)=>{blocker=reason;diagnostics.reasons[reason]=(diagnostics.reasons[reason]??0)+1;};
'''),
(204,209,r'''    if(!ruleApplies(r,f.symbol)){reject("当前币没有该关系的适用证据，禁止套用其他币的异动");continue;}
    const family=familyKey(r),episodeKey=`${f.symbol}:${family}`;
    if((s.relationEntries[episodeKey]??0)>now){reject("同币同关系的反应周期尚未结束，版本变化不重置重复入场限制");continue;}
    const q=quotes[f.symbol],meta=contracts[f.symbol];if(!freshQuote(q,now)||q.entryReady===false){reject("等待新鲜、顺序核对完成的买卖盘口，不补过去成交");continue;}
    if(!meta||!finite(meta.quantoMultiplier)||meta.quantoMultiplier<=0||!finite(meta.leverageMax)||meta.leverageMax<1||!finite(meta.maintenanceRate)){reject("等待合约乘数和杠杆元数据");continue;}
    const marked=forwardEquity(s,quotes,now),equity=marked.equity;if(equity<=0){reject("净值不足，不自动充值或重置");break;}
    if(marked.stalePositions){reject("已有持仓估值过期，暂停新增风险");break;}
    const spread=(q.bestAsk-q.bestBid)/((q.bestAsk+q.bestBid)/2);if(spread>.0015){reject("当前买卖价差过大");continue;}
    const calibration=executionCalibration(s.feedback??[],family,r.evidence!.symbols,now);
    const calibratedNet=r.evidence!.rawNet-calibration.penalty;
    if(calibratedNet<=0){reject("最新成交偏差已抵消该关系的净优势");continue;}
'''),
(210,211,r'''    const economics=entryEconomics({...r,estimatedNetRate:calibratedNet},f.price,price,spread);
    if(economics.contextInvalid){reject("入场前价格已明显偏离原观察条件，不把下跌自动当成便宜机会");continue;}
    if(economics.remaining<=0){reject("价差及入场前已发生的价格推进吃掉剩余优势");continue;}
'''),
(212,214,r'''    // Same-side same-horizon rules are a conservative correlated bucket, not
    // claimed to be a learned covariance model. Existing exposure is not closed.
    const related=s.positions.filter(t=>t.side===r.side&&t.rule.horizon===r.horizon).reduce((a,t)=>a+t.plannedRisk,0);
    const quality=Math.min(r.evidence!.quality,economics.quality),targetRisk=equity*.015*quality;
    const lossRate=r.stopRate+Math.max(COST_FLOOR,r.evidence!.costRate)+spread;
    const desired=Math.min(equity*1.5,targetRisk/lossRate);
    const immediateExit=(r.side==="LONG"?q.bestBid:q.bestAsk)*(1-d*PAPER_COST.slippageRate);
    const immediateCost=Math.max(r.evidence!.costRate,PAPER_COST.feeRate*(1+immediateExit/price)+d*(1-immediateExit/price));
    // Reserve the new leg's entry-to-exit marking cost before allocating risk;
    // otherwise a nominal 3% cap already exceeds 3% immediately after opening.
    const wanted=Math.max(0,Math.min(desired,(equity*4-gross)/(1+4*immediateCost),
      targetRisk/(lossRate+.015*quality*immediateCost),
      (equity*.10-risk)/(lossRate+.10*immediateCost),
      (equity*.065-same)/(lossRate+.065*immediateCost),
      (equity*.03-related)/(lossRate+.03*immediateCost)));
    if(wanted<equity*.05||wanted<desired*.25){reject("同向同期限风险预算或有效仓位不足，不填碎片订单");continue;}
    const count=Math.floor(wanted/(price*meta.quantoMultiplier));if(count<Math.max(1,meta.minContracts??1)){reject("风险额度或最小张数不足");continue;}
'''),
(215,215,r'''    if(notional<equity*.05||notional<desired*.25){reject("整数张数后只剩碎片仓位，跳过而不放大风险");continue;}
'''),
(216,217,r'''    if(s.positions.reduce((a,t)=>a+t.margin,0)+margin>equity*.75){reject("模拟可用保证金不足");continue;}
'''),
(219,220,r'''      plannedRisk:notional*lossRate,stopPrice:price*(1-d*r.stopRate),armPrice:price*(1+d*r.armRate),favorable:0,adverse:0,
'''),
(221,222,r'''      relationFailureBars:0,lastRelationBar:f.at,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
      forecast:{policy:EVIDENCE_POLICY,family,signalAt:f.at,signalPrice:f.price,baseNetRate:economics.remaining+calibration.penalty,
        calibratedNetRate:calibratedNet,remainingNetRate:economics.remaining,quality}};
'''),
(223,224,r'''    s.relationEntries[episodeKey]=now+r.horizon*60000;diagnostics.opened++;
    event(s,now,"ENTRY",t.id,`${f.symbol}按适用规则${r.id}使用新鲜买卖价模拟成交；不是Gate实盘成交。`,
      {ruleId:r.id,notional,contracts:count,remainingNet:economics.remaining,calibrationPenalty:calibration.penalty,quality});
'''),
(225,225,r'''  for(const[key,until]of Object.entries(s.relationEntries))if(until<now)delete s.relationEntries[key];
'''),
(229,229,r'''  const upgraded=s.policyVersion!==EVIDENCE_POLICY;
  if(upgraded){
    if(s.policyVersion)throw new Error("未知算法版本，禁止自动覆盖");
    const mark=forwardEquity(s,quotes,now);
    s.policyUpgrade={at:now,from:"legacy-forward-v1.0",to:EVIDENCE_POLICY,equity:mark.equity,stalePositions:mark.stalePositions,
      balance:s.balance,resolved:s.resolved,positionIds:s.positions.map(t=>t.id)};
    s.policyVersion=EVIDENCE_POLICY;s.lastFitAt=0;s.relationEntries??={};
    for(const r of s.rules)r.status="DORMANT";
    for(const t of [...s.history,...s.positions])s.relationEntries[`${t.symbol}:${familyKey(t.rule)}`]=Math.max(
      s.relationEntries[`${t.symbol}:${familyKey(t.rule)}`]??0,t.openedAt+t.rule.horizon*60000);
    event(s,now,"UPGRADE",EVIDENCE_POLICY,"升级关系适用性、真实模拟成交偏差及同关系风险；本金、亏损、历史和原持仓保护保持连续。",
      {equity:mark.equity,resolved:s.resolved,open:s.positions.length});
  }
'''),
(230,231,r'''  const dataDue=upgraded||!s.lastCycleAt||Math.floor((now-90_000)/BAR_MS)>Math.floor((s.lastCycleAt-90_000)/BAR_MS);
  // Exits at currently executable prices happen first. Their now-known results
  // can calibrate NEW entries immediately; no future closure enters learning.
  manage(s,quotes,now);s.feedback=collectFeedback(s.feedback??[],s.history,now);
'''),
(233,234,r'''  if(dataDue)openTrades(s,quotes,contracts,now);const marked=forwardEquity(s,quotes,now);
'''),
(239,240,r'''  const matched=Object.values(s.frames).filter(f=>now-f.at<11*60_000&&s.rules.some(r=>r.status==="EXPERIMENTAL"&&r.expiresAt>now&&ruleApplies(r,f.symbol)&&conditionMatches(f.x,r.conditions)));
'''),
(245,245,r'''    policyVersion:s.policyVersion??"legacy-forward-v1.0",policyUpgrade:s.policyUpgrade??null,
    evidenceDiagnostics:s.evidenceDiagnostics??null,entryDiagnostics:s.entryDiagnostics??null,feedbackCount:s.feedback?.length??0,
'''),
(253,254,r'''      risk:"单笔风险上限1.5%随净优势可信程度缩放，总风险10%，同向6.5%，同向同期限3%，总名义额4倍；碎片仓位跳过，不是最佳仓位结论",
'''),
])
