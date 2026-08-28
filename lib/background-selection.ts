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
 * Cloudflare Free keeps each deep batch capped at three symbols. Those three
 * slots must balance speed and coverage; otherwise an active market can pin the
 * same anchor/anomaly/mover forever and starve the rest of the universe.
 *
 * Three-phase schedule:
 *   phase 0: market anchor + strongest anomaly + mandatory rotation
 *   phase 1: strongest anomaly + two mandatory rotation slots
 *   phase 2: fastest mover + two mandatory rotation slots
 *
 * This preserves fast reaction to extremes while guaranteeing that ordinary
 * tradeable contracts continue to reach the Human Trader Engine even when the
 * same leaders stay active for hours. Existing positions are still protected by
 * PositionMonitor every ten seconds and do not consume discovery capacity.
 */
export function chooseBackgroundDeepUniverse(
  universe: UniverseTicker[],
  coreSymbols: string[],
  _openSymbols: string[],
  limit: number,
  rotationOffset: number,
  previous: BackgroundMarketSnapshot = {},
) {
  const boundedLimit = Math.max(1, Math.min(3, limit));
  const tradeable = universe.filter((ticker) => ticker.state !== "blocked");
  if (!tradeable.length) return [];

  const selected: UniverseTicker[] = [];
  const add = (ticker: UniverseTicker | undefined) => {
    if (ticker && selected.length < boundedLimit && !selected.some((item) => item.symbol === ticker.symbol)) {
      selected.push(ticker);
    }
  };

  const anomalies = [...tradeable].sort((a, b) => Math.abs(b.coarseScore) - Math.abs(a.coarseScore));
  const movers = [...tradeable]
    .filter((ticker) => previous[ticker.symbol])
    .map((ticker) => ({ ticker, velocity: movementVelocity(ticker, previous) }))
    .sort((a, b) => b.velocity - a.velocity || Math.abs(b.ticker.coarseScore) - Math.abs(a.ticker.coarseScore));
  const anchors = anchorRows(universe, coreSymbols).filter((ticker) => ticker.state !== "blocked");
  const phase = ((rotationOffset % 3) + 3) % 3;

  if (phase === 0) {
    add(rotate(anchors, Math.floor(rotationOffset / 3))[0] ?? anomalies[0]);
    add(anomalies.find((ticker) => !selected.some((item) => item.symbol === ticker.symbol)));
  } else if (phase === 1) {
    add(anomalies[0]);
  } else {
    const mover = (movers[0]?.velocity ?? 0) > 0.01 ? movers[0]?.ticker : anomalies[0];
    add(mover);
  }

  const rotatingPool = [...tradeable].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const rotating = rotate(rotatingPool, rotationOffset * 2);
  for (const ticker of rotating) {
    if (selected.length >= boundedLimit) break;
    add(ticker);
  }

  // Extremely small/duplicated universes can exhaust the rotating pool before
  // all three slots are filled. Use dynamic priorities only as a final fallback.
  for (const ticker of anomalies) {
    if (selected.length >= boundedLimit) break;
    add(ticker);
  }
  for (const mover of movers) {
    if (selected.length >= boundedLimit) break;
    add(mover.ticker);
  }
  return selected;
}