import { historicalDirection } from "../lib/analog-path-strategy";
import { ANALOG_MIN_SAMPLES, type HistoricalForecast } from "../lib/historical-forecast";

type Candle = { time?: number; open: number; high: number; low: number; close: number };
const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
function date(time: number) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(time); }

function CandlestickChart({ rows, boundary, label }: { rows: Candle[]; boundary?: number; label: string }) {
  if (!rows.length) return <div className="rz-kline-empty">等待下一轮真实 OHLC K 线</div>;
  const min = Math.min(...rows.map((c) => c.low)), max = Math.max(...rows.map((c) => c.high));
  const padding = Math.max((max - min) * .08, Math.abs(max) * .0002, .000001);
  const bottom = min - padding, top = max + padding, span = top - bottom;
  const x = (index: number) => 14 + (index + .5) / rows.length * 424;
  const y = (price: number) => 16 + (top - price) / span * 112;
  const width = Math.max(2, Math.min(7, 318 / rows.length));
  const boundaryX = boundary == null ? null : 14 + boundary / rows.length * 424;
  return <svg viewBox="0 0 470 154" role="img" aria-label={label}>
    {boundaryX != null && <><rect x={boundaryX} y="8" width={438 - boundaryX} height="126" fill="#e8b65a" opacity="0.07" /><line x1={boundaryX} x2={boundaryX} y1="8" y2="134" stroke="#a89a72" strokeDasharray="3 4" /></>}
    {rows.map((c, index) => {
      const rising = c.close >= c.open, color = rising ? "#69d7a3" : "#ff8b82";
      const bodyTop = y(Math.max(c.open, c.close)), bodyHeight = Math.max(1.5, Math.abs(y(c.open) - y(c.close)));
      return <g key={`${c.time ?? index}:${index}`}><line x1={x(index)} x2={x(index)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" /><rect x={x(index) - width / 2} y={bodyTop} width={width} height={bodyHeight} fill={rising ? "none" : color} stroke={color} strokeWidth="1" /></g>;
    })}
    <text x="14" y="148" fill="#aab7ce" fontSize="10">{boundary == null ? "两小时前" : "相似段开始"}</text>
    {boundaryX != null && <><text x={boundaryX - 18} y="148" fill="#aab7ce" fontSize="10">参考点</text><text x="390" y="148" fill="#aab7ce" fontSize="10">实际后续</text></>}
    <text x="442" y="19" fill="#aab7ce" fontSize="9">{top.toPrecision(6)}</text><text x="442" y="128" fill="#aab7ce" fontSize="9">{bottom.toPrecision(6)}</text>
  </svg>;
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
    <section className="rz-kline-current"><strong>当前两小时 · 实际 K 线</strong><CandlestickChart rows={current} label="当前最近两小时的真实开高低收K线" /></section>
    <div className="rz-kline-title"><strong>最相似 5 段 · 实际历史 K 线</strong><small>每张独立价格刻度；虚线右侧是当时真实发生的后一小时</small></div>
    <div className="rz-kline-list">{matches.map((m, index) => <section className="rz-kline-match" key={m.from}>
      <header><strong>#{index + 1} · {date(m.from)}</strong><span>相似 {m.similarity.toFixed(0)}% · 后续 {signed(m.forwardPct)}</span></header>
      <CandlestickChart rows={m.candles ?? []} boundary={24} label={`第${index + 1}段历史相似走势的真实开高低收K线`} />
    </section>)}</div>
    <small>绿色为收涨 K 线，红色为收跌 K 线；全部来自已存历史 OHLC，不再用归一化折线代替。</small>
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
