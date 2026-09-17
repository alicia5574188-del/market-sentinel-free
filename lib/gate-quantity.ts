/** Exact downward quantity conversion at the exchange adapter only.
 * Minimum quantity is also used as a conservative quantization quantum.
 * It is not inferred from price ticks, leverage or the number of coins.
 */
export type GateSizeRules = {
  enableDecimal?: boolean;
  orderSizeMin?: string;
  orderSizeMax?: string;
  marketOrderSizeMax?: string;
};
const ZERO=BigInt(0),TEN=BigInt(10);
function parts(value: string | number) {
  const s = String(value).trim();
  const m = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) throw new Error("数量格式无效");
  const exponent = Number(m[3] ?? 0), scale = (m[2]?.length ?? 0) - exponent;
  if (!Number.isSafeInteger(exponent) || Math.abs(scale) > 30) throw new Error("数量精度超出范围");
  let n = BigInt(m[1] + (m[2] ?? ""));
  if (scale < 0) n *= TEN ** BigInt(-scale);
  return { n, scale: Math.max(0, scale), d: TEN ** BigInt(Math.max(0, scale)) };
}
function text(n: bigint, scale: number) {
  const s = n.toString().padStart(scale + 1, "0");
  return scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, "") || "0" : s;
}
export function quantizeMirrorNotional(target: number, price: number, multiplier: number, spec: GateSizeRules) {
  if (!spec.orderSizeMin || typeof spec.enableDecimal !== "boolean") throw new Error("缺少合约小数数量或最小下单量规格");
  const unit = parts(spec.orderSizeMin);
  if (unit.n <= ZERO || (!spec.enableDecimal && unit.n % unit.d !== ZERO)) throw new Error("合约最小量与小数开关不一致");
  const t = parts(target), p = parts(price), m = parts(multiplier);
  if (p.n <= ZERO || m.n <= ZERO) throw new Error("合约价格或乘数无效");
  const units = t.n * p.d * m.d * unit.d / (t.d * p.n * m.n * unit.n);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("数量单位超出可核对精度");
  const quantityText = text(units * unit.n, unit.scale), quantity = Number(quantityText);
  if (!Number.isFinite(quantity) || quantity > Number.MAX_SAFE_INTEGER) throw new Error("合约数量超出可核对范围");
  for (const limit of [spec.orderSizeMax, spec.marketOrderSizeMax]) {
    if (!limit) continue;
    const max = parts(limit);
    if (max.n > ZERO && units * unit.n * max.d > max.n * unit.d) throw new Error("比例数量超过交易所最大单笔数量，不静默拆单或缩单");
  }
  return { quantity, quantityText, minimum: Number(spec.orderSizeMin), quantum: text(unit.n, unit.scale),
    minimumNotional: Number(spec.orderSizeMin) * price * multiplier, supportsDecimals: spec.enableDecimal };
}
export type SizeDiagnostic = {
  targetContracts: number; minimumContracts: number; quantityQuantum: string;
  supportsDecimals: boolean; targetNotional: number; minimumNotional: number;
  minimumMargin: number; requiredLiveEquity: number;
};