import { and, desc, eq } from "drizzle-orm";
import { requireApiAccount } from "../../../api-auth";
import { getDb } from "../../../../db";
import { tradeCases } from "../../../../db/schema";
import { v2Opportunities } from "../../../../db/v2-schema";

const PLAYBOOKS = [
  ["P1_TREND_PULLBACK", "P1 趋势回踩"],
  ["P2_TREND_BREAKOUT", "P2 趋势突破"],
  ["P3_RANGE_REVERSAL", "P3 震荡边缘反转"],
  ["P4_COMPRESSION_BREAKOUT", "P4 压缩突破"],
  ["P5_EXPANSION_MOMENTUM", "P5 扩张动量"],
  ["P6_LIQUIDATION_REVERSAL", "P6 清算反转"],
  ["P7_LIQUIDATION_CONTINUATION", "P7 清算延续"],
  ["P8_EXHAUSTION_REVERSAL", "P8 衰竭反转"],
  ["P9_RELATIVE_STRENGTH", "P9 相对强弱"],
  ["P10_ROTATION_LEADERSHIP", "P10 轮动/龙头强弱"],
  ["P11_FAILED_BREAKOUT", "P11 假突破反向"],
  ["P12_FLOW_DIVERGENCE", "P12 资金流背离"],
] as const;

const PLAYBOOK_IDS = new Set(PLAYBOOKS.map(([id]) => id));

function parseStrategy2Playbook(regime: string | null | undefined) {
  if (!regime?.startsWith("S2|")) return null;
  const playbook = regime.split("|")[1] ?? null;
  return playbook && PLAYBOOK_IDS.has(playbook as (typeof PLAYBOOKS)[number][0]) ? playbook : null;
}

function diagnosis(input: { evaluations: number; trade: number; watch: number; reject: number; completedSamples: number }) {
  if (input.completedSamples > 0) return "已有完成学习样本，继续按前向结果观察。";
  if (input.trade > 0) return "近期已有 TRADE 候选，但还没有完成学习样本；等待生命周期自然完成，不降低门槛。";
  if (input.evaluations > 0) return "策略正常参与评估，但近期没有进入 TRADE；先观察市场是否出现适配环境，不人为放宽条件。";
  return "近期没有发现该策略评估记录；这才属于需要检查扫描/数据链路的异常信号。";
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  try {
    const observedAt = Date.now();
    const windowMs = 5 * 60_000;
    const cutoff = observedAt - windowMs;
    const db = getDb();

    const [recentRows, closedRows] = await Promise.all([
      db.select({
        observedAt: v2Opportunities.observedAt,
        playbook: v2Opportunities.playbook,
        state: v2Opportunities.state,
      }).from(v2Opportunities).orderBy(desc(v2Opportunities.observedAt)).limit(720),
      db.select({
        regime: tradeCases.regime,
      }).from(tradeCases).where(and(
        eq(tradeCases.status, "closed"),
        eq(tradeCases.simulationModel, "contract_v2"),
      )).orderBy(desc(tradeCases.exitAt)).limit(5000),
    ]);

    const recent = recentRows.filter((row) => row.observedAt >= cutoff && PLAYBOOK_IDS.has(row.playbook as (typeof PLAYBOOKS)[number][0]));
    const completedByPlaybook = new Map<string, number>();
    for (const row of closedRows) {
      const playbook = parseStrategy2Playbook(row.regime);
      if (!playbook) continue;
      completedByPlaybook.set(playbook, (completedByPlaybook.get(playbook) ?? 0) + 1);
    }

    const playbooks = PLAYBOOKS.map(([id, label]) => {
      const decisions = recent.filter((row) => row.playbook === id);
      const completedSamples = completedByPlaybook.get(id) ?? 0;
      const item = {
        id,
        label,
        evaluations: decisions.length,
        trade: decisions.filter((row) => row.state === "TRADE").length,
        watch: decisions.filter((row) => row.state === "WATCH").length,
        reject: decisions.filter((row) => row.state === "REJECT").length,
        completedSamples,
      };
      return { ...item, diagnosis: diagnosis(item) };
    });

    const missingPlaybooks = playbooks
      .filter((item) => item.completedSamples === 0)
      .map((item) => ({ id: item.id, label: item.label }));

    return Response.json({
      observedAt,
      observationOnly: true,
      strategyLogicChanged: false,
      windowMinutes: Math.round(windowMs / 60_000),
      coverageCount: playbooks.filter((item) => item.completedSamples > 0).length,
      missingPlaybooks,
      playbooks,
      note: "该诊断只读取现有机会档案与已完成 Strategy 2.0 学习样本，不修改触发阈值、评分、风险、Execution Engine 或实盘权限。",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({
      observedAt: Date.now(),
      observationOnly: true,
      strategyLogicChanged: false,
      windowMinutes: 5,
      coverageCount: 0,
      missingPlaybooks: [],
      playbooks: [],
      error: error instanceof Error ? error.message : "Playbook 诊断暂不可用",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
