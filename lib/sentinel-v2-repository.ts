import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { v2MarketSnapshots, v2Opportunities, v2TradeThesis, v2WarningEvents } from "../db/v2-schema.ts";
import type { V2MarketContext } from "./sentinel-v2-core.ts";
import type { Strategy2Opportunity } from "./sentinel-v2-strategy.ts";

function parseJson<T>(value:string,fallback:T):T{try{return JSON.parse(value) as T}catch{return fallback}}
export async function saveV2MarketContext(context:V2MarketContext){
  const db=getDb(),id=crypto.randomUUID();
  await db.insert(v2MarketSnapshots).values({id,observedAt:context.observedAt,regime:context.regime,confidence:context.confidence,stability:context.stability,regimeScore:context.regimeScore,regimeMargin:context.regimeMargin,transitionRisk:context.transitionRisk,transitionVelocity:context.transitionVelocity,riskAcceleration:context.riskAcceleration,developingRegime:context.developingRegime,permission:context.permission,bias:context.bias,contextJson:JSON.stringify(context),createdAt:Date.now()});
  if(context.warnings.length)await db.insert(v2WarningEvents).values(context.warnings.map(w=>({id:crypto.randomUUID(),snapshotId:id,warningKey:w.id,observedAt:context.observedAt,type:w.type,level:w.level,status:w.status,severity:w.severity,confidence:w.confidence,relevance:w.relevance,timeframe:w.timeframe,direction:w.direction,title:w.title,detail:w.detail,impact:w.impact,payloadJson:JSON.stringify(w),createdAt:Date.now()})));
  return id;
}
export async function getLatestV2MarketContext():Promise<V2MarketContext|null>{const [row]=await getDb().select({contextJson:v2MarketSnapshots.contextJson}).from(v2MarketSnapshots).orderBy(desc(v2MarketSnapshots.observedAt)).limit(1);return row?parseJson(row.contextJson,null):null}
export async function saveV2Opportunities(opportunities:Strategy2Opportunity[]){if(!opportunities.length)return 0;const now=Date.now();await getDb().insert(v2Opportunities).values(opportunities.map(o=>({id:crypto.randomUUID(),symbol:o.symbol,observedAt:o.observedAt,playbook:o.playbook,side:o.side,state:o.state,opportunityScore:o.opportunityScore,environmentFit:o.environmentFit,playbookFit:o.playbookFit,structureScore:o.structure,timingScore:o.timing,confirmationScore:o.confirmation,riskReward:o.riskReward,portfolioImpact:o.portfolioImpact,riskMultiplier:o.riskMultiplier,reasonsJson:JSON.stringify(o.reasons),waitingJson:JSON.stringify(o.waitingFor),rejectJson:JSON.stringify(o.rejectReasons),payloadJson:JSON.stringify(o),createdAt:now})));return opportunities.length}
function stateRank(state:string){return state==="TRADE"?3:state==="WATCH"?2:state==="REJECT"?1:0}
export async function listRecentV2Opportunities(limit=80){
  const rows=await getDb().select({payloadJson:v2Opportunities.payloadJson}).from(v2Opportunities).orderBy(desc(v2Opportunities.observedAt)).limit(Math.max(12,Math.min(500,limit*12)));
  const grouped=new Map<string,Strategy2Opportunity>();
  for(const row of rows){const o=parseJson<Strategy2Opportunity|null>(row.payloadJson,null);if(!o)continue;const cur=grouped.get(o.symbol);if(!cur||o.observedAt>cur.observedAt||(o.observedAt===cur.observedAt&&(stateRank(o.state)>stateRank(cur.state)||(stateRank(o.state)===stateRank(cur.state)&&o.opportunityScore>cur.opportunityScore))))grouped.set(o.symbol,o)}
  return [...grouped.values()].sort((a,b)=>stateRank(b.state)-stateRank(a.state)||b.opportunityScore-a.opportunityScore).slice(0,limit);
}
export async function getV2StrategyPoolActivity(windowMs=5*60_000){
  const cutoff=Date.now()-Math.max(60_000,windowMs);
  const rows=await getDb().select({observedAt:v2Opportunities.observedAt,payloadJson:v2Opportunities.payloadJson}).from(v2Opportunities).orderBy(desc(v2Opportunities.observedAt)).limit(720);
  const opportunities=rows.filter(row=>row.observedAt>=cutoff).map(row=>parseJson<Strategy2Opportunity|null>(row.payloadJson,null)).filter((row):row is Strategy2Opportunity=>Boolean(row));
  const playbooks=[...new Set(opportunities.map(item=>item.playbook))].sort((a,b)=>Number(a.match(/^P(\d+)/)?.[1]??99)-Number(b.match(/^P(\d+)/)?.[1]??99));
  const symbols=[...new Set(opportunities.map(item=>item.symbol))];
  return {
    windowMinutes:Math.max(1,Math.round(windowMs/60_000)),
    evaluations:opportunities.length,
    symbols:symbols.length,
    playbookCount:playbooks.length,
    playbooks,
    states:{
      trade:opportunities.filter(item=>item.state==="TRADE").length,
      watch:opportunities.filter(item=>item.state==="WATCH").length,
      reject:opportunities.filter(item=>item.state==="REJECT").length,
    },
  };
}
export async function getV2Opportunity(symbol:string){
  const rows=await getDb().select({payloadJson:v2Opportunities.payloadJson}).from(v2Opportunities).where(eq(v2Opportunities.symbol,symbol)).orderBy(desc(v2Opportunities.observedAt)).limit(24);
  const ops=rows.map(r=>parseJson<Strategy2Opportunity|null>(r.payloadJson,null)).filter((r):r is Strategy2Opportunity=>Boolean(r));if(!ops.length)return null;const at=ops[0].observedAt;return ops.filter(o=>o.observedAt===at).sort((a,b)=>stateRank(b.state)-stateRank(a.state)||b.opportunityScore-a.opportunityScore)[0]??null;
}
export async function listRecentV2Warnings(limit=20){const rows=await getDb().select({payloadJson:v2WarningEvents.payloadJson}).from(v2WarningEvents).orderBy(desc(v2WarningEvents.observedAt)).limit(Math.max(1,Math.min(100,limit)));return rows.map(r=>parseJson(r.payloadJson,null)).filter(Boolean)}
export async function upsertV2TradeThesis(input:{tradeId:string;playbook:string;entryRegime:string;currentRegime:string;entryTransitionRisk:number;currentTransitionRisk:number;thesisHealth:number;entryThesis:unknown;currentThesis:unknown}){await getDb().insert(v2TradeThesis).values({tradeId:input.tradeId,playbook:input.playbook,entryRegime:input.entryRegime,currentRegime:input.currentRegime,entryTransitionRisk:input.entryTransitionRisk,currentTransitionRisk:input.currentTransitionRisk,thesisHealth:input.thesisHealth,entryThesisJson:JSON.stringify(input.entryThesis),currentThesisJson:JSON.stringify(input.currentThesis),updatedAt:Date.now()}).onConflictDoUpdate({target:v2TradeThesis.tradeId,set:{currentRegime:input.currentRegime,currentTransitionRisk:input.currentTransitionRisk,thesisHealth:input.thesisHealth,currentThesisJson:JSON.stringify(input.currentThesis),updatedAt:Date.now()}})}
export async function listV2TradeTheses(limit=50){const rows=await getDb().select().from(v2TradeThesis).orderBy(desc(v2TradeThesis.updatedAt)).limit(Math.max(1,Math.min(200,limit)));return rows.map(r=>({tradeId:r.tradeId,playbook:r.playbook,entryRegime:r.entryRegime,currentRegime:r.currentRegime,entryTransitionRisk:r.entryTransitionRisk,currentTransitionRisk:r.currentTransitionRisk,thesisHealth:r.thesisHealth,entryThesis:parseJson(r.entryThesisJson,{}),currentThesis:parseJson(r.currentThesisJson,{}),updatedAt:r.updatedAt}))}
export async function deleteV2ThesisForTrades(tradeIds:string[]){if(!tradeIds.length)return;await getDb().delete(v2TradeThesis).where(inArray(v2TradeThesis.tradeId,tradeIds))}