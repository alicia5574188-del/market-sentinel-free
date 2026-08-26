import { and, desc, eq, like } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import type { GateAnalysisPacket } from "./gate-client.ts";
import { processDecision, type AppSettings, type LifecycleResult } from "./repository.ts";
import type { Candle } from "./signal-engine.ts";
import { STRATEGY2_LABELS, type Strategy2Id, type Strategy2Signal } from "./strategy-2-engine.ts";
import { calculateStrategyStatistics } from "./strategy-promotion.ts";

const LEGACY_SHADOW_PREFIX = "shadow_v3:";
const STRATEGIES: { id: Strategy2Id; label: string }[] = (Object.entries(STRATEGY2_LABELS) as [Strategy2Id, string][]).map(([id, label]) => ({ id, label }));

type ReadyGrowthSignal = Strategy2Signal & { side: "LONG" | "SHORT"; entryPlan: NonNullable<Strategy2Signal["entryPlan"]> };
export type GrowthModuleResult = { opened: number; closed: number; evaluated: number; archived: number; selected: Strategy2Id | null; lifecycle: LifecycleResult | null };

function isReadyGrowthSignal(signal: Strategy2Signal): signal is ReadyGrowthSignal {
  return signal.state === "ready" && signal.side !== "WAIT" && Boolean(signal.entryPlan?.ready);
}
function chooseGrowthSignal(signals: Strategy2Signal[]) {
  return signals.filter(isReadyGrowthSignal).sort((a,b)=>b.confidence-a.confidence||Math.abs(b.score)-Math.abs(a.score))[0] ?? null;
}

function growthPacket(packet: GateAnalysisPacket, signal: ReadyGrowthSignal): GateAnalysisPacket {
  const direction = signal.side === "LONG" ? 1 : -1;
  const posteriorLong = Math.min(0.98, Math.max(0.02, 0.5 + direction * Math.abs(signal.score) * 0.45));
  const supporting = signal.strategyMeta.supportingPlaybooks ?? [];
  const evidence = signal.reasons.map((detail,index)=>({ title:index===0?`${signal.label}触发`:`${signal.label}证据 ${index+1}`, detail, score:Number(Math.abs(signal.score).toFixed(2)) }));
  if (supporting.length) evidence.unshift({ title:"多策略同向汇合", detail:supporting.join("、"), score:Math.min(1,0.55+supporting.length*0.1) });
  const counterEvidence = signal.blockers.length ? signal.blockers.map((detail)=>({title:"硬性风险检查",detail})) : packet.decision.counterEvidence.slice(0,3);
  const globalRegime = signal.strategyMeta.globalRegime ?? "unknown";
  const assetRegime = signal.strategyMeta.assetRegime ?? "transition";
  const regimeKey = `S2|${signal.strategyMeta.playbookId}|global:${globalRegime}|asset:${assetRegime}`;
  return {...packet, decision:{...packet.decision,state:"confirmed",stateLabel:signal.strategyMeta.tradeMode==="exploration"?"Strategy 2.0 探索交易":"Strategy 2.0 确认",side:signal.side,confidence:signal.confidence,directionalScore:signal.score,posteriorLong,regime:regimeKey,action:`${signal.label}触发，按 ${signal.strategyMeta.tradeMode ?? "exploration"} 风险执行`,thesis:`Sentinel Strategy 2.0 当前由「${signal.label}」主导。${supporting.length?`同向支持：${supporting.join("、")}。`:""}${signal.thesis}`,entryZone:signal.entryPlan.entryZone,trigger:`Strategy 2.0 · ${signal.label}：${signal.reasons.join("；")}`,invalidation:`${signal.label}结构失效：触及结构止损 ${signal.entryPlan.stopLossPrice}`,invalidationPrice:signal.entryPlan.stopLossPrice,expiresMinutes:Math.min(packet.decision.expiresMinutes,signal.strategyMeta.tradeMode==="exploration"?10:15),entryPlan:signal.entryPlan,evidence,counterEvidence,metrics:signal.metrics,diagnostics:{...packet.decision.diagnostics,confirmationCount:signal.reasons.length,atrPct:signal.regime.atrPct??packet.decision.diagnostics.atrPct}}};
}

export async function retireLegacyShadowTrades() {
  const archived = await getDb().update(tradeCases).set({activeKey:null,status:"archived",archivedAt:Date.now(),learningApplied:true}).where(and(eq(tradeCases.status,"holding"),like(tradeCases.simulationModel,`${LEGACY_SHADOW_PREFIX}%`))).returning({id:tradeCases.id});
  return archived.length;
}
export async function listOpenShadowTradeSymbols(){ return [] as string[]; }

export async function processShadowStrategies(packet:GateAnalysisPacket,_candles5m:Candle[],signals:Strategy2Signal[],settings:AppSettings):Promise<GrowthModuleResult>{
  const db=getDb();
  const [existing]=await db.select({id:tradeCases.id}).from(tradeCases).where(and(eq(tradeCases.symbol,packet.symbol),eq(tradeCases.status,"holding"),eq(tradeCases.simulationModel,"contract_v2"))).limit(1);
  if(existing)return {opened:0,closed:0,evaluated:signals.length,archived:0,selected:null,lifecycle:null};
  const selected=chooseGrowthSignal(signals);
  if(!selected)return {opened:0,closed:0,evaluated:signals.length,archived:0,selected:null,lifecycle:null};
  const lifecycle=await processDecision(growthPacket(packet,selected),settings);
  return {opened:lifecycle.kind==="opened"?1:0,closed:lifecycle.kind==="closed"?1:0,evaluated:signals.length,archived:0,selected:lifecycle.kind==="opened"?selected.strategyId:null,lifecycle};
}

export async function getStrategyLabDashboard(){
  const rows=await getDb().select({status:tradeCases.status,netMovePct:tradeCases.netMovePct,exitAt:tradeCases.exitAt,entryAt:tradeCases.entryAt,regime:tradeCases.regime}).from(tradeCases).where(eq(tradeCases.simulationModel,"contract_v2")).orderBy(desc(tradeCases.entryAt)).limit(2500);
  const closed=rows.filter(r=>r.status==="closed");
  const stats=calculateStrategyStatistics(closed.map(r=>({netMovePct:r.netMovePct,exitAt:r.exitAt,regime:r.regime})));
  return {observedAt:Date.now(),note:"Strategy 2.0：12 套 Playbook 同时评估、竞争与学习；同一币只建立一个主仓位，多策略同向作为支持 Thesis。",baseline:{id:"baseline_v1" as const,label:"Sentinel Strategy 2.0",mode:"baseline" as const,openCount:rows.filter(r=>r.status==="holding").length,stats},strategies:STRATEGIES.map(strategy=>({id:strategy.id,label:strategy.label,mode:"shadow" as const,openCount:0,stats:calculateStrategyStatistics([]),promotion:{status:"watch" as const,label:"全策略池并行",eligible:true,requiredSamples:0,requiredActiveDays:0,reasons:["所有 Playbook 从第一天参与评估；真实交易按环境、证据和探索价值竞争主仓位"]}}))};
}
