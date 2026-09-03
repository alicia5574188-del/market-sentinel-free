import type { Hte31CounterfactualReport } from "./hte31-counterfactual.ts";
import type { ResonanceEntryQualityReport } from "./resonance-entry-quality.ts";

export type Hte31TradeVerdictCode =
  | "VALID_TRADE"
  | "NO_TRADE"
  | "DIRECTION_WRONG"
  | "ENTRY_EARLY"
  | "ENTRY_LATE"
  | "EXIT_EARLY"
  | "EXIT_LATE"
  | "RISK_PLAN_MISMATCH"
  | "INSUFFICIENT_EVIDENCE";

export type Hte31TradeFinalVerdict = {
  final: boolean;
  code: Hte31TradeVerdictCode;
  label: string;
  shouldTrade: boolean | null;
  explanation: string;
  profitPath: string;
  recommendedAction: string;
  evidence: string[];
};

type TradeLike = {
  status: "holding" | "closed";
  netPnlUsdt?: number | null;
  riskBudgetUsdt: number;
  postExitStatus?: "pending" | "observing" | "complete" | null;
  postExitLabel?: string | null;
  exitEfficiency?: number | null;
  stopRecovery?: boolean | null;
  postExitMfePct?: number | null;
};

function resultR(trade: TradeLike) {
  return trade.riskBudgetUsdt > 0 && trade.netPnlUsdt != null ? trade.netPnlUsdt / trade.riskBudgetUsdt : null;
}

function bestAlternative(entryQuality: ResonanceEntryQualityReport, counterfactual: Hte31CounterfactualReport) {
  const delayed = entryQuality.delayedEntries
    .filter((item) => item.valid && item.terminalR != null)
    .map((item) => ({ label: `延迟 ${item.delayMinutes} 分钟进场`, value: item.terminalR! }));
  const reference = counterfactual.horizons.find((item) => item.minutes === 240) ?? counterfactual.horizons.at(-1);
  const directOpposite = reference ? [{ label: `入场直接反向（${reference.minutes}分钟）`, value: reference.oppositeR }] : [];
  const reversals = counterfactual.reversals.map((item) => ({ label: item.label, value: item.terminalR }));
  return [...delayed, ...directOpposite, ...reversals].sort((a, b) => b.value - a.value)[0] ?? null;
}

function verdict(
  code: Hte31TradeVerdictCode,
  label: string,
  shouldTrade: boolean | null,
  explanation: string,
  profitPath: string,
  recommendedAction: string,
  evidence: string[],
  final = true,
): Hte31TradeFinalVerdict {
  return { final, code, label, shouldTrade, explanation, profitPath, recommendedAction, evidence };
}

/**
 * Produces the final, observer-only answer for a closed order. It is deliberately
 * conservative: one trade may propose a correction, but only repeated evidence
 * is allowed to change a strategy rule elsewhere in the learning system.
 */
export function buildHte31TradeFinalVerdict(input: {
  trade: TradeLike;
  entryQuality: ResonanceEntryQualityReport | null;
  counterfactual: Hte31CounterfactualReport | null;
}): Hte31TradeFinalVerdict {
  const { trade, entryQuality, counterfactual } = input;
  const r = resultR(trade);
  const evidence = [
    `订单结果 ${r == null ? "--" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`}`,
    `出场后观察 ${trade.postExitStatus ?? "pending"}`,
  ];
  if (trade.status !== "closed") {
    return verdict("INSUFFICIENT_EVIDENCE", "尚未出场", null, "订单仍在持仓，不能提前给最终结论。", "继续按原始止损和目标管理。", "等待平仓及出场后观察完成。", evidence, false);
  }
  if (trade.postExitStatus !== "complete" || !entryQuality?.sampleSufficient || !counterfactual?.horizons.length) {
    return verdict("INSUFFICIENT_EVIDENCE", "持续观察中", null, "订单已经出场，但 12 小时观察或反事实证据尚未完整。", "暂不使用不完整数据倒推赚钱路径。", "继续完成 0/30/60/120/240/720 分钟观察，再形成最终判断。", evidence, false);
  }

  const alternative = bestAlternative(entryQuality, counterfactual);
  evidence.push(`进场诊断：${entryQuality.classificationLabel}`);
  if (alternative) evidence.push(`最佳可验证替代：${alternative.label} ${alternative.value >= 0 ? "+" : ""}${alternative.value.toFixed(2)}R`);

  if (entryQuality.classification === "direction_wrong") {
    return verdict("DIRECTION_WRONG", "这笔方向不该做", false, "同一进场时点的反方向明显优于原方向，问题首先是方向判断。", alternative && alternative.value > 0 ? `${alternative.label} 可达到约 ${alternative.value.toFixed(2)}R。` : "没有可靠的原方向盈利路径。", "加强大周期/全市场方向一致性；只有同类问题重复后才调整策略规则。", evidence);
  }
  if (entryQuality.classification === "entry_too_early") {
    const delay = entryQuality.delayedEntries.find((item) => item.delayBars === entryQuality.bestDelayBars);
    return verdict("ENTRY_EARLY", "应该等确认再进", true, "方向可能成立，但原进场过早，先承受了不必要的不利波动。", delay?.terminalR != null ? `延迟 ${delay.delayMinutes} 分钟可把路径改善为 ${delay.terminalR.toFixed(2)}R。` : "等待一次确认或回踩后再进更合理。", "把等待确认作为该策略/环境组合的模拟挑战规则；重复出现后再启用。", evidence);
  }
  if (entryQuality.classification === "entry_too_late") {
    return verdict("ENTRY_LATE", "应该更早进场", true, "方向可能成立，但进场过晚导致盈亏空间被压缩。", entryQuality.earlierEntryAdvantageR != null ? `更早进场的优势约为 +${entryQuality.earlierEntryAdvantageR.toFixed(2)}R。` : "应在原始触发仍有效时更早执行。", "检查是否有重复确认条件拖延进场；只在相同环境的重复样本中修正。", evidence);
  }
  if (entryQuality.classification === "stop_too_tight" || trade.stopRecovery || trade.postExitLabel === "疑似假止损") {
    return verdict("RISK_PLAN_MISMATCH", "止损位置需重做", true, "方向未必错误，但结构止损过紧或保护过早，订单被正常波动洗出。", "保持风险金额不变，使用更符合结构的止损并相应缩小数量。", "验证止损位置与波动环境；禁止通过放大保证金或风险预算解决。", evidence);
  }
  if (trade.postExitLabel === "退出偏早") {
    return verdict("EXIT_EARLY", "退出过早", true, "入场逻辑可保留，但退出后仍有明显顺向空间。", trade.postExitMfePct != null ? `退出后最大有利波动约 ${trade.postExitMfePct.toFixed(2)}%。` : "延后保护或分批退出可能改善收益。", "在模拟中验证更晚保护/分批退出，不改变原始止损风险。", evidence);
  }
  if (trade.postExitLabel === "退出偏晚") {
    return verdict("EXIT_LATE", "退出过晚", true, "订单曾有可兑现利润，但退出阶段回吐过多。", `当前退出效率 ${trade.exitEfficiency == null ? "--" : `${trade.exitEfficiency.toFixed(1)}%`}。`, "验证更早锁定利润或分批退出；不因单笔结果立即改规则。", evidence);
  }

  const reference = counterfactual.horizons.find((item) => item.minutes === 240) ?? counterfactual.horizons.at(-1)!;
  if ((r ?? 0) < 0 && reference.originalR <= -0.15 && (!alternative || alternative.value < 0.25)) {
    return verdict("NO_TRADE", "这笔不应该做", false, "原方向、延迟进场和确认后反转都没有形成足够的正收益路径。", "没有发现值得复制的赚钱路径；最优动作是跳过这笔交易。", "保留为负样本，检查策略与当时市场环境是否匹配；重复后缩减该组合使用。", evidence);
  }
  return verdict("VALID_TRADE", "交易逻辑可保留", true, "没有发现足够强的证据证明方向、进场或退出存在结构性错误。", (r ?? 0) > 0 ? "原订单本身已经实现正收益。" : "这次亏损更接近策略允许范围内的正常噪声。", "继续按原规则模拟；只有相同问题重复时才改变策略。", evidence);
}
