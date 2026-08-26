import { GatePrivateClient } from "./gate-private.ts";

export type GatePositionModeSwitchResult = {
  changed: boolean;
  positionMode: "single";
};

function hasPosition(positions: Awaited<ReturnType<GatePrivateClient["positions"]>>) {
  return positions.some((position) => Math.abs(Number(position.size ?? 0)) > 0);
}

export async function switchGateToSinglePositionMode(client: GatePrivateClient): Promise<GatePositionModeSwitchResult> {
  const account = await client.futuresAccount();
  const currentMode = account.position_mode ?? (account.in_dual_mode ? "dual" : "single");
  if (currentMode === "single") return { changed: false, positionMode: "single" };

  const [positions, orders, priceOrders] = await Promise.all([
    client.positions(true),
    client.openOrders(),
    client.priceOrders("open"),
  ]);

  if (hasPosition(positions) || orders.length > 0 || priceOrders.length > 0) {
    throw new Error("Gate 当前还有合约持仓或挂单，无法切换为单向模式；请先在 Gate 清空持仓和挂单后再试");
  }

  await client.request("POST", "/futures/usdt/set_position_mode", {
    query: { position_mode: "single" },
  });

  const verified = await client.futuresAccount();
  const verifiedMode = verified.position_mode ?? (verified.in_dual_mode ? "dual" : "single");
  if (verifiedMode !== "single") throw new Error("Gate 未确认切换到单向持仓模式，请稍后重试");

  return { changed: true, positionMode: "single" };
}
