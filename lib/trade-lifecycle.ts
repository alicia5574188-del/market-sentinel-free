export type TradeSide = "LONG" | "SHORT";
export type ExitCode = "take_profit" | "stop_loss" | "breakeven" | "structure_reversal" | "flow_reversal" | "macro_risk" | "timeout";

export type HistoricalExperience = {
  sampleCount: number;
  wins: number;
  losses: number;
  bayesianWinRate: number;
  averageNetPct: number;
  averageMfePct: number;
  averageMaePct: number;
  profitFactor: number | null;
  stopRate: number;
  lastLesson?: TradeLesson | null;
};

export type ExperienceBySide = {
  LONG: HistoricalExperience | null;
  SHORT: HistoricalExperience | null;
};

export type EntryCheck = {
  key: string;
  label: string;
  passed: boolean;
  required: boolean;
  detail: string;
};

export type ExitRule = {
  code: ExitCode;
  label: string;
  condition: string;
};

export type EntryPlan = {
  ready: boolean;
  side: TradeSide;
  entryPrice: number;
  entryZone: [number, number];
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  riskPerUnit: number;
  plannedRiskPct: number;
  riskReward: number;
  maxHoldingMinutes: number;
  checks: EntryCheck[];
  exitRules: ExitRule[];
};

export type TradePositionSnapshot = {
  id: string;
  symbol: string;
  side: TradeSide;
  entryAt: number;
  entryPrice: number;
  initialStopPrice: number;
  currentStopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  target1HitAt: number | null;
  maxHoldingMinutes: number;
  maxPriceSeen: number;
  minPriceSeen: number;
  adverseFlowCount: number;
  confidence: number;
  regime: string;
};

export type ExitAnalysisInput = {
  observedAt: number;
  price: number;
  highPrice?: number | null;
  lowPrice?: number | null;
  directionalScore: number;
  confirmationCount: number;
  macroEventRisk: number;
  metrics: { key: string; label: string; score: number; detail: string; available: boolean }[];
  roundTripCostBps: number;
};

export type PositionEvaluation = {
  close: boolean;
  exitPrice: number | null;
  exitCode: ExitCode | null;
  exitReason: string | null;
  exitEvidence: string[];
  target1ReachedNow: boolean;
  currentStopPrice: number;
  target1HitAt: number | null;
  adverseFlowCount: number;
  maxPriceSeen: number;
  minPriceSeen: number;
  grossMovePct: number;
  netMovePct: number;
  estimatedCostPct: number;
  mfePct: number;
  maePct: number;
  progressR: number;
  holdMinutes: number;
};

export type TradeLesson = {
  outcome: "profit" | "loss" | "flat";
  summary: string;
  whatWorked: string[];
  whatFailed: string[];
  nextAdjustment: string[];
};

export type MemoryAccumulator = {
  sampleCount: number;
  wins: number;
  losses: number;
  bayesAlpha: number;
  bayesBeta: number;
  averageNetPct: number;
  averageMfePct: number;
  averageMaePct: number;
  grossProfitSumPct: number;
  grossLossSumPct: number;
  targetExits: number;
  stopExits: number;
  reversalExits: number;
  timeoutExits: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function signedMove(side: TradeSide, entry: number, exit: number) {
  const raw = (exit / entry - 1) * 100;
  return side === "SHORT" ? -raw : raw;
}

export function experienceEdge(experience: HistoricalExperience | null | undefined) {
  if (!experience || experience.sampleCount <= 0) return 0;
  const shrink = experience.sampleCount / (experience.sampleCount + 8);
  const winComponent = (experience.bayesianWinRate - 0.5) * 1.25;
  const netComponent = clamp(experience.averageNetPct / 1.5, -0.55, 0.55);
  const stopPenalty = clamp((experience.stopRate - 0.45) * 0.5, 0, 0.2);
  return clamp((winComponent + netComponent - stopPenalty) * shrink, -0.55, 0.55);
}

export function evaluatePosition(trade: TradePositionSnapshot, input: ExitAnalysisInput): PositionEvaluation {
  const direction = trade.side === "LONG" ? 1 : -1;
  const windowHigh = Math.max(input.price, input.highPrice ?? input.price);
  const windowLow = Math.min(input.price, input.lowPrice ?? input.price);
  const maxPriceSeen = Math.max(trade.maxPriceSeen, windowHigh);
  const minPriceSeen = Math.min(trade.minPriceSeen, windowLow);
  const riskPerUnit = Math.max(Math.abs(trade.entryPrice - trade.initialStopPrice), trade.entryPrice * 0.0001);
  const mfePct = trade.side === "LONG"
    ? signedMove("LONG", trade.entryPrice, maxPriceSeen)
    : signedMove("SHORT", trade.entryPrice, minPriceSeen);
  const maePct = trade.side === "LONG"
    ? signedMove("LONG", trade.entryPrice, minPriceSeen)
    : signedMove("SHORT", trade.entryPrice, maxPriceSeen);
  const holdMinutes = Math.max(0, (input.observedAt - trade.entryAt) / 60_000);
  const target1Touched = trade.side === "LONG" ? windowHigh >= trade.takeProfit1Price : windowLow <= trade.takeProfit1Price;
  const target2Touched = trade.side === "LONG" ? windowHigh >= trade.takeProfit2Price : windowLow <= trade.takeProfit2Price;
  const stopTouched = trade.side === "LONG" ? windowLow <= trade.currentStopPrice : windowHigh >= trade.currentStopPrice;
  const target1ReachedNow = trade.target1HitAt == null && target1Touched && !stopTouched;
  const target1HitAt = trade.target1HitAt ?? (target1ReachedNow ? input.observedAt : null);
  const currentStopPrice = target1HitAt == null
    ? trade.currentStopPrice
    : trade.side === "LONG" ? Math.max(trade.currentStopPrice, trade.entryPrice) : Math.min(trade.currentStopPrice, trade.entryPrice);

  const aligned = (score: number) => score * direction;
  const adverseMetrics = input.metrics.filter((metric) => metric.available && ["spot-flow", "order-book", "derivatives", "multi-timeframe"].includes(metric.key) && aligned(metric.score) <= -0.18);
  const adverseFlowNow = adverseMetrics.some((metric) => metric.key === "spot-flow") && adverseMetrics.length >= 2;
  const adverseFlowCount = adverseFlowNow ? trade.adverseFlowCount + 1 : 0;
  const structureReversed = aligned(input.directionalScore) <= -0.24 && input.confirmationCount >= 3;
  const macroRisk = input.macroEventRisk >= 0.85;
  const timedOut = holdMinutes >= trade.maxHoldingMinutes;

  let exitCode: ExitCode | null = null;
  let exitPrice: number | null = null;
  let exitReason: string | null = null;
  let exitEvidence: string[] = [];
  if (stopTouched) {
    const protectedAtEntry = trade.target1HitAt != null && Math.abs(trade.currentStopPrice - trade.entryPrice) <= riskPerUnit * 0.02;
    exitCode = protectedAtEntry ? "breakeven" : "stop_loss";
    exitPrice = trade.currentStopPrice;
    exitReason = target2Touched
      ? `同一 5m 价格窗口同时跨过止损与第二目标，无法可靠判定先后；系统按保守原则以止损 ${trade.currentStopPrice} 记录。`
      : protectedAtEntry
      ? `第一目标后保护止损回到入场价 ${trade.entryPrice}，按保护价退出（扣除费用后可能小幅亏损）。`
      : `5m 窗口最低/最高价触及结构止损 ${trade.currentStopPrice}，原入场逻辑失效。`;
  } else if (target2Touched) {
    exitCode = "take_profit";
    exitPrice = trade.takeProfit2Price;
    exitReason = `5m 窗口价格到达第二目标 ${trade.takeProfit2Price}，按计划完成止盈。`;
  } else if (macroRisk) {
    exitCode = "macro_risk";
    exitPrice = input.price;
    exitReason = "高影响宏观事件进入硬拦截窗口，退出持仓避免跳空风险。";
  } else if (structureReversed) {
    exitCode = "structure_reversal";
    exitPrice = input.price;
    exitReason = "多源方向评分已反向并达到确认阈值，原方向结构不再成立。";
  } else if (adverseFlowCount >= 2) {
    exitCode = "flow_reversal";
    exitPrice = input.price;
    exitReason = "现货主动流与至少一个独立结构源连续两轮反向，退出持仓。";
  } else if (timedOut) {
    exitCode = "timeout";
    exitPrice = input.price;
    exitReason = `持仓达到 ${trade.maxHoldingMinutes} 分钟上限且未完成第二目标，释放风险预算。`;
  }

  const valuationPrice = exitPrice ?? input.price;
  const favorableMove = direction * (valuationPrice - trade.entryPrice);
  const progressR = favorableMove / riskPerUnit;
  const grossMovePct = signedMove(trade.side, trade.entryPrice, valuationPrice);
  const estimatedCostPct = input.roundTripCostBps / 100;
  const netMovePct = grossMovePct - estimatedCostPct;
  if (exitCode === "take_profit") exitEvidence = [`本单达到 ${progressR.toFixed(2)}R`, `持仓 ${holdMinutes.toFixed(0)} 分钟`, `扣除估算成本后 ${netMovePct.toFixed(2)}%`];
  else if (exitCode === "stop_loss" || exitCode === "breakeven") exitEvidence = [`最不利波动 ${maePct.toFixed(2)}%`, `退出时 ${progressR.toFixed(2)}R`, target2Touched ? "同窗双向触价按保守顺序归因" : "严格执行预设风险边界"];
  else if (exitCode === "macro_risk") exitEvidence = [`宏观风险 ${Math.round(input.macroEventRisk * 100)}/100`, `退出净变动 ${netMovePct.toFixed(2)}%`];
  else if (exitCode === "structure_reversal") exitEvidence = [`反向评分 ${input.directionalScore.toFixed(3)}`, `反向确认源 ${input.confirmationCount} 类`];
  else if (exitCode === "flow_reversal") exitEvidence = adverseMetrics.map((metric) => `${metric.label}：${metric.detail}`).slice(0, 4);
  else if (exitCode === "timeout") exitEvidence = [`期间最大有利波动 ${mfePct.toFixed(2)}%`, `期间最大不利波动 ${maePct.toFixed(2)}%`, `最终净变动 ${netMovePct.toFixed(2)}%`];

  return {
    close: exitCode != null,
    exitPrice,
    exitCode,
    exitReason,
    exitEvidence,
    target1ReachedNow,
    currentStopPrice,
    target1HitAt,
    adverseFlowCount,
    maxPriceSeen,
    minPriceSeen,
    grossMovePct,
    netMovePct,
    estimatedCostPct,
    mfePct,
    maePct,
    progressR,
    holdMinutes,
  };
}

export function deriveTradeLesson(trade: TradePositionSnapshot, evaluation: PositionEvaluation, entryEvidence: { title: string }[], exitMetrics: ExitAnalysisInput["metrics"]): TradeLesson {
  const outcome: TradeLesson["outcome"] = evaluation.netMovePct > 0.03 ? "profit" : evaluation.netMovePct < -0.03 ? "loss" : "flat";
  const opposing = exitMetrics.filter((metric) => metric.available && metric.score * (trade.side === "LONG" ? 1 : -1) < -0.18).map((metric) => metric.label);
  const whatWorked = outcome === "profit"
    ? [`入场时的${entryEvidence.slice(0, 2).map((item) => item.title).join("、") || "多源证据"}最终得到价格验证。`, evaluation.exitCode === "take_profit" ? "按第二目标止盈，避免主观延长持仓。" : "出场纪律保留了已形成的优势。"]
    : [`预设止损和风险预算把单笔损失限制在计划范围内。`, `完整记录了 ${evaluation.mfePct.toFixed(2)}% MFE 与 ${evaluation.maePct.toFixed(2)}% MAE。`];
  const whatFailed = outcome === "loss"
    ? [`原入场证据未能延续${opposing.length ? `，出场时${opposing.slice(0, 3).join("、")}已经反向` : "，价格未按预期扩展"}。`, evaluation.exitCode === "stop_loss" ? "结构止损被触发，说明入场位置或确认强度不足。" : `订单因${evaluation.exitCode ?? "规则"}退出。`]
    : opposing.length ? [`持仓后出现${opposing.slice(0, 3).join("、")}反向，后续同类行情需更早管理。`] : [];
  const nextAdjustment = outcome === "loss"
    ? ["该币种同方向的历史经验分将下调，后续确认可信度会受到负向修正。", evaluation.maePct < -Math.abs(evaluation.mfePct) ? "后续同类结构优先等待更靠近失效位的入场区间。" : "保留当前止损框架，等待更多样本后再调整阈值。"]
    : ["该币种同方向的历史经验分将小幅上调，但采用贝叶斯收缩避免少量盈利造成过度自信。"];
  return {
    outcome,
    summary: `${trade.symbol} ${trade.side} 以${evaluation.exitCode ?? "规则"}结束，净变动 ${evaluation.netMovePct.toFixed(2)}%，持仓 ${evaluation.holdMinutes.toFixed(0)} 分钟。`,
    whatWorked,
    whatFailed,
    nextAdjustment,
  };
}

export function accumulateMemory(current: MemoryAccumulator | null, evaluation: Pick<PositionEvaluation, "netMovePct" | "mfePct" | "maePct" | "exitCode">): MemoryAccumulator {
  const before = current ?? {
    sampleCount: 0, wins: 0, losses: 0, bayesAlpha: 1, bayesBeta: 1,
    averageNetPct: 0, averageMfePct: 0, averageMaePct: 0,
    grossProfitSumPct: 0, grossLossSumPct: 0,
    targetExits: 0, stopExits: 0, reversalExits: 0, timeoutExits: 0,
  };
  const sampleCount = before.sampleCount + 1;
  const won = evaluation.netMovePct > 0;
  const average = (oldValue: number, value: number) => oldValue + (value - oldValue) / sampleCount;
  return {
    sampleCount,
    wins: before.wins + (won ? 1 : 0),
    losses: before.losses + (won ? 0 : 1),
    bayesAlpha: before.bayesAlpha + (won ? 1 : 0),
    bayesBeta: before.bayesBeta + (won ? 0 : 1),
    averageNetPct: average(before.averageNetPct, evaluation.netMovePct),
    averageMfePct: average(before.averageMfePct, evaluation.mfePct),
    averageMaePct: average(before.averageMaePct, evaluation.maePct),
    grossProfitSumPct: before.grossProfitSumPct + Math.max(0, evaluation.netMovePct),
    grossLossSumPct: before.grossLossSumPct + Math.min(0, evaluation.netMovePct),
    targetExits: before.targetExits + (evaluation.exitCode === "take_profit" ? 1 : 0),
    stopExits: before.stopExits + (["stop_loss", "breakeven"].includes(evaluation.exitCode ?? "") ? 1 : 0),
    reversalExits: before.reversalExits + (["structure_reversal", "flow_reversal", "macro_risk"].includes(evaluation.exitCode ?? "") ? 1 : 0),
    timeoutExits: before.timeoutExits + (evaluation.exitCode === "timeout" ? 1 : 0),
  };
}
