/**
 * 新交易系统（NTS）的全部参数。只有这一个文件；改参数只改这里。
 * 决策引擎 = 视频的 SMC 订单块方法（smc.ts）。仓位 2% / +3% / 100x 是用户给定的固定规则；smc 段每个参数都写了来源。
 */
export const NTS_VERSION = "nts-smc-v1" as const;

export type NtsConfig = {
  /** 总开关：新交易系统自动开仓（模拟盘）。默认开；用户可以关。关了不开新仓，已有仓位照常管理到平仓。 */
  enabled: boolean;
  symbols: readonly string[];
  leverage: number;
  /** 本金口径：开仓时的账户余额（复利）。 */
  firstMarginPct: number;       // 首仓保证金 / 本金
  addMarginPct: number;         // 补仓保证金 / 本金（读法 A）
  maxLossPct: number;           // 1R：整笔最坏亏损 / 本金
  /** 止损 / 保本 */
  stopSlipPct: number;          // 止损滑点假设（只用于最坏亏损估算）
  breakevenPct: number;         // 补仓后保本价 = 均价 + 该比例（覆盖来回手续费+滑点约 0.19%）
  /** 费用（沿用模拟盘现有成本模型，这里只用于估算保本价与最坏亏损） */
  feeRate: number;              // 单边吃单费率
  slippagePct: number;          // 模拟成交滑点
  maintenanceRate: number;      // 全仓维持保证金率（BTC/ETH 第一档 0.3%）
  /** 市场偏向（只记录/显示，不参与放行/否决） */
  neutralBand: number;
  biasWeights: { trend: number; oi: number; funding: number; basis: number };
  tfWeights: { "1d": number; "4h": number; "1h": number };
  /** 辅助指标（RSI/MACD）：只做小幅加减分/置信度调整，不进入任何放行/否决条件 */
  aux: { maxBiasAdj: number; maxConfAdj: number; rsiOverbought: number; rsiOversold: number };
  /** SMC 订单块（视频方法）。参数尽量少，每个都写了来源。 */
  smc: {
    obTfs: readonly ("1h" | "4h" | "1d")[]; // 订单块周期：1D 大级别支撑压力、4H 结构区、1H 执行区（视频的多周期）
    confirmBars: number;      // 吞没后几根K线内要有收盘突破阴线高点（视频：吞没后"随后"突破；取 3 根）
    maxPriorVisits: number;   // 已结束的回踩次数上限：0 = 只做第一次回踩（视频：新鲜区）
    pivot4h: number;          // 4H 摆动点左右根数（HH/HL、BOS 判定）
    stopAtrBuf: number;       // 止损 = 区外 + 该倍数 × ATR(1H)（视频：止损放在区外一点）
    rrMin: number;            // TP1 至少多少 R 才做（视频的目标是最近对向区；太近不值得；2.5 为样本内选定）
    noTargetRR: number;       // 前方没有对向区/流动性时 TP1 取几 R
    addAt: number;            // 补仓位 = 区内该比例处（0.5 = 区的均衡位，视频"区的更深处"）
    doubleWindow: number;     // 双底/双顶在最近多少根 15m 内找
    doubleTolAtr: number;     // 两个底/顶的高度差 ≤ 该倍数 × ATR(15m)
  };
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
  stopSlipPct: 0.0005,
  breakevenPct: 0.002,
  feeRate: 0.0007,
  slippagePct: 0.00025,
  maintenanceRate: 0.003,
  neutralBand: 0.1,
  biasWeights: { trend: 0.55, oi: 0.2, funding: 0.15, basis: 0.1 },
  tfWeights: { "1d": 0.4, "4h": 0.35, "1h": 0.25 },
  aux: { maxBiasAdj: 0.06, maxConfAdj: 0.08, rsiOverbought: 72, rsiOversold: 28 },
  // obTfs / rrMin 由样本内（2025-11-01→2026-05-01）4 组小网格选出：["1h"] + rrMin 2.5 样本内 PF 1.50；
  // 样本外（2026-05-01→2026-10-28）未调参复核 PF 1.15、净 +95.5U。视频原版（1h/4h/1d、rrMin 1.5）样本内 PF 0.72、样本外 PF 0.59。
  // 4H/1D 仍用于趋势结构（HH/HL/BOS）；只用 1H 区开仓 ⇒ 逆势单（只允许在 4H/1D 区）实际关闭。
  smc: { obTfs: ["1h"], confirmBars: 3, maxPriorVisits: 0, pivot4h: 2, stopAtrBuf: 0.2, rrMin: 2.5, noTargetRR: 2,
    addAt: 0.5, doubleWindow: 24, doubleTolAtr: 0.5 },
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
        else if (Array.isArray(out[k])) { if (Array.isArray(v) && (v.every(x => typeof x === "number" && Number.isFinite(x)) || (v.length > 0 && v.every(x => typeof x === "string" && ["15m", "1h", "4h", "1d"].includes(x))))) out[k] = [...v]; }
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
  c.symbols = DEFAULT_NTS_CONFIG.symbols;
  return c;
}
