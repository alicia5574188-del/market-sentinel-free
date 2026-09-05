import type { MarketAnalysisPacket } from "./exchange-market.ts";
import { DIRECT_MARKET_BRAIN_VERSION, type DirectMarketCandidate } from "./direct-market-types.ts";
import type { Hte31Candle } from "./hte31-types.ts";
import { buildHistoricalForecast, cleanAnalogCandles, candleTimeMs, type AnalogEvent } from "./historical-forecast.ts";

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
export function pearsonCorrelation(leftCandles: Hte31Candle[], rightCandles: Hte31Candle[]) {
  const moves = (rows: Hte31Candle[]) => new Map(rows.slice(1).flatMap((r, i) =>
    candleTimeMs(r) - candleTimeMs(rows[i]) === 300_000 && rows[i].close > 0
      ? [[candleTimeMs(r), r.close / rows[i].close - 1] as const] : []));
  const left = moves(leftCandles), right = moves(rightCandles);
  const pairs = [...left].filter(([time]) => right.has(time)).slice(-72).map(([time, v]) => [v, right.get(time)!]);
  if (pairs.length < 24) return null;
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let covariance = 0, vx = 0, vy = 0;
  for (const [x, y] of pairs) { covariance += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; }
  return vx > 0 && vy > 0 ? Math.max(-1, Math.min(1, covariance / Math.sqrt(vx * vy))) : null;
}

export function buildDirectMarketCandidate(input: {
  packet: MarketAnalysisPacket; candles: Hte31Candle[]; btcCandles: Hte31Candle[];
  volumeRank: number; batchId: string; roundTripCostBps?: number; events?: AnalogEvent[];
  marketContext?: { benchmarkMomentum: number | null; advancingRatio: number; decliningRatio: number };
}): DirectMarketCandidate {
  const { packet } = input, now = packet.observedAt, candles = cleanAnalogCandles(input.candles, now);
  const price = packet.market.futuresPrice;
  const recent = candles.slice(-24), swing = candles.slice(-6);
  const ranges = recent.slice(1).map((r, i) => Math.max(r.high - r.low, Math.abs(r.high - recent[i].close), Math.abs(r.low - recent[i].close)));
  const atr = mean(ranges.slice(-14));
  const low = swing.length ? Math.min(...swing.map((r) => r.low)) : price;
  const high = swing.length ? Math.max(...swing.map((r) => r.high)) : price;
  const longStop = Math.min(low - atr * 0.3, price - atr * 1.2);
  const shortStop = Math.max(high + atr * 0.3, price + atr * 1.2);
  // Direction comes from historical outcomes. Compute a neutral forecast first,
  // then replay its chosen direction against that direction's actual structure.
  let forecast = buildHistoricalForecast({ candles, now, events: input.events,
    costBps: (input.roundTripCostBps ?? 12) + Math.abs(packet.market.fundingRate ?? 0) * 10_000,
    stopPct: Math.max(price - longStop, shortStop - price) / price * 100 });
  const side = forecast.upPct >= forecast.downPct ? "LONG" as const : "SHORT" as const;
  const structuralStop = side === "LONG" ? longStop : shortStop;
  const stopDistance = (side === "LONG" ? 1 : -1) * (price - structuralStop);
  forecast = buildHistoricalForecast({ candles, now, events: input.events, costBps: forecast.costBps, stopPct: stopDistance / price * 100 });
  const support = side === "LONG" ? forecast.upPct : forecast.downPct;
  const checks = [
    { key: "setup", label: "历史相似预测", passed: forecast.side !== "WAIT", detail: forecast.reason },
    { key: "data", label: "连续行情与独立样本", passed: forecast.state === "READY", detail: `${forecast.historyBars} 根历史K线 · ${forecast.sampleCount} 个独立片段` },
    { key: "liquidity", label: "流动性安全", passed: packet.market.volumeUsd >= 12_000_000, detail: `24小时成交额 ${(packet.market.volumeUsd / 1_000_000).toFixed(1)} 百万` },
    { key: "macro", label: "已知重大事件保护", passed: (packet.market.macroEventRisk ?? 0) < 0.85, detail: packet.market.macroEventLabel ?? "部分日历覆盖，未知事件不作相似证据" },
    { key: "structural-stop", label: "真实结构止损", passed: price > 0 && structuralStop > 0 && stopDistance > 0 && stopDistance / price <= 0.05, detail: `距离 ${(stopDistance / price * 100).toFixed(2)}%，不向结构内压缩` },
    { key: "entry-drift", label: "信号仍在附近", passed: Boolean(recent.length && atr > 0 && Math.abs(price - recent.at(-1)!.close) <= atr * 0.75), detail: "最新价格距信号收盘不超过0.75倍平均波幅" },
  ];
  const ready = checks.every((c) => c.passed), sign = side === "LONG" ? 1 : -1;
  const halfWidth = Math.min(stopDistance * 0.12, price * 0.0015);
  const target = price * forecast.targetPct / 100;
  const btcCorrelation = packet.symbol === "BTC_USDT" ? 1 : pearsonCorrelation(candles.slice(-96), cleanAnalogCandles(input.btcCandles, now));
  const riskClusterId = btcCorrelation == null ? "btc-correlation-unavailable"
    : Math.abs(btcCorrelation) >= 0.8 ? `btc-${btcCorrelation >= 0 ? "positive" : "inverse"}` : `independent-${packet.symbol}`;
  const counterEvidence = checks.filter((c) => !c.passed).map((c) => `${c.label}：${c.detail}`);
  const setup = "HISTORICAL_ANALOG" as const, setupLabel = "历史相似预测";
  return {
    symbol: packet.symbol, batchId: input.batchId, observedAt: now,
    freshness: Date.now() - now <= 90_000 ? "FRESH" : "STALE", scanStage: "DEEP",
    volumeRank: input.volumeRank, volumeUsd: packet.market.volumeUsd, riskClusterId, btcCorrelation,
    location: price >= high ? "TOP" : price <= low ? "BOTTOM" : "MIDDLE",
    paths: { up: forecast.upPct, down: forecast.downPct, rangeOrInvalid: forecast.neutralPct },
    directionalScore: (forecast.upPct - forecast.downPct) / 100, netEdgeR: forecast.netEdgeR,
    confidence: Math.round(support), setup, setupLabel, setupScore: support,
    setupEvaluations: [{ setup, setupLabel, side, score: support, triggered: forecast.side !== "WAIT", qualified: ready, selected: true, blockers: counterEvidence }],
    decision: ready ? side : "WAIT", entryZone: ready ? [price - halfWidth, price + halfWidth] : null,
    invalidationPrice: ready ? structuralStop : null, targets: ready ? [price + sign * target * 0.5, price + sign * target] : [],
    evidence: [`最近两小时对照过去两周，预测未来一小时；${forecast.sampleCount} 个不重叠历史片段`,
      `历史上涨 ${forecast.upPct.toFixed(1)}% / 下跌 ${forecast.downPct.toFixed(1)}% / 成本内波动 ${forecast.neutralPct.toFixed(1)}%，不是保证胜率`,
      `后续涨跌中位数 ${forecast.medianPct.toFixed(2)}%，按止损与费用重放期望 ${forecast.netEdgeR.toFixed(2)} 倍风险`, forecast.eventContext],
    counterEvidence, checks, candles5m: candles.slice(-96), forecast,
    assetRegime: Math.abs(recent.at(-1)?.close ?? 0) > 0 && atr / price > 0.008 ? "volatile" : "transition", maxHoldingMinutes: 60,
  };
}
export function directCandidateSummary(candidate: DirectMarketCandidate) {
  return `${DIRECT_MARKET_BRAIN_VERSION} · ${candidate.setupLabel} · 历史上涨${candidate.paths.up.toFixed(1)}%/下跌${candidate.paths.down.toFixed(1)}%/成本内波动${candidate.paths.rangeOrInvalid.toFixed(1)}%`;
}
