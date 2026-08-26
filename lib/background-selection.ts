import type { UniverseTicker } from "./gate-client.ts";

export type BackgroundMarketSnapshot = Record<string, {
  coarseScore: number;
  changePercentage: number;
}>;

function rotate<T>(items: T[], offset: number) {
  if (!items.length) return items;
  const normalized = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(normalized), ...items.slice(0, normalized)];
}

export function snapshotBackgroundUniverse(universe: UniverseTicker[]): BackgroundMarketSnapshot {
  return Object.fromEntries(universe.map((ticker) => [ticker.symbol, {
    coarseScore: ticker.coarseScore,
    changePercentage: ticker.changePercentage,
  }]));
}

function movementVelocity(ticker: UniverseTicker, previous: BackgroundMarketSnapshot) {
  const prior = previous[ticker.symbol];
  if (!prior) return 0;
  const coarseDelta = Math.abs(ticker.coarseScore - prior.coarseScore);
  const changeDelta = Math.min(1, Math.abs(ticker.changePercentage - prior.changePercentage) / 3);
  const directionFlip = Math.sign(ticker.coarseScore) !== Math.sign(prior.coarseScore)
    && Math.abs(ticker.coarseScore) >= 0.08
    && Math.abs(prior.coarseScore) >= 0.08
    ? 0.35
    : 0;
  return coarseDelta * 0.65 + changeDelta * 0.25 + directionFlip;
}

function anchorRows(universe: UniverseTicker[], coreSymbols: string[]) {
  const bySymbol = new Map(universe.map((ticker) => [ticker.symbol, ticker]));
  const explicitAnchors = coreSymbols.filter((symbol) => /^(BTC|ETH)_USDT$/.test(symbol));
  const symbols = explicitAnchors.length ? explicitAnchors : coreSymbols.slice(0, 2);
  return symbols.map((symbol) => bySymbol.get(symbol)).filter((ticker): ticker is UniverseTicker => Boolean(ticker));
}

/**
 * Cloudflare Free keeps the deep batch capped at three symbols, but those slots
 * are now used as sensors rather than a simple rotation queue:
 *   1) a BTC/ETH market anchor,
 *   2) the strongest current cross-sectional anomaly,
 *   3) the fastest-changing symbol versus the previous one-minute universe.
 *
 * Existing positions are protected independently by PositionMonitor every ten
 * seconds, so they no longer consume two discovery slots by default. If an open
 * position is itself the strongest anomaly or fastest mover it is still chosen.
 * On the first run after a cold start there is no previous snapshot, so the
 * third slot falls back to rotation until the next scan establishes velocity.
 */
export function chooseBackgroundDeepUniverse(
  universe: UniverseTicker[],
  coreSymbols: string[],
  openSymbols: string[],
  limit: number,
  rotationOffset: number,
  previous: BackgroundMarketSnapshot = {},
) {
  const boundedLimit = Math.max(1, Math.min(3, limit));
  const selected: UniverseTicker[] = [];
  const add = (ticker: UniverseTicker | undefined) => {
    if (ticker && selected.length < boundedLimit && !selected.some((item) => item.symbol === ticker.symbol)) {
      selected.push(ticker);
    }
  };

  const anchors = anchorRows(universe, coreSymbols)
    .sort((a, b) => Math.abs(b.coarseScore) - Math.abs(a.coarseScore));
  add(anchors[0] ?? rotate(anchorRows(universe, coreSymbols), rotationOffset)[0]);
  if (selected.length >= boundedLimit) return selected;

  const tradeable = universe.filter((ticker) => ticker.state !== "blocked");
  const anomalies = [...tradeable]
    .filter((ticker) => !selected.some((item) => item.symbol === ticker.symbol))
    .sort((a, b) => Math.abs(b.coarseScore) - Math.abs(a.coarseScore));
  add(anomalies[0]);
  if (selected.length >= boundedLimit) return selected;

  const movers = [...tradeable]
    .filter((ticker) => !selected.some((item) => item.symbol === ticker.symbol) && previous[ticker.symbol])
    .map((ticker) => ({ ticker, velocity: movementVelocity(ticker, previous) }))
    .sort((a, b) => b.velocity - a.velocity || Math.abs(b.ticker.coarseScore) - Math.abs(a.ticker.coarseScore));
  if ((movers[0]?.velocity ?? 0) > 0.01) add(movers[0].ticker);
  if (selected.length >= boundedLimit) return selected;

  const bySymbol = new Map(universe.map((ticker) => [ticker.symbol, ticker]));
  const rotatingPool: UniverseTicker[] = [];
  for (const symbol of [...openSymbols, ...coreSymbols]) {
    const ticker = bySymbol.get(symbol);
    if (ticker && ticker.state !== "blocked" && !rotatingPool.some((item) => item.symbol === symbol)) rotatingPool.push(ticker);
  }
  for (const ticker of anomalies.slice(1)) {
    if (!rotatingPool.some((item) => item.symbol === ticker.symbol)) rotatingPool.push(ticker);
  }
  for (const ticker of tradeable) {
    if (!rotatingPool.some((item) => item.symbol === ticker.symbol)) rotatingPool.push(ticker);
  }
  for (const ticker of rotate(rotatingPool, rotationOffset)) add(ticker);
  return selected;
}
