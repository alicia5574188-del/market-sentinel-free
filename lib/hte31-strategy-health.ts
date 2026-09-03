import type { Hte31StrategyFamilyId, Hte31TraderId } from "./hte31-strategy-catalog.ts";

export type Hte31StrategyHealthState =
  | "LEARNING"
  | "ACTIVE"
  | "UNDERPERFORMING"
  | "DEGRADED"
  | "STARVED"
  | "REGIME_WAIT"
  | "RETEST"
  | "PAUSED";

export type Hte31StrategyHealthInput = {
  sampleCount: number;
  expectancyR: number;
  recentSampleCount: number;
  recentExpectancyR: number;
  baselineSampleCount: number;
  baselineExpectancyR: number;
  everProfitable: boolean;
  evaluations: number;
  triggerActive: number;
  ready: number;
  nearReady: number;
  topFailures: { label: string; count: number; rate: number }[];
  guardState?: "ACTIVE" | "PAUSED";
  revalidation?: boolean;
};

export type Hte31StrategyHealth = {
  state: Hte31StrategyHealthState;
  label: string;
  reason: string;
  action: string;
};

const LABELS: Record<Hte31StrategyHealthState, string> = {
  LEARNING: "学习中",
  ACTIVE: "正常使用",
  UNDERPERFORMING: "近期亏损",
  DEGRADED: "由盈转弱",
  STARVED: "长期无单",
  REGIME_WAIT: "等待适配环境",
  RETEST: "模拟复考",
  PAUSED: "组合暂停",
};

function topFailure(input: Hte31StrategyHealthInput) {
  return input.topFailures[0]?.label ?? "进场条件";
}

export function evaluateHte31StrategyHealth(input: Hte31StrategyHealthInput): Hte31StrategyHealth {
  if (input.guardState === "PAUSED") {
    return {
      state: "PAUSED",
      label: LABELS.PAUSED,
      reason: "该策略在特定环境/方向组合中已有足够负面样本，当前隔离。",
      action: "保留策略本体，只暂停亏损组合；等待模拟复考，禁止自动扩大使用。",
    };
  }
  if (input.revalidation) {
    return {
      state: "RETEST",
      label: LABELS.RETEST,
      reason: "亏损组合已完成隔离，允许一笔受限模拟复考。",
      action: "仅用一笔新模拟订单验证修正后的进场条件，结果不合格则重新隔离。",
    };
  }

  const recentReady = input.recentSampleCount >= 4;
  const wasProfitable = input.everProfitable
    || (input.baselineSampleCount >= 8 && input.baselineExpectancyR >= 0.15);
  if (recentReady && wasProfitable && input.recentExpectancyR <= -0.15) {
    return {
      state: "DEGRADED",
      label: LABELS.DEGRADED,
      reason: `历史曾有效，但最近 ${input.recentSampleCount} 笔期望降至 ${input.recentExpectancyR.toFixed(2)}R。`,
      action: "比较近期与历史的环境、方向、进场和出场差异；降低近期排序权重，并在模拟中验证修正。",
    };
  }
  if (recentReady && input.recentExpectancyR <= -0.15) {
    return {
      state: "UNDERPERFORMING",
      label: LABELS.UNDERPERFORMING,
      reason: `最近 ${input.recentSampleCount} 笔期望为 ${input.recentExpectancyR.toFixed(2)}R，已达到复盘阈值。`,
      action: "逐单区分方向、进场、出场和环境问题；只缩减或暂停问题组合，不草率删除整个策略。",
    };
  }

  if (input.evaluations >= 30 && input.ready === 0 && input.triggerActive >= 3) {
    return {
      state: "STARVED",
      label: LABELS.STARVED,
      reason: `观察 ${input.evaluations} 次且已有 ${input.triggerActive} 次基础触发，但始终未能开单；主要卡在“${topFailure(input)}”。`,
      action: "检查条件是否重复或过严；只在模拟中提出一个可验证的放宽方案，并设置回滚标准。",
    };
  }
  if (input.evaluations >= 30 && input.triggerActive === 0) {
    return {
      state: "REGIME_WAIT",
      label: LABELS.REGIME_WAIT,
      reason: `观察 ${input.evaluations} 次仍没有基础触发，当前市场可能不属于该策略适用环境。`,
      action: "继续监控适用环境，不为增加开单而降低核心定义；若跨环境长期无触发，再审查策略是否失效。",
    };
  }
  if (input.sampleCount < 8) {
    return {
      state: "LEARNING",
      label: LABELS.LEARNING,
      reason: `当前只有 ${input.sampleCount} 笔完成样本，暂不足以判定长期有效性。`,
      action: "继续进入统一模拟池积累独立订单，历史表现暂不参与大脑排序。",
    };
  }
  return {
    state: "ACTIVE",
    label: LABELS.ACTIVE,
    reason: `${input.sampleCount} 笔样本，整体期望 ${input.expectancyR.toFixed(2)}R，近期未触发退化或闲置警报。`,
    action: "按当前规则继续模拟，逐单复盘并监控近期相对历史的变化。",
  };
}

const FAMILY_PRIORITY: Record<Hte31StrategyHealthState, number> = {
  DEGRADED: 8,
  UNDERPERFORMING: 7,
  PAUSED: 6,
  RETEST: 5,
  STARVED: 4,
  ACTIVE: 3,
  LEARNING: 2,
  REGIME_WAIT: 1,
};

export function summarizeHte31FamilyHealth(input: {
  familyId: Hte31StrategyFamilyId;
  members: { traderId: Hte31TraderId; health: Hte31StrategyHealth }[];
}) {
  const focus = [...input.members].sort((a, b) => FAMILY_PRIORITY[b.health.state] - FAMILY_PRIORITY[a.health.state])[0];
  return {
    familyId: input.familyId,
    state: focus?.health.state ?? "LEARNING" as Hte31StrategyHealthState,
    label: focus?.health.label ?? LABELS.LEARNING,
    reason: focus?.health.reason ?? "尚无可用诊断样本。",
    action: focus?.health.action ?? "继续模拟学习。",
    focusTraderId: focus?.traderId ?? null,
    variants: input.members,
  };
}
