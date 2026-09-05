import type { Hte31Candle } from "./hte31-types.ts";
import type { ArchiveProgress } from "./historical-archive.ts";

export const ANALOG_BAR_MS = 300_000;
export const ANALOG_HISTORY_MS = 14 * 24 * 60 * 60_000;
export const ANALOG_WINDOW = 24;
export const ANALOG_HORIZON = 12;
export const ANALOG_MIN_SAMPLES = 5;
export type AnalogEvent = { time: number; title: string };
export type HistoricalForecast = {
  model: "historical-analog-v1";
  state: "READY" | "INSUFFICIENT" | "STALE";
  reason: string;
  signalAt: number;
  historyFrom: number | null;
  historyTo: number | null;
  historyBars: number;
  missingHistoryBars?: number;
  archive?: ArchiveProgress;
  windowMinutes: number;
  horizonMinutes: number;
  sampleCount: number;
  effectiveSamples: number;
  similarity: number;
  swingBias?: { upPct: number; downPct: number; neutralPct: number; thresholdPct: number; maxUpPct: number; maxDownPct: number };
  directionUpPct?: number;
  directionDownPct?: number;
  upPct: number;
  downPct: number;
  neutralPct: number;
  medianPct: number;
  lowerPct: number;
  upperPct: number;
  side: "LONG" | "SHORT" | "WAIT";
  netEdgeR: number;
  stopPct: number;
  targetPct: number;
  costBps: number;
  eventContext: string;
  path: { referencePct?: number; minutes: number; lowerPct: number; medianPct: number; upperPct: number }[];
  episodes?: { weight: number; from: number; bars: { openPct: number; highPct: number; lowPct: number; closePct: number }[] }[];
  matches: { from: number; to: number; futureTo: number; similarity: number; forwardPct: number; calendar: string; event: string; pathPct: number[] }[];
};

/** Votes use the first cost-sized excursion, never the final close. Ambiguous OHLC bars abstain. */
export function historicalSwingVotes(episodes: NonNullable<HistoricalForecast["episodes"]>, costBps: number) {
  const thresholdPct = Math.max(0.05, Math.max(12, costBps) / 100 * 1.5);
  const votes = episodes.map(e => {
    for (const b of e.bars) {
      if (b.openPct >= thresholdPct) return 1;
      if (b.openPct <= -thresholdPct) return -1;
      const up = b.highPct >= thresholdPct, down = b.lowPct <= -thresholdPct;
      if (up && down) return 0;
      if (up) return 1;
      if (down) return -1;
    }
    return 0;
  });
  const ratio = (side: number) => votes.length ? votes.filter(v => v === side).length / votes.length * 100 : 0;
  return { votes, bias: { upPct: ratio(1), downPct: ratio(-1), neutralPct: ratio(0), thresholdPct,
    maxUpPct: Math.max(0, ...episodes.flatMap(e => e.bars.map(b => b.highPct))),
    maxDownPct: Math.max(0, ...episodes.flatMap(e => e.bars.map(b => -b.lowPct))) } };
}

export function candleTimeMs(row: Hte31Candle) { return row.time > 10_000_000_000 ? row.time : row.time * 1000; }
export function cleanAnalogCandles(candles: Hte31Candle[], now: number, oldest = 0) {
  const unique = new Map<number, Hte31Candle>();
  for (const row of candles) {
    const time = candleTimeMs(row);
    if (![time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
      || time % ANALOG_BAR_MS !== 0 || time + ANALOG_BAR_MS > now || time < oldest
      || Math.min(row.open, row.high, row.low, row.close) <= 0 || row.volume < 0
      || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) continue;
    unique.set(time, { ...row, time: time / 1000 });
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
function quantile(xs: number[], p: number) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b), at = (sorted.length - 1) * p, low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
}
function rmse(a: number[], b: number[]) { return Math.sqrt(mean(a.map((v, i) => (v - b[i]) ** 2))); }
function relativeDifference(a: number, b: number, floor = 0.0001) { return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), floor); }
function features(rows: Hte31Candle[]) {
  const base = rows[0].open;
  const path = rows.map((r) => Math.log(r.close / base));
  const moves = rows.map((r, i) => Math.log(r.close / (i ? rows[i - 1].close : r.open)));
  const avg = mean(moves), vol = Math.sqrt(mean(moves.map((v) => (v - avg) ** 2)));
  const amplitude = Math.log(Math.max(...rows.map((r) => r.high)) / Math.min(...rows.map((r) => r.low)));
  const midpoint = (rows.length - 1) / 2;
  const slope = path.reduce((sum, v, i) => sum + (i - midpoint) * v, 0)
    / rows.reduce((sum, _, i) => sum + (i - midpoint) ** 2, 0) * rows.length;
  const volumeBase = Math.max(mean(rows.map((r) => r.volume)), 1);
  return { path, moves, vol, amplitude, slope, volume: rows.map((r) => Math.log1p(r.volume / volumeBase)) };
}
export function analogCalendar(time: number) {
  // A fixed Beijing clock keeps weekday/date labels and matching consistent.
  const date = new Date(time + 8 * 3_600_000), day = date.getUTCDay();
  return { day, weekend: day === 0 || day === 6, minute: date.getUTCHours() * 60 + date.getUTCMinutes(), monthEnd: date.getUTCDate() >= 28 };
}
function eventAt(time: number, events: AnalogEvent[]) {
  const event = events.filter((e) => Number.isFinite(e.time) && Math.abs(e.time - time) <= 90 * 60_000)
    .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
  const title = event?.title.replace(/Consumer Price Index/gi, "美国消费者物价指数").replace(/Employment Situation/gi, "美国就业报告").replace(/Producer Price Index/gi, "美国生产者物价指数").replace(/Job Openings and Labor Turnover/gi, "美国职位空缺与人员流动");
  return event ? `${title}:${time < event.time ? "前" : "后"}` : null;
}
function contiguous(rows: Hte31Candle[]) { return rows.every((r, i) => i === 0 || candleTimeMs(r) - candleTimeMs(rows[i - 1]) === ANALOG_BAR_MS); }

/** Candidate selection sees only past shape/calendar, never its future return. */
export function buildHistoricalForecast(input: { candles: Hte31Candle[]; now: number; costBps: number; events?: AnalogEvent[]; stopPct: number }): HistoricalForecast {
  const rows = cleanAnalogCandles(input.candles, input.now);
  const events = input.events ?? [];
  const expectedBars = (Math.floor(input.now / ANALOG_BAR_MS) - Math.ceil((input.now - ANALOG_HISTORY_MS) / ANALOG_BAR_MS));
  const missingHistoryBars = Math.max(0, expectedBars - rows.length);
  const signalAt = rows.length ? candleTimeMs(rows.at(-1)!) + ANALOG_BAR_MS : 0;
  const result: HistoricalForecast = {
    model: "historical-analog-v1", state: "INSUFFICIENT", reason: "可用历史不足，后台正在补取已有行情", signalAt,
    historyFrom: rows.length ? candleTimeMs(rows[0]) : null, historyTo: signalAt || null, historyBars: rows.length, missingHistoryBars,
    windowMinutes: 120, horizonMinutes: 60, sampleCount: 0, effectiveSamples: 0, similarity: 0,
    upPct: 0, downPct: 0, neutralPct: 0, medianPct: 0, lowerPct: 0, upperPct: 0,
    side: "WAIT", netEdgeR: 0, stopPct: input.stopPct, targetPct: 0,
    costBps: Math.max(0, input.costBps), eventContext: "事件日历为部分覆盖；未收录不代表无事件", path: [], matches: [],
  };
  if (!rows.length) return { ...result, reason: "尚未取得有效历史行情，后台会继续补取" };
  if (input.now - signalAt >= ANALOG_BAR_MS || signalAt > input.now) return { ...result, state: "STALE", reason: "最新完整五分钟K线已过期" };
  const currentStart = rows.length - ANALOG_WINDOW;
  if (currentStart < ANALOG_WINDOW + ANALOG_HORIZON) return result;
  const current = rows.slice(currentStart);
  if (!contiguous(current)) return { ...result, reason: "最新两小时K线存在缺口" };
  const f = features(current), calendar = analogCalendar(signalAt), currentEvent = eventAt(signalAt, events);
  result.eventContext = currentEvent ? `已知事件：${currentEvent}；仅匹配事件时间，不使用事后结果` : result.eventContext;
  const candidates: { start: number; distance: number; weight: number }[] = [];
  for (let start = 0; start + ANALOG_WINDOW + ANALOG_HORIZON <= currentStart; start++) {
    const episode = rows.slice(start, start + ANALOG_WINDOW + ANALOG_HORIZON);
    if (!contiguous(episode)) continue;
    const sample = episode.slice(0, ANALOG_WINDOW), sf = features(sample);
    const anchorAt = candleTimeMs(sample.at(-1)!) + ANALOG_BAR_MS;
    const sc = analogCalendar(anchorAt), historicalEvent = eventAt(anchorAt, events);
    const clockDelta = Math.abs(calendar.minute - sc.minute);
    const clockDistance = Math.min(clockDelta, 1440 - clockDelta) / 720;
    const pathScale = Math.max(f.amplitude, sf.amplitude, 0.001);
    const distance = 0.36 * rmse(f.path, sf.path) / pathScale
      + 0.10 * rmse(f.moves, sf.moves) / Math.max(f.vol, sf.vol, 0.0005)
      + 0.12 * relativeDifference(f.vol, sf.vol)
      + 0.10 * relativeDifference(f.amplitude, sf.amplitude)
      + 0.10 * Math.abs(f.slope - sf.slope) / pathScale
      + 0.05 * rmse(f.volume, sf.volume)
      + 0.07 * clockDistance + 0.04 * Number(calendar.day !== sc.day)
      + 0.04 * Number(calendar.weekend !== sc.weekend) + 0.02 * Number(calendar.monthEnd !== sc.monthEnd)
      + (currentEvent && historicalEvent ? (currentEvent === historicalEvent ? -0.03 : 0.06) : 0);
    const weight = Math.exp(-Math.max(0, distance) * 2);
    if (weight >= 0.55) candidates.push({ start, distance, weight });
  }
  const selected: typeof candidates = [];
  for (const candidate of candidates.sort((a, b) => a.distance - b.distance || a.start - b.start)) {
    // Entire shape AND outcome intervals are disjoint; one move is one sample.
    if (selected.some((s) => Math.abs(s.start - candidate.start) < ANALOG_WINDOW + ANALOG_HORIZON)) continue;
    selected.push(candidate);
    if (selected.length === 20) break;
  }
  const totalWeight = selected.reduce((sum, s) => sum + s.weight, 0);
  result.sampleCount = selected.length;
  result.effectiveSamples = totalWeight ? totalWeight ** 2 / selected.reduce((sum, s) => sum + s.weight ** 2, 0) : 0;
  result.similarity = mean(selected.map((s) => s.weight)) * 100;
  const costPct = result.costBps / 100;
  const paths = selected.map((s) => {
    const anchor = rows[s.start + ANALOG_WINDOW - 1].close;
    return rows.slice(s.start + ANALOG_WINDOW, s.start + ANALOG_WINDOW + ANALOG_HORIZON).map((r) => (r.close / anchor - 1) * 100);
  });
  result.episodes=selected.map(s=>{
    const anchor=rows[s.start+ANALOG_WINDOW-1].close;
    return {weight:s.weight,from:candleTimeMs(rows[s.start]),bars:rows.slice(s.start+ANALOG_WINDOW,s.start+ANALOG_WINDOW+ANALOG_HORIZON).map(r=>({openPct:(r.open/anchor-1)*100,highPct:(r.high/anchor-1)*100,lowPct:(r.low/anchor-1)*100,closePct:(r.close/anchor-1)*100}))};
  });
  const swing = historicalSwingVotes(result.episodes, result.costBps);
  result.swingBias = swing.bias;
  const majority = swing.bias.upPct >= 60 ? 1 : swing.bias.downPct >= 60 ? -1 : 0;
  const referencePaths = paths.filter((_, i) => !majority || swing.votes[i] === majority);
  const forwards = paths.map((path) => path.at(-1)!);
  const ratio = (predicate: (v: number) => boolean) => totalWeight
    ? selected.reduce((sum, s, i) => sum + (predicate(forwards[i]) ? s.weight : 0), 0) / totalWeight * 100 : 0;
  result.directionUpPct=ratio(v=>v>0); result.directionDownPct=ratio(v=>v<0);
  result.upPct = ratio((v) => v > costPct);
  result.downPct = ratio((v) => v < -costPct);
  result.neutralPct = totalWeight ? Math.max(0, 100 - result.upPct - result.downPct) : 0;
  result.medianPct = quantile(forwards, 0.5); result.lowerPct = quantile(forwards, 0.1); result.upperPct = quantile(forwards, 0.9);
  result.path = selected.length ? Array.from({ length: ANALOG_HORIZON + 1 }, (_, i) => ({ minutes: i * 5,
    referencePct: i ? mean(referencePaths.map(p => p[i - 1])) : 0,
    lowerPct: i ? quantile(paths.map((p) => p[i - 1]), 0.1) : 0,
    medianPct: i ? quantile(paths.map((p) => p[i - 1]), 0.5) : 0,
    upperPct: i ? quantile(paths.map((p) => p[i - 1]), 0.9) : 0 })) : [];
  result.matches = selected.slice(0, 5).map((s, i) => {
    const segment = rows.slice(s.start, s.start + ANALOG_WINDOW + ANALOG_HORIZON);
    const anchor = segment[ANALOG_WINDOW - 1].close;
    const to = candleTimeMs(segment[ANALOG_WINDOW - 1]) + ANALOG_BAR_MS;
    const sc = analogCalendar(to);
    return { from: candleTimeMs(segment[0]), to, futureTo: candleTimeMs(segment.at(-1)!) + ANALOG_BAR_MS,
      similarity: s.weight * 100, forwardPct: forwards[i], calendar: `星期${"日一二三四五六"[sc.day]} · ${sc.weekend ? "周末" : "工作日"}`,
      event: eventAt(to, events) ?? "事件资料未覆盖", pathPct: segment.map((r) => (r.close / anchor - 1) * 100) };
  });
  if (result.sampleCount < ANALOG_MIN_SAMPLES || result.effectiveSamples < ANALOG_MIN_SAMPLES - 0.5) return { ...result,
    reason: `本轮检索${rows.length}根已存K线；合格相似走势${result.sampleCount}/${ANALOG_MIN_SAMPLES}段，暂不开仓。旧历史持续回补和轮换检索。` };
  result.state = "READY";
  const side = result.upPct >= 58 && result.medianPct > costPct ? 1 : result.downPct >= 58 && result.medianPct < -costPct ? -1 : 0;
  if (!side) return { ...result, reason: "相似片段后续方向分散，等待新的完整K线" };
  const targetPct = quantile(forwards.map((v) => v * side), 0.6);
  result.targetPct = targetPct;
  if (!(input.stopPct > 0 && targetPct > costPct * 2 && targetPct / input.stopPct >= 0.8)) return { ...result, reason: "历史推进幅度不足以覆盖成本和真实止损距离" };
  // Replay the same stop/target/TP1 breakeven policy, resolving ambiguous bars stop-first.
  const outcomes = selected.map((s) => {
    const anchor = rows[s.start + ANALOG_WINDOW - 1].close;
    let stop = -input.stopPct, move = 0;
    for (const row of rows.slice(s.start + ANALOG_WINDOW, s.start + ANALOG_WINDOW + ANALOG_HORIZON)) {
      const adverse = ((side > 0 ? row.low : row.high) / anchor - 1) * 100 * side;
      const favorable = ((side > 0 ? row.high : row.low) / anchor - 1) * 100 * side;
      const open = (row.open / anchor - 1) * 100 * side;
      if (adverse <= stop) { move = Math.min(stop, open); break; }
      if (favorable >= targetPct) { move = targetPct; break; }
      move = (row.close / anchor - 1) * 100 * side;
      if (favorable >= targetPct * 0.5) stop = Math.max(stop, costPct);
    }
    return (move - costPct) / (input.stopPct + costPct);
  });
  result.netEdgeR = selected.reduce((sum, s, i) => sum + outcomes[i] * s.weight, 0) / totalWeight;
  if (result.netEdgeR < 0.05) return { ...result, reason: "相似片段按止损、目标与费用重放后没有足够净优势" };
  return { ...result, side: side > 0 ? "LONG" : "SHORT", reason: "历史方向一致且成本后重放期望为正；属于样本估计，等待实测验证" };
}
