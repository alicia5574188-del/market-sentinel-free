import type { UniverseTicker } from "./gate-client.ts";

function rotate<T>(items: T[], offset: number) {
  if (!items.length) return items;
  const normalized = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(normalized), ...items.slice(0, normalized)];
}

/**
 * Free Workers are intentionally given a small deep-analysis batch. Open
 * positions receive two rotating slots, the strongest non-position anomaly
 * receives one immediate slot, and any remaining capacity rotates through
 * core symbols and the rest of the ranked universe. The cheap universe pass
 * still observes all configured symbols every minute.
 */
export function chooseBackgroundDeepUniverse(
  universe: UniverseTicker[],
  coreSymbols: string[],
  openSymbols: string[],
  limit: number,
  rotationOffset: number,
) {
  const boundedLimit = Math.max(1, Math.min(3, limit));
  const bySymbol = new Map(universe.map((ticker) => [ticker.symbol, ticker]));
  const selected: UniverseTicker[] = [];
  const add = (ticker: UniverseTicker | undefined) => {
    if (ticker && selected.length < boundedLimit && !selected.some((item) => item.symbol === ticker.symbol)) {
      selected.push(ticker);
    }
  };

  const openRows = openSymbols.map((symbol) => bySymbol.get(symbol)).filter((ticker): ticker is UniverseTicker => Boolean(ticker));
  const openSlots = Math.min(openRows.length, Math.min(2, Math.max(0, boundedLimit - 1)));
  for (const ticker of rotate(openRows, rotationOffset).slice(0, openSlots)) add(ticker);

  const anomalies = [...universe]
    .filter((ticker) => !openSymbols.includes(ticker.symbol))
    .sort((a, b) => Math.abs(b.coarseScore) - Math.abs(a.coarseScore));
  add(anomalies[0]);

  const rotatingPool: UniverseTicker[] = [];
  for (const symbol of coreSymbols) {
    const ticker = bySymbol.get(symbol);
    if (ticker && !rotatingPool.some((item) => item.symbol === symbol)) rotatingPool.push(ticker);
  }
  for (const ticker of anomalies.slice(1)) {
    if (!rotatingPool.some((item) => item.symbol === ticker.symbol)) rotatingPool.push(ticker);
  }
  for (const ticker of universe) {
    if (!rotatingPool.some((item) => item.symbol === ticker.symbol)) rotatingPool.push(ticker);
  }
  for (const ticker of rotate(rotatingPool, rotationOffset)) add(ticker);
  return selected;
}

