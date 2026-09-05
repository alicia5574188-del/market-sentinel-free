import type { HistoricalForecast } from "../lib/historical-forecast";

type Candle = { close: number };
const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
function date(time: number) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(time); }

export function HistoricalForecastCard({ symbol, forecast, candles }: { symbol: string; forecast: HistoricalForecast; candles: Candle[] }) {
  const current = candles.slice(-24), anchor = current.at(-1)?.close ?? 0;
  const currentPath = anchor > 0 ? current.map((c) => (c.close / anchor - 1) * 100) : [];
  const matches = forecast.matches.slice(0, 3);
  const values = [...currentPath, ...matches.flatMap((m) => m.pathPct), ...forecast.path.flatMap((p) => [p.lowerPct, p.upperPct])];
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = Math.max(max - min, 0.05);
  const x = (minutes: number) => 18 + (minutes + 120) / 180 * 424;
  const y = (value: number) => 20 + (max - value) / span * 148;
  const line = (path: number[], from: number) => path.map((v, i) => `${x(from + i * 5)},${y(v)}`).join(" ");
  const band = [...forecast.path.map((p) => `${x(p.minutes)},${y(p.upperPct)}`), ...[...forecast.path].reverse().map((p) => `${x(p.minutes)},${y(p.lowerPct)}`)].join(" ");
  return <article className="rz-panel rz-strategy-performance">
    <div className="rz-strategy-head"><div><strong>{symbol.replace("_USDT", "")} · 历史相似预测</strong><small>观察最近两小时 · 推演未来一小时 · {forecast.signalAt ? date(forecast.signalAt) : "等待数据"}</small></div><span>{forecast.state === "READY" ? "模拟验证" : forecast.state === "STALE" ? "行情延迟" : forecast.historyBars < 60 ? "历史数据不足" : "相似依据不足"}</span></div>
    <p>{forecast.state === "INSUFFICIENT" && forecast.reason.includes("合格相似走势") ? `找到 ${forecast.sampleCount} 段合格相似走势，至少需要8段；继续寻找。` : forecast.reason}</p>
    {forecast.archive && <details className="rz-history-progress"><summary>{forecast.archive.storedBars == null ? "历史库暂时无法读取" : `已存 ${forecast.archive.storedBars} 根K线`}{forecast.archive.from ? ` · ${date(forecast.archive.from)} 起` : ""}</summary><p>{forecast.archive.note}。本轮检索 {forecast.archive.searchedBars} 根，较早历史分批轮换参与匹配。</p></details>}
    {forecast.state === "READY" && <>
      <svg viewBox="0 0 470 204" style={{ width: "100%", display: "block" }} role="img" aria-label="最新两小时与历史相似走势对照，右侧为历史后续分布，不是确定预测">
        <line x1="18" x2="442" y1={y(0)} y2={y(0)} stroke="#63708a" strokeDasharray="3 4" />
        <line x1={x(0)} x2={x(0)} y1="12" y2="174" stroke="#63708a" strokeDasharray="3 4" />
        {matches.map((m) => <polyline key={m.from} points={line(m.pathPct, -115)} fill="none" stroke="#768ba8" strokeWidth="1.1" opacity="0.45" />)}
        <polygon points={band} fill="#e8b65a" opacity="0.17" />
        <polyline points={line(currentPath, -(currentPath.length - 1) * 5)} fill="none" stroke="#84b0ff" strokeWidth="2.8" />
        <polyline points={forecast.path.map((p) => `${x(p.minutes)},${y(p.medianPct)}`).join(" ")} fill="none" stroke="#f5c66d" strokeWidth="2.4" strokeDasharray="5 3" />
        <text x="18" y="194" fill="#aab7ce" fontSize="12">两小时前</text><text x={x(0) - 12} y="194" fill="#aab7ce" fontSize="12">现在</text><text x="384" y="194" fill="#aab7ce" fontSize="12">一小时后</text>
        <text x="446" y="25" fill="#aab7ce" fontSize="10">{max.toFixed(1)}%</text><text x="446" y="168" fill="#aab7ce" fontSize="10">{min.toFixed(1)}%</text>
      </svg>
      <small>蓝线：最新走势　灰线：历史片段　金色：历史后续中位数与八成区间</small>
      <div className="rz-strategy-numbers">
        <div><span>历史上涨 / 下跌占比</span><b>{forecast.upPct.toFixed(0)}% / {forecast.downPct.toFixed(0)}%</b></div>
        <div><span>一小时后涨跌中位数</span><b>{signed(forecast.medianPct)}</b></div>
        <div><span>历史后续八成区间</span><b>{signed(forecast.lowerPct)} ～ {signed(forecast.upperPct)}</b></div>
        <div><span>独立片段 / 平均相似度</span><b>{forecast.sampleCount} / {forecast.similarity.toFixed(0)}%</b></div>
      </div>
      <details><summary>查看相似日期和匹配依据</summary>
        {forecast.matches.map((m) => <p key={m.from}>{date(m.from)}—{date(m.to)} · {m.calendar}<br />相似度 {m.similarity.toFixed(0)}%，之后一小时 {signed(m.forwardPct)}<br />{m.event}</p>)}
        <p>形状、波幅、波动、斜率、成交量、时段、星期、周末和月末综合对照。日期均为北京时间。{forecast.eventContext}</p>
      </details>
    </>}
    {!forecast.archive && <small>已读取 {forecast.historyBars} 根五分钟K线{forecast.historyFrom ? `，${date(forecast.historyFrom)} 起` : ""}。{forecast.state === "READY" ? "历史分布不等于未来胜率，实际成交以订单为准。" : "样本不足时不展示预测比例。"}</small>}
  </article>;
}
