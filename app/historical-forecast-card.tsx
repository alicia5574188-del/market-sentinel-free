import { historicalDirection } from "../lib/analog-path-strategy";
import { ANALOG_MIN_SAMPLES, type HistoricalForecast } from "../lib/historical-forecast";

type Candle = { time?: number; open: number; high: number; low: number; close: number };
const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
function date(time: number) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(time); }

const OVERLAY_COLORS = ["#7aa8ff", "#e8b65a", "#69d7a3", "#d38bff", "#ff8b82", "#55d8e8"];

function OverlayLineChart({ current, matches }: { current: Candle[]; matches: HistoricalForecast["matches"] }) {
  const series = [
    { key: "current", label: "当前", rows: current, reference: Math.max(0, current.length - 1), color: OVERLAY_COLORS[0] },
    ...matches.map((match, index) => ({ key: `${match.from}`, label: `#${index + 1} ${date(match.from)}`, rows: match.candles ?? [], reference: Math.min(23, Math.max(0, (match.candles?.length ?? 1) - 1)), color: OVERLAY_COLORS[index + 1] })),
  ].map((line) => {
    const base = line.rows[line.reference]?.close;
    return { ...line, values: base > 0 ? line.rows.map((candle) => (candle.close / base - 1) * 100) : [] };
  });
  const values = series.flatMap((line) => line.values);
  if (!values.length) return <div className="rz-kline-empty">等待下一轮真实五分钟收盘线</div>;
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * .08, .05);
  const bottom = rawMin - padding, top = rawMax + padding, span = top - bottom;
  const maxIndex = Math.max(35, ...series.map((line) => line.values.length - 1));
  const x = (index: number) => 14 + index / maxIndex * 424;
  const y = (value: number) => 12 + (top - value) / span * 124;
  const boundaryX = x(23);
  return <div className="rz-analog-overlay">
    <svg viewBox="0 0 470 164" role="img" aria-label="当前真实收盘线与最相似五段历史真实收盘线叠加图">
      <rect x={boundaryX} y="7" width={438 - boundaryX} height="133" fill="#e8b65a" opacity="0.06" />
      {bottom <= 0 && top >= 0 && <line x1="14" x2="438" y1={y(0)} y2={y(0)} stroke="#718096" strokeDasharray="3 4" opacity="0.7" />}
      <line x1={boundaryX} x2={boundaryX} y1="7" y2="140" stroke="#a89a72" strokeDasharray="4 4" />
      {series.map((line, index) => line.values.length > 1 && <polyline key={line.key} points={line.values.map((value, point) => `${x(point)},${y(value)}`).join(" ")} fill="none" stroke={line.color} strokeWidth={index === 0 ? 2.8 : 1.6} strokeLinejoin="round" strokeLinecap="round" opacity={index === 0 ? 1 : .82} />)}
      <text x="14" y="157" fill="#aab7ce" fontSize="10">两小时前</text>
      <text x={boundaryX - 18} y="157" fill="#aab7ce" fontSize="10">参考点</text>
      <text x="383" y="157" fill="#aab7ce" fontSize="10">实际后一小时</text>
      <text x="441" y="15" fill="#aab7ce" fontSize="9">{signed(top)}</text>
      <text x="441" y="137" fill="#aab7ce" fontSize="9">{signed(bottom)}</text>
    </svg>
    <div className="rz-analog-legend">{series.map((line) => <span key={line.key}><i style={{ backgroundColor: line.color }} />{line.label}</span>)}</div>
  </div>;
}

export function HistoricalForecastCard({ symbol, forecast, candles, observedAt = forecast.signalAt }: { symbol: string; forecast: HistoricalForecast; candles: Candle[]; observedAt?: number }) {
  const current = candles.filter(c => c.time == null || (c.time > 10_000_000_000 ? c.time : c.time * 1000) + 300_000 <= forecast.signalAt).slice(-24);
  const matches = forecast.matches.slice(0, ANALOG_MIN_SAMPLES);
  const hasDistribution = forecast.sampleCount > 0 && forecast.path.length > 1;
  const stale = forecast.state === "STALE" || observedAt - forecast.signalAt >= 300_000;
  const referenceOnly = stale || forecast.state !== "READY";
  return <article className="rz-panel rz-strategy-performance">
    <div className="rz-strategy-head"><div><strong>{symbol.replace("_USDT", "")} · 历史相似预测</strong><small>观察最近两小时 · 推演未来一小时 · {forecast.signalAt ? date(forecast.signalAt) : "等待数据"}</small></div><span>{stale ? "行情延迟" : forecast.state === "READY" ? "模拟验证" : forecast.historyBars < 60 ? "历史数据不足" : "相似依据不足"}</span></div>
    <p>{historicalDirection(forecast,observedAt,forecast.costBps).reason}。方向明确后比较立即入场与先反向后入场；不再叠加回踩信号。</p>
    {forecast.archive && <details className="rz-history-progress"><summary>{forecast.archive.storedBars == null ? "历史库暂时无法读取" : `已存 ${forecast.archive.storedBars} 根K线`}{forecast.archive.from ? ` · ${date(forecast.archive.from)} 起` : ""}</summary><p>{/历史请求失败|history/i.test(forecast.archive.note) ? "较早历史本轮暂未更新，已存数据继续参与匹配；后台稍后重试" : forecast.archive.note}。本轮检索 {forecast.archive.searchedBars} 根，只取互不重叠且最相似的五段。</p></details>}
    <div className="rz-kline-title"><strong>当前走势 + 最相似 5 段 · 真实收盘线</strong><small>一张图叠加；虚线右侧是各历史片段实际发生的后一小时</small></div>
    <OverlayLineChart current={current} matches={matches} />
    <small>蓝线是当前真实收盘走势，其余五条线来自用于决策的五个最相似历史片段；仅为方便比较而各自在参考点归零，没有平均线、预测线或虚构数据。</small>
    <p>{stale ? "数据已过期，图仅作历史参考，不用于当前入场。" : referenceOnly ? `当前${forecast.sampleCount}段相似片段，至少需要${ANALOG_MIN_SAMPLES}段；图仅供观察，暂不作为开仓依据。` : "这五段同时用于方向、目标、保护距离和路径回放；样本参考不是未来胜率保证。"}</p>
    {hasDistribution && <>
      <div className="rz-strategy-numbers">
        <div><span>先向上 / 先向下波动占比</span><b>{forecast.swingBias ? `${forecast.swingBias.upPct.toFixed(0)}% / ${forecast.swingBias.downPct.toFixed(0)}%` : "正在更新"}</b></div>
        <div><span>途中最大上涨 / 最大下跌</span><b>{forecast.swingBias ? `${signed(forecast.swingBias.maxUpPct)} / ${signed(-forecast.swingBias.maxDownPct)}` : "正在更新"}</b></div>
        <div><span>历史后续八成区间</span><b>{signed(forecast.lowerPct)} ～ {signed(forecast.upperPct)}</b></div>
        <div><span>独立片段 / 平均相似度</span><b>{forecast.sampleCount} / {forecast.similarity.toFixed(0)}%</b></div>
      </div>
      <details><summary>查看相似日期和匹配依据</summary>
        {matches.map((m) => <p key={m.from}>{date(m.from)}—{date(m.to)} · {m.calendar}<br />相似度 {m.similarity.toFixed(0)}%，之后一小时 {signed(m.forwardPct)}<br />{m.event}</p>)}
        <p>形状、波幅、波动、斜率、成交量、时段、星期、周末和月末综合对照。日期均为北京时间。{forecast.eventContext}</p>
      </details>
    </>}
    {!forecast.archive && <small>已读取 {forecast.historyBars} 根五分钟K线{forecast.historyFrom ? `，${date(forecast.historyFrom)} 起` : ""}。{forecast.state === "READY" ? "历史分布不等于未来胜率，实际成交以订单为准。" : "样本较少时仅作参考。"}</small>}
  </article>;
}
