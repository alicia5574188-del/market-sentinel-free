const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VAULT_SALT = encoder.encode("market-sentinel/gate-credential-vault/v1");
const VAULT_INFO = encoder.encode("gate-api-v4-key-and-secret");
const VAULT_AAD = encoder.encode("market-sentinel:gate:credentials:v1");

export type GateCredentials = {
  apiKey: string;
  apiSecret: string;
  environment: "live" | "testnet";
};

export type EncryptedGateCredentials = {
  ciphertext: string;
  iv: string;
  cryptoVersion: 1;
};

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveVaultKey(ownerAccessToken: string) {
  if (ownerAccessToken.length < 16) throw new Error("实盘凭据保险库密钥不可用，请先配置有效的后台访问码");
  const rootKey = await crypto.subtle.importKey("raw", encoder.encode(ownerAccessToken), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: VAULT_SALT,
    info: VAULT_INFO,
  }, rootKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export function normalizeGateCredentials(credentials: GateCredentials): GateCredentials {
  const apiKey = credentials.apiKey.trim();
  const apiSecret = credentials.apiSecret.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) throw new Error("Gate API Key 格式不正确");
  if (!/^[\x21-\x7E]{8,256}$/.test(apiSecret)) throw new Error("Gate API Secret 格式不正确");
  if (credentials.environment !== "live" && credentials.environment !== "testnet") throw new Error("Gate 环境无效");
  return { apiKey, apiSecret, environment: credentials.environment };
}

export async function encryptGateCredentials(credentials: GateCredentials, ownerAccessToken: string): Promise<EncryptedGateCredentials> {
  const value = normalizeGateCredentials(credentials);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(ownerAccessToken);
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: VAULT_AAD, tagLength: 128 }, key, plaintext);
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv),
    cryptoVersion: 1,
  };
}

export async function decryptGateCredentials(encrypted: EncryptedGateCredentials, ownerAccessToken: string): Promise<GateCredentials> {
  if (encrypted.cryptoVersion !== 1) throw new Error("不支持的实盘凭据加密版本");
  try {
    const key = await deriveVaultKey(ownerAccessToken);
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: base64UrlToBytes(encrypted.iv),
      additionalData: VAULT_AAD,
      tagLength: 128,
    }, key, base64UrlToBytes(encrypted.ciphertext));
    return normalizeGateCredentials(JSON.parse(decoder.decode(plaintext)) as GateCredentials);
  } catch {
    throw new Error("实盘凭据无法解密；后台访问码变更后请重新填写 Gate API 信息");
  }
}

export function gateKeyHint(apiKey: string) {
  const clean = apiKey.trim();
  return clean.length <= 8 ? `${clean.slice(0, 2)}••••${clean.slice(-2)}` : `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}
