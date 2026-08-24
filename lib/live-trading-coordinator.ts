import { getRuntimeBindings } from "./runtime-bindings";

export function liveTradingCoordinator() {
  const namespace = getRuntimeBindings().LIVE_TRADING_COORDINATOR;
  if (!namespace) throw new Error("实盘执行协调器尚未配置；自动开仓保持关闭");
  return namespace.getByName("live-trading");
}
