type ContractRow = { contract?: string };
type PriceOrderRow = { initial?: { contract?: string } };

export type GateCutoverReadClient = {
  positions(holding?: boolean): Promise<ContractRow[]>;
  openOrders(contract?: string): Promise<ContractRow[]>;
  priceOrders(status?: "open" | "finished", contract?: string): Promise<PriceOrderRow[]>;
};

export type LiveCutoverPreflight = {
  counts: {
    positions: number;
    openOrders: number;
    priceOrders: number;
  };
  activeContracts: string[];
  checkedAt: number;
  safeToCutover: boolean;
};

function contractName(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function readGateCutoverPreflight(
  client: GateCutoverReadClient,
  checkedAt = Date.now(),
): Promise<LiveCutoverPreflight> {
  const [positions, openOrders, priceOrders] = await Promise.all([
    client.positions(true),
    client.openOrders(),
    client.priceOrders("open"),
  ]);
  const activeContracts = [...new Set([
    ...positions.map((position) => contractName(position.contract)),
    ...openOrders.map((order) => contractName(order.contract)),
    ...priceOrders.map((order) => contractName(order.initial?.contract)),
  ].filter((contract): contract is string => contract !== null))].sort();
  const counts = {
    positions: positions.length,
    openOrders: openOrders.length,
    priceOrders: priceOrders.length,
  };

  return {
    counts,
    activeContracts,
    checkedAt,
    safeToCutover: counts.positions === 0 && counts.openOrders === 0 && counts.priceOrders === 0,
  };
}
