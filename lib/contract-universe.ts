const CRYPTO_CONTRACT_TYPES = new Set([
  "",
  "crypto",
  "cryptocurrency",
  "digital_asset",
  "digital_assets",
]);

export function normalizeContractType(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Gate's regular crypto futures historically omit contract_type. Newer
 * TradFi-style futures set it to stocks, metals, indices, forex or
 * commodities. Unknown non-empty classifications fail closed so a newly
 * introduced non-crypto class cannot silently enter the research universe.
 */
export function isCryptoContractType(value: unknown) {
  return CRYPTO_CONTRACT_TYPES.has(normalizeContractType(value));
}

