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
 * Select deep-scan candidates while respecting the Cloudflare Free connection
 * ceiling. Production uses limit=1 and wakes this selector about every 20s, so
 * one Durable Object invocation owns one symbol only. That keeps the per-symbol
 * Gate fan-out below the platform's simultaneous outgoing-connection ceiling.
 *
 * Single-slot three-phase schedule:
 *   phase 0: strongest anomaly every minute
 *   phase 1: alternate fastest mover / market anchor between minutes
 *   phase 2: mandatory alphabetical rotation for broad coverage
 *
 * The older multi-slot path remains available for non-free/foreground callers.
 * Existing positions are protected independently by PositionMonitor and do not
 * consume discovery capacity.
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
  const rotatingPool = [...tradeable].sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (boundedLimit === 1) {
    const phase = ((rotationOffset % 3) + 3) % 3;
    const round = Math.floor(Math.max(0, rotationOffset) / 3);
    if (phase === 0) {
      add(anomalies[0]);
    } else if (phase === 1) {
      const fastestMover = (movers[0]?.velocity ?? 0) > 0.01 ? movers[0]?.ticker : undefined;
      if (round % 2 === 0) add(fastestMover ?? rotate(anchors, round)[0] ?? anomalies[0]);
      else add(rotate(anchors, round)[0] ?? fastestMover ?? anomalies[0]);
    } else {
      add(rotate(rotatingPool, round)[0] ?? anomalies[0]);
    }
    return selected;
  }

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

  const rotating = rotate(rotatingPool, rotationOffset * 2);
  for (const ticker of rotating) {
    if (selected.length >= boundedLimit) break;
    add(ticker);
  }

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
