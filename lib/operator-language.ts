// Display-only translations. Stored identifiers and execution comparisons stay unchanged.
const LABELS: Record<string, string> = {
  TOP: "区间高位", MIDDLE: "区间中部", BOTTOM: "区间低位", BREAKOUT: "向上突破", BREAKDOWN: "向下跌破",
  FRESH: "最新数据", STALE: "数据已过期", UNAVAILABLE: "数据不可用", READY: "已就绪", PENDING: "等待处理",
  CALIBRATING: "校准中", VALIDATING: "验证中", NORMAL: "正常", CAUTION: "谨慎", DEFENSIVE: "防守", PAUSED: "暂停",
  HOLD: "继续持有", PROTECT: "加强保护", EXIT: "平仓", ENTRY: "入场", STOP: "止损", LONG: "做多", SHORT: "做空", WAIT: "等待", NEUTRAL: "方向未明确",
  TP1: "第一止盈", TP2: "第二止盈",
  live: "运行中", starting: "启动中", idle: "等待中", stopped: "已停止", paused: "已暂停", blocked: "已拦截",
  degraded: "降级运行", recovering: "恢复中", stale: "数据已过期", unavailable: "暂不可用", error: "异常",
  settings: "读取设置", universe: "筛选交易品种", deep: "深度分析", candles: "读取价格走势", evaluate: "评估信号",
  submitting: "提交中", open: "持仓中", holding: "持仓中", protected: "保护中", closing: "平仓中", closed: "已平仓",
  rejected: "已拒绝", failed: "失败", canceled: "已撤销", cancelled: "已撤销", pending: "等待处理", completed: "已完成",
  verified: "已验证", unverified: "待验证", isolated: "逐仓", cross: "全仓", active: "启用", disabled: "停用",
  info: "提示", warning: "警告", warn: "警告", critical: "严重异常", success: "成功",
  stop_loss: "止损", take_profit: "止盈", timeout: "持仓到期", version_reset: "版本切换归档", breakeven: "保本退出", brain_invalidation: "结构失效退出",
  "btc-positive": "比特币同向风险", "btc-inverse": "比特币反向风险", "btc-correlation-unavailable": "相关性待确认",
};

export function operatorLabel(value: string | null | undefined) {
  return value == null || value === "" ? "--" : LABELS[value] ?? "状态待确认";
}

export function riskClusterLabel(value: string) {
  return value.startsWith("independent-")
    ? `${value.slice("independent-".length).replace("_USDT", "")}独立风险`
    : operatorLabel(value);
}

const TEXT: Record<string, string> = {
  ...LABELS,
  TP1: "第一止盈", TP2: "第二止盈", PF: "盈利因子", MAE: "最大不利波动", MFE: "最大有利波动",
  ATR: "平均波幅", Spot: "现货资金流", Book: "订单簿", Funding: "资金费率", OI: "持仓量", Flow: "资金流", HTF: "高周期", IV: "隐含波动率",
  Scanner: "市场扫描", "Trade Manager": "持仓管理", "Web Push": "消息推送", "Service Worker": "后台服务",
  "Entry Efficiency": "入场效率", "Exit Efficiency": "退出效率", "Exit Capture": "收益捕获率",
  "Failed to fetch": "网络请求失败", "fetch failed": "网络请求失败", "Network Error": "网络异常",
  trend_up: "上涨趋势", trend_down: "下跌趋势", range: "区间震荡", compression: "波动压缩",
  expansion_up: "向上扩张", expansion_down: "向下扩张", leverage_liquidation: "极端杠杆清算", transition: "环境切换",
};
const WORDS = new RegExp(`\\b(?:${Object.keys(TEXT).sort((a, b) => b.length - a.length).join("|")})\\b`, "g");

export function chineseOperatorText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/direct-market-brain-v\d[\w-]*/g, "当前策略版本")
    .replace(/\bSF\d+\s*|\s*\[HT[\w-]+\]/g, "")
    .replace(WORDS, (word) => TEXT[word])
    .replace(/([+-]?\d+(?:\.\d+)?)R\b/g, "$1倍风险")
    .replace(/\b(\d+)m\b/g, "$1分钟").replace(/\b(\d+)h\b/g, "$1小时");
}
