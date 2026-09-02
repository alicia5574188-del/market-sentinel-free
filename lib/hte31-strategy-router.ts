import {
  HTE31_RESEARCH_TRADER_IDS,
  hte31ResearchCatalogItem,
  type Hte31ResearchTraderId,
} from "./hte31-strategy-catalog.ts";

export const HTE31_ROUTER_MIN_SAMPLES = 30;
export const HTE31_ROUTER_MIN_PROFIT_FACTOR = 1.30;
export const HTE31_ROUTER_MIN_EXPECTANCY_R = 0.15;

export type Hte31RouterEvidence = {
  traderId: Hte31ResearchTraderId;
  completed: number;
  pending: number;
  wins: number;
  losses: number;
  expectancyR: number;
  profitFactor: number | null;
};

export type Hte31RouterCandidate = Hte31RouterEvidence & {
  code: string;
  label: string;
  qualified: boolean;
  score: number;
  reason: string;
};

export type Hte31ResearchRouter = {
  mode: "observe_only";
  automaticExecutionChanges: false;
  automaticStrategySwitching: false;
  minimumSamples: number;
  candidates: Hte31RouterCandidate[];
  qualified: Hte31RouterCandidate[];
  summary: string;
};

function finite(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value : 0;
}

export function buildHte31ResearchRouter(evidence: Partial<Record<Hte31ResearchTraderId, Hte31RouterEvidence>>): Hte31ResearchRouter {
  const candidates = HTE31_RESEARCH_TRADER_IDS.map((traderId) => {
    const item = hte31ResearchCatalogItem(traderId);
    const row = evidence[traderId] ?? {
      traderId,
      completed: 0,
      pending: 0,
      wins: 0,
      losses: 0,
      expectancyR: 0,
      profitFactor: null,
    };
    const pf = row.profitFactor;
    const qualified = row.completed >= HTE31_ROUTER_MIN_SAMPLES
      && pf != null
      && pf >= HTE31_ROUTER_MIN_PROFIT_FACTOR
      && row.expectancyR >= HTE31_ROUTER_MIN_EXPECTANCY_R;
    const sampleConfidence = Math.min(1, row.completed / HTE31_ROUTER_MIN_SAMPLES);
    const pfScore = pf == null ? 0 : Math.min(2.5, pf) / 2.5;
    const expectancyScore = Math.max(-1, Math.min(1, row.expectancyR / 0.6));
    const score = Number((sampleConfidence * (expectancyScore * 0.65 + pfScore * 0.35)).toFixed(4));
    const reason = qualified
      ? `${row.completed}样本 · PF ${pf!.toFixed(2)} · Exp ${row.expectancyR >= 0 ? "+" : ""}${row.expectancyR.toFixed(2)}R；达到研究晋级门槛，但仍不自动改写正式执行。`
      : `${row.completed}/${HTE31_ROUTER_MIN_SAMPLES}样本 · PF ${pf == null ? "--" : pf.toFixed(2)} · Exp ${row.expectancyR >= 0 ? "+" : ""}${row.expectancyR.toFixed(2)}R；继续积累独立前向样本。`;
    return {
      ...row,
      code: item.code,
      label: item.label,
      qualified,
      score,
      reason,
    } satisfies Hte31RouterCandidate;
  }).sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score - a.score || b.completed - a.completed);

  const qualified = candidates.filter((row) => row.qualified);
  return {
    mode: "observe_only",
    automaticExecutionChanges: false,
    automaticStrategySwitching: false,
    minimumSamples: HTE31_ROUTER_MIN_SAMPLES,
    candidates,
    qualified,
    summary: qualified.length
      ? `${qualified.map((row) => row.code).join(" / ")} 已达到研究晋级门槛；当前仍只给大脑提供证据，不抢占 HT4 或其他正式策略的执行权。`
      : "研究路由器仍处于观察期：允许多策略同时建立影子样本，但不会根据少量盈亏提高优先级、自动反手或替换 HT4。",
  };
}
