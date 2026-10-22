/** FIXTURE for the 大脑 page (tests/brain-page.test.ts and the redesign screenshots). Production-like: the backfill / shadow-trade /
 * predictor counts are copied from the live /__health of 4075c08b (2026-10-22 ~13:20 UTC); per-playbook forecasts, gate decisions and
 * pool trades are SYNTHETIC (seeded), shaped like the runtime's view and the engine's poolStatus. `later` = the same a few days on
 * (live score and hit rate filled in, illustrative). Never used by the worker. */
import {POOL,tierOf} from "../../lib/dynamic/playbooks.ts";
import {PRED_ALLOC} from "../../lib/dynamic/allocator.ts";
let seed=7;const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
const NOW=Date.parse("2026-10-22T13:20:00Z"),H=3_600_000;
const r3=(x:number)=>Math.round(x*1e3)/1e3;
const labelOf=(s:number)=>s<.34?"数据少":s<.67?"数据一般":"数据较足";
const fmtH=(h:number)=>h<48?`${Math.round(h)} 小时`:`${Math.round(h/24)} 天`;
export function build(later:boolean){
  seed=later?11:7;
  const playbooks=POOL.map(pb=>{
    const tier=tierOf(pb),trades=pb.external?37:Math.round(20+rnd()*260),has=trades>25&&rnd()>.25;
    const cur=rnd()>.5?"GOOD":"BAD",el=1+rnd()*60,p6=r3(cur==="GOOD"?.45+rnd()*.4:.15+rnd()*.5),sample=r3(Math.min(1,trades/300+rnd()*.2)),label=labelOf(sample);
    const tn=later?Math.round(rnd()*40):0,hit=r3(.48+rnd()*.2);
    const tr=tn?`预测命中率 ${Math.round(hit*100)}%（${tn} 次）`:"预测还没到期评分";
    const pred=has?{line:cur==="BAD"?`现在：亏钱期（已 ${fmtH(el)}）。预计：${rnd()>.5?"BTC 4 小时转涨、波动放大":"约 9 小时后"}时开始赚钱，24 小时内概率 ${Math.round((p6+.08)*100)}%【${label}】。${tr}`
        :`现在：赚钱期（已 ${fmtH(el)}）。预计：24 小时后仍在赚钱期的概率 ${Math.round((p6-.05)*100)}%【${label}】。${tr}`,
      cur,elapsedH:r3(el),p6,p24:r3(Math.min(.95,p6+.05)),p72:r3(Math.min(.95,p6+.1)),trigger:{kind:"time",text:"约 9 小时后"},label,sample,
      phases:{good:3+Math.round(rnd()*8),bad:3+Math.round(rnd()*8),meanGoodH:Math.round(10+rnd()*40),meanBadH:Math.round(10+rnd()*50)},period:null,profile:{session:rnd()>.5?"US":"ASIA"},wLog:0,
      track:{n:tn,hit:tn?hit:0,brier:tn?r3(.2+rnd()*.06):0},hist:{n:0,hit:0},live:null,real:null,realLine:"实盘检验：还没有到期的 6 小时预测"}:null;
    const tradable=tier==="short"||pb.id==="htf-donch20";
    let gate;
    if(!tradable)gate={ok:false,risk:0,conf:0,why:"长线打法只记录（日线突破做多除外）"};
    else if(!pred)gate={ok:false,risk:0,conf:0,why:trades?"数据少：还没见到一段赚钱和一段亏钱，只记录":"还没有影子交易"};
    else if(p6<PRED_ALLOC.pMin)gate={ok:false,risk:0,conf:0,why:`未来 6 小时处在赚钱期的概率 ${Math.round(p6*100)}%（要 ≥58%）【${label}】`};
    else{const tw=tn>=10?Math.max(.25,Math.min(1,(hit-.5)/.25)):.25,edge=Math.max(0,Math.min(1,(p6-.58)/.22)),sc=.25+.75*sample,r=(.0025+.0025*edge)*tw*sc;
      gate={ok:true,risk:r,conf:r/.005,why:`预测：未来 6 小时在赚钱期的概率 ${Math.round(p6*100)}%（${cur==="GOOD"?`赚钱期第 ${Math.round(el)} 小时`:`亏钱期第 ${Math.round(el)} 小时`}）【${label}】；${tn>=10?`预测命中率 ${Math.round(hit*100)}%（${tn} 次）→ ×${tw.toFixed(2)}`:`预测才评过 ${tn} 次（<10），用最小仓位`}；证据 ×${sc.toFixed(2)} → 风险 ${(r*100).toFixed(2)}%`};}
    return {id:pb.id,label:pb.label,iv:pb.iv,side:pb.side,rule:pb.rule,tier,family:pb.family??pb.id,familyLabel:pb.familyLabel??pb.label,only:null,trades,
      all:{n:trades,mean:r3((rnd()-.45)*.004),win:r3(.35+rnd()*.25)},rolling:null,counts:null,unit:"day",good:3,bad:4,meanGoodWeeks:0,meanBadWeeks:0,persistence:null,current:null,
      pattern:false,patternWhy:"赚钱段和亏钱段各要 ≥3 次",stage:"early",sample,forecast:null,byBucket:{},bySession:{},gate,pred,open:0};
  });
  const lab=(id:string)=>playbooks.find(p=>p.id===id)?.label??id;
  const withF=playbooks.filter(p=>p.pred).length,tot=later?118:0;
  const realH=(h:number)=>({h,good:{forecasts:later?41:0,trades:later?57:0,avg:later?.0021:null,sum:later?.1197:0},other:{forecasts:later?77:0,trades:later?96:0,avg:later?-.0009:null,sum:later?-.0864:0}});
  const okIds=playbooks.filter(p=>p.gate.ok).map(p=>p.id),noIds=playbooks.filter(p=>p.pred&&!p.gate.ok&&p.tier==="short").map(p=>p.id);
  const pa=okIds[0]??"burst-leader",pb2=okIds[1]??pa;
  const dynamic={version:"dynamic-v1.4",booted:true,bootError:null,lastError:null,lastStepAt:NOW-20_000,lastStepMs:420,maxStepMs:10822,lastAnalyzeAt:NOW-4*60_000,
    store:{error:null,rowsToday:261,deferred:0,failures:0},
    backfill:{pct:later?.41:0,done:later?64:0,total:157,bars:later?2_140_000:388_000,byIv:{"5m":{done:later?30:0,total:31,bars:120000,from:"2026-07-24"},"15m":{done:later?29:0,total:31,bars:60000,from:"2026-04-25"},"1h":{done:later?5:0,total:31,bars:52000,from:"2025-10-22"},"4h":{done:0,total:32,bars:9000,from:"2025-01-01"},"1d":{done:0,total:32,bars:7000,from:"2024-01-01"}},
      reqToday:later?512:73,reqTotal:later?2900:800,errTotal:7,pausedUntil:null,blocked:later?["okx"]:[],startedAt:NOW-40*H,etaMin:later?900:2600,working:"BTC_USDT 1d"},
    shadowTrades:later?9210:6692,tradesLoaded:true,replay:{unitsDone:later?140:60,unitsQueued:4,unitsKnown:later?300:200,liveSeries:93,liveEvals:4000},
    state:{day:"2026-10-21",bucket:"UP|MID",label:"BTC 上升趋势、波动中等",trend:"UP",strength:.061,atrPct:.024,volPct:.44,dd90:-.072,eff20:.3,eth:"UP",altVsBtc:-.031,lead:"BTC",corr30:.8},
    intraday:{hour:"2026-10-22T12:00",bucket:"UP|LOW",label:"1 小时上涨、波动低",trend:"上涨",trend4h:"上涨",vol:"低",atrPct:.0041,volPct:.28,eth:"上涨",session:"欧洲盘"},
    stateHistory:[],playbooks,allowed:playbooks.filter(p=>p.gate.ok).map(p=>({pb:p.id,label:p.label,risk:p.gate.risk,why:p.gate.why})),
    limits:{maxPoolOpen:null,maxPerPlaybook:null,baseRisk:.005,shortRisk:.005},
    predictor:{ready:true,at:NOW-4*60_000,ms:380,playbooks:withF,hourRows:30,pMin:.58,track:{n:tot,hit:later?.61:0,brier:later?.221:0,calib:[]},
      topNow:[],real:[realH(6),realH(24),realH(72)],
      realLine:later?"实盘检验（6 小时内跟着来的影子交易）：看好时 平均 0.21%/笔（41 次预测后 57 笔）；不看好时 平均 -0.09%/笔（77 次预测后 96 笔）":"实盘检验：还没有到期的 6 小时预测",
      recent:later?[{pb:pa,label:lab(pa),h:6,p:.66,y:1,hit:true,n:2,net:.0061},{pb:noIds[0]??pa,label:lab(noIds[0]??pa),h:6,p:.31,y:0,hit:true,n:1,net:-.004},{pb:"burst-leader",label:lab("burst-leader"),h:24,p:.62,y:0,hit:false,n:0,net:0}]:[]},
    events:[{at:NOW-30*60_000,k:"FORECAST",text:"最看好：……（示例）"},{at:NOW-55*60_000,k:"ALLOC",text:`${lab(pa)}：允许开单 — 预测……（示例）`}]};
  const open=[{id:"t-801",sym:"SOL_USDT",side:"LONG" as const,pb:pa,entry:182.4,stop:179.9,openedAt:NOW-2.4*H,price:184.1,move:r3(184.1/182.4-1),risk:.0031},
    {id:"t-802",sym:"DOGE_USDT",side:"SHORT" as const,pb:pb2,entry:.2311,stop:.2352,openedAt:NOW-0.7*H,price:.2318,move:-(.2318/.2311-1),risk:.0025},
    {id:"t-790",sym:"LINK_USDT",side:"LONG" as const,pb:"htf-donch20",entry:17.62,stop:16.41,openedAt:NOW-31*H,price:17.95,move:17.95/17.62-1,risk:.0075}];
  const recent=[
    {id:"t-799",sym:"ARB_USDT",side:"LONG" as const,pb:"burst-leader",entry:.512,exit:.5262,move:.5262/.512-1,net:3.41,risk:.0042,openedAt:NOW-6*H,closedAt:NOW-3.1*H,exitCode:"LIVING_BURST_TRAIL",exitWhy:"爆发单跟踪止损：从最高点回落 30%"},
    {id:"t-797",sym:"AVAX_USDT",side:"SHORT" as const,pb:pb2,entry:27.31,exit:27.52,move:-(27.52/27.31-1),net:-2.88,risk:.0025,openedAt:NOW-9*H,closedAt:NOW-7.5*H,exitCode:"STOP",exitWhy:"打到止损"},
    {id:"t-795",sym:"XRP_USDT",side:"LONG" as const,pb:pa,entry:2.481,exit:2.512,move:2.512/2.481-1,net:2.05,risk:.0031,openedAt:NOW-14*H,closedAt:NOW-11*H,exitCode:"LIVING_DYN_EXIT",exitWhy:"到目标价（1 倍区间）"},
    {id:"t-781",sym:"ETH_USDT",side:"LONG" as const,pb:"htf-donch20",entry:4012,exit:4188,move:4188/4012-1,net:6.1,risk:.0075,openedAt:NOW-6*24*H,closedAt:NOW-26*H,exitCode:"LIVING_HTF_TRAIL",exitWhy:"跌破 10 日最低（跟踪止损）"}];
  const gateRec=(m:number,o:Record<string,unknown>)=>({t:"GATE" as const,at:NOW-m*60_000,...o});
  const gates=[
    gateRec(4,{pb:noIds[0]??pa,sym:"BNB_USDT",side:"SHORT",src:"signal",kind:"pool",ok:false,decision:"DENY",p6:.41,pMin:.58,phase:"BAD",elapsedH:19,label:"数据一般",risk:0,why:"分配器不允许（只记录）— 未来 6 小时处在赚钱期的概率 41%（要 ≥58%）【数据一般】"}),
    gateRec(41,{pb:pb2,sym:"DOGE_USDT",side:"SHORT",src:"signal",kind:"pool",ok:true,decision:"ORDER",p6:.63,pMin:.58,phase:"GOOD",elapsedH:5,label:"数据少",risk:.0025,why:"分配器允许：预测：未来 6 小时在赚钱期的概率 63%（赚钱期第 5 小时）【数据少】；预测才评过 0 次（<10），用最小仓位；证据 ×0.40 → 风险 0.25%"}),
    gateRec(58,{pb:pa,src:"allocator",ok:true,decision:"ALLOW",p6:.71,pMin:.58,phase:"GOOD",elapsedH:3,label:"数据一般",risk:.0031,why:"预测：未来 6 小时在赚钱期的概率 71%（赚钱期第 3 小时）【数据一般】；预测才评过 0 次（<10），用最小仓位；证据 ×0.61 → 风险 0.31%"}),
    gateRec(73,{pb:"burst-leader",sym:"OP_USDT",side:"LONG",src:"signal",kind:"burst",ok:false,decision:"DENY",p6:.44,pMin:.58,phase:"BAD",elapsedH:30,label:"数据少",risk:0,why:"爆发选中，但动态分配不允许（只记录影子单）：未来 6 小时处在赚钱期的概率 44%（要 ≥58%）【数据少】"}),
    gateRec(96,{pb:noIds[1]??pa,sym:"SUI_USDT",side:"LONG",src:"signal",kind:"pool",ok:false,decision:"BUSY",p6:.66,pMin:.58,phase:"GOOD",elapsedH:2,label:"数据一般",risk:0,why:"这个币已有持仓（一币一笔）"}),
    gateRec(130,{pb:"htf-donch20",sym:"AAVE_USDT",side:"LONG",src:"signal",kind:"htf",ok:false,decision:"DENY",p6:.52,pMin:.58,phase:"GOOD",elapsedH:70,label:"数据较足",risk:0,why:"日线突破做多选中，但动态分配不允许（只记录）：未来 6 小时处在赚钱期的概率 52%（要 ≥58%）【数据较足】"}),
    gateRec(180,{pb:noIds[2]??pa,src:"allocator",ok:false,decision:"CUT",p6:.6,pMin:.58,phase:"GOOD",elapsedH:9,label:"数据少",risk:0,why:"预测说赚钱期，但开闸后前 3 笔影子交易全亏，暂停 12 小时"})];
  const today=recent.slice(0,3);
  const pool={max:8,perPb:4,dayStart:Date.parse("2026-10-21T16:00:00Z"),open,today:{opened:4,closed:3,win:2,move:today.reduce((a,t)=>a+t.move,0),net:2.58},
    all:{closed:later?37:19,win:later?20:9,move:later?.0412:.0087},recent,gates};
  const items=([["fastProtect","1 集体异动保护",true],["fastFollow","2 集体异动跟随",false],["newSource","3 新来源",false],["noChase","4 不追高",true],["liqSafety","5 强平安全",true],
    ["thesisExit","6 判断出场",true],["sizing","7 仓位",true],["burstLeader","8 爆发选领涨（打法池成员）",true],["htfTrend","9 日线突破做多",true],["dynAllocator","10 总方案：周期预测器开单",true]] as const).map(([key,label,on])=>({key,label,on}));
  const s={version:"living-v2.9",mode:"paper-enabled",configured:"paper-enabled",acting:true,fallback:null,items,loadedAt:NOW-3*H,
    market:{state:"CALM",side:null,confidence:.42,sentence:"（旧）大盘平静，资金没有明显方向。",at:NOW-60_000,allowed:[]},marketTimeline:[],board:[],
    positions:open.map(p=>({id:p.id,symbol:p.sym,side:p.side,entry:p.entry,stop:p.stop,openedAt:p.openedAt,living:true,playbook:lab(p.pb),intent:null,story:`${lab(p.pb)}：信号收盘后开（示例）`,evidence:null,invalidation:null,
      hold:p.pb==="htf-donch20"?"日线突破单：只按止损和 10 日最低跟踪止损出场":"按这套打法自己的出场规则管理（目标 / 跟踪止损 / 时间）",holdAt:null})),
    thesis:null,probes:[],fast:{state:"CALM",side:null,reason:null,flow:null,episodes:212,surges7d:3},watches:[],
    selfCheck:{byPlaybook:[],fast:{alerts:30,fake:12,confirmed:9,follow30:[]},intentReads:{}},decisions:[{at:NOW-5*60_000,k:"DYN_SIGNAL",sym:"BNB_USDT",side:"SHORT",reason:"（示例）"}],
    htf:null,dynamic,pool,basket:30,flowSymbols:30,lastFeedAt:NOW-3000,flowAt:NOW-60_000,cpu:{planMs:38,maxPlanMs:160,hubMs:4},writesToday:310,lastError:null};
  const trade=(p:typeof open[number])=>({id:p.id,symbol:p.sym,side:p.side,openedAt:p.openedAt,closedAt:null,status:"OPEN",entryPrice:p.entry,stopPrice:p.stop,lastPrice:p.price,
    quantity:Math.round(1000*p.risk/Math.abs(p.stop/p.entry-1)/p.entry*1e4)/1e4,entryFee:.05,netPnl:null,inverseCopy:false});
  const data={updatedAt:NOW,positions:open.map(trade),history:recent.map(t=>({id:t.id,symbol:t.sym,side:t.side,openedAt:t.openedAt,closedAt:t.closedAt,status:"CLOSED",netPnl:t.net,exitReason:t.exitCode,inverseCopy:false}))};
  return {s,data,now:NOW};
}
