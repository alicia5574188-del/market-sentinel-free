/**
 * 新交易系统（NTS）的全部参数。只有这一个文件。默认值来自「状态→计划」系统规格；改参数只改这里。
 * 没有任何一个数是为了让回放"好看"而调出来的。
 */
export const NTS_VERSION = "nts-v1" as const;

export type NtsConfig = {
  /** 总开关：新交易系统自动开仓（模拟盘）。默认开；用户可以关。关了不开新仓，已有仓位照常管理到平仓。 */
  enabled: boolean;
  symbols: readonly string[];
  leverage: number;
  /** 本金口径：开仓时的账户余额（复利）。 */
  firstMarginPct: number;       // 首仓保证金 / 本金
  addMarginPct: number;         // 补仓保证金 / 本金（读法 A）
  maxLossPct: number;           // 1R：整笔最坏亏损 / 本金
  /** 止损 */
  firstStopPct: number;         // 未补仓：首仓价下方
  hardStopPct: number;          // 补仓后：均价下方
  stopSlipPct: number;          // 止损滑点假设（只用于最坏亏损估算）
  /** 出场阶梯（补仓后，自补仓时刻起） */
  breakevenPct: number;         // 保本价 = 均价 +
  tolerancePct: number;         // 6~12h：均价 +
  toleranceFromH: number;
  timeStopH: number;            // 满 12h 市价平
  /** 未补仓：目标、状态失效、时间失效 */
  firstTargetPct: number;       // 没有阻力区时的默认目标距离下限
  maxTargetPct: number;         // 目标距离上限
  unaddedTimeStopH: number;     // 未补仓 8h 仍无 +0.5% 浮盈且回到入场价附近
  unaddedTimeStopGainPct: number;
  /** 费用（沿用模拟盘现有成本模型，这里只用于估算保本价与最坏亏损） */
  feeRate: number;              // 单边吃单费率
  roundTripCostPct: number;     // 来回手续费+资金费，规格 0.19%
  slippagePct: number;          // 模拟成交滑点
  maintenanceRate: number;      // 全仓维持保证金率（BTC/ETH 第一档 0.3%）
  /** 市场偏向 */
  neutralBand: number;          // |core| ≥ 带宽：只做偏向方向，满仓位
  /** |core| < 带宽（中性）时：不再一票否决，按触发方向开仓，仓位 × 此倍数；0 = 中性不做（旧行为） */
  neutralSizeMult: number;
  biasWeights: { trend: number; oi: number; funding: number; basis: number };
  tfWeights: { "1d": number; "4h": number; "1h": number };
  /** 辅助指标（RSI/MACD）：只做小幅加减分/置信度调整，不进入任何放行/否决条件 */
  aux: { maxBiasAdj: number; maxConfAdj: number; rsiOverbought: number; rsiOversold: number };
  /** 支撑压力区 */
  zone: { pivotLeft: number; pivotRight: number; clusterAtr: number; minScore: number; maxZones: number; lookback: Record<"15m" | "1h" | "4h" | "1d", number>;
    tfWeight: Record<"15m" | "1h" | "4h" | "1d", number> };
  /** 触发 */
  trigger: { sweepMinPct: number; sweepMaxPct: number; reclaimBars: number; volMinMult: number; volMaxMult: number;
    closeStrength: number; maxChasePct: number; rrMin: number; costMult: number; expectedMoveHours: number;
    /** 次级触发「回踩确认」：最近 retestBars 根 15m 回踩进区（未收盘跌破区另一侧），最后一根为同向确认K线 */
    retest: boolean; retestBars: number; retestStrength: number;
    /** 前方没有对向区时：目标空间 = 1H ATR% × 该倍数（上限 maxTargetPct），而不是否决 */
    noOppAtrMult: number };
  /** 补仓 H1~H5 / G1~G4 */
  add: { distMinPct: number; distMaxPct: number; levelTolerancePct: number; minTouches: number; gMin: number;
    funding: number; oiDropPct: number; atrPctMax: number; volMaxMult: number };
  /** 波动缩放：ATR(1H)% 高于参考值时，止损距离放宽、保证金按比例缩小（1R 不变） */
  vol: { refAtr1hPct: number; maxScale: number };
  /** 当日停开：当日（老挝时间 UTC+7）已实现亏损达到 dayStopR 个 R 后当日不再开新仓。
   *  月度熔断（−3% 减半、−5% 停开）已按用户决定（2026-10-29）整体移除：没有任何按月的减仓或停开；旧配置里的月度键会被忽略。 */
  breaker: { dayStopR: number; tzOffsetHours: number };
  /** 事件窗口（毫秒时间戳区间）。默认空：事件日历没有免费自动源，日志会写「未配置」。 */
  eventWindows: { start: number; end: number; label: string }[];
  /** 日志 */
  log: { traceEveryMs: number; flushEveryMs: number; noTradeSampleMs: number; maxVetoes: number; maxChunkBytes: number;
    postExitMarksMin: readonly number[]; keepChunks: number };
  /** 拉数据（只用已有的 Gate 公开接口，自己的令牌桶，不碰执行行情的预算） */
  data: { restPerSec: number; candleLimit: Record<"15m" | "1h" | "4h" | "1d", number>; minCandles: Record<"15m" | "1h" | "4h" | "1d", number>;
    derivEveryMs: number; staleBarFactor: number };
};

export const DEFAULT_NTS_CONFIG: NtsConfig = {
  enabled: true,
  symbols: ["BTC_USDT", "ETH_USDT"],
  leverage: 100,
  firstMarginPct: 0.02,
  addMarginPct: 0.03,
  maxLossPct: 0.05,
  firstStopPct: 0.007,
  hardStopPct: 0.0075,
  stopSlipPct: 0.0005,
  breakevenPct: 0.002,
  tolerancePct: 0.0005,
  toleranceFromH: 6,
  timeStopH: 12,
  firstTargetPct: 0.01,
  maxTargetPct: 0.03,
  unaddedTimeStopH: 8,
  unaddedTimeStopGainPct: 0.005,
  feeRate: 0.0007,
  roundTripCostPct: 0.0019,
  slippagePct: 0.00025,
  maintenanceRate: 0.003,
  neutralBand: 0.1,
  neutralSizeMult: 0.5,
  biasWeights: { trend: 0.55, oi: 0.2, funding: 0.15, basis: 0.1 },
  tfWeights: { "1d": 0.4, "4h": 0.35, "1h": 0.25 },
  aux: { maxBiasAdj: 0.06, maxConfAdj: 0.08, rsiOverbought: 72, rsiOversold: 28 },
  zone: { pivotLeft: 3, pivotRight: 3, clusterAtr: 0.4, minScore: 45, maxZones: 8,
    lookback: { "15m": 400, "1h": 400, "4h": 300, "1d": 200 }, tfWeight: { "15m": 0.25, "1h": 0.5, "4h": 0.8, "1d": 1 } },
  trigger: { sweepMinPct: 0.0005, sweepMaxPct: 0.003, reclaimBars: 3, volMinMult: 1.0, volMaxMult: 3.0,
    closeStrength: 0.6, maxChasePct: 0.0015, rrMin: 1.2, costMult: 3, expectedMoveHours: 8,
    retest: true, retestBars: 4, retestStrength: 0.55, noOppAtrMult: 3 },
  add: { distMinPct: 0.003, distMaxPct: 0.006, levelTolerancePct: 0.001, minTouches: 2, gMin: 2,
    funding: 0.0002, oiDropPct: 0.003, atrPctMax: 0.9, volMaxMult: 3 },
  vol: { refAtr1hPct: 0.0037, maxScale: 1.6 },
  breaker: { dayStopR: 1, tzOffsetHours: 7 },
  eventWindows: [],
  log: { traceEveryMs: 10 * 60_000, flushEveryMs: 10 * 60_000, noTradeSampleMs: 4 * 3_600_000, maxVetoes: 6, maxChunkBytes: 90_000,
    postExitMarksMin: [30, 60, 120], keepChunks: 20_000 },
  data: { restPerSec: 0.2, candleLimit: { "15m": 300, "1h": 300, "4h": 300, "1d": 260 }, minCandles: { "15m": 120, "1h": 220, "4h": 220, "1d": 210 },
    derivEveryMs: 60 * 60_000, staleBarFactor: 3 },
};

/** Shallow-merge user overrides one level deep; unknown keys are ignored; bad numbers fall back to the default. */
export function normalizeNtsConfig(raw: unknown): NtsConfig {
  const base = structuredClone(DEFAULT_NTS_CONFIG) as unknown as Record<string, unknown>;
  if (!raw || typeof raw !== "object") return base as unknown as NtsConfig;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    const value = src[key], def = base[key];
    if (value === undefined) continue;
    if (typeof def === "number") { if (typeof value === "number" && Number.isFinite(value)) base[key] = value; }
    else if (typeof def === "boolean") { if (typeof value === "boolean") base[key] = value; }
    else if (Array.isArray(def)) { if (Array.isArray(value)) base[key] = value; }
    else if (def && typeof def === "object" && value && typeof value === "object") {
      const out = { ...(def as Record<string, unknown>) };
      for (const k of Object.keys(out)) {
        const v = (value as Record<string, unknown>)[k];
        if (typeof out[k] === "number" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
        else if (typeof out[k] === "boolean") { if (typeof v === "boolean") out[k] = v; }
        else if (Array.isArray(out[k])) { if (Array.isArray(v) && v.every(x => typeof x === "number" && Number.isFinite(x))) out[k] = [...v]; }
        else if (out[k] && typeof out[k] === "object" && v && typeof v === "object" && !Array.isArray(v)) out[k] = { ...(out[k] as object), ...(v as object) };
      }
      base[key] = out;
    }
  }
  const c = base as unknown as NtsConfig;
  // hard safety rails that no override may break
  c.leverage = Math.max(1, Math.min(100, c.leverage));
  c.firstMarginPct = Math.max(0, Math.min(0.05, c.firstMarginPct));
  c.addMarginPct = Math.max(0, Math.min(0.05, c.addMarginPct));
  c.maxLossPct = Math.max(0.001, Math.min(0.05, c.maxLossPct));
  c.neutralSizeMult = Math.max(0, Math.min(1, c.neutralSizeMult));
  c.symbols = DEFAULT_NTS_CONFIG.symbols;
  return c;
}
